# Agent Evaluation Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reproducible hybrid evaluation suite for the patient appointment concierge, covering 120 synthetic scenarios, deterministic safety gates, 40 model-eligible language scenarios with three-run support, privacy-safe reports, and a separately gated live Medplum smoke.

**Architecture:** Extract the existing booking-chat tool loop into a dependency-injected production function and drive that same function from the evaluator. All scenarios run through deterministic contract and safety scoring; language-routing scenarios can additionally call the configured Gemini model while tool results remain synthetic and controlled. A CLI aggregates observations into stable JSON and Markdown reports, while an opt-in smoke command alone may touch the configured synthetic Medplum project.

**Tech Stack:** TypeScript 5.9, Node.js 22, Vitest 4, `tsx`, Medplum FHIR types/client, Gemini OpenAI-compatible chat completions, JSON fixtures, Markdown reports.

**Spec:** `IMPROVEMENT_PLAN.md`, Phase 1, plus the approved 2026-09-13 chat design.

## Global Constraints

- Use synthetic data only; never introduce real patient data or protected health information.
- Gemini interprets language and selects tools; deterministic TypeScript retains grounding, ranking, confirmation, patient binding, FHIR revalidation, and booking authority.
- The evaluator must execute production orchestration or production policy functions; it must not award scores by copying expected values into observed values.
- Deterministic safety results and live-model quality results must be reported separately.
- No LLM judge controls a headline metric. Scorers are deterministic functions over recorded actions and outcomes.
- Never serialize prompts, model content, tool payloads, FHIR bodies, patient IDs, practitioner IDs, NPIs, access tokens, API keys, or session transcripts into reports.
- All 120 scenarios run deterministically. Exactly 40 routing/clarification scenarios are model-eligible; the model command defaults to three repetitions.
- Live Gemini and live Medplum modes are opt-in commands. Missing configuration fails closed with a clear message before any request.
- The live Medplum smoke must use synthetic demo data, run-specific demo tags, and explicit cleanup. It must not target the public demo as a load test.
- Work directly on `main`; do not create branches or worktrees. Stage explicit paths only.
- Follow red-green-refactor for every production behavior change.
- Keep the existing 326-test suite, API ESM check, lint, and production build green.

---

### Task 1: Extract a traceable, dependency-injected booking tool loop

**Files:**
- Create: `src/bots/agent/lib/bookingChatLoop.ts`
- Create: `src/bots/agent/lib/bookingChatLoop.test.ts`
- Modify: `src/bots/agent/agent-booking-chat.ts`
- Modify: `src/bots/agent/agent-booking-chat.test.ts`

**Interfaces:**
- Consumes: `BookingChatMessage`, `BookingSession`, `BookingToolCall`, `ProposeOptionsArgs`, `resolveProposedOptions`, `BookableOption`.
- Produces:

```ts
export type BookingChatTraceEvent =
  | { type: 'model-call'; step: number }
  | { type: 'model-response'; step: number; toolNames: string[] }
  | { type: 'tool-result'; step: number; toolName: string; outcome: 'ok' | 'error' | 'skipped' }
  | { type: 'terminal'; step: number; kind: 'question' | 'options' | 'step-cap' };

export interface BookingChatLoopRuntime {
  callModel(transcript: BookingChatMessage[]): Promise<{
    message: { role: 'assistant'; content: string | null; tool_calls?: BookingToolCall[] };
  }>;
  executeTool(name: string, args: Record<string, unknown>, transcript: BookingChatMessage[]): Promise<unknown>;
  writeSummary(resolved: Extract<ReturnType<typeof resolveProposedOptions>, { ok: true }>): Promise<string>;
  persist(session: BookingSession, status: 'in-progress' | 'completed' | 'stopped'): Promise<void>;
  onTrace?(event: BookingChatTraceEvent): void;
}

export async function runBookingChatLoop(
  session: BookingSession,
  runtime: BookingChatLoopRuntime
): Promise<BookingChatResult>;
```

- `agent-booking-chat.handler()` remains the public production entrypoint. It creates or loads the FHIR session, constructs production runtime closures, and delegates to `runBookingChatLoop()`.
- Trace events contain only step numbers, tool names, outcome categories, and terminal kinds.

- [ ] **Step 1: Write failing loop tests**

Add tests proving that the extracted function:

```ts
test('records a question terminal without emitting message content', async () => {
  const trace: BookingChatTraceEvent[] = [];
  const result = await runBookingChatLoop(session(), runtime({
    model: toolCall('ask_clarifying_question', { question: 'Which specialty?' }),
    trace,
  }));
  expect(result.kind).toBe('question');
  expect(trace).toEqual([
    { type: 'model-call', step: 0 },
    { type: 'model-response', step: 0, toolNames: ['ask_clarifying_question'] },
    { type: 'tool-result', step: 0, toolName: 'ask_clarifying_question', outcome: 'ok' },
    { type: 'terminal', step: 0, kind: 'question' },
  ]);
  expect(JSON.stringify(trace)).not.toContain('Which specialty?');
});
```

Also cover grounded options, malformed arguments, tool failure, skipped trailing calls, and the eight-step cap.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npx vitest run src/bots/agent/lib/bookingChatLoop.test.ts --reporter=verbose
```

Expected: FAIL because `bookingChatLoop.ts` and `runBookingChatLoop` do not exist.

- [ ] **Step 3: Implement the minimal loop extraction**

Move only the loop and skipped-tool-result behavior out of `agent-booking-chat.ts`. Preserve the existing eight-step cap, grounding through `resolveProposedOptions`, resumable step-cap behavior, summary creation timing, and session persistence semantics.

- [ ] **Step 4: Delegate the production handler to the extracted loop**

Keep `callGeminiWithTools`, FHIR context loading, session creation/loading, production tool execution, and summary Communication creation in `agent-booking-chat.ts`. Build a `BookingChatLoopRuntime` from those functions and the event API key.

- [ ] **Step 5: Verify loop and handler behavior GREEN**

Run:

```powershell
npx vitest run src/bots/agent/lib/bookingChatLoop.test.ts src/bots/agent/agent-booking-chat.test.ts --reporter=verbose
```

Expected: both files pass with no behavior changes in existing handler tests.

- [ ] **Step 6: Commit the extraction**

```powershell
git add src/bots/agent/lib/bookingChatLoop.ts src/bots/agent/lib/bookingChatLoop.test.ts src/bots/agent/agent-booking-chat.ts src/bots/agent/agent-booking-chat.test.ts
git commit -m "refactor: extract traceable booking chat loop"
```

---

### Task 2: Define and validate the scenario contract

**Files:**
- Create: `tools/eval/types.ts`
- Create: `tools/eval/loadScenarios.ts`
- Create: `tools/eval/loadScenarios.test.ts`
- Create: `data/evals/booking-scenarios.json`

**Interfaces:**
- Produces:

```ts
export type EvalCategory =
  | 'routing-clarification'
  | 'preference-ranking'
  | 'grounding-tampering'
  | 'availability-dependency'
  | 'confirmation-session';

export type DeterministicDriver =
  | 'booking-chat-loop'
  | 'preference-ranking'
  | 'proposal-grounding'
  | 'confirmation-state'
  | 'session-boundary';

export interface AgentEvalScenario {
  id: string;
  category: EvalCategory;
  description: string;
  patientMessage: string;
  modelEligible: boolean;
  deterministicDriver: DeterministicDriver;
  fixture: EvalFixture;
  expected: EvalExpected;
}

export interface AgentEvalCatalog {
  version: 1;
  scenarios: AgentEvalScenario[];
}

export function loadScenarioCatalog(path: string): AgentEvalCatalog;
```

- `EvalFixture` includes only synthetic provider aliases, specialties, preferences, bookable time windows, tool outcomes, and optional failure categories. It never contains real identifiers.
- `EvalExpected` contains terminal kind, specialty code, clarification policy, optional top provider alias, expected tool constraints, and named safety gates.

- [ ] **Step 1: Write failing loader tests**

Cover a valid minimal catalog plus rejection of duplicate IDs, unknown category/driver, empty message, real-looking identifier fields, missing expected result, invalid counts, a model-eligible non-routing scenario, and any object containing forbidden report keys such as `accessToken`, `apiKey`, `authorization`, `patientId`, `npi`, or `transcript`.

- [ ] **Step 2: Verify loader tests RED**

Run:

```powershell
npx vitest run tools/eval/loadScenarios.test.ts --reporter=verbose
```

Expected: FAIL because the loader does not exist.

- [ ] **Step 3: Implement manual runtime validation**

Use narrow type guards rather than adding a schema dependency. Error messages name only the scenario index/ID and invalid field; they never echo the patient message or fixture body.

- [ ] **Step 4: Add the first 12 scenario definitions**

Add a representative vertical slice: three routing/clarification, two preference, three grounding/tampering, two dependency, and two confirmation/session scenarios. Use aliases such as `provider-a`; the executor maps aliases to ephemeral synthetic values internally.

- [ ] **Step 5: Verify loader GREEN**

Run:

```powershell
npx vitest run tools/eval/loadScenarios.test.ts --reporter=verbose
```

Expected: PASS and catalog count exactly 12.

- [ ] **Step 6: Commit the scenario contract**

```powershell
git add tools/eval/types.ts tools/eval/loadScenarios.ts tools/eval/loadScenarios.test.ts data/evals/booking-scenarios.json
git commit -m "feat: define agent evaluation scenarios"
```

---

### Task 3: Implement deterministic metrics and safety gates

**Files:**
- Create: `tools/eval/scorers.ts`
- Create: `tools/eval/scorers.test.ts`

**Interfaces:**
- Consumes `AgentEvalScenario` and:

```ts
export interface AgentEvalObservation {
  scenarioId: string;
  mode: 'deterministic' | 'model' | 'live-smoke';
  repetition: number;
  terminalKind: 'question' | 'options' | 'booked' | 'slot-taken' | 'error';
  specialtyCode?: string;
  toolNames: string[];
  loopSteps: number;
  displayedOptions: EvalObservedOption[];
  availableOptionKeys: string[];
  confirmationRequested: boolean;
  bookingMutationCount: number;
  bookingMutationCountBeforeConfirmation: number;
  crossPatientSessionAccepted: boolean;
  duplicateAppointmentCount: number;
  sanitizedErrorCategory?: string;
}
```

- Produces:

```ts
export interface ScenarioScore {
  scenarioId: string;
  passed: boolean;
  checks: Record<string, boolean>;
}

export interface EvalAggregate {
  scenarioRuns: number;
  taskSuccess: RatioMetric;
  routingAccuracy: RatioMetric;
  clarificationCompliance: RatioMetric;
  toolSequenceCompliance: RatioMetric;
  groundedOptionPrecision: RatioMetric;
  distinctProviderCompliance: RatioMetric;
  preferenceAdherence: RatioMetric;
  confirmationViolationRate: RatioMetric;
  unauthorizedBookingRate: RatioMetric;
  slotConflictCorrectness: RatioMetric;
  sessionResumptionSuccess: RatioMetric;
  stepCapRate: RatioMetric;
  safetyGatePassed: boolean;
}

export function scoreScenario(scenario: AgentEvalScenario, observation: AgentEvalObservation): ScenarioScore;
export function aggregateScores(scenarios: AgentEvalScenario[], observations: AgentEvalObservation[]): EvalAggregate;
```

- [ ] **Step 1: Write one failing test per metric**

Each test names the production behavior that would change the result. Include zero-denominator output as `{ numerator: 0, denominator: 0, value: null }`, never `100%`.

- [ ] **Step 2: Write deliberate-violation tests**

Prove that fabricated availability, pre-confirmation mutation, cross-patient acceptance, duplicate appointment creation, and successful stale-slot booking each set `safetyGatePassed` to false.

- [ ] **Step 3: Verify scorers RED**

Run:

```powershell
npx vitest run tools/eval/scorers.test.ts --reporter=verbose
```

Expected: FAIL because scoring functions do not exist.

- [ ] **Step 4: Implement pure scorers**

Use exact option keys built from provider alias, start, and end. Count raw numerators and denominators first, then calculate values. Task success requires the expected terminal result and every applicable scenario check to pass.

- [ ] **Step 5: Verify scorers GREEN**

Run the focused scorer tests and require every deliberate violation to fail for the intended reason.

- [ ] **Step 6: Commit scoring**

```powershell
git add tools/eval/scorers.ts tools/eval/scorers.test.ts
git commit -m "feat: score agent quality and safety gates"
```

---

### Task 4: Execute the 12-scenario deterministic vertical slice

**Files:**
- Create: `tools/eval/deterministicExecutor.ts`
- Create: `tools/eval/deterministicExecutor.test.ts`
- Create: `tools/eval/runAgentEval.ts`
- Create: `tools/eval/runAgentEval.test.ts`

**Interfaces:**
- Produces:

```ts
export async function executeDeterministicScenario(
  scenario: AgentEvalScenario
): Promise<AgentEvalObservation>;

export interface AgentEvalExecutor {
  execute(scenario: AgentEvalScenario, repetition: number): Promise<AgentEvalObservation>;
}

export async function runEvaluation(
  catalog: AgentEvalCatalog,
  executor: AgentEvalExecutor,
  options: { mode: AgentEvalObservation['mode']; repetitions: number }
): Promise<{ observations: AgentEvalObservation[]; aggregate: EvalAggregate }>;
```

- `booking-chat-loop` runs the extracted production loop with scripted model turns and controlled tool results.
- `preference-ranking` invokes production `rankBookableOptions`.
- `proposal-grounding` invokes production `resolveProposedOptions`.
- `confirmation-state` invokes production `optionsReceived`, `optionSelected`, `bookingStarted`, `slotTaken`, and `confirmSelectedOption` as applicable.
- `session-boundary` invokes the production session/state boundary under a synthetic in-memory adapter.

- [ ] **Step 1: Write failing executor tests**

Prove each deterministic driver invokes the named production function and returns an observation derived from the actual result. Include a test that mutating the fixture's expected value cannot directly mutate the observation.

- [ ] **Step 2: Verify executor tests RED**

Run:

```powershell
npx vitest run tools/eval/deterministicExecutor.test.ts tools/eval/runAgentEval.test.ts --reporter=verbose
```

- [ ] **Step 3: Implement drivers and orchestration**

Keep scenario-specific setup in driver functions. Do not duplicate grounding, ranking, or confirmation algorithms in `tools/eval`.

- [ ] **Step 4: Add CLI argument validation**

Support:

```text
--mode deterministic|model|live-smoke
--repetitions <positive integer>
--scenario <exact scenario id>
--category <exact category>
--output <directory>
```

Unknown flags, conflicting filters, and invalid repetition counts exit non-zero before execution.

- [ ] **Step 5: Run the 12-scenario vertical slice**

Run:

```powershell
npx tsx tools/eval/runAgentEval.ts --mode deterministic --repetitions 1 --output results/evals
```

Expected: 12 observations, all intended safe scenarios pass, and deliberate-violation scorer tests remain red against unsafe observations.

- [ ] **Step 6: Commit the vertical slice**

```powershell
git add tools/eval/deterministicExecutor.ts tools/eval/deterministicExecutor.test.ts tools/eval/runAgentEval.ts tools/eval/runAgentEval.test.ts
git commit -m "feat: run deterministic agent evaluations"
```

---

### Task 5: Generate and validate the complete 120-scenario catalog

**Files:**
- Create: `tools/eval/buildScenarioCatalog.ts`
- Create: `tools/eval/buildScenarioCatalog.test.ts`
- Modify: `data/evals/booking-scenarios.json`
- Modify: `tools/eval/loadScenarios.test.ts`

**Interfaces:**
- Produces `buildScenarioCatalog(): AgentEvalCatalog` and `serializeScenarioCatalog(catalog): string`.
- The checked-in JSON is a deterministic generated artifact. Its scenario IDs, descriptions, messages, fixtures, and expected policies originate from hand-reviewed tables in `buildScenarioCatalog.ts`.

- [ ] **Step 1: Write failing catalog composition tests**

Require exactly 120 unique scenarios with category counts `40/25/20/20/15`, exactly 40 model-eligible routing scenarios, no forbidden keys, at least two message phrasings per routing family, and coverage of every named safety gate.

- [ ] **Step 2: Verify catalog tests RED**

Run:

```powershell
npx vitest run tools/eval/buildScenarioCatalog.test.ts tools/eval/loadScenarios.test.ts --reporter=verbose
```

- [ ] **Step 3: Implement hand-reviewed scenario tables and deterministic expansion**

Use explicit arrays for specialty/referral messages, clear complaints, ambiguous complaints, General Practice fallbacks, preference combinations, tampering cases, dependency failures, and confirmation/session cases. Generated variants must change meaningful inputs, not only append sequence numbers.

- [ ] **Step 4: Regenerate the JSON catalog**

Run:

```powershell
npx tsx tools/eval/buildScenarioCatalog.ts
```

The command writes only `data/evals/booking-scenarios.json` and emits the count summary, never scenario messages.

- [ ] **Step 5: Verify generated-file stability**

Run the generator twice and require no Git diff after the second run. Run the catalog tests and deterministic evaluator across all 120 scenarios.

- [ ] **Step 6: Commit the full catalog**

```powershell
git add tools/eval/buildScenarioCatalog.ts tools/eval/buildScenarioCatalog.test.ts tools/eval/loadScenarios.test.ts data/evals/booking-scenarios.json
git commit -m "feat: add 120 synthetic agent eval scenarios"
```

---

### Task 6: Add the controlled Gemini model evaluator

**Files:**
- Create: `tools/eval/modelExecutor.ts`
- Create: `tools/eval/modelExecutor.test.ts`
- Modify: `tools/eval/runAgentEval.ts`
- Modify: `tools/eval/runAgentEval.test.ts`
- Modify: `src/bots/agent/agent-booking-chat.ts`

**Interfaces:**
- Production exports a named `callGeminiBookingModel(transcript, apiKey)` using the same model, temperature, prompt, and tool schema as the handler.
- Produces:

```ts
export function createModelExecutor(options: {
  apiKey: string;
  concurrency: number;
}): AgentEvalExecutor;
```

- Controlled tool execution derives previous-provider, NPPES-provider, and availability results only from scenario fixtures. `check_availability` returns an error unless the provider alias appeared in a prior search result in that run.
- The runner constructs the initial transcript from `BOOKING_CHAT_SYSTEM_PROMPT`, a synthetic patient-context message, and the scenario patient message, then calls `runBookingChatLoop()`.

- [ ] **Step 1: Write failing model-executor tests with a fake caller**

Prove the executor uses the production prompt, rejects non-model-eligible scenarios, preserves search-before-availability provenance, emits no prompt content in observations, and captures tool order, loop steps, specialty, displayed options, and terminal kind.

- [ ] **Step 2: Verify model tests RED**

Run:

```powershell
npx vitest run tools/eval/modelExecutor.test.ts tools/eval/runAgentEval.test.ts --reporter=verbose
```

- [ ] **Step 3: Implement the controlled model executor**

Default concurrency to one. A future Phase 2 change may optimize evaluation throughput; Phase 1 prioritizes clean evidence and predictable rate usage.

- [ ] **Step 4: Load the Gemini key without leaking it**

The CLI loads `.env.local` through `dotenv/config`, checks `GEMINI_API_KEY`, and prints only whether configuration is present. It never prints key length, prefix, headers, or request bodies.

- [ ] **Step 5: Verify the model adapter with fake calls GREEN**

Run focused tests. Inspect serialized observations to ensure patient messages and model content are absent.

- [ ] **Step 6: Commit the model evaluator**

```powershell
git add tools/eval/modelExecutor.ts tools/eval/modelExecutor.test.ts tools/eval/runAgentEval.ts tools/eval/runAgentEval.test.ts src/bots/agent/agent-booking-chat.ts
git commit -m "feat: evaluate live model decisions with controlled tools"
```

---

### Task 7: Generate privacy-safe JSON and Markdown reports

**Files:**
- Create: `tools/eval/report.ts`
- Create: `tools/eval/report.test.ts`
- Modify: `tools/eval/runAgentEval.ts`
- Modify: `package.json`
- Create: `docs/metrics/agent-eval-baseline.md`

**Interfaces:**
- Produces:

```ts
export interface AgentEvalReport {
  schemaVersion: 1;
  catalogVersion: 1;
  mode: AgentEvalObservation['mode'];
  model?: string;
  repetitions: number;
  scenarioRuns: number;
  aggregate: EvalAggregate;
  failures: Array<{ scenarioId: string; failedChecks: string[] }>;
}

export function buildReport(input: BuildReportInput): AgentEvalReport;
export function renderReportMarkdown(report: AgentEvalReport): string;
export function assertReportIsSafe(report: AgentEvalReport): void;
```

- JSON contains aggregate values and scenario IDs/failed check names only. Markdown includes exact command, Git commit, Node version, model name, limitations, and metric numerators/denominators.

- [ ] **Step 1: Write failing report tests**

Cover stable ordering, `null` ratios, percentage formatting, percentage-point wording, safety-gate failure prominence, no raw observations, and rejection of every forbidden key/value marker.

- [ ] **Step 2: Verify report tests RED**

Run:

```powershell
npx vitest run tools/eval/report.test.ts --reporter=verbose
```

- [ ] **Step 3: Implement report generation and atomic writes**

Write to a sibling temporary file, then rename it to the requested destination. A failed safety assertion must remove the temporary file and leave an existing report unchanged.

- [ ] **Step 4: Add npm commands**

```json
{
  "eval:agent": "tsx tools/eval/runAgentEval.ts --mode deterministic --repetitions 1 --output results/evals",
  "eval:agent:model": "tsx tools/eval/runAgentEval.ts --mode model --repetitions 3 --output results/evals",
  "eval:agent:smoke": "tsx tools/eval/runAgentEval.ts --mode live-smoke --repetitions 1 --output results/evals"
}
```

- [ ] **Step 5: Generate the deterministic baseline**

Run `npm run eval:agent`, copy the aggregate evidence into `docs/metrics/agent-eval-baseline.md`, and label the model section pending until the live-model command succeeds. Do not copy raw prompts or observations.

- [ ] **Step 6: Commit reports and commands**

```powershell
git add tools/eval/report.ts tools/eval/report.test.ts tools/eval/runAgentEval.ts package.json package-lock.json docs/metrics/agent-eval-baseline.md
git commit -m "feat: report reproducible agent eval results"
```

---

### Task 8: Add the opt-in synthetic Medplum smoke contract

**Files:**
- Create: `tools/eval/liveSmokeExecutor.ts`
- Create: `tools/eval/liveSmokeExecutor.test.ts`
- Modify: `tools/eval/runAgentEval.ts`
- Modify: `tools/eval/runAgentEval.test.ts`
- Modify: `docs/metrics/agent-eval-baseline.md`

**Interfaces:**
- Produces `createLiveSmokeExecutor(environment): AgentEvalExecutor`.
- Requires `MEDPLUM_BASE_URL`, `MEDPLUM_PROJECT_ID`, `DEMO_MEDPLUM_CLIENT_ID`, `DEMO_MEDPLUM_CLIENT_SECRET`, `DEMO_WORKER_CLIENT_ID`, `DEMO_WORKER_CLIENT_SECRET`, and `GEMINI_API_KEY` before any login or resource request.
- Restricts execution to eight scenarios explicitly marked `liveSmokeEligible: true`.
- Uses run-specific `demo-generated` tags and records created resource references in memory solely for cleanup; reports contain only scenario IDs and aggregate outcomes.

- [ ] **Step 1: Write failing fail-closed tests**

Prove missing variables, non-synthetic catalog entries, unapproved scenarios, and cleanup-plan construction failures prevent every network call.

- [ ] **Step 2: Verify live-smoke tests RED**

Run:

```powershell
npx vitest run tools/eval/liveSmokeExecutor.test.ts tools/eval/runAgentEval.test.ts --reporter=verbose
```

- [ ] **Step 3: Implement configuration validation and the eight-scenario allowlist**

Reuse the real API and handler boundaries. Do not add a browser route or deploy an evaluator endpoint.

- [ ] **Step 4: Implement cleanup and failure reporting**

Cleanup runs in `finally`, treats an already-deleted tagged resource as success, and reports cleanup failure separately from scenario quality.

- [ ] **Step 5: Run only when all credentials are configured**

If configuration is incomplete, record `live smoke not run: missing required local configuration` in the baseline document. This is an honest limitation, not a passing result.

- [ ] **Step 6: Commit the smoke contract**

```powershell
git add tools/eval/liveSmokeExecutor.ts tools/eval/liveSmokeExecutor.test.ts tools/eval/runAgentEval.ts tools/eval/runAgentEval.test.ts docs/metrics/agent-eval-baseline.md
git commit -m "test: add gated synthetic Medplum eval smoke"
```

---

### Task 9: Run the baseline and final verification

**Files:**
- Modify: `docs/metrics/agent-eval-baseline.md`
- Modify: `README.md`
- Modify: `IMPROVEMENT_PLAN.md`

**Interfaces:**
- README links to the evaluation methodology and reports only verified results.
- The improvement plan marks Phase 1 complete only if deterministic and model gates actually ran; otherwise it records the exact remaining external blocker.

- [ ] **Step 1: Run the deterministic baseline twice**

```powershell
npm run eval:agent
npm run eval:agent
```

Expected: identical aggregates and failures after excluding timestamps/run IDs.

- [ ] **Step 2: Run the 40-scenario model baseline**

```powershell
npm run eval:agent:model
```

Expected: 120 model observations, three per model-eligible scenario. Any API expense is authorized separately at command execution time.

- [ ] **Step 3: Run the live smoke if configured**

```powershell
npm run eval:agent:smoke
```

If required demo credentials are absent, do not substitute administrator credentials; document the skipped external condition.

- [ ] **Step 4: Run focused evaluation tests**

```powershell
npx vitest run src/bots/agent/lib/bookingChatLoop.test.ts tools/eval --reporter=verbose
```

- [ ] **Step 5: Run full repository verification**

```powershell
npm test
npm run verify:api-esm
npm run lint
npm run build
git diff --check
```

- [ ] **Step 6: Audit generated reports**

Search for forbidden keys and representative prompt/patient phrases. Confirm only aggregate metrics, scenario IDs, failed check names, environment versions, model name, commands, and limitations remain.

- [ ] **Step 7: Update durable documentation**

Add a concise README evaluation section linking to `docs/metrics/agent-eval-baseline.md`. Mark Phase 1 status accurately in `IMPROVEMENT_PLAN.md`; do not mark the live smoke complete if it did not run.

- [ ] **Step 8: Commit final evidence**

```powershell
git add README.md IMPROVEMENT_PLAN.md docs/metrics/agent-eval-baseline.md
git commit -m "docs: publish agent evaluation baseline"
```

## Plan self-review

- Spec coverage: scenario count, hybrid layers, all defined metrics, safety gates, privacy, model repetitions, live smoke, reports, and full verification each map to a task above.
- Placeholder scan: the plan contains no unresolved implementation placeholders. Values that depend on execution are explicitly required outputs of the baseline command, not prefilled claims.
- Type consistency: `AgentEvalScenario` flows from loading through executors; every executor emits `AgentEvalObservation`; scorers create `EvalAggregate`; reporting consumes that aggregate.
- Scope: only Phase 1 is implemented here. Latency/token optimization and frontend payload work remain separate Phase 2 and Phase 3 plans.
