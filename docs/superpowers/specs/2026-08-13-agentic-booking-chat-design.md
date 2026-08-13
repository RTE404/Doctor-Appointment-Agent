# Agentic Booking Chat — Design

## Objective

Replace the fixed `intake → find-doctors → ensure-doctor → $find → rank` call chain behind the patient booking search
with a real, model-directed tool-calling loop: the model decides which tools to call, in what order, when it needs to
ask the patient something, and when it has enough information to finalize. The patient interacts with it as a
chat, not a one-shot form. Appointment booking itself (`agent-book-appointment`) is unchanged and stays the sole,
fully deterministic authority for writing an `Appointment`.

This is a narrowing of "make the agent more agentic" to the part of the system where giving the model agency does not
touch anything safety-critical: what to look at and when, not whether a slot gets booked.

## Scope

### In scope

1. **Model-directed tool loop** in place of the current hardcoded orchestration in `agent-find-bookable-options.ts`.
2. **Multi-turn clarification** — the model can ask more than one question across a real conversation instead of the
   current single-retry-then-fail behavior.
3. **Replanning on failure** — a taken slot or empty search re-enters the loop as new information the model reasons
   over (widen dates, drop a preference, try another candidate), instead of filtering a list that was computed once.
4. **Model-driven option selection with a deterministic floor** — the model picks and explains up to **8** distinct-
   provider options from tool results it actually gathered; code enforces the distinct-provider/max-count rule and
   grounds every pick against real search results regardless of what the model submits.
5. **Persistent, server-side session state** — the full Gemini message transcript (system/user/assistant/tool
   messages) is stored server-side and resent to Gemini in full on every turn, for the life of one booking search.
6. **Chat-style patient UI**, visually and structurally consistent with the existing doctor-desk chat
   (`AgentChat.tsx` / `PatientAgentChatPage.tsx`), replacing the `ComplaintForm` step of `PatientHistoryPage`.

### Explicitly out of scope

- Letting the model reason over *ranking candidates it hasn't validated* — everything it can pick from must come from
  a real tool call in the same session (no free-floating trade-off narration over hypothetical providers).
- Compound/multi-specialty requests (idea 5 from the brainstorm) — one session still resolves to one specialty.
- A self-critique/reflection pass on the model's own routing decision (idea 6).
- Multi-agent decomposition (idea 7) — this is one bot with one tool-calling loop, not a router agent + scheduler
  agent pair.
- Long-term/cross-session preference memory — a session's transcript is scoped to one booking search, same as today.
- Any change to `agent-book-appointment.ts`'s validation, `$find`/`$book` handling, or the booking confirmation UI.
- `DoctorResultsPage` / `SlotPickerPage` — a separate, currently-disconnected manual flow driven by `BookingContext`.
  Not touched by this work.

## High-Level Design (HLD)

### Architecture

```text
Patient (chat UI)
    |
    v
New page: BookingChatPage (src/pages/agent) — reuses the doctor-desk chat visual pattern
    |
    v
POST /api/execute  { action: 'agent-booking-chat', input: { patientId, message, sessionId? } }
    |
    v
agent-booking-chat bot
    |
    |-- load or create session Communication (persisted transcript)
    |-- append patient message to transcript
    |-- run the tool-calling loop (bounded steps):
    |       Gemini call --tool_calls--> execute tool (deterministic lib code) --> append result --> repeat
    |       until the model calls ask_clarifying_question or propose_options, or the step cap is hit
    |-- persist updated transcript (full read-and-spread update)
    |
    v
Response: either
  { kind: 'question', reply, sessionId }                          -> chat continues
  { kind: 'options', options: BookableOption[], sessionId }       -> hand off to selection/confirm UI; sessionId
                                                                      stays live, so the patient can keep chatting to
                                                                      refine instead of picking a card
  { kind: 'error', reply, sessionId }                             -> chat shows the problem, patient can keep typing

Existing, unchanged from here down:
  BookableOptionCard selection -> "Confirm booking" -> agent-book-appointment -> BookingConfirmationPage
```

### Key decisions

- **One new bot, `agent-booking-chat`, replaces two existing bots** (`agent-intake`, `agent-find-bookable-options`) as
  the patient-facing entry point. Their underlying `lib/` functions (`loadPatientClinicalContext`, NPPES search,
  previous-physician lookup, `ensurePractitionerAndSchedule`, `rankBookableOptions`, `normalizeLlmSpecialty`) are
  reused as-is inside the new bot's tools — none of that deterministic code changes.
- **State lives server-side, in FHIR**, not in browser memory — consistent with how this app already treats every
  consequential AI interaction as a durable, auditable resource (the `ai-previsit-summary` and `ai-chat`
  `Communication`s). A new tag, `ai-booking-session`, follows the same convention.
- **The full transcript is resent to Gemini every turn.** No sliding window, no summarization — for a session this
  short-lived (one booking search), the simplicity and auditability outweigh the token cost.
- **`agent-book-appointment` does not change.** It still reads a `preparation`-status, `ai-previsit-summary`-tagged
  `Communication` with `topic`/`reasonCode`/`note` set. The new bot produces that exact same resource shape at
  finalize time instead of `agent-intake` producing it upfront.

## Low-Level Design (LLD)

### `agent-booking-chat` — input/output

```ts
export type BookingChatInput = {
  patientId: string;
  message: string;
  sessionId?: string; // omitted on the first call of a session
};

export type BookingChatResult =
  | { kind: 'question'; sessionId: string; reply: string }
  | { kind: 'options'; sessionId: string; options: BookableOption[] }
  | { kind: 'error'; sessionId: string; reply: string };
```

`BookableOption` is the existing type from `lib/bookableOptions.ts` — unchanged.

### Session lifecycle

- **No `sessionId`**: create a new `Communication` (see "Session persistence" below), seed its transcript with the
  system prompt (see below) plus a system-authored context message from `get_patient_context`'s output (loaded once,
  eagerly — see rationale under Tools), then the patient's first message. Run the loop.
- **With `sessionId`**: read the `Communication`, verify `subject.reference === Patient/${patientId}` and
  `status === 'in-progress'` (reject otherwise — same "this artifact must actually belong to this patient/session"
  posture as `agent-book-appointment`'s summary check), append the new patient message, run the loop.
- **`propose_options` succeeding does not end the session.** It leaves `status: 'in-progress'`, same as a clarifying
  question — the patient can send another message (e.g. "none of those work, try afternoons") and the loop resumes
  with the full prior transcript, including every search and availability check already gathered, so the model isn't
  starting from zero. The system prompt tells the model to treat a post-`propose_options` message as feedback on the
  options just shown rather than an unrelated new request.
- **Terminal states**: only a step-cap or unrecoverable error ends a session (`status: 'stopped'`) — a stopped
  session cannot be resumed; the patient must start over (surfaced in the UI as "let's start again").

### Tools

All tool implementations are thin, already-tested `lib/` wrappers — no new business logic, only new call sites.

| Tool | Wraps | Args | Returns |
|---|---|---|---|
| `search_previous_physician` | `findPreviousPhysician` (from old `agent-find-doctors.ts`) | `{ specialtyCode: string }` | matching previous `FoundCandidate` or `null` |
| `search_nppes` | `searchNppesDoctors` + `rankCandidates` | `{ specialtyCode: string }` | up to 15 ranked `FoundCandidate[]` (raised from today's 10 — see "Candidate pool sizing") |
| `check_availability` | `ensurePractitionerAndSchedule` + `Appointment/$find` | `{ npi: string, startOffsetDays?: number, windowDays?: number }` (defaults: start now, 7-day window, matching today) | `BookableOption[]` for that one provider, or `[]` |
| `ask_clarifying_question` | — | `{ question: string }` | ends the turn; loop suspends, returns `{kind: 'question', reply: question}` |
| `propose_options` | `normalizeLlmSpecialty` + summary `Communication` write + grounding/cap enforcement (new, see below) | `{ specialty: string, reason: string, summary: string, picks: { npi: string, start: string, end: string, reasoning: string }[] }` | validated `BookableOption[]`, or a tool-result error the model can react to (e.g. "specialty not recognized, try again") |

`get_patient_context` (wrapping `loadPatientClinicalContext`) is **not** offered as a callable tool — it is loaded
once up front and injected into the transcript as the first system-authored message when a session starts. Patient
clinical context doesn't change mid-session, there's no reason to spend a tool-call round-trip re-fetching it, and it
guarantees the model always has it rather than depending on the model remembering to ask for it.

Tool schemas follow the OpenAI-compatible `tools: [{type: 'function', function: {name, description, parameters}}]`
shape already reachable through the existing `chat/completions` endpoint in `geminiRequest.ts`. Each tool's
`parameters` is a plain JSON Schema object.

**Risk to validate early**: this design assumes Gemini's OpenAI-compatible endpoint supports function/tool calling
for `gemini-3.5-flash-lite` the same way the rest of `geminiRequest.ts` already assumes JSON-mode support. This
should be the first thing spiked in implementation, before building out the full loop — see Rollout notes.

### The loop algorithm

```text
function runTurn(session, patientMessage):
  transcript = session.transcript + [{role: 'user', content: patientMessage}]
  for step in 1..MAX_STEPS (8):
    response = callGemini(transcript, tools)
    if response.tool_calls is empty:
      # model replied with plain text instead of a tool call — treat as a clarifying question
      transcript += [response.message]
      persist(session, transcript, status: 'in-progress')
      return {kind: 'question', reply: response.message.content}

    transcript += [response.message]  # the assistant message containing tool_calls
    for call in response.tool_calls:
      if call.name == 'ask_clarifying_question':
        transcript += [toolResultMessage(call, 'ok')]
        persist(session, transcript, status: 'in-progress')
        return {kind: 'question', reply: call.args.question}

      if call.name == 'propose_options':
        result = handlePropose(session, call.args)  # validation + grounding, see below
        if result.ok:
          persist(session, transcript + [toolResultMessage(call, result)], status: 'in-progress')
          return {kind: 'options', options: result.options}
        else:
          # invalid/ungrounded — tell the model why, let it try again within the step budget
          transcript += [toolResultMessage(call, result.errorForModel)]
          continue

      # any other tool: execute deterministically, append the real result, keep looping
      output = executeTool(call.name, call.args)
      transcript += [toolResultMessage(call, output)]

  persist(session, transcript, status: 'stopped')
  return {kind: 'error', reply: "I wasn't able to find a good match — let's start again."}
```

### `propose_options` validation and grounding

This is the deterministic floor that keeps the safety boundaries in `AGENT_OVERVIEW.md` ("never invent providers or
appointment times") true even though selection is now model-driven:

1. **Specialty check** — `normalizeLlmSpecialty(args.specialty)` must resolve to a real `SPECIALTY_TABLE` entry.
   Failure → error result, loop continues (model can retry or ask a clarifying question instead).
2. **Grounding check** — every `{npi, start, end}` pick must exactly match a `BookableOption` returned by a
   `check_availability` call earlier in *this session's* transcript. Any pick that doesn't match is dropped. If
   dropping picks leaves zero, this is treated as a failed proposal (error result, loop continues) rather than
   returning an empty option list.
3. **Distinct-provider + count cap** — after grounding, dedupe by NPI and cap at `MAX_BOOKABLE_OPTIONS = 8`. If the
   model's (post-grounding) picks already satisfy this, use them, in the model's order (this is where the model's
   trade-off reasoning actually shows up). If they don't — too many from one provider, or the model only proposed
   two providers when more grounded candidates exist — fall back to running the existing `rankBookableOptions`
   (limit raised from 3 to 8) over the full grounded candidate pool gathered during the session. This reuses, rather
   than replaces, the current deterministic ranking as a backstop.
4. **Write the summary `Communication`** — only after 1–3 pass, with the exact shape `agent-intake` writes today
   (`status: 'preparation'`, `category: ai-previsit-summary`, `topic` = NUCC coding, `reasonCode`/`note`/`sender`),
   so `agent-book-appointment.ts` needs no changes at all.

### Session persistence — the transcript `Communication`

```ts
{
  resourceType: 'Communication',
  status: 'in-progress' | 'completed' | 'stopped',
  category: [{ coding: [{ system: 'http://example.com/agent-communication-category', code: 'ai-booking-session' }] }],
  subject: { reference: `Patient/${patientId}` },
  sender: { reference: `Device/${agentDeviceId}` },   // same seeded Device as every other agent Communication
  payload: [{ contentString: JSON.stringify(transcriptMessages) }],
  meta: { tag: [{ code: 'ai-generated' }] },
}
```

`transcriptMessages` is the raw OpenAI-compatible message array (`role`, `content`, `tool_calls`, `tool_call_id`) —
exactly what gets sent back to Gemini verbatim on the next turn. Every turn does read → append → call Gemini → append
→ `updateResource` (full read-and-spread, the same pattern already used in `agent-book-appointment.ts`'s post-booking
metadata update) so a stale partial write can never silently drop fields.

### Candidate pool sizing

To reliably fill up to 8 distinct-provider slots after availability filtering (some candidates will have zero
availability in the 7-day window), upstream candidate limits need to grow alongside the option cap:

- `search_nppes`: NPPES ranked results raised from top 10 to top 15.
- Merged/deduped candidate set considered for `check_availability` calls: raised from today's hardcoded top-5 to
  top-12 (the model decides how many of these it actually calls `check_availability` on, bounded by the overall
  step cap).

### API wiring

- Add `'agent-booking-chat'` to `ALLOWED_ACTIONS` / `HANDLERS` in `api/execute.ts`; add it to `GEMINI_ACTIONS`.
- Remove `'agent-intake'` and `'agent-find-bookable-options'` from `ALLOWED_ACTIONS` / `HANDLERS` / `GEMINI_ACTIONS`
  once the new bot replaces them (see "Removed code" below). `'agent-find-doctors'`, `'agent-ensure-doctor'`, and
  `'agent-book-appointment'` are untouched — the doctor-desk chat action `'agent-patient-chat'` is unrelated and
  untouched.

### Frontend

**New page**: `src/pages/agent/BookingChatPage.tsx`, replacing the `ComplaintForm`-driven top half of
`PatientHistoryPage.tsx`. Same visual pattern as `AgentChat.tsx`: bordered turn cards, textarea + submit button,
disclaimer banner. Once a turn resolves to `kind: 'options'`, the page renders the existing `BookableOptionCard` list
and "Confirm booking" flow exactly as `PatientHistoryPage` does today — that part of the file is unchanged.

**Turn model** — richer than doctor-desk's flat `{question, answer}`, since a turn can be a clarifying exchange or
the final option set:

```ts
export type BookingChatTurn =
  | { kind: 'patient'; text: string }
  | { kind: 'agent-question'; text: string }
  | { kind: 'agent-options'; options: BookableOption[] };
```

**Page state**: `sessionId`, `turns: BookingChatTurn[]`, plus the existing `agentState`
(`BookingAgentState`/`bookingAgentModel.ts`) for everything from option-selection onward — that state machine is
unchanged; it just now gets entered via `optionsReceived` triggered by a chat turn instead of a form submit.

### Removed / deprecated code

Once `agent-booking-chat` is live and wired into `PatientHistoryPage`:

- `agent-intake.ts` / `agent-intake.test.ts` — removed. Its prompt logic and specialty-normalization call move into
  `agent-booking-chat`'s system prompt and `propose_options` handler.
- `agent-find-bookable-options.ts` / `.test.ts` — removed. Its orchestration becomes the tool-calling loop; its
  `lib/` dependencies (`bookableOptions.ts`, `ensurePractitionerAndSchedule.ts`, etc.) are kept and reused.
- `ComplaintForm.tsx` / any tests — removed, replaced by the new chat turn input.
- `agent-find-doctors.ts` is **kept** — `search_previous_physician`/`search_nppes` tools call into its constituent
  functions directly (or the file is kept as-is and both tools call its exported helpers), since `DoctorResultsPage`
  (out of scope, but still routed) also depends on it via the `'agent-find-doctors'` action.

## Deterministic vs Non-Deterministic Boundary

Non-deterministic (model) responsibilities: deciding which tools to call and in what order; deciding when to ask the
patient a clarifying question and what to ask; proposing a specialty, reason, and pre-visit summary; selecting and
explaining up to 8 final options from validated candidates.

Deterministic responsibilities (unchanged in spirit from the existing design, extended to the new surface area):
patient-context loading, NPPES/previous-physician search, schedule provisioning, `$find` availability queries,
specialty-table validation, grounding every model pick against real tool output, the distinct-provider/8-option cap
and its `rankBookableOptions` fallback, session/turn persistence, the step cap, summary `Communication` authoring,
and everything in `agent-book-appointment.ts` (revalidation, `$find` rerun, `$book`, confirmation gating).

The model may decide *what to investigate and how to explain its picks*. It may never invent a provider or slot,
bypass grounding, exceed the option cap, or write or book an `Appointment`.

## Failure Behavior

- Gemini returns plain text instead of a tool call: treated as a clarifying question (see loop algorithm) rather than
  an error — keeps the conversation moving instead of hard-failing on a model formatting slip.
- `propose_options` fails validation (bad specialty, nothing groundable): loop feeds the failure back to the model as
  a tool result and lets it retry within the step budget, rather than surfacing a raw error to the patient.
- Step cap reached: session is marked `stopped`, patient sees a "let's start again" message, no partial/garbled
  option list is ever shown.
- Resuming a `sessionId` that's missing, not `in-progress`, or doesn't belong to `patientId`: rejected the same way
  `agent-book-appointment` rejects a mismatched summary Communication today — generic action failure, no session
  details leaked.
- Individual `check_availability` failures for one candidate: that candidate is simply unavailable to the model for
  this turn (a failed tool call's result is an error the model can see and route around — e.g. try a different
  candidate — same spirit as today's `Promise.allSettled` partial-failure tolerance).
- Selected slot taken at booking time: unchanged — `agent-book-appointment` still returns `slot_taken`, the existing
  `bookingAgentModel.slotTaken()` handling still applies (idea 3's "real" replanning happens one level up, during the
  search chat itself, not at booking time — booking time behavior doesn't change).

## Testing / Verification

- Every tool is a thin wrapper over already-tested `lib/` functions — direct unit tests, no new coverage gaps.
- Loop orchestration: extend the existing `__setGeminiCallerForTests`-style seam so the stub can return a **scripted
  sequence** of tool-calling responses across multiple calls, to exercise multi-turn behavior (ask → resume →
  propose) deterministically without a live Gemini call.
- `propose_options` validation/grounding/cap-and-fallback logic: unit-tested directly and independently of model
  behavior (feed it hand-built picks, including deliberately ungrounded/over-cap ones, assert the corrected output).
- Session persistence: unit-test the read-append-persist cycle against a mock `MedplumClient`, including the
  ownership/status rejection cases.
- Regression: all existing tests for `agent-find-doctors`, `agent-ensure-doctor`, `agent-book-appointment`,
  `bookableOptions`, `ranking`, `schedulingPreferences` continue to pass unchanged, since none of that code's
  behavior changes.
- Final gates: TypeScript, ESLint, focused Vitest files, full Vitest, production build — same bar as every prior
  change in this repo.

## Rollout notes

Recommended build order (to be expanded into a full implementation plan):

1. **Spike**: confirm Gemini's OpenAI-compatible endpoint supports tool/function calling for
   `gemini-3.5-flash-lite` with the exact request/response shape assumed above. This is the one unvalidated external
   assumption the whole design leans on.
2. Session persistence primitives (create/read/update the transcript `Communication`) with tests, independent of the
   loop.
3. Tool implementations (thin wrappers) with tests.
4. Loop orchestration + `propose_options` validation/grounding/fallback, with the scripted-sequence test harness.
5. Wire `agent-booking-chat` into `api/execute.ts`.
6. Frontend: `BookingChatPage`, turn model, wire into `PatientHistoryPage`.
7. Remove `agent-intake`, `agent-find-bookable-options`, `ComplaintForm` and their tests.
8. Full regression pass + manual run-through via `npm run dev:full`.

## Open Questions

- Exact `MAX_STEPS` (8 proposed) and `MAX_BOOKABLE_OPTIONS` (8 proposed) values may need tuning once real latency/cost
  and candidate-availability rates are observed.
- Whether a `stopped` session should be visibly resumable-with-a-fresh-start in the same UI, or whether the patient
  should be routed back to `/agent/:patientId` entirely — left to implementation-time UI judgment, doesn't affect the
  backend design.
