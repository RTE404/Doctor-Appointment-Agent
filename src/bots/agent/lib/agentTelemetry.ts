// src/bots/agent/lib/agentTelemetry.ts
// Privacy-safe stage timing and model-usage recording. Records hold only a
// stage name, a duration, an outcome, an error category, and token counts —
// never text, identifiers, URLs, or payloads.

export const AGENT_STAGES = [
  'turn.total',
  'context.load',
  'session.load',
  'session.create',
  'session.persist',
  'model.call',
  'tool.previous-search',
  'tool.nppes-search',
  'tool.provider-reconcile',
  'tool.find',
  'options.resolve',
  'summary.write',
  'booking.total',
  'booking.reread',
  'booking.find-recheck',
  'booking.book',
  'booking.link',
] as const;

export type AgentStage = (typeof AGENT_STAGES)[number];
export type StageOutcome = 'ok' | 'error' | 'skipped';
export type StageErrorCategory = 'timeout' | 'http-4xx' | 'http-5xx' | 'validation' | 'unknown';

export interface StageRecord {
  stage: AgentStage;
  durationMs: number;
  outcome: StageOutcome;
  errorCategory?: StageErrorCategory;
}

export interface ModelUsageRecord {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  retries: number;
}

export interface TelemetrySnapshot {
  stages: StageRecord[];
  modelCalls: ModelUsageRecord[];
}

export interface AgentTelemetry {
  time<T>(stage: AgentStage, work: () => Promise<T>, options?: { isErrorResult?: (result: T) => boolean }): Promise<T>;
  recordModelUsage(usage: ModelUsageRecord): void;
  snapshot(): TelemetrySnapshot;
}

function statusCategory(status: number): StageErrorCategory {
  if (status >= 400 && status < 500) return 'http-4xx';
  if (status >= 500 && status < 600) return 'http-5xx';
  return 'unknown';
}

export function categorizeError(error: unknown): StageErrorCategory {
  if (!(error instanceof Error)) return 'unknown';
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'timeout';
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') return statusCategory(status);
  const match = /failed: (\d{3})\b/.exec(error.message);
  return match ? statusCategory(Number(match[1])) : 'unknown';
}

export function isToolErrorResult(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'error' in result;
}

function numberOrUndefined(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function createAgentTelemetry(clock: () => number = () => performance.now()): AgentTelemetry {
  const stages: StageRecord[] = [];
  const modelCalls: ModelUsageRecord[] = [];

  function record(stage: AgentStage, startedAt: number | undefined, outcome: StageOutcome, errorCategory?: StageErrorCategory): void {
    try {
      if (startedAt === undefined) return;
      const durationMs = Math.max(0, clock() - startedAt);
      stages.push(errorCategory ? { stage, durationMs, outcome, errorCategory } : { stage, durationMs, outcome });
    } catch {
      // Telemetry must never affect the agent path.
    }
  }

  return {
    async time<T>(
      stage: AgentStage,
      work: () => Promise<T>,
      options?: { isErrorResult?: (result: T) => boolean }
    ): Promise<T> {
      let startedAt: number | undefined;
      try {
        startedAt = clock();
      } catch {
        startedAt = undefined;
      }
      let result: T;
      try {
        result = await work();
      } catch (error) {
        record(stage, startedAt, 'error', categorizeError(error));
        throw error;
      }
      let isError = false;
      try {
        isError = options?.isErrorResult?.(result) === true;
      } catch {
        isError = false;
      }
      record(stage, startedAt, isError ? 'error' : 'ok', isError ? 'validation' : undefined);
      return result;
    },
    recordModelUsage(usage) {
      modelCalls.push({
        promptTokens: numberOrUndefined(usage.promptTokens),
        completionTokens: numberOrUndefined(usage.completionTokens),
        totalTokens: numberOrUndefined(usage.totalTokens),
        retries: usage.retries,
      });
    },
    snapshot() {
      return {
        stages: stages.map((entry) => ({ ...entry })),
        modelCalls: modelCalls.map((entry) => JSON.parse(JSON.stringify(entry)) as ModelUsageRecord),
      };
    },
  };
}

export const noopTelemetry: AgentTelemetry = {
  time: (_stage, work) => work(),
  recordModelUsage: () => undefined,
  snapshot: () => ({ stages: [], modelCalls: [] }),
};
