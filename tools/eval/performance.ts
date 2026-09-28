import type { ModelUsageRecord, StageRecord } from '../../src/bots/agent/lib/agentTelemetry.js';
import { billableOutputTokens, costUsd } from './pricing.js';
import type { PricingTable } from './pricing.js';
import type { AgentEvalObservation, RatioMetric } from './types.js';

export interface DurationSummary {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  lowSample: boolean;
}

export interface PerformanceSummary {
  measuredTurns: number;
  stages: Record<string, DurationSummary>;
  coldStages: Record<string, DurationSummary>;
  modelCallLatency: DurationSummary;
  turnTotalByTerminal: Record<'question' | 'options', DurationSummary>;
  bookingTotal: DurationSummary;
  efficiency: {
    meanModelCalls: number | null;
    meanToolCalls: number | null;
    meanLoopSteps: number | null;
    loopStepDistribution: Record<string, number>;
  };
  tokens: {
    modelCalls: number;
    callsMissingUsage: number;
    meanPromptPerTurn: number | null;
    meanOutputPerTurn: number | null;
    meanTotalPerTurn: number | null;
    meanTotalPerOptionsTurn: number | null;
    meanTotalPerCompletedBooking: number | null;
  };
  cost:
    | {
        status: 'priced';
        model: string;
        source: string;
        retrievedOn: string;
        meanUsdPerTurn: number | null;
        meanUsdPerOptionsTurn: number | null;
        meanUsdPerCompletedBooking: number | null;
      }
    | { status: 'unavailable'; reason: string };
  retries: number;
  stageErrorRate: Record<string, RatioMetric>;
}

const LOW_SAMPLE_THRESHOLD = 20;

export function nearestRank(sortedValues: number[], percentile: number): number | null {
  if (sortedValues.length === 0) return null;
  const rank = Math.ceil((percentile / 100) * sortedValues.length);
  return sortedValues[Math.min(sortedValues.length, Math.max(1, rank)) - 1];
}

export function summarizeDurations(values: number[]): DurationSummary {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    max: sorted.length === 0 ? null : sorted[sorted.length - 1],
    lowSample: sorted.length < LOW_SAMPLE_THRESHOLD,
  };
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function perTurnSums(stages: StageRecord[]): Map<string, number> {
  const sums = new Map<string, number>();
  for (const record of stages) sums.set(record.stage, (sums.get(record.stage) ?? 0) + record.durationMs);
  return sums;
}

function summarizeStages(observations: AgentEvalObservation[]): Record<string, DurationSummary> {
  const byStage = new Map<string, number[]>();
  for (const observation of observations) {
    for (const [stage, total] of perTurnSums(observation.telemetry?.stages ?? [])) {
      byStage.set(stage, [...(byStage.get(stage) ?? []), total]);
    }
  }
  return Object.fromEntries([...byStage].sort(([a], [b]) => a.localeCompare(b)).map(([stage, values]) => [stage, summarizeDurations(values)]));
}

function stageTotal(observation: AgentEvalObservation, stage: string): number | undefined {
  return perTurnSums(observation.telemetry?.stages ?? []).get(stage);
}

function hasCompleteUsage(call: ModelUsageRecord): boolean {
  return call.promptTokens !== undefined && billableOutputTokens(call) !== undefined;
}

interface TurnTokens {
  prompt: number;
  output: number;
}

function turnTokens(observation: AgentEvalObservation): TurnTokens | undefined {
  const calls = observation.telemetry?.modelCalls ?? [];
  if (calls.length === 0 || !calls.every(hasCompleteUsage)) return undefined;
  return calls.reduce<TurnTokens>(
    (sum, call) => ({ prompt: sum.prompt + (call.promptTokens as number), output: sum.output + (billableOutputTokens(call) as number) }),
    { prompt: 0, output: 0 }
  );
}

export function summarizePerformance(
  observations: AgentEvalObservation[],
  pricing: PricingTable,
  model: string
): PerformanceSummary {
  const measured = observations.filter((observation) => observation.telemetry !== undefined);
  const warm = measured.filter((observation) => observation.warmth !== 'cold');
  const cold = measured.filter((observation) => observation.warmth === 'cold');
  const allCalls = measured.flatMap((observation) => observation.telemetry?.modelCalls ?? []);
  const withTokens = measured.flatMap((observation) => {
    const tokens = turnTokens(observation);
    return tokens ? [{ observation, tokens }] : [];
  });
  const totalOf = (entry: { tokens: TurnTokens }) => entry.tokens.prompt + entry.tokens.output;
  const price = pricing.models[model];
  const turnCost = (entry: { tokens: TurnTokens }) =>
    costUsd({ promptTokens: entry.tokens.prompt, completionTokens: entry.tokens.output, retries: 0 }, price) as number;
  const optionsTurns = withTokens.filter((entry) => entry.observation.terminalKind === 'options');
  const bookedTurns = withTokens.filter((entry) => entry.observation.bookingCompleted === true);

  const stageErrorRate: Record<string, RatioMetric> = {};
  for (const record of measured.flatMap((observation) => observation.telemetry?.stages ?? [])) {
    const current = stageErrorRate[record.stage] ?? { numerator: 0, denominator: 0, value: null };
    const numerator = current.numerator + (record.outcome === 'error' ? 1 : 0);
    const denominator = current.denominator + 1;
    stageErrorRate[record.stage] = { numerator, denominator, value: numerator / denominator };
  }

  const loopStepDistribution: Record<string, number> = {};
  for (const observation of measured) {
    loopStepDistribution[String(observation.loopSteps)] = (loopStepDistribution[String(observation.loopSteps)] ?? 0) + 1;
  }

  return {
    measuredTurns: measured.length,
    stages: summarizeStages(warm),
    coldStages: summarizeStages(cold),
    modelCallLatency: summarizeDurations(
      warm.flatMap((observation) => (observation.telemetry?.stages ?? []).filter((s) => s.stage === 'model.call').map((s) => s.durationMs))
    ),
    turnTotalByTerminal: {
      question: summarizeDurations(warm.filter((o) => o.terminalKind === 'question').flatMap((o) => stageTotal(o, 'turn.total') ?? [])),
      options: summarizeDurations(warm.filter((o) => o.terminalKind === 'options').flatMap((o) => stageTotal(o, 'turn.total') ?? [])),
    },
    bookingTotal: summarizeDurations(measured.flatMap((o) => stageTotal(o, 'booking.total') ?? [])),
    efficiency: {
      meanModelCalls: mean(measured.map((o) => o.telemetry?.modelCalls.length ?? 0)),
      meanToolCalls: mean(measured.map((o) => o.toolNames.length)),
      meanLoopSteps: mean(measured.map((o) => o.loopSteps)),
      loopStepDistribution,
    },
    tokens: {
      modelCalls: allCalls.length,
      callsMissingUsage: allCalls.filter((call) => !hasCompleteUsage(call)).length,
      meanPromptPerTurn: mean(withTokens.map((entry) => entry.tokens.prompt)),
      meanOutputPerTurn: mean(withTokens.map((entry) => entry.tokens.output)),
      meanTotalPerTurn: mean(withTokens.map(totalOf)),
      meanTotalPerOptionsTurn: mean(optionsTurns.map(totalOf)),
      meanTotalPerCompletedBooking: mean(bookedTurns.map(totalOf)),
    },
    cost: price
      ? {
          status: 'priced',
          model,
          source: price.source,
          retrievedOn: price.retrievedOn,
          meanUsdPerTurn: mean(withTokens.map(turnCost)),
          meanUsdPerOptionsTurn: mean(optionsTurns.map(turnCost)),
          meanUsdPerCompletedBooking: mean(bookedTurns.map(turnCost)),
        }
      : { status: 'unavailable', reason: `No price entry for ${model}` },
    retries: allCalls.reduce((sum, call) => sum + call.retries, 0),
    stageErrorRate,
  };
}
