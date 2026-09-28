# Agent Latency and Cost (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instrument the booking concierge with privacy-safe stage timings and Gemini token usage, publish a latency/cost
baseline from the approved protocol, then (after a separately approved optimization addendum) publish an after-report.

**Architecture:** A dependency-free recorder (`agentTelemetry.ts`) is threaded as an optional parameter through the
booking loop, its tools, the booking handler, and eval executors; `noopTelemetry` is the default so production output
is unchanged. The Gemini caller returns `usage` and a retry count, which the loop records per model call. A pure
`tools/eval/performance.ts` turns per-observation telemetry into per-turn stage sums, nearest-rank percentiles, token
means, and report-time cost from `tools/eval/pricing.json`. The live smoke gains a confirmed booking whose `$book`
request carries the run tag so existing cleanup removes it.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Vitest, Medplum `MedplumClient`, Gemini OpenAI-compatible REST,
`tsx` eval CLI.

**Spec:** `docs/superpowers/specs/2026-09-28-agent-latency-cost-design.md`

## Global Constraints

- Work on `main`; one small commit per task step marked "Commit", staging only that task's files.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- TDD for every behavior change: failing test, run it failing, minimal code, run it passing, commit.
- Telemetry never stores prompts, model responses, tool payloads, FHIR bodies, URLs, error messages, access tokens,
  API keys, headers, patient IDs, practitioner IDs, NPIs, or transcripts.
- `noopTelemetry` is the default at every seam; no production code path changes output when no recorder is passed.
- Deterministic mode records no telemetry; `npm run eval:agent` must stay byte-stable (run it twice, diff the JSON).
- No change to specialty validation, grounding, ranking floors, confirmation, `$book` authority, or validation order in
  `agent-book-appointment.ts`. Booking mutations are never retried.
- Gemini retry applies to HTTP 429, 500, 502, 503, 504 only, schedule `[1_000, 4_000, 16_000, 60_000]` ms plus
  `Math.random() * 250` jitter, four retries maximum.
- Pricing: `gemini-3.5-flash-lite` input $0.30 / 1M tokens, output $2.50 / 1M tokens (paid tier standard; output
  includes thinking tokens), source `https://ai.google.dev/gemini-api/docs/pricing`, retrieved 2026-09-28.
  Billable output tokens = `max(completion_tokens, total_tokens - prompt_tokens)`.
- Stage summaries are **per-turn sums**: for each observation, durations of the same stage are added; percentiles are
  taken across observations in which the stage occurred. Model-call latency is additionally summarized per call.
- Percentiles are nearest-rank; a summary with fewer than 20 samples sets `lowSample: true` and still shows p95.
- Paid Gemini calls and live demo-project writes happen only in Task 12 and the after-report task, and only when the
  human partner has confirmed the run.
- Verification gates before each commit that touches `src/` or `api/`: the task's focused tests; before the final
  commit of each task also `npm test`, `npm run verify:api-esm`, `npm run lint`, `npm run build`.

## Review Focus

- A timed step that resolves to `{ error: ... }` must be recorded as `error/validation`, not `ok` (Task 2); and a `check_availability` call rejected by the provenance gate must record no provider-reconcile or `$find` stage, because no FHIR work ran (Task 4).
- A Gemini response with no `usage` block (or partial usage) must count as "missing usage" and never be estimated or crash the aggregator — pinned in Task 3 and Task 8.
- A recorder whose clock throws must not break or alter the booking turn's result — pinned in Task 2.
- A live booking that returns `slot_taken` must be a handled outcome (no Appointment tracked, `bookingCompleted: false`), not a harness failure — pinned in Task 10.
- A `$book` post from the tracking client must carry the run tag even when the Appointment already has `meta.tag` entries (demo tag present) — pinned in Task 10.

---

### Task 1: Retry transient Gemini 5xx responses

**Files:**
- Modify: `src/bots/agent/agent-booking-chat.ts:29-68`
- Test: `src/bots/agent/agent-booking-chat-gemini.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `callGeminiBookingModel` retries statuses in `RETRYABLE_GEMINI_STATUSES = new Set([429, 500, 502, 503, 504])`.

- [ ] **Step 1: Write the failing tests** — append inside the existing `describe('callGeminiBookingModel', ...)`:

```ts
  test('retries a transient 503 response and returns the next successful completion', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'After overload' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = expect(
      callGeminiBookingModel([{ role: 'user', content: 'Synthetic request' }], 'test-key')
    ).resolves.toMatchObject({ message: { role: 'assistant', content: 'After overload' } });

    await vi.advanceTimersByTimeAsync(1_000);
    await resultPromise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test.each([500, 502, 504])('treats HTTP %i as transient', async (status) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status }));
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = expect(
      callGeminiBookingModel([{ role: 'user', content: 'Synthetic request' }], 'test-key')
    ).rejects.toThrow(`Gemini request failed: ${status}`);

    await vi.advanceTimersByTimeAsync(81_000);
    await resultPromise;
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  test('fails immediately on a non-retryable 400', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      callGeminiBookingModel([{ role: 'user', content: 'Synthetic request' }], 'test-key')
    ).rejects.toThrow('Gemini request failed: 400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/bots/agent/agent-booking-chat-gemini.test.ts`
Expected: the 503 and 500/502/504 tests FAIL (`Gemini request failed: 503` thrown without retry); the 400 test passes.

- [ ] **Step 3: Minimal implementation** — in `agent-booking-chat.ts` rename the constant and widen the status check:

```ts
const GEMINI_RETRY_DELAYS_MS = [1_000, 4_000, 16_000, 60_000] as const;
const RETRYABLE_GEMINI_STATUSES = new Set([429, 500, 502, 503, 504]);
```

and inside `callGeminiBookingModel` replace every `GEMINI_429_RETRY_DELAYS_MS` with `GEMINI_RETRY_DELAYS_MS` and the
throw condition with:

```ts
    if (!RETRYABLE_GEMINI_STATUSES.has(response.status) || attempt === GEMINI_RETRY_DELAYS_MS.length) {
      throw new Error(`Gemini request failed: ${response.status}`);
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/bots/agent/agent-booking-chat-gemini.test.ts`
Expected: all tests PASS (3 existing + 5 new).

- [ ] **Step 5: Gates and commit**

Run: `npm test && npm run verify:api-esm && npm run lint`
```bash
git add src/bots/agent/agent-booking-chat.ts src/bots/agent/agent-booking-chat-gemini.test.ts
git commit -m "fix: retry transient Gemini 5xx responses"
```

---

### Task 2: Privacy-safe telemetry recorder

**Files:**
- Create: `src/bots/agent/lib/agentTelemetry.ts`
- Test: `src/bots/agent/lib/agentTelemetry.test.ts`

**Interfaces:**
- Produces (exact exports used by every later task):

```ts
export const AGENT_STAGES: readonly [
  'turn.total', 'context.load', 'session.load', 'session.create', 'session.persist', 'model.call',
  'tool.previous-search', 'tool.nppes-search', 'tool.provider-reconcile', 'tool.find', 'options.resolve',
  'summary.write', 'booking.total', 'booking.reread', 'booking.find-recheck', 'booking.book', 'booking.link'
];
export type AgentStage = (typeof AGENT_STAGES)[number];
export type StageOutcome = 'ok' | 'error' | 'skipped';
export type StageErrorCategory = 'timeout' | 'http-4xx' | 'http-5xx' | 'validation' | 'unknown';
export interface StageRecord { stage: AgentStage; durationMs: number; outcome: StageOutcome; errorCategory?: StageErrorCategory }
export interface ModelUsageRecord { promptTokens?: number; completionTokens?: number; totalTokens?: number; retries: number }
export interface TelemetrySnapshot { stages: StageRecord[]; modelCalls: ModelUsageRecord[] }
export interface AgentTelemetry {
  time<T>(stage: AgentStage, work: () => Promise<T>, options?: { isErrorResult?: (result: T) => boolean }): Promise<T>;
  recordModelUsage(usage: ModelUsageRecord): void;
  snapshot(): TelemetrySnapshot;
}
export function createAgentTelemetry(clock?: () => number): AgentTelemetry;
export const noopTelemetry: AgentTelemetry;
export function categorizeError(error: unknown): StageErrorCategory;
export function isToolErrorResult(result: unknown): boolean;
```

- [ ] **Step 1: Write the failing tests** — `src/bots/agent/lib/agentTelemetry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  AGENT_STAGES,
  categorizeError,
  createAgentTelemetry,
  isToolErrorResult,
  noopTelemetry,
} from './agentTelemetry';

function fakeClock(...readings: number[]): () => number {
  let index = 0;
  return () => readings[Math.min(index++, readings.length - 1)];
}

describe('createAgentTelemetry', () => {
  it('records an ok stage with the clock-measured duration and returns the result', async () => {
    const telemetry = createAgentTelemetry(fakeClock(10, 35));
    await expect(telemetry.time('model.call', async () => 'value')).resolves.toBe('value');
    expect(telemetry.snapshot().stages).toEqual([{ stage: 'model.call', durationMs: 25, outcome: 'ok' }]);
  });

  it('records a thrown error with a sanitized category and rethrows the original error', async () => {
    const telemetry = createAgentTelemetry(fakeClock(0, 5));
    const original = new Error('Gemini request failed: 503');
    await expect(telemetry.time('model.call', async () => { throw original; })).rejects.toBe(original);
    expect(telemetry.snapshot().stages).toEqual([
      { stage: 'model.call', durationMs: 5, outcome: 'error', errorCategory: 'http-5xx' },
    ]);
  });

  it('records a resolved { error } tool result as a validation error and returns it unchanged', async () => {
    const telemetry = createAgentTelemetry(fakeClock(0, 2));
    const result = { error: 'NPI 1234567890 was not returned by a search' };
    await expect(
      telemetry.time('tool.find', async () => result, { isErrorResult: isToolErrorResult })
    ).resolves.toBe(result);
    expect(telemetry.snapshot().stages[0]).toEqual({
      stage: 'tool.find', durationMs: 2, outcome: 'error', errorCategory: 'validation',
    });
  });

  it('still returns the work result when the clock throws', async () => {
    let calls = 0;
    const telemetry = createAgentTelemetry(() => {
      calls += 1;
      if (calls > 1) throw new Error('clock failure');
      return 0;
    });
    await expect(telemetry.time('session.persist', async () => 42)).resolves.toBe(42);
    expect(telemetry.snapshot().stages).toEqual([]);
  });

  it('records model usage and returns copies from snapshot', () => {
    const telemetry = createAgentTelemetry();
    telemetry.recordModelUsage({ promptTokens: 100, completionTokens: 20, totalTokens: 120, retries: 1 });
    const first = telemetry.snapshot();
    first.modelCalls.push({ retries: 9 });
    expect(telemetry.snapshot().modelCalls).toEqual([
      { promptTokens: 100, completionTokens: 20, totalTokens: 120, retries: 1 },
    ]);
  });

  it('serializes only allowlisted keys and enum string values, whatever the inputs contained', async () => {
    const telemetry = createAgentTelemetry(fakeClock(0, 1, 1, 3, 3, 4));
    await telemetry.time('tool.nppes-search', async () => ({ patientId: 'Patient/abc', npi: '1234567890' }));
    await telemetry.time('model.call', async () => { throw new Error('Bearer secret-token Patient/abc'); }).catch(() => undefined);
    await telemetry.time('tool.find', async () => ({ error: 'Practitioner/xyz transcript text' }), { isErrorResult: isToolErrorResult });
    telemetry.recordModelUsage({ promptTokens: 1, completionTokens: 1, totalTokens: 2, retries: 0 });

    const allowedKeys = new Set(['stages', 'modelCalls', 'stage', 'durationMs', 'outcome', 'errorCategory',
      'promptTokens', 'completionTokens', 'totalTokens', 'retries']);
    const allowedStrings = new Set<string>([...AGENT_STAGES, 'ok', 'error', 'skipped',
      'timeout', 'http-4xx', 'http-5xx', 'validation', 'unknown']);
    JSON.parse(JSON.stringify(telemetry.snapshot()), (key, value) => {
      if (key !== '' && !/^\d+$/.test(key)) expect(allowedKeys.has(key)).toBe(true);
      if (typeof value === 'string') expect(allowedStrings.has(value)).toBe(true);
      return value;
    });
  });
});

describe('categorizeError', () => {
  it('maps error names and statuses to categories without reading other text', () => {
    expect(categorizeError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('timeout');
    expect(categorizeError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(categorizeError(Object.assign(new Error('x'), { status: 404 }))).toBe('http-4xx');
    expect(categorizeError(new Error('Gemini request failed: 429'))).toBe('http-4xx');
    expect(categorizeError(new Error('Gemini request failed: 502'))).toBe('http-5xx');
    expect(categorizeError(new Error('something else'))).toBe('unknown');
    expect(categorizeError('not an error')).toBe('unknown');
  });
});

describe('noopTelemetry', () => {
  it('passes results and errors through and records nothing', async () => {
    await expect(noopTelemetry.time('turn.total', async () => 'x')).resolves.toBe('x');
    await expect(noopTelemetry.time('turn.total', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    noopTelemetry.recordModelUsage({ retries: 0 });
    expect(noopTelemetry.snapshot()).toEqual({ stages: [], modelCalls: [] });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/bots/agent/lib/agentTelemetry.test.ts`
Expected: FAIL — `Failed to resolve import "./agentTelemetry"`.

- [ ] **Step 3: Implementation** — `src/bots/agent/lib/agentTelemetry.ts`:

```ts
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
  const match = /request failed: (\d{3})\b/.exec(error.message);
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
```

Note: `snapshot` round-trips model calls through JSON so `undefined` token fields are dropped, matching the
"records model usage" test's `toEqual`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/bots/agent/lib/agentTelemetry.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bots/agent/lib/agentTelemetry.ts src/bots/agent/lib/agentTelemetry.test.ts
git commit -m "feat: add privacy-safe agent telemetry recorder"
```

---

### Task 3: Capture Gemini usage and time the booking loop

**Files:**
- Modify: `src/bots/agent/agent-booking-chat.ts:25-68` (response type, return usage/retries)
- Modify: `src/bots/agent/lib/bookingChatLoop.ts` (runtime type, timing, usage recording)
- Test: `src/bots/agent/agent-booking-chat-gemini.test.ts`, `src/bots/agent/lib/bookingChatLoop.test.ts`

**Interfaces:**
- Consumes: `AgentTelemetry`, `noopTelemetry`, `ModelUsageRecord` from Task 2.
- Produces:

```ts
// bookingChatLoop.ts
export interface GeminiUsage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
export interface BookingChatModelResponse {
  message: { role: 'assistant'; content: string | null; tool_calls?: BookingToolCall[] };
  usage?: GeminiUsage;
  retries?: number;
}
// BookingChatLoopRuntime.callModel now returns Promise<BookingChatModelResponse>
// BookingChatLoopRuntime gains: telemetry?: AgentTelemetry
// agent-booking-chat.ts: callGeminiBookingModel(...): Promise<BookingChatModelResponse>
```

- [ ] **Step 1: Write the failing Gemini test** — append to `agent-booking-chat-gemini.test.ts`:

```ts
  test('returns Gemini usage and the retry count', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = expect(
      callGeminiBookingModel([{ role: 'user', content: 'Synthetic request' }], 'test-key')
    ).resolves.toEqual({
      message: { role: 'assistant', content: 'ok' },
      usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 },
      retries: 1,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await resultPromise;
  });
```

Also change the two existing success tests' `.resolves.toEqual({ message: ... })` to `.resolves.toMatchObject({ message: ... })`
(they now also receive `retries`).

- [ ] **Step 2: Write the failing loop tests** — first read `src/bots/agent/lib/bookingChatLoop.test.ts` to reuse its
existing session/runtime helpers; then append:

```ts
import { createAgentTelemetry } from './agentTelemetry';

describe('runBookingChatLoop telemetry', () => {
  it('times each model call, records usage, and marks missing usage as absent', async () => {
    const telemetry = createAgentTelemetry();
    const responses = [
      {
        message: { role: 'assistant' as const, content: null, tool_calls: [
          { id: 'c1', type: 'function' as const, function: { name: 'search_nppes', arguments: '{"specialtyCode":"207RC0000X"}' } },
        ] },
        usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
        retries: 0,
      },
      { message: { role: 'assistant' as const, content: 'Which day works?' } },
    ];
    await runBookingChatLoop(
      { communication: { resourceType: 'Communication', id: 'session-1' } as Communication, transcript: [] },
      {
        callModel: async () => responses.shift() as never,
        executeTool: async () => [],
        writeSummary: async () => 'summary-1',
        persist: async () => undefined,
        telemetry,
      }
    );
    const snapshot = telemetry.snapshot();
    expect(snapshot.stages.filter((s) => s.stage === 'model.call')).toHaveLength(2);
    expect(snapshot.stages.some((s) => s.stage === 'session.persist')).toBe(true);
    expect(snapshot.modelCalls).toEqual([
      { promptTokens: 50, completionTokens: 5, totalTokens: 55, retries: 0 },
      { retries: 0 },
    ]);
  });
});
```

(Add `import type { Communication } from '@medplum/fhirtypes';` if the file does not already import it.)

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/bots/agent/agent-booking-chat-gemini.test.ts src/bots/agent/lib/bookingChatLoop.test.ts`
Expected: FAIL — Gemini result lacks `usage`/`retries`; loop test fails on `telemetry` (no stages recorded).

- [ ] **Step 4: Implement in `bookingChatLoop.ts`**

Add near the top:

```ts
import { noopTelemetry } from './agentTelemetry.js';
import type { AgentTelemetry } from './agentTelemetry.js';

export interface GeminiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface BookingChatModelResponse {
  message: { role: 'assistant'; content: string | null; tool_calls?: BookingToolCall[] };
  usage?: GeminiUsage;
  retries?: number;
}
```

Change the runtime interface:

```ts
export interface BookingChatLoopRuntime {
  callModel(transcript: BookingChatMessage[]): Promise<BookingChatModelResponse>;
  executeTool(name: string, args: Record<string, unknown>, transcript: BookingChatMessage[]): Promise<unknown>;
  writeSummary(resolved: Extract<ReturnType<typeof resolveProposedOptions>, { ok: true }>): Promise<string>;
  persist(session: BookingSession, status: 'in-progress' | 'completed' | 'stopped'): Promise<void>;
  onTrace?(event: BookingChatTraceEvent): void;
  telemetry?: AgentTelemetry;
}
```

In `runBookingChatLoop`, first line after `let session = initialSession;`:

```ts
  const telemetry = runtime.telemetry ?? noopTelemetry;
  const persist = (current: BookingSession) =>
    telemetry.time('session.persist', () => runtime.persist(current, 'in-progress'));
```

Replace `const response = await runtime.callModel(session.transcript);` with:

```ts
    const response = await telemetry.time('model.call', () => runtime.callModel(session.transcript));
    telemetry.recordModelUsage({
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
      totalTokens: response.usage?.total_tokens,
      retries: response.retries ?? 0,
    });
```

Replace every `await runtime.persist(session, 'in-progress');` (four occurrences) with `await persist(session);`.
Replace `const resolved = resolveProposedOptions(session.transcript, args as unknown as ProposeOptionsArgs);` with:

```ts
        const resolved = await telemetry.time('options.resolve', async () =>
          resolveProposedOptions(session.transcript, args as unknown as ProposeOptionsArgs)
        );
```

Replace `const summaryCommunicationId = await runtime.writeSummary(resolved);` with:

```ts
        const summaryCommunicationId = await telemetry.time('summary.write', () => runtime.writeSummary(resolved));
```

- [ ] **Step 5: Implement in `agent-booking-chat.ts`**

Remove the local `GeminiToolResponse` interface; import the shared type and use it:

```ts
import type { BookingChatModelResponse } from './lib/bookingChatLoop.js';

type GeminiToolCaller = (transcript: BookingChatMessage[], apiKey: string) => Promise<BookingChatModelResponse>;
```

Change `callGeminiBookingModel`'s return type to `Promise<BookingChatModelResponse>` and its success branch to:

```ts
    if (response.ok) {
      const body = await response.json();
      return { message: body.choices[0].message, usage: body.usage, retries: attempt };
    }
```

- [ ] **Step 6: Fix type fallout in eval executors**

In `tools/eval/modelExecutor.ts` change `EvalModelCaller`'s return type to
`Promise<BookingChatModelResponse>` (import it from `../../src/bots/agent/lib/bookingChatLoop.js`). No other change.

- [ ] **Step 7: Run to verify pass**

Run: `npx vitest run src/bots/agent tools/eval`
Expected: PASS.

- [ ] **Step 8: Gates and commit**

Run: `npm test && npm run verify:api-esm && npm run lint`, then `npm run eval:agent` twice and confirm
`git diff --no-index` of the two `results/evals/agent-eval-deterministic.json` copies is empty (copy the first to the
scratchpad before the second run).
```bash
git add src/bots/agent/lib/bookingChatLoop.ts src/bots/agent/lib/bookingChatLoop.test.ts src/bots/agent/agent-booking-chat.ts src/bots/agent/agent-booking-chat-gemini.test.ts tools/eval/modelExecutor.ts
git commit -m "feat: record Gemini usage and time the booking loop"
```

---

### Task 4: Time the booking chat handler and its tools

**Files:**
- Modify: `src/bots/agent/agent-booking-chat.ts:97-159` (handler, `executeReadOnlyTool`)
- Modify: `src/bots/agent/lib/bookingChatTools.ts:228-271` (`checkAvailabilityTool`)
- Test: `src/bots/agent/agent-booking-chat.test.ts`, `src/bots/agent/lib/bookingChatTools.test.ts`

**Interfaces:**
- Consumes: Task 2 exports; Task 3 loop `telemetry` runtime field.
- Produces:

```ts
export async function handler(
  medplum: MedplumClient,
  event: BotEvent<BookingChatInput>,
  onTrace?: (event: BookingChatTraceEvent) => void,
  telemetry?: AgentTelemetry
): Promise<BookingChatResult>;

export async function checkAvailabilityTool(
  medplum: MedplumClient,
  args: { npi: string; startOffsetDays?: number; windowDays?: number },
  candidate: FoundCandidate,
  telemetry?: AgentTelemetry
): Promise<BookableOption[]>;
```

- [ ] **Step 1: Write the failing tool test** — read `bookingChatTools.test.ts` for its existing `checkAvailabilityTool`
mock setup (it mocks `ensurePractitionerAndSchedule`, `readResource`, and `get`). Add a test that reuses that setup,
passes `createAgentTelemetry()` as the fourth argument, and asserts:

```ts
    const stages = telemetry.snapshot().stages.map((entry) => entry.stage);
    expect(stages).toEqual(['tool.provider-reconcile', 'tool.find']);
```

- [ ] **Step 2: Write the failing handler test** — read `agent-booking-chat.test.ts` for its existing mocked handler run
(it stubs the Gemini caller via `__setGeminiToolCallerForTests` and uses a `MockClient`). Add a test that reuses the
simplest scenario that ends in a clarifying question, passes `undefined` for `onTrace` and `createAgentTelemetry()` as
the fourth argument, and asserts:

```ts
    const stages = telemetry.snapshot().stages.map((entry) => entry.stage);
    expect(stages[0]).toBe('context.load');
    expect(stages).toContain('session.create');
    expect(stages).toContain('model.call');
    expect(stages.at(-1)).toBe('turn.total');
```

and a second test with a model script whose first response calls `check_availability` with an NPI never searched,
asserting no `tool.provider-reconcile` stage is recorded (the provenance gate returns before any timed work).

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/bots/agent/agent-booking-chat.test.ts src/bots/agent/lib/bookingChatTools.test.ts`
Expected: FAIL — no stages recorded.

- [ ] **Step 4: Implement `checkAvailabilityTool` timing** — add the parameter and wrap the two phases:

```ts
import { noopTelemetry } from './agentTelemetry.js';
import type { AgentTelemetry } from './agentTelemetry.js';

export async function checkAvailabilityTool(
  medplum: MedplumClient,
  args: { npi: string; startOffsetDays?: number; windowDays?: number },
  candidate: FoundCandidate,
  telemetry: AgentTelemetry = noopTelemetry
): Promise<BookableOption[]> {
  const { ensured, practitioner, schedule } = await telemetry.time('tool.provider-reconcile', async () => {
    const ensuredResources = await ensurePractitionerAndSchedule(medplum, args.npi, candidate);
    const [practitionerResource, scheduleResource] = await Promise.all([
      medplum.readResource('Practitioner', ensuredResources.practitionerId),
      medplum.readResource('Schedule', ensuredResources.scheduleId),
    ]);
    return { ensured: ensuredResources, practitioner: practitionerResource, schedule: scheduleResource };
  });
```

keep the `doctorName`, `timeZone`, `start`, `end`, and `url` lines unchanged, then replace the `$find` call with:

```ts
  const bundle = await telemetry.time('tool.find', () => medplum.get<Bundle<Appointment>>(url));
```

- [ ] **Step 5: Implement handler timing** — in `agent-booking-chat.ts`:

```ts
import { noopTelemetry } from './lib/agentTelemetry.js';
import type { AgentTelemetry } from './lib/agentTelemetry.js';
```

Give `executeReadOnlyTool` a final `telemetry: AgentTelemetry` parameter and wrap its cases:

```ts
    case 'search_previous_physician':
      return telemetry.time('tool.previous-search', () =>
        searchPreviousPhysicianTool(medplum, patientId, args.specialtyCode as string)
      );
    case 'search_nppes':
      return telemetry.time('tool.nppes-search', async () => {
        const patient = await medplum.readResource('Patient', patientId);
        return searchNppesTool(medplum, patient, args.specialtyCode as string);
      });
```

and in the `check_availability` case pass `telemetry` as the fourth argument of `checkAvailabilityTool`.

Replace the body of `handler` with:

```ts
export async function handler(
  medplum: MedplumClient,
  event: BotEvent<BookingChatInput>,
  onTrace?: (event: BookingChatTraceEvent) => void,
  telemetry: AgentTelemetry = noopTelemetry
): Promise<BookingChatResult> {
  const { patientId, message, sessionId } = event.input;
  const apiKey = event.secrets['GEMINI_API_KEY']?.valueString as string;

  return telemetry.time('turn.total', async () => {
    let session: BookingSession;
    if (sessionId) {
      session = await telemetry.time('session.load', () => loadBookingSession(medplum, sessionId, patientId));
      session = { ...session, transcript: [...session.transcript, { role: 'user', content: message }] };
    } else {
      const context = await telemetry.time('context.load', () => loadPatientClinicalContext(medplum, patientId));
      const initialTranscript: BookingChatMessage[] = [
        { role: 'system', content: BOOKING_CHAT_SYSTEM_PROMPT },
        { role: 'system', content: buildPatientContextMessage(context) },
        { role: 'user', content: message },
      ];
      session = await telemetry.time('session.create', () =>
        createBookingSession(medplum, patientId, initialTranscript)
      );
    }

    return runBookingChatLoop(session, {
      callModel: (transcript) => geminiToolCaller(transcript, apiKey),
      executeTool: (name, args, transcript) =>
        executeReadOnlyTool(medplum, patientId, name, args, transcript, telemetry),
      writeSummary: (resolved) => writeSummaryCommunication(medplum, patientId, resolved),
      persist: (currentSession, status) => persistBookingSession(medplum, currentSession, status),
      onTrace,
      telemetry,
    });
  });
}
```

The search stages record thrown errors through `time`. The provenance-gate `{ error }` return happens before any timed
work, so no stage is recorded for it; the loop's existing `tool-result` trace still marks it `error`.

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run src/bots/agent`
Expected: PASS.

- [ ] **Step 7: Gates and commit**

Run: `npm test && npm run verify:api-esm && npm run lint && npm run build`
```bash
git add src/bots/agent/agent-booking-chat.ts src/bots/agent/agent-booking-chat.test.ts src/bots/agent/lib/bookingChatTools.ts src/bots/agent/lib/bookingChatTools.test.ts
git commit -m "feat: time booking chat handler stages and tools"
```

---

### Task 5: Time the booking handler

**Files:**
- Modify: `src/bots/agent/agent-book-appointment.ts:76-213`
- Test: `src/bots/agent/agent-book-appointment.test.ts`

**Interfaces:**
- Consumes: Task 2 exports.
- Produces: `handler(medplum: MedplumClient, event: BotEvent<BookInput>, telemetry?: AgentTelemetry): Promise<BookResult>`.

- [ ] **Step 1: Write the failing tests** — read `agent-book-appointment.test.ts` for its successful-booking fixture and
its `slot_taken` fixture. Add two tests reusing them, passing `createAgentTelemetry()` as the third argument:

```ts
    // successful booking
    const stages = telemetry.snapshot().stages.map((entry) => entry.stage);
    expect(stages.filter((stage) => stage === 'booking.reread').length).toBeGreaterThanOrEqual(1);
    expect(stages).toContain('booking.find-recheck');
    expect(stages).toContain('booking.book');
    expect(stages).toContain('booking.link');
    expect(stages.at(-1)).toBe('booking.total');
```

```ts
    // slot_taken from $find
    const stages = telemetry.snapshot().stages.map((entry) => entry.stage);
    expect(stages).not.toContain('booking.book');
    expect(telemetry.snapshot().stages.at(-1)).toMatchObject({ stage: 'booking.total', outcome: 'ok' });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/bots/agent/agent-book-appointment.test.ts`
Expected: FAIL — no stages recorded.

- [ ] **Step 3: Implement** — add the imports and parameter; rename the existing body to an inner function so the
validation order is untouched:

```ts
import { noopTelemetry } from './lib/agentTelemetry.js';
import type { AgentTelemetry } from './lib/agentTelemetry.js';

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<BookInput>,
  telemetry: AgentTelemetry = noopTelemetry
): Promise<BookResult> {
  return telemetry.time('booking.total', () => bookWithTelemetry(medplum, event.input, telemetry));
}

async function bookWithTelemetry(medplum: MedplumClient, input: BookInput, telemetry: AgentTelemetry): Promise<BookResult> {
  const { patientId, practitionerId, scheduleId, start, end, summaryCommunicationId } = input;
  const reread = <T>(work: () => Promise<T>): Promise<T> => telemetry.time('booking.reread', work);
  ...existing body...
}
```

Inside the existing body, wrap without reordering:
- the four initial reads: `await reread(() => medplum.readResource('Patient', patientId));` and likewise for
  Practitioner, Schedule, Communication (keep the `const schedule =` / `const summary =` assignments);
- `medplum.searchOne('Device', …)`, `medplum.searchResources('PractitionerRole', …)`, and
  `medplum.searchOne('HealthcareService', …)` each with `reread(() => …)`;
- `const findBundle = await telemetry.time('booking.find-recheck', () => medplum.get<Bundle<Appointment>>(findUrl));`
- the `$book` post: `const response = (await telemetry.time('booking.book', () => medplum.post(...))) as Bundle;`
- the summary update inside the existing try: `await telemetry.time('booking.link', () => medplum.updateResource<Communication>({...}));`

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/bots/agent/agent-book-appointment.test.ts`
Expected: PASS, including all pre-existing tests unchanged.

- [ ] **Step 5: Gates and commit**

Run: `npm test && npm run verify:api-esm && npm run lint`
```bash
git add src/bots/agent/agent-book-appointment.ts src/bots/agent/agent-book-appointment.test.ts
git commit -m "feat: time booking handler stages"
```

---

### Task 6: Request timing log in the execute API

**Files:**
- Modify: `api/execute.ts:71-75` (dependencies), `api/execute.ts:140-212` (wrap `handleExecuteRequest`)
- Test: `api/execute.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ExecuteTimingLog {
  event: 'execute-timing';
  correlationId: string;
  action: ActionName | 'invalid';
  durationMs: number;
  statusClass: '2xx' | '3xx' | '4xx' | '5xx';
}
// ExecuteDependencies gains: log?: (entry: ExecuteTimingLog) => void;
```

- [ ] **Step 1: Write the failing tests** — using the file's existing `createDependencies`/`createHandlers` helpers:

```ts
test('logs one privacy-safe timing entry per POST request', async () => {
  const log = vi.fn();
  const dependencies = { ...createDependencies(createHandlers().handlers), log };
  await handleExecuteRequest(
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer browser-token' },
      body: { action: 'agent-booking-chat', input: { patientId: 'patient-secret-id', message: 'chest pain' } },
    },
    environment,
    dependencies
  );
  expect(log).toHaveBeenCalledTimes(1);
  const entry = log.mock.calls[0][0];
  expect(Object.keys(entry).sort()).toEqual(['action', 'correlationId', 'durationMs', 'event', 'statusClass']);
  expect(entry).toMatchObject({ event: 'execute-timing', action: 'agent-booking-chat', statusClass: '2xx' });
  expect(entry.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.stringify(entry)).not.toMatch(/patient-secret-id|chest pain|browser-token/);
});

test('logs an invalid envelope as action "invalid" and does not log GET health checks', async () => {
  const log = vi.fn();
  const dependencies = { ...createDependencies(createHandlers().handlers), log };
  await handleExecuteRequest({ method: 'GET', headers: {} }, environment, dependencies);
  await handleExecuteRequest(
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: { action: 'not-allowed' } },
    environment,
    dependencies
  );
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0][0]).toMatchObject({ action: 'invalid', statusClass: '4xx' });
});
```

Adapt the Bearer token and body shape to what `createDependencies` authenticates successfully in the existing
`agent-booking-chat` dispatch test in this file.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run api/execute.test.ts`
Expected: FAIL — `log` never called.

- [ ] **Step 3: Implement** — in `api/execute.ts`:

```ts
import { randomUUID } from 'node:crypto';

export interface ExecuteTimingLog {
  event: 'execute-timing';
  correlationId: string;
  action: ActionName | 'invalid';
  durationMs: number;
  statusClass: '2xx' | '3xx' | '4xx' | '5xx';
}
```

Add `log?: (entry: ExecuteTimingLog) => void;` to `ExecuteDependencies`. Rename the existing exported
`handleExecuteRequest` function to `handleExecuteRequestUntimed` (not exported) and add:

```ts
function logExecuteTiming(entry: ExecuteTimingLog): void {
  console.log(JSON.stringify(entry));
}

export async function handleExecuteRequest(
  request: ExecuteRequest,
  environment: ExecuteEnvironment,
  dependencies: ExecuteDependencies = productionDependencies
): Promise<ExecuteResponse> {
  const startedAt = performance.now();
  const response = await handleExecuteRequestUntimed(request, environment, dependencies);
  if (request.method === 'POST') {
    (dependencies.log ?? logExecuteTiming)({
      event: 'execute-timing',
      correlationId: randomUUID(),
      action: parseEnvelope(request.body)?.action ?? 'invalid',
      durationMs: Math.round(performance.now() - startedAt),
      statusClass: `${Math.min(5, Math.max(2, Math.floor(response.status / 100)))}xx` as ExecuteTimingLog['statusClass'],
    });
  }
  return response;
}
```

`productionDependencies` is declared after these functions in the file today; keep the default parameter referencing it
exactly as the original function did.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run api/execute.test.ts`
Expected: PASS, including the ESM compile test.

- [ ] **Step 5: Gates and commit**

Run: `npm test && npm run verify:api-esm && npm run lint`
```bash
git add api/execute.ts api/execute.test.ts
git commit -m "feat: log privacy-safe execute request timing"
```

---

### Task 7: Pricing file and cost calculation

**Files:**
- Create: `tools/eval/pricing.json`, `tools/eval/pricing.ts`
- Test: `tools/eval/pricing.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ModelPrice { inputPerMillionUsd: number; outputPerMillionUsd: number; source: string; retrievedOn: string; notes?: string }
export interface PricingTable { version: 1; models: Record<string, ModelPrice> }
export function loadPricing(path?: string): PricingTable;          // default 'tools/eval/pricing.json'
export function billableOutputTokens(usage: ModelUsageRecord): number | undefined;
export function costUsd(usage: ModelUsageRecord, price: ModelPrice): number | undefined;
```

- [ ] **Step 1: Create `tools/eval/pricing.json`**

```json
{
  "version": 1,
  "models": {
    "gemini-3.5-flash-lite": {
      "inputPerMillionUsd": 0.3,
      "outputPerMillionUsd": 2.5,
      "source": "https://ai.google.dev/gemini-api/docs/pricing",
      "retrievedOn": "2026-09-28",
      "notes": "Paid tier standard pricing; output price includes thinking tokens."
    }
  }
}
```

- [ ] **Step 2: Write the failing tests** — `tools/eval/pricing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { billableOutputTokens, costUsd, loadPricing } from './pricing';

const price = { inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5, source: 'fixture', retrievedOn: '2026-09-28' };

describe('pricing', () => {
  it('loads the checked-in table with a dated source for the evaluated model', () => {
    const table = loadPricing();
    expect(table.version).toBe(1);
    expect(table.models['gemini-3.5-flash-lite']).toMatchObject({ inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5 });
    expect(table.models['gemini-3.5-flash-lite'].retrievedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('bills hidden thinking tokens counted in total but not completion', () => {
    expect(billableOutputTokens({ promptTokens: 100, completionTokens: 10, totalTokens: 150, retries: 0 })).toBe(50);
    expect(billableOutputTokens({ promptTokens: 100, completionTokens: 10, totalTokens: 110, retries: 0 })).toBe(10);
    expect(billableOutputTokens({ completionTokens: 10, retries: 0 })).toBe(10);
    expect(billableOutputTokens({ retries: 0 })).toBeUndefined();
  });

  it('computes cost from prompt and billable output tokens and refuses to estimate missing usage', () => {
    expect(costUsd({ promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000, retries: 0 }, price))
      .toBeCloseTo(2.8, 10);
    expect(costUsd({ completionTokens: 5, retries: 0 }, price)).toBeUndefined();
  });

  it('rejects a malformed table', () => {
    expect(() => loadPricing('tools/eval/pricing.test.ts')).toThrow();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tools/eval/pricing.test.ts`
Expected: FAIL — cannot resolve `./pricing`.

- [ ] **Step 4: Implement `tools/eval/pricing.ts`**

```ts
import { readFileSync } from 'node:fs';

import type { ModelUsageRecord } from '../../src/bots/agent/lib/agentTelemetry.js';

export interface ModelPrice {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  source: string;
  retrievedOn: string;
  notes?: string;
}

export interface PricingTable {
  version: 1;
  models: Record<string, ModelPrice>;
}

export function loadPricing(path = 'tools/eval/pricing.json'): PricingTable {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as PricingTable;
  if (parsed.version !== 1 || typeof parsed.models !== 'object' || parsed.models === null) {
    throw new Error('Invalid pricing table');
  }
  for (const price of Object.values(parsed.models)) {
    if (
      !(price.inputPerMillionUsd >= 0) ||
      !(price.outputPerMillionUsd >= 0) ||
      typeof price.source !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(price.retrievedOn)
    ) {
      throw new Error('Invalid pricing entry');
    }
  }
  return parsed;
}

export function billableOutputTokens(usage: ModelUsageRecord): number | undefined {
  const hiddenInclusive =
    usage.totalTokens !== undefined && usage.promptTokens !== undefined
      ? usage.totalTokens - usage.promptTokens
      : undefined;
  if (usage.completionTokens === undefined) return hiddenInclusive;
  return hiddenInclusive === undefined ? usage.completionTokens : Math.max(usage.completionTokens, hiddenInclusive);
}

export function costUsd(usage: ModelUsageRecord, price: ModelPrice): number | undefined {
  const output = billableOutputTokens(usage);
  if (usage.promptTokens === undefined || output === undefined) return undefined;
  return (usage.promptTokens * price.inputPerMillionUsd + output * price.outputPerMillionUsd) / 1_000_000;
}
```

- [ ] **Step 5: Run to verify pass, then commit**

Run: `npx vitest run tools/eval/pricing.test.ts` — Expected: PASS.
```bash
git add tools/eval/pricing.json tools/eval/pricing.ts tools/eval/pricing.test.ts
git commit -m "feat: add dated Gemini pricing table and cost calculation"
```

---

### Task 8: Performance summary aggregation

**Files:**
- Modify: `tools/eval/types.ts` (observation fields)
- Create: `tools/eval/performance.ts`
- Test: `tools/eval/performance.test.ts`

**Interfaces:**
- Consumes: `TelemetrySnapshot`, `AgentStage` (Task 2); `PricingTable`, `costUsd`, `billableOutputTokens` (Task 7).
- Produces — add to `AgentEvalObservation` in `types.ts`:

```ts
  telemetry?: TelemetrySnapshot;
  warmth?: 'cold' | 'warm';
  bookingCompleted?: boolean;
```

and in `performance.ts`:

```ts
export interface DurationSummary { count: number; p50: number | null; p95: number | null; max: number | null; lowSample: boolean }
export interface PerformanceSummary {
  measuredTurns: number;
  stages: Record<string, DurationSummary>;            // warm (or unlabeled) turns, per-turn sums
  coldStages: Record<string, DurationSummary>;        // cold turns only; {} when none
  modelCallLatency: DurationSummary;                  // per call, warm turns
  turnTotalByTerminal: Record<'question' | 'options', DurationSummary>;
  bookingTotal: DurationSummary;
  efficiency: {
    meanModelCalls: number | null; meanToolCalls: number | null; meanLoopSteps: number | null;
    loopStepDistribution: Record<string, number>;
  };
  tokens: {
    modelCalls: number; callsMissingUsage: number;
    meanPromptPerTurn: number | null; meanOutputPerTurn: number | null; meanTotalPerTurn: number | null;
    meanTotalPerOptionsTurn: number | null; meanTotalPerCompletedBooking: number | null;
  };
  cost:
    | { status: 'priced'; model: string; source: string; retrievedOn: string;
        meanUsdPerTurn: number | null; meanUsdPerOptionsTurn: number | null; meanUsdPerCompletedBooking: number | null }
    | { status: 'unavailable'; reason: string };
  retries: number;
  stageErrorRate: Record<string, RatioMetric>;
}
export function nearestRank(sortedValues: number[], percentile: number): number | null;
export function summarizeDurations(values: number[]): DurationSummary;
export function summarizePerformance(observations: AgentEvalObservation[], pricing: PricingTable, model: string): PerformanceSummary;
```

- [ ] **Step 1: Add the observation fields to `types.ts`** (with `import type { TelemetrySnapshot } from '../../src/bots/agent/lib/agentTelemetry.js';`).

- [ ] **Step 2: Write the failing tests** — `tools/eval/performance.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { nearestRank, summarizeDurations, summarizePerformance } from './performance';
import type { AgentEvalObservation } from './types';

const pricing = {
  version: 1 as const,
  models: { 'gemini-3.5-flash-lite': { inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5, source: 'fixture', retrievedOn: '2026-09-28' } },
};

function observation(overrides: Partial<AgentEvalObservation>): AgentEvalObservation {
  return {
    scenarioId: 's', mode: 'model', repetition: 1, terminalKind: 'options', toolNames: [], loopSteps: 1,
    displayedOptions: [], availableOptionKeys: [], searchedProviderAliases: [], clarificationAsked: false,
    confirmationRequested: false, bookingMutationCount: 0, bookingMutationCountBeforeConfirmation: 0,
    crossPatientSessionAccepted: false, duplicateAppointmentCount: 0, slotConflictRejected: false, sessionResumed: false,
    ...overrides,
  };
}

describe('nearestRank', () => {
  it('uses the nearest-rank method', () => {
    const values = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(nearestRank(values, 50)).toBe(10);
    expect(nearestRank(values, 95)).toBe(19);
    expect(nearestRank([7], 95)).toBe(7);
    expect(nearestRank([], 50)).toBeNull();
  });
});

describe('summarizeDurations', () => {
  it('labels fewer than 20 samples as low-sample but still reports p95', () => {
    expect(summarizeDurations([30, 10, 20])).toEqual({ count: 3, p50: 20, p95: 30, max: 30, lowSample: true });
    expect(summarizeDurations([])).toEqual({ count: 0, p50: null, p95: null, max: null, lowSample: true });
  });
});

describe('summarizePerformance', () => {
  it('sums a stage within a turn, separates cold turns, and splits turn totals by terminal kind', () => {
    const summary = summarizePerformance(
      [
        observation({ warmth: 'cold', telemetry: { stages: [{ stage: 'model.call', durationMs: 900, outcome: 'ok' }], modelCalls: [] } }),
        observation({
          warmth: 'warm',
          terminalKind: 'options',
          telemetry: {
            stages: [
              { stage: 'model.call', durationMs: 100, outcome: 'ok' },
              { stage: 'model.call', durationMs: 150, outcome: 'ok' },
              { stage: 'tool.find', durationMs: 40, outcome: 'error', errorCategory: 'http-5xx' },
              { stage: 'turn.total', durationMs: 400, outcome: 'ok' },
            ],
            modelCalls: [],
          },
        }),
      ],
      pricing,
      'gemini-3.5-flash-lite'
    );
    expect(summary.stages['model.call']).toMatchObject({ count: 1, p50: 250 });
    expect(summary.coldStages['model.call']).toMatchObject({ count: 1, p50: 900 });
    expect(summary.modelCallLatency).toMatchObject({ count: 2, max: 150 });
    expect(summary.turnTotalByTerminal.options).toMatchObject({ count: 1, p50: 400 });
    expect(summary.turnTotalByTerminal.question.count).toBe(0);
    expect(summary.stageErrorRate['tool.find']).toEqual({ numerator: 1, denominator: 1, value: 1 });
  });

  it('averages tokens only over turns with complete usage and counts missing usage', () => {
    const summary = summarizePerformance(
      [
        observation({ telemetry: { stages: [], modelCalls: [
          { promptTokens: 1000, completionTokens: 100, totalTokens: 1100, retries: 1 },
          { promptTokens: 2000, completionTokens: 100, totalTokens: 2100, retries: 0 },
        ] } }),
        observation({ terminalKind: 'question', telemetry: { stages: [], modelCalls: [{ retries: 0 }] } }),
      ],
      pricing,
      'gemini-3.5-flash-lite'
    );
    expect(summary.tokens).toMatchObject({ modelCalls: 3, callsMissingUsage: 1, meanPromptPerTurn: 3000, meanOutputPerTurn: 200, meanTotalPerTurn: 3200, meanTotalPerOptionsTurn: 3200 });
    expect(summary.retries).toBe(1);
    expect(summary.cost).toMatchObject({ status: 'priced', meanUsdPerTurn: (3000 * 0.3 + 200 * 2.5) / 1_000_000 });
  });

  it('reports cost as unavailable, not zero, when the model has no price entry', () => {
    const summary = summarizePerformance([observation({})], pricing, 'unknown-model');
    expect(summary.cost).toEqual({ status: 'unavailable', reason: 'No price entry for unknown-model' });
  });

  it('reports tokens per completed booking only from turns whose booking completed', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15, retries: 0 };
    const summary = summarizePerformance(
      [
        observation({ mode: 'live-smoke', bookingCompleted: true, telemetry: { stages: [{ stage: 'booking.total', durationMs: 700, outcome: 'ok' }], modelCalls: [usage] } }),
        observation({ mode: 'live-smoke', bookingCompleted: false, telemetry: { stages: [], modelCalls: [usage, usage] } }),
      ],
      pricing,
      'gemini-3.5-flash-lite'
    );
    expect(summary.tokens.meanTotalPerCompletedBooking).toBe(15);
    expect(summary.bookingTotal).toMatchObject({ count: 1, p50: 700 });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tools/eval/performance.test.ts`
Expected: FAIL — cannot resolve `./performance`.

- [ ] **Step 4: Implement `tools/eval/performance.ts`**

```ts
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
```

Note: `turnCost` passes the already-billable output as `completionTokens` with no `totalTokens`, so
`billableOutputTokens` returns it unchanged.

- [ ] **Step 5: Run to verify pass, then commit**

Run: `npx vitest run tools/eval/performance.test.ts tools/eval` — Expected: PASS.
```bash
git add tools/eval/types.ts tools/eval/performance.ts tools/eval/performance.test.ts
git commit -m "feat: summarize eval latency, tokens, and cost"
```

---

### Task 9: Report performance and wire the model executor

**Files:**
- Modify: `tools/eval/report.ts` (report field, Markdown section)
- Modify: `tools/eval/runAgentEval.ts:175-195` (compute performance for non-deterministic modes)
- Modify: `tools/eval/modelExecutor.ts:82-175` (per-scenario telemetry)
- Test: `tools/eval/report.test.ts`, `tools/eval/modelExecutor.test.ts`

**Interfaces:**
- Consumes: `PerformanceSummary`, `summarizePerformance` (Task 8); `loadPricing` (Task 7); `createAgentTelemetry` (Task 2).
- Produces: `AgentEvalReport.performance?: PerformanceSummary`; `BuildReportInput.performance?: PerformanceSummary`;
  model observations carry `telemetry`.

- [ ] **Step 1: Write the failing report tests** — in `report.test.ts`, reuse the file's existing `buildReport` input
fixture and add:

```ts
  it('includes a performance section when supplied and keeps it privacy-safe', () => {
    const performance = summarizePerformance(
      [{ ...observations[0], telemetry: { stages: [{ stage: 'model.call', durationMs: 120, outcome: 'ok' }], modelCalls: [{ promptTokens: 10, completionTokens: 2, totalTokens: 12, retries: 0 }] } }],
      { version: 1, models: { 'gemini-3.5-flash-lite': { inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5, source: 'fixture', retrievedOn: '2026-09-28' } } },
      'gemini-3.5-flash-lite'
    );
    const report = buildReport({ ...input, performance });
    expect(report.performance?.stages['model.call'].p50).toBe(120);
    const markdown = renderReportMarkdown(report);
    expect(markdown).toContain('## Performance');
    expect(markdown).toContain('| model.call | 1 | 120 | 120 | 120 | yes |');
    expect(markdown).toContain('Low-sample stages (fewer than 20 turns) are labeled');
  });

  it('omits the performance section when absent', () => {
    expect(renderReportMarkdown(buildReport(input))).not.toContain('## Performance');
  });
```

(Import `summarizePerformance` from `./performance`; `observations` and `input` are the names of the existing fixtures —
rename in the test if the file uses different names.)

- [ ] **Step 2: Write the failing model-executor test** — in `modelExecutor.test.ts`, reuse the existing scripted
`callModel` test and add an assertion that the returned observation has
`observation.telemetry?.stages.some((s) => s.stage === 'model.call') === true` and
`observation.telemetry?.modelCalls.length` equal to the number of scripted model responses.

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tools/eval/report.test.ts tools/eval/modelExecutor.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement report changes** — in `report.ts`:

```ts
import type { DurationSummary, PerformanceSummary } from './performance.js';
```

Add `performance?: PerformanceSummary;` to both `AgentEvalReport` and `BuildReportInput`; in `buildReport` add
`...(input.performance ? { performance: input.performance } : {}),` after `limitations`. Add:

```ts
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
```

In `renderReportMarkdown`, insert `...(report.performance ? renderPerformance(report.performance) : []),` immediately
before `'## Limitations'`.

- [ ] **Step 5: Implement executor and runner changes**

`modelExecutor.ts`: `import { createAgentTelemetry } from '../../src/bots/agent/lib/agentTelemetry.js';`; in
`executeModelScenario` create `const telemetry = createAgentTelemetry();` before `runBookingChatLoop`, add `telemetry,`
to the runtime object, and add `telemetry: telemetry.snapshot(),` to the returned observation.

`runAgentEval.ts`: `import { summarizePerformance } from './performance.js';` and `import { loadPricing } from './pricing.js';`.
Before `buildReport`, add:

```ts
  const model = 'gemini-3.5-flash-lite';
  const performance =
    options.mode === 'deterministic' ? undefined : summarizePerformance(result.observations, loadPricing(), model);
```

use `model` in the existing `...(options.mode !== 'deterministic' ? { model } : {})`, and pass
`...(performance ? { performance } : {})` into `buildReport`.

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run tools/eval`
Expected: PASS.

- [ ] **Step 7: Byte-stability check and commit**

Run `npm run eval:agent`, copy `results/evals/agent-eval-deterministic.json` to the scratchpad, run it again, and
`git diff --no-index <copy> results/evals/agent-eval-deterministic.json` — expected: no output.
Run: `npm test && npm run lint`
```bash
git add tools/eval/report.ts tools/eval/report.test.ts tools/eval/runAgentEval.ts tools/eval/modelExecutor.ts tools/eval/modelExecutor.test.ts
git commit -m "feat: report agent performance for model and live evals"
```

---

### Task 10: Live smoke telemetry and confirmed booking

**Files:**
- Modify: `tools/eval/liveSmokeExecutor.ts`
- Test: `tools/eval/liveSmokeExecutor.test.ts`

**Interfaces:**
- Consumes: Task 2 recorder; Task 4 `bookingChatHandler(client, event, onTrace, telemetry)`; Task 5
  `bookAppointmentHandler(client, event, telemetry)`; Task 8 observation fields.
- Produces (exported for tests):

```ts
export interface BookingMutationCounter { count: number }
export function createTrackingClient(client: MedplumClient, plan: LiveSmokeCleanupPlan, counter: BookingMutationCounter): MedplumClient;
export async function confirmAndBookTopOption(
  client: MedplumClient,
  input: { patientId: string; option: BookableOption; summaryCommunicationId: string },
  plan: LiveSmokeCleanupPlan,
  counter: BookingMutationCounter,
  telemetry: AgentTelemetry,
  book?: typeof bookAppointmentHandler
): Promise<{ confirmationRequested: true; bookingCompleted: boolean; mutationsBeforeConfirmation: number }>;
// LiveSmokeRunResult gains: telemetry?: TelemetrySnapshot; bookingCompleted?: boolean;
//   confirmationRequested?: boolean; bookingMutationCount?: number; bookingMutationCountBeforeConfirmation?: number;
```

- [ ] **Step 1: Write the failing tests** — append to `liveSmokeExecutor.test.ts`:

```ts
import { createAgentTelemetry } from '../../src/bots/agent/lib/agentTelemetry';
import { confirmAndBookTopOption, createTrackingClient } from './liveSmokeExecutor';

const option = {
  id: 'o1', npi: '1234567890', practitionerId: 'pr-1', scheduleId: 'sc-1', doctorName: 'Dr. Synthetic',
  start: '2026-10-05T13:00:00.000Z', end: '2026-10-05T13:30:00.000Z', timeZone: 'America/New_York', previousDoctor: false,
};

describe('live smoke booking', () => {
  it('tags the $book appointment with the run tag, keeping existing tags, and counts the mutation', async () => {
    const post = vi.fn(async () => ({}));
    const fake = { post, createResource: vi.fn(), fhirUrl: (...parts: string[]) => new URL(`https://x.test/fhir/R4/${parts.join('/')}`) };
    const counter = { count: 0 };
    const plan = { runTagCode: 'agent-eval-run', resources: [] };
    const client = createTrackingClient(fake as never, plan, counter);
    await client.post(fake.fhirUrl('Appointment', '$book'), {
      resourceType: 'Parameters',
      parameter: [{ name: 'appointment', resource: { resourceType: 'Appointment', meta: { tag: [{ system: 'demo', code: 'demo-generated' }] } } }],
    });
    const sent = post.mock.calls[0][1] as { parameter: Array<{ resource: { meta: { tag: Array<{ system: string; code: string }> } } }> };
    expect(sent.parameter[0].resource.meta.tag).toEqual(
      expect.arrayContaining([
        { system: 'demo', code: 'demo-generated' },
        { system: 'https://doctor-appointment-agent.example/fhir/eval-run', code: 'agent-eval-run' },
      ])
    );
    expect(counter.count).toBe(1);
  });

  it('tracks a booked appointment for cleanup after the confirmation step', async () => {
    const plan = { runTagCode: 'agent-eval-run', resources: [] as Array<{ resourceType: 'Appointment' | 'Communication' | 'Encounter'; id: string }> };
    const counter = { count: 0 };
    const book = vi.fn(async () => {
      counter.count += 1;
      return { ok: true as const, appointment: { resourceType: 'Appointment' as const, id: 'appt-1', status: 'booked' as const, participant: [] } };
    });
    const result = await confirmAndBookTopOption({} as never, { patientId: 'p', option, summaryCommunicationId: 'c' }, plan, counter, createAgentTelemetry(), book as never);
    expect(result).toEqual({ confirmationRequested: true, bookingCompleted: true, mutationsBeforeConfirmation: 0 });
    expect(plan.resources).toEqual([{ resourceType: 'Appointment', id: 'appt-1' }]);
  });

  it('handles slot_taken without tracking an appointment', async () => {
    const plan = { runTagCode: 'agent-eval-run', resources: [] };
    const book = vi.fn(async () => ({ ok: false as const, reason: 'slot_taken' as const }));
    const result = await confirmAndBookTopOption({} as never, { patientId: 'p', option, summaryCommunicationId: 'c' }, plan, { count: 0 }, createAgentTelemetry(), book as never);
    expect(result.bookingCompleted).toBe(false);
    expect(plan.resources).toEqual([]);
  });

  it('labels the first executed scenario cold and later ones warm, and passes booking counters through', async () => {
    const deps = dependencies({
      run: vi.fn(async (): Promise<LiveSmokeRunResult> => ({
        terminalKind: 'options', toolNames: [], loopSteps: 1, displayedOptions: [], availableOptionKeys: [],
        searchedProviderAliases: [], clarificationAsked: false, sessionResumed: true,
        confirmationRequested: true, bookingCompleted: true, bookingMutationCount: 1, bookingMutationCountBeforeConfirmation: 0,
      })),
    });
    const executor = createLiveSmokeExecutor(environment, deps);
    const [first] = [...LIVE_SMOKE_SCENARIO_IDS];
    const one = await executor.execute(scenario(first), 1);
    const two = await executor.execute(scenario(first), 2);
    expect(one.warmth).toBe('cold');
    expect(two.warmth).toBe('warm');
    expect(one).toMatchObject({ confirmationRequested: true, bookingCompleted: true, bookingMutationCount: 1, bookingMutationCountBeforeConfirmation: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tools/eval/liveSmokeExecutor.test.ts`
Expected: FAIL — `createTrackingClient`/`confirmAndBookTopOption` not exported; `warmth` undefined.

- [ ] **Step 3: Implement** — in `liveSmokeExecutor.ts`:

1. Imports:

```ts
import { handler as bookAppointmentHandler } from '../../src/bots/agent/agent-book-appointment.js';
import { createAgentTelemetry } from '../../src/bots/agent/lib/agentTelemetry.js';
import type { AgentTelemetry, TelemetrySnapshot } from '../../src/bots/agent/lib/agentTelemetry.js';
```

2. Extend `LiveSmokeRunResult` with the optional fields listed under Interfaces.

3. Replace `trackingClient` with an exported `createTrackingClient` that adds `$book` handling:

```ts
export interface BookingMutationCounter {
  count: number;
}

function isBookUrl(url: unknown): boolean {
  return String(url).endsWith('/Appointment/$book');
}

export function createTrackingClient(client: MedplumClient, plan: LiveSmokeCleanupPlan, counter: BookingMutationCounter): MedplumClient {
  const activityTypes = new Set<ActivityResourceType>(['Appointment', 'Communication', 'Encounter']);
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'createResource') {
        return async (resource: Resource): Promise<Resource> => {
          const created = await target.createResource(addRunTags(resource, plan.runTagCode));
          if (created.id && activityTypes.has(created.resourceType as ActivityResourceType)) {
            plan.resources.push({ resourceType: created.resourceType as ActivityResourceType, id: created.id });
          }
          return created;
        };
      }
      if (property === 'post') {
        return async (url: URL | string, body: unknown, ...rest: unknown[]): Promise<unknown> => {
          if (!isBookUrl(url)) {
            return (target.post as (...args: unknown[]) => Promise<unknown>).call(target, url, body, ...rest);
          }
          const parameters = body as { parameter?: Array<{ name: string; resource?: Resource }> };
          const tagged = {
            ...parameters,
            parameter: (parameters.parameter ?? []).map((parameter) =>
              parameter.resource ? { ...parameter, resource: addRunTags(parameter.resource, plan.runTagCode) } : parameter
            ),
          };
          counter.count += 1;
          return (target.post as (...args: unknown[]) => Promise<unknown>).call(target, url, tagged, ...rest);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as MedplumClient;
}
```

Note `addRunTags` applies `withDemoGeneratedTag` too; the booking handler already set the demo tag, so this is
idempotent.

4. Add:

```ts
export async function confirmAndBookTopOption(
  client: MedplumClient,
  input: { patientId: string; option: BookableOption; summaryCommunicationId: string },
  plan: LiveSmokeCleanupPlan,
  counter: BookingMutationCounter,
  telemetry: AgentTelemetry,
  book: typeof bookAppointmentHandler = bookAppointmentHandler
): Promise<{ confirmationRequested: true; bookingCompleted: boolean; mutationsBeforeConfirmation: number }> {
  // Explicit confirmation step: nothing may have been booked before this point.
  const mutationsBeforeConfirmation = counter.count;
  const result = await book(
    client,
    {
      bot: { identifier: { system: 'http://example.com', value: 'agent-book-appointment' } },
      contentType: 'application/json',
      input: {
        patientId: input.patientId,
        practitionerId: input.option.practitionerId,
        scheduleId: input.option.scheduleId,
        start: input.option.start,
        end: input.option.end,
        summaryCommunicationId: input.summaryCommunicationId,
      },
      secrets: {},
    },
    telemetry
  );
  if (result.ok && result.appointment.id) {
    plan.resources.push({ resourceType: 'Appointment', id: result.appointment.id });
  }
  return { confirmationRequested: true, bookingCompleted: result.ok, mutationsBeforeConfirmation };
}
```

5. In `runProduction`: create `const telemetry = createAgentTelemetry();` and `const counter = { count: 0 };`, build the
client with `createTrackingClient(session.worker, plan, counter)`, call
`bookingChatHandler(client, event, (traceEvent) => trace.push(traceEvent), telemetry)`, and after the specialty read:

```ts
  let booking: Awaited<ReturnType<typeof confirmAndBookTopOption>> | undefined;
  if (result.kind === 'options' && result.options.length > 0) {
    booking = await confirmAndBookTopOption(
      client,
      { patientId: session.syntheticPatientId, option: result.options[0], summaryCommunicationId: result.summaryCommunicationId },
      plan,
      counter,
      telemetry
    );
  }
```

and add to the returned object:

```ts
    telemetry: telemetry.snapshot(),
    confirmationRequested: booking?.confirmationRequested ?? false,
    bookingCompleted: booking?.bookingCompleted ?? false,
    bookingMutationCount: counter.count,
    bookingMutationCountBeforeConfirmation: booking?.mutationsBeforeConfirmation ?? counter.count,
```

6. In `createLiveSmokeExecutor`: add `let executed = 0;` beside `sessionPromise`; in `execute` compute
`const warmth = executed === 0 ? 'cold' : 'warm'; executed += 1;` before running; replace the hard-coded booking fields
in the returned observation with:

```ts
          warmth,
          confirmationRequested: result.confirmationRequested ?? false,
          bookingMutationCount: result.bookingMutationCount ?? 0,
          bookingMutationCountBeforeConfirmation: result.bookingMutationCountBeforeConfirmation ?? 0,
          bookingCompleted: result.bookingCompleted ?? false,
```

keeping `crossPatientSessionAccepted: false, duplicateAppointmentCount: 0, slotConflictRejected: false`, and spreading
`...result` before these fields so they win.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tools/eval`
Expected: PASS, including the existing live-smoke tests (the cleanup-plan and config tests are unaffected).

- [ ] **Step 5: Gates and commit**

Run: `npm test && npm run verify:api-esm && npm run lint && npm run build`
```bash
git add tools/eval/liveSmokeExecutor.ts tools/eval/liveSmokeExecutor.test.ts
git commit -m "feat: time live smoke turns and book the top option after confirmation"
```

---

### Task 11: Verify tag preservation on one live booking

A single live check that `$book` keeps the run tag, before spending the full baseline budget. This is a paid,
demo-writing run: ask the human partner to confirm before Step 1.

- [ ] **Step 1: Run one live scenario once**

Run (with `<scratchpad>` = the session scratchpad directory): `npx tsx tools/eval/runAgentEval.ts --mode live-smoke --repetitions 1 --scenario routing-cardiology-explicit --output <scratchpad>/tagcheck`
Expected: exit 0 and a report. If the run fails with `Live smoke cleanup failed` or
`Live smoke cleanup refused an untagged resource`, STOP: `$book` did not preserve the run tag. Report to the human
partner; do not weaken the cleanup check (spec §5). Note: if the scenario ends in a question instead of options, no
booking is attempted — rerun with `--scenario routing-generalpractice-explicit`; if neither yields options, report that.

- [ ] **Step 2: Confirm the report shows a booking**

In `<scratchpad>/tagcheck/agent-eval-live-smoke.md`, the Performance section's `booking.total` row has Turns `1`.
No commit (scratchpad output only).

---

### Task 12: Publish the baseline

Paid, demo-writing runs. Confirm with the human partner before Step 1.

- [ ] **Step 1: Model layer** — Run: `npm run eval:agent:model`. Copy `results/evals/agent-eval-model.md` to the
scratchpad as `baseline-model.md`.

- [ ] **Step 2: Live layer** — Run: `npm run eval:agent:smoke -- --repetitions 5`. Copy
`results/evals/agent-eval-live-smoke.md` to the scratchpad as `baseline-live.md`.

- [ ] **Step 3: Privacy scan** — Run:
`grep -n -i -E "[0-9a-f]{8}-[0-9a-f]{4}-|bearer|secret|token=|npi|Patient/|Practitioner/" results/evals/agent-eval-model.json results/evals/agent-eval-live-smoke.json`
Expected: no output (the `tokens` object keys contain "token" but not `token=`).

- [ ] **Step 4: Write `docs/metrics/agent-performance-baseline.md`** with: commit, date, Node version, machine note,
exact commands, pricing source and date, both layers' Performance tables copied verbatim from the reports, both layers'
safety-gate status and task success, a stage ranking (live warm stages by p95 per-turn sum, and model-layer prompt
tokens per turn), and a "What these numbers do not mean" section (live n=40 is small; cold turns separated; model-layer
tool timings are stubs).

- [ ] **Step 5: Commit**

```bash
git add docs/metrics/agent-performance-baseline.md
git commit -m "docs: publish agent latency and cost baseline"
```

- [ ] **Step 6: Checkpoint** — present the stage ranking and the proposed optimizations (spec §6) to the human partner.
Implementation of any optimization waits for their approval and a short plan addendum
(`docs/superpowers/plans/2026-09-28-agent-latency-cost-optimizations.md`) written from the actual baseline numbers.

---

### Task 13: After-report (runs after the approved optimization addendum is implemented)

- [ ] **Step 1:** Re-run Task 12 Steps 1–3 unchanged (same commands, repetitions, machine).
- [ ] **Step 2:** Write `docs/metrics/agent-performance-after.md` comparing against the baseline for live p95
  `turn.total (options)`, mean total tokens and cost per options turn and per completed booking, mean tool calls, and
  step-cap rate — each with absolute change, percentage-point change where a rate, and relative change — plus both
  layers' safety gates and task success. State plainly any ≥20% target that was not met.
- [ ] **Step 3:** Update `IMPROVEMENT_PLAN.md` Phase 2 status with verified results only.
- [ ] **Step 4: Commit**

```bash
git add docs/metrics/agent-performance-after.md IMPROVEMENT_PLAN.md
git commit -m "docs: publish agent latency and cost after-report"
```
