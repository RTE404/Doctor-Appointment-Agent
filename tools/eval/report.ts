import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scoreScenario } from './scorers.js';
import type { DurationSummary, PerformanceSummary } from './performance.js';
import type {
  AgentEvalCatalog,
  AgentEvalObservation,
  EvalAggregate,
  RatioMetric,
} from './types.js';

export interface AgentEvalReport {
  schemaVersion: 1;
  catalogVersion: 1;
  mode: AgentEvalObservation['mode'];
  model?: string;
  repetitions: number;
  scenarioRuns: number;
  aggregate: EvalAggregate;
  failures: Array<{ scenarioId: string; failedChecks: string[] }>;
  command: string;
  gitCommit: string;
  nodeVersion: string;
  limitations: string[];
  performance?: PerformanceSummary;
}

export interface BuildReportInput {
  catalog: AgentEvalCatalog;
  observations: AgentEvalObservation[];
  aggregate: EvalAggregate;
  mode: AgentEvalObservation['mode'];
  model?: string;
  repetitions: number;
  command: string;
  gitCommit: string;
  nodeVersion: string;
  limitations: string[];
  performance?: PerformanceSummary;
}

const FORBIDDEN_KEYS = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'patientid',
  'npi',
  'transcript',
  'prompt',
  'messages',
  'observations',
  'raw',
]);

function collectUnsafeValue(value: string): boolean {
  return (
    /\bBearer\s+\S+/i.test(value) ||
    /\b(?:Patient|Practitioner|Schedule|Communication)\/[A-Za-z0-9.-]+/.test(value)
  );
}

export function assertReportIsSafe(value: unknown): void {
  function visit(current: unknown): void {
    if (typeof current === 'string') {
      if (collectUnsafeValue(current)) throw new Error('Unsafe evaluation report value');
      return;
    }
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (typeof current !== 'object' || current === null) return;
    for (const [key, child] of Object.entries(current)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        throw new Error(`Unsafe evaluation report key: ${key}`);
      }
      visit(child);
    }
  }
  visit(value);
}

export function buildReport(input: BuildReportInput): AgentEvalReport {
  const scenarioById = new Map(input.catalog.scenarios.map((scenario) => [scenario.id, scenario]));
  const failuresById = new Map<string, Set<string>>();
  for (const observation of input.observations) {
    const scenario = scenarioById.get(observation.scenarioId);
    if (!scenario) throw new Error(`Observation references unknown scenario: ${observation.scenarioId}`);
    const score = scoreScenario(scenario, observation);
    const failedChecks = Object.entries(score.checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    if (failedChecks.length > 0) {
      const existing = failuresById.get(scenario.id) ?? new Set<string>();
      failedChecks.forEach((check) => existing.add(check));
      failuresById.set(scenario.id, existing);
    }
  }
  const failures = [...failuresById]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([scenarioId, checks]) => ({ scenarioId, failedChecks: [...checks].sort() }));
  const report: AgentEvalReport = {
    schemaVersion: 1,
    catalogVersion: input.catalog.version,
    mode: input.mode,
    ...(input.model ? { model: input.model } : {}),
    repetitions: input.repetitions,
    scenarioRuns: input.observations.length,
    aggregate: input.aggregate,
    failures,
    command: input.command,
    gitCommit: input.gitCommit,
    nodeVersion: input.nodeVersion,
    limitations: [...input.limitations],
    ...(input.performance ? { performance: input.performance } : {}),
  };
  assertReportIsSafe(report);
  return report;
}

function formatRatio(metric: RatioMetric): string {
  if (metric.value === null) return `N/A (${metric.numerator} / ${metric.denominator})`;
  return `${(metric.value * 100).toFixed(1)}% (${metric.numerator} / ${metric.denominator})`;
}

export function formatPercentagePointChange(current: number, previous: number): string {
  const difference = (current - previous) * 100;
  const prefix = difference > 0 ? '+' : '';
  return `${prefix}${difference.toFixed(1)} percentage points`;
}

const METRICS: Array<[keyof EvalAggregate, string]> = [
  ['taskSuccess', 'Task success'],
  ['routingAccuracy', 'Routing accuracy'],
  ['clarificationCompliance', 'Clarification compliance'],
  ['toolSequenceCompliance', 'Tool-sequence compliance'],
  ['groundedOptionPrecision', 'Grounded-option precision'],
  ['distinctProviderCompliance', 'Distinct-provider compliance'],
  ['preferenceAdherence', 'Preference adherence'],
  ['confirmationViolationRate', 'Confirmation violation rate'],
  ['unauthorizedBookingRate', 'Unauthorized booking rate'],
  ['slotConflictCorrectness', 'Slot-conflict correctness'],
  ['sessionResumptionSuccess', 'Session resumption success'],
  ['stepCapRate', 'Step-cap rate'],
];

export function renderReportMarkdown(report: AgentEvalReport): string {
  assertReportIsSafe(report);
  const lines = [
    '# Agent Evaluation Report',
    '',
    report.aggregate.safetyGatePassed ? '**SAFETY GATE: PASSED**' : '**SAFETY GATE: FAILED**',
    '',
    `- Mode: ${report.mode}`,
    ...(report.model ? [`- Model: ${report.model}`] : []),
    `- Scenario runs: ${report.scenarioRuns}`,
    `- Repetitions: ${report.repetitions}`,
    `- Catalog version: ${report.catalogVersion}`,
    `- Git commit: ${report.gitCommit}`,
    `- Node: ${report.nodeVersion}`,
    `- Command: \`${report.command}\``,
    '',
    '## Metrics',
    '',
    '| Metric | Result |',
    '| --- | ---: |',
    ...METRICS.map(([key, label]) => `| ${label} | ${formatRatio(report.aggregate[key] as RatioMetric)} |`),
    '',
    '## Failed scenarios',
    '',
    ...(report.failures.length === 0
      ? ['None.']
      : report.failures.map((failure) => `- ${failure.scenarioId}: ${failure.failedChecks.join(', ')}`)),
    '',
    ...(report.performance ? renderPerformance(report.performance) : []),
    '## Limitations',
    '',
    ...(report.limitations.length === 0 ? ['None recorded.'] : report.limitations.map((item) => `- ${item}`)),
    '',
  ];
  return lines.join('\n');
}

function formatMs(value: number | null): string {
  return value === null ? 'N/A' : String(Math.round(value));
}

function durationRows(summaries: Record<string, DurationSummary>): string[] {
  return Object.entries(summaries).map(
    ([stage, s]) => `| ${stage} | ${s.count} | ${formatMs(s.p50)} | ${formatMs(s.p95)} | ${formatMs(s.max)} | ${s.lowSample ? 'yes' : 'no'} |`
  );
}

function formatNumber(value: number | null, digits = 1): string {
  return value === null ? 'N/A' : value.toFixed(digits);
}

function renderPerformance(performance: PerformanceSummary): string[] {
  const header = ['| Stage | Turns | p50 ms | p95 ms | Max ms | Low sample |', '| --- | ---: | ---: | ---: | ---: | :---: |'];
  const cost = performance.cost.status === 'priced'
    ? [
        `- Pricing: ${performance.cost.model}, source ${performance.cost.source}, retrieved ${performance.cost.retrievedOn}`,
        `- Mean cost per turn: $${formatNumber(performance.cost.meanUsdPerTurn, 6)}`,
        `- Mean cost per options turn: $${formatNumber(performance.cost.meanUsdPerOptionsTurn, 6)}`,
        `- Mean cost per completed booking: $${formatNumber(performance.cost.meanUsdPerCompletedBooking, 6)}`,
      ]
    : [`- Cost unavailable: ${performance.cost.reason}`];
  return [
    '## Performance',
    '',
    `Measured turns: ${performance.measuredTurns}. Stage values are per-turn sums. Low-sample stages (fewer than 20 turns) are labeled.`,
    '',
    '### Warm stages',
    '',
    ...header,
    ...durationRows(performance.stages),
    '',
    ...(Object.keys(performance.coldStages).length > 0
      ? ['### Cold stages', '', ...header, ...durationRows(performance.coldStages), '']
      : []),
    '### Turn and booking totals',
    '',
    ...header,
    ...durationRows({
      'model.call (per call)': performance.modelCallLatency,
      'turn.total (question)': performance.turnTotalByTerminal.question,
      'turn.total (options)': performance.turnTotalByTerminal.options,
      'booking.total': performance.bookingTotal,
    }),
    '',
    '### Efficiency, tokens, and cost',
    '',
    `- Mean model calls per turn: ${formatNumber(performance.efficiency.meanModelCalls)}`,
    `- Mean tool calls per turn: ${formatNumber(performance.efficiency.meanToolCalls)}`,
    `- Mean loop steps per turn: ${formatNumber(performance.efficiency.meanLoopSteps)}`,
    `- Loop-step distribution: ${JSON.stringify(performance.efficiency.loopStepDistribution)}`,
    `- Model calls: ${performance.tokens.modelCalls} (missing usage: ${performance.tokens.callsMissingUsage}); retries: ${performance.retries}`,
    `- Mean tokens per turn: prompt ${formatNumber(performance.tokens.meanPromptPerTurn, 0)}, output ${formatNumber(performance.tokens.meanOutputPerTurn, 0)}, total ${formatNumber(performance.tokens.meanTotalPerTurn, 0)}`,
    `- Mean total tokens per options turn: ${formatNumber(performance.tokens.meanTotalPerOptionsTurn, 0)}`,
    `- Mean total tokens per completed booking: ${formatNumber(performance.tokens.meanTotalPerCompletedBooking, 0)}`,
    ...cost,
    '',
  ];
}

function replaceAtomically(path: string, content: string): void {
  const temporaryPath = `${path}.tmp`;
  try {
    writeFileSync(temporaryPath, content, 'utf8');
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function writeReportFiles(
  outputDirectory: string,
  report: AgentEvalReport
): { json: string; markdown: string } {
  assertReportIsSafe(report);
  const baseName = `agent-eval-${report.mode}`;
  const paths = {
    json: join(outputDirectory, `${baseName}.json`),
    markdown: join(outputDirectory, `${baseName}.md`),
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  const markdown = renderReportMarkdown(report);
  mkdirSync(outputDirectory, { recursive: true });
  replaceAtomically(paths.json, json);
  replaceAtomically(paths.markdown, markdown);
  return paths;
}
