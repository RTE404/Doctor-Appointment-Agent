# Agent Latency and Cost (Phase 2) — Design

## Objective

Measure where the Patient Appointment Concierge spends time and model tokens, optimize the largest measured
bottlenecks, and prove with the same protocol before and after that latency or cost improved while every Phase 1
safety gate still holds. This implements Phase 2 of `IMPROVEMENT_PLAN.md`; that document's project boundaries,
privacy rules, and reporting rules apply unchanged.

## Inputs from Phase 1

- The booking loop (`src/bots/agent/lib/bookingChatLoop.ts`) already exposes an `onTrace` seam with model-call,
  model-response, tool-result, and terminal events, but no durations or token counts.
- `callGeminiBookingModel` discards the `usage` block that Gemini's OpenAI-compatible endpoint returns.
- Tool calls requested in one model response execute sequentially, including multiple `check_availability` calls,
  each of which may reconcile Practitioner/Schedule resources and run `$find`.
- The full transcript, including raw search and availability tool results, is resent to Gemini on every loop step.
- The live smoke showed repeated `propose_options` calls after deterministic correction, and two official attempts
  died on transient Gemini HTTP 503 responses that the 429-only retry does not cover.
- The live smoke stops at proposed options and never books, so booking latency is currently unmeasured.

## Scope

### In scope

1. Bounded retry of transient Gemini 5xx responses.
2. A privacy-safe telemetry recorder with stage timings and token usage.
3. Instrumentation of the booking chat turn and the booking handler.
4. Token capture and report-time cost calculation from a versioned price file.
5. Eval report extensions for latency distributions, tokens, cost, and efficiency counts.
6. A confirmed booking step in the live smoke, with run-tag cleanup of the booked appointment.
7. A published baseline, then optimizations chosen from that baseline, then a published after-report.

### Out of scope

- OpenTelemetry, external observability services, or production log shipping.
- Any change to specialty validation, grounding, ranking floors, confirmation, or `$book` authority.
- Optimizations not justified by the baseline, even if listed as candidates.
- Frontend payload work (Phase 3).

## Measurement protocol (approved: "practice + real ×5")

| Layer | Command | Sample | Measures |
| --- | --- | --- | --- |
| Model (practice) | `npm run eval:agent:model` | 40 scenarios × 3 = 120 turns | Gemini latency, tokens, cost, model/tool calls, loop steps, step-cap rate |
| Live (real) | `npm run eval:agent:smoke -- --repetitions 5` | 8 scenarios × 5 = 40 turns, plus confirmed bookings | Real Medplum/NPPES stage latency, total turn latency, booking latency, live tokens |

- In the live command, the trailing `--repetitions 5` overrides the script's default `--repetitions 1`; the CLI
  already keeps the last value provided.
- The identical protocol runs for the baseline and the after-report, with the same scenario catalog version, model,
  repetitions, and machine.
- Practice-layer tool timings are stubs and are never reported as tool latency.
- Within a live run, the first turn is labeled `cold` and reported separately from `warm` turns.
- Paid Gemini calls and live demo-project writes happen only when these commands are explicitly run.

## Design

### 0. Transient Gemini retry

`callGeminiBookingModel` retries HTTP 429, 500, 502, 503, and 504 with the existing bounded schedule
(1, 4, 16, 60 seconds plus jitter, four retries maximum). Other statuses fail immediately. Tests cover recovery from
a 503, the retry cap, and immediate failure on a 400. This lands first so measurement runs are not lost to transient
outages; retries are counted in telemetry so they cannot silently inflate latency.

### 1. Telemetry recorder — `src/bots/agent/lib/agentTelemetry.ts`

```ts
type AgentStage =
  | 'turn.total' | 'context.load' | 'session.load' | 'session.create' | 'session.persist'
  | 'model.call' | 'tool.previous-search' | 'tool.nppes-search' | 'tool.provider-reconcile'
  | 'tool.find' | 'options.resolve' | 'summary.write'
  | 'booking.total' | 'booking.reread' | 'booking.find-recheck' | 'booking.book' | 'booking.link';

interface StageRecord {
  stage: AgentStage;
  durationMs: number;
  outcome: 'ok' | 'error' | 'skipped';
  errorCategory?: 'timeout' | 'http-4xx' | 'http-5xx' | 'validation' | 'unknown';
}

interface ModelUsageRecord {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  retries: number;
}

interface AgentTelemetry {
  time<T>(stage: AgentStage, work: () => Promise<T>): Promise<T>;
  recordModelUsage(usage: ModelUsageRecord): void;
  snapshot(): { stages: StageRecord[]; modelCalls: ModelUsageRecord[] };
}
```

- `createAgentTelemetry(clock?)` uses `performance.now()` by default; tests inject a fake clock.
- `time` records `ok` on resolve and `error` with a sanitized category on throw, then rethrows unchanged. A tool
  result shaped `{ error }` is recorded as `error` with category `validation`.
- `noopTelemetry` is the default everywhere, so production behavior and output are unchanged unless a caller supplies
  a recorder.
- Error categories are derived from HTTP status or error class only; error messages are never stored.
- No field can hold free text, identifiers, URLs, prompts, tool payloads, or FHIR bodies. A test serializes a
  snapshot produced from content-rich inputs and fails if any key outside the allowlist, or any string value other
  than a stage name, outcome, or error category, appears.

### 2. Instrumentation points

- **Booking chat (`agent-booking-chat.ts`, `bookingChatLoop.ts`):** the handler accepts an optional telemetry
  recorder alongside `onTrace`. It wraps context/session load or create, each `callModel`, `resolveProposedOptions`,
  `writeSummary`, `persist`, and the whole turn.
- **Tools (`bookingChatTools.ts`):** tool functions receive the recorder. `search_previous_physician` and
  `search_nppes` are timed as whole stages; `check_availability` is split into `tool.provider-reconcile`
  (`ensurePractitionerAndSchedule` and rereads) and `tool.find` (`$find`).
- **Booking (`agent-book-appointment.ts`):** rereads, the `$find` recheck, `$book`, and summary linking, plus the
  total. No validation or ordering changes.
- **API (`api/execute.ts`):** records only the action name, total duration, and HTTP status class, emitted as one
  structured log line per request. No bodies, tokens, IDs, or headers.
- The existing trace events are unchanged; eval executors combine trace events and telemetry snapshots.

### 3. Tokens and cost

- `callGeminiBookingModel` returns `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`) when present and the
  retry count, and the loop records it per model call.
- If a response lacks `usage`, the call is recorded with absent token fields; reports show the count of calls missing
  usage and never estimate tokens from characters.
- `tools/eval/pricing.json` holds `{ model, inputPerMillionUsd, outputPerMillionUsd, source, retrievedOn }`, filled
  from Google's published Gemini API pricing at implementation time. Cost is computed only in reports from recorded
  token counts. A model with no price entry makes the cost column `N/A` with the reason stated.

### 4. Eval and report extensions

- `AgentEvalObservation` gains optional `telemetry` (stage records and model usage) and `warmth` (`cold` | `warm`).
- `aggregateEvaluation` adds, per layer:
  - p50, p95, maximum, and sample count for every stage with samples (nearest-rank percentiles; a stage with fewer
    than 20 samples shows its count and is labeled low-sample instead of hiding p95);
  - end-to-end turn p50/p95 split by terminal kind (question, options), and booking total p50/p95;
  - mean and distribution of model calls, tool calls, and loop steps per turn;
  - mean prompt, completion, and total tokens per turn and per completed booking (tokens of the turns that produced
    the booked options);
  - cost per turn and per completed booking from `pricing.json`;
  - retry count, dependency-failure rate by stage, and step-cap rate.
- JSON and Markdown reports include these sections; the existing privacy scan extends to them.
- Existing Phase 1 metrics and safety gates are unchanged and remain release-blocking.

### 5. Live-smoke confirmed booking

- For each live scenario that ends in `options`, the executor issues an explicit confirmation step and calls the real
  `agent-book-appointment` handler with the top displayed option, the scenario's synthetic patient, and the summary
  `Communication` from that turn.
- The tracking client is extended so a `$book` request adds the run tag to the proposed Appointment's `meta` before
  it is sent, and records the returned Appointment for cleanup. Cleanup already verifies the run tag, `$cancel`s
  booked or pending appointments (releasing the slot), and deletes tracked resources in reverse order.
- Booking observations become real rather than hard-coded: `bookingMutationCount` counts `$book` calls observed by
  the proxy, `bookingMutationCountBeforeConfirmation` counts those observed before the executor's confirmation step,
  and `confirmationRequested` is true only when that step ran.
- A `slot_taken` response is recorded as a handled booking outcome, not a harness failure.
- If cleanup cannot verify the run tag on any resource it tracked, the run fails as it does today.

### 6. Optimization selection

After the baseline is published:

1. Rank stages by p95 contribution to the live turn total, and by share of prompt tokens in the model layer.
2. Present the ranking and the proposed optimizations for approval before implementing any of them.
3. Implement only candidates from `IMPROVEMENT_PLAN.md` Phase 2 that address the top latency contributor and the top
   token contributor, each test-first and in its own commit.
4. Likely candidates, to be confirmed by the data:
   - **Bounded parallel availability checks:** run `check_availability` calls from one model response concurrently
     with a fixed limit of 3, appending tool results in the original call order so the transcript is deterministic,
     and keeping per-call error results and the provenance gate.
   - **Compact model-visible transcript:** keep the full transcript in the persisted session for audit, but send
     Gemini a compacted view of older tool results containing only the fields needed for tool selection, provenance,
     grounding, and preference reasoning. Grounding continues to run against the full transcript.
5. Re-run the identical protocol and publish the after-report.

## Error handling

- Telemetry never throws into the agent path; a recorder failure is swallowed and the stage result passes through
  unchanged.
- Timing wraps preserve the original error object and message for the caller.
- Booking mutations are never retried by any Phase 2 change; the Gemini retry applies only to the read-only model call.

## Testing

- Recorder: success, handled `{ error }` result, thrown error, timeout category, fake-clock durations, and the
  forbidden-field serialization test.
- Percentiles: nearest-rank p50/p95 on known samples, a single sample, and an empty set; low-sample labeling.
- Usage parsing: usage present, partially present, and absent; retry counting.
- Cost: known token counts against a fixture price table; missing model entry yields `N/A`.
- Gemini retry: 5xx recovery, the cap, and non-retryable 4xx.
- Live-smoke booking: with injected dependencies, the `$book` request is tagged, the booked Appointment is tracked
  and cleaned up, `slot_taken` is handled, and mutation counters reflect the confirmation step.
- Optimizations: parallel checks preserve transcript order and per-call errors; compaction preserves grounding.
- Gates for every commit: `npm test`, `npm run verify:api-esm`, `npm run lint`, `npm run build`, and the
  deterministic eval safety gate.

## Deliverables

- `docs/metrics/agent-performance-baseline.md`: protocol, commit, environment, pricing source and date, and all
  baseline tables.
- `docs/metrics/agent-performance-after.md`: the same protocol after optimization, reporting absolute change,
  percentage-point change, and relative change separately, and stating plainly any target that was not met.
- `IMPROVEMENT_PLAN.md` Phase 2 status updated with verified results only.

## Completion criteria

- Every timed stage reports p50, p95, maximum, and sample count per layer.
- Tokens and cost per turn and per completed booking are reported, or the report states that usage was not supplied.
- At least one measured latency bottleneck and one measured token bottleneck are addressed, or one change is shown to
  address both.
- Phase 1 safety gates pass before and after; no hidden task-success regression in either eval layer.
- The targets (≥20% lower live p95 option-search latency, ≥20% lower tokens or cost per completed booking, lower
  step-cap frequency) are reported honestly whether or not they are met.
