# Patient Appointment Concierge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one working patient-facing agent that turns a complaint and three scheduling preferences into ranked appointments from up to three distinct providers in the next seven days and books one only after explicit confirmation.

**Architecture:** Keep the current Medplum/Vercel action architecture. Extend the existing Gemini intake call to return validated request-scoped preferences, add one `agent-find-bookable-options` action that composes existing doctor search, schedule provisioning, and `Appointment/$find`, then reuse `agent-book-appointment` unchanged behind a deterministic UI confirmation state. Do not add a general tool-calling loop, a database, or persistent agent memory.

**Tech Stack:** TypeScript 5.9, React 19, Mantine 8, Medplum 5.1.27, Gemini OpenAI-compatible chat completions, Vitest 4, Vite 7.

## Global Constraints

- Target implementation and verification time: four hours maximum.
- Agent tools: exactly `agent-find-bookable-options` and the existing `agent-book-appointment`.
- Search window: current instant through exactly seven days later.
- Preferences: time of day, previous matching doctor, and proximity only.
- Deterministic ranking: time-of-day match, previous matching doctor, known shorter distance, then earlier slot.
- Return only the best-ranked slot per provider so the final options contain distinct provider NPIs.
- Preferences are soft ranking signals and are never persisted.
- Routing: explicit specialty/referral; clear supported mapping; one clarification for ambiguity; `General Practice` when no specialty preference exists.
- Do not add patient-side specialty correction or revision.
- Do not expose specialty routing, seven-day defaults, or ranking internals in patient-facing copy.
- Do not diagnose, triage, recommend treatment, or let Gemini write or rank appointments.
- Preserve the existing authoritative booking validation and `slot_taken` behavior.
- Preserve every pre-existing worktree change. Do not pull, rebase, reset, or stage unrelated hunks.
- Do not add dependencies.

## File Structure

**Create**

- `src/bots/agent/lib/schedulingPreferences.ts`: shared preference types, runtime normalization, time-of-day bucketing.
- `src/bots/agent/lib/schedulingPreferences.test.ts`: preference and time-bucket unit tests.
- `src/bots/agent/lib/bookableOptions.ts`: bookable-option type and pure deterministic ranking.
- `src/bots/agent/lib/bookableOptions.test.ts`: ranking-priority and cap tests.
- `src/bots/agent/agent-find-bookable-options.ts`: composite first tool.
- `src/bots/agent/agent-find-bookable-options.test.ts`: orchestration tests with injected dependencies.
- `src/components/agent/BookableOptionCard.tsx`: grounded option presentation and selection control.
- `src/pages/agent/bookingAgentModel.ts`: deterministic UI state and confirmation gate.
- `src/pages/agent/bookingAgentModel.test.ts`: state-transition tests.

**Modify**

- `src/bots/agent/lib/prompts.ts`: request structured preferences and enforce the approved routing policy.
- `src/bots/agent/lib/prompts.test.ts`: assert the new prompt contract and retained clinical limits.
- `src/bots/agent/agent-intake.ts`: validate and return preferences with successful intake.
- `src/bots/agent/agent-intake.test.ts`: cover preferences, general-care result, and clarification.
- `api/execute.ts`: register `agent-find-bookable-options` and provide its Gemini secret.
- `api/execute.test.ts`: cover allowlisting, dispatch, secret scoping, and generic failures.
- `src/pages/agent/PatientHistoryPage.tsx`: replace the multi-page doctor/slot handoff with the two-tool agent flow.

**Reuse unchanged**

- `src/bots/agent/agent-find-doctors.ts`
- `src/bots/agent/lib/ensurePractitionerAndSchedule.ts`
- `src/bots/agent/agent-book-appointment.ts`
- `src/pages/agent/BookingConfirmationPage.tsx`
- `src/api/executeAction.ts`
- `src/components/agent/ComplaintForm.tsx`

---

### Task 1: Extend intake with validated scheduling preferences

**Time box:** 30 minutes

**Files:**
- Create: `src/bots/agent/lib/schedulingPreferences.ts`
- Create: `src/bots/agent/lib/schedulingPreferences.test.ts`
- Modify: `src/bots/agent/lib/prompts.ts`
- Modify: `src/bots/agent/lib/prompts.test.ts`
- Modify: `src/bots/agent/agent-intake.ts`
- Modify: `src/bots/agent/agent-intake.test.ts`

**Interfaces:**
- Produces: `SchedulingPreferences`, `normalizeSchedulingPreferences(value)`, and successful `IntakeResult.preferences`.
- Consumed by: `agent-find-bookable-options.ts` and `bookableOptions.ts` in later tasks.

- [ ] **Step 1: Write preference normalization tests**

Create tests that require accepted enum values, safe boolean defaults, and timezone-aware buckets:

```ts
import { describe, expect, test } from 'vitest';
import { normalizeSchedulingPreferences, timeOfDayAt } from './schedulingPreferences';

describe('normalizeSchedulingPreferences', () => {
  test('accepts only the three approved preference fields', () => {
    expect(
      normalizeSchedulingPreferences({
        timeOfDay: 'morning',
        preferPreviousDoctor: true,
        preferNearby: true,
        unsupported: 'ignored',
      })
    ).toEqual({ timeOfDay: 'morning', preferPreviousDoctor: true, preferNearby: true });
  });

  test('fails closed to unset and false for malformed model output', () => {
    expect(normalizeSchedulingPreferences({ timeOfDay: 'night', preferPreviousDoctor: 'yes' })).toEqual({
      timeOfDay: undefined,
      preferPreviousDoctor: false,
      preferNearby: false,
    });
  });
});

describe('timeOfDayAt', () => {
  test('uses the doctor schedule timezone', () => {
    expect(timeOfDayAt('2026-08-12T13:00:00Z', 'America/New_York')).toBe('morning');
    expect(timeOfDayAt('2026-08-12T18:00:00Z', 'America/New_York')).toBe('afternoon');
    expect(timeOfDayAt('2026-08-12T22:00:00Z', 'America/New_York')).toBe('evening');
  });
});
```

- [ ] **Step 2: Run the new tests and verify failure**

Run:

```powershell
npx vitest run src/bots/agent/lib/schedulingPreferences.test.ts
```

Expected: FAIL because `schedulingPreferences.ts` does not exist.

- [ ] **Step 3: Implement the exact preference contract**

Create:

```ts
export type TimeOfDay = 'morning' | 'afternoon' | 'evening';

export interface SchedulingPreferences {
  timeOfDay?: TimeOfDay;
  preferPreviousDoctor: boolean;
  preferNearby: boolean;
}

const TIME_VALUES = new Set<TimeOfDay>(['morning', 'afternoon', 'evening']);

export function normalizeSchedulingPreferences(value: unknown): SchedulingPreferences {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const timeOfDay = TIME_VALUES.has(record.timeOfDay as TimeOfDay) ? (record.timeOfDay as TimeOfDay) : undefined;
  return {
    timeOfDay,
    preferPreviousDoctor: record.preferPreviousDoctor === true,
    preferNearby: record.preferNearby === true,
  };
}

export function timeOfDayAt(instant: string, timeZone: string): TimeOfDay {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(instant))
  );
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}
```

- [ ] **Step 4: Extend the Gemini intake prompt and tests**

Require strict JSON with this shape:

```text
{"specialty": string, "reason": string, "summary": string, "preferences": {"timeOfDay": "morning" | "afternoon" | "evening" | null, "preferPreviousDoctor": boolean, "preferNearby": boolean}}
```

Add these routing instructions to `INTAKE_SYSTEM_PROMPT`:

```text
Use an explicitly named specialty or referral when present. Otherwise map a clear complaint to one supported scheduling specialty. Use General Practice when the patient gives no specialty preference and no clear specialist request. If the complaint is genuinely ambiguous, return a specialty value that cannot normalize so the application asks one clarification. Extract only time of day, preference for a previously seen matching doctor, and preference for proximity. These are scheduling signals, never clinical conclusions.
```

Assert the prompt still prohibits diagnosis, treatment, and urgency classification.

- [ ] **Step 5: Extend intake types and runtime normalization**

Change the model and successful result shapes to:

```ts
interface GeminiIntakeResult {
  specialty: string;
  reason: string;
  summary: string;
  preferences?: unknown;
}

export type IntakeResult =
  | {
      intent: { specialtyCode: string; specialtyLabel: string; reason: string };
      summaryCommunicationId: string;
      preferences: SchedulingPreferences;
    }
  | { needsClarification: true };
```

Return `preferences: normalizeSchedulingPreferences(geminiResult.preferences)` only after specialty normalization succeeds. Do not persist preferences in the FHIR Communication.

- [ ] **Step 6: Update intake tests and run focused coverage**

Add successful model output containing morning, previous-doctor, and nearby preferences. Assert the returned values are normalized. Add `specialty: 'General Practice'` and assert code `208D00000X`. Retain the unsupported-specialty clarification test.

Run:

```powershell
npx vitest run src/bots/agent/lib/schedulingPreferences.test.ts src/bots/agent/lib/prompts.test.ts src/bots/agent/agent-intake.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit only this task's hunks**

Because `agent-intake.ts` and its test were already modified before this feature, stage interactively:

```powershell
git add src/bots/agent/lib/schedulingPreferences.ts src/bots/agent/lib/schedulingPreferences.test.ts
git add -p src/bots/agent/lib/prompts.ts src/bots/agent/lib/prompts.test.ts src/bots/agent/agent-intake.ts src/bots/agent/agent-intake.test.ts
git diff --cached --check
git commit -m "feat: extract concierge scheduling preferences"
```

---

### Task 2: Implement deterministic bookable-option ranking

**Time box:** 25 minutes

**Files:**
- Create: `src/bots/agent/lib/bookableOptions.ts`
- Create: `src/bots/agent/lib/bookableOptions.test.ts`

**Interfaces:**
- Consumes: `SchedulingPreferences` and `timeOfDayAt` from Task 1.
- Produces: `BookableOption` and `rankBookableOptions(options, preferences, limit)`.
- Consumed by: the composite action in Task 3 and UI in Task 5.

- [ ] **Step 1: Write ranking tests before implementation**

Use fixtures that force every priority boundary:

```ts
const options: BookableOption[] = [
  option('afternoon-previous-near', '2026-08-12T18:00:00Z', true, 1),
  option('morning-new-near', '2026-08-12T13:00:00Z', false, 1),
  option('morning-previous-far', '2026-08-12T14:00:00Z', true, 20),
  option('morning-previous-near', '2026-08-12T15:00:00Z', true, 2),
];

expect(
  rankBookableOptions(options, {
    timeOfDay: 'morning',
    preferPreviousDoctor: true,
    preferNearby: true,
  }).map((item) => item.id)
).toEqual(['morning-previous-near', 'morning-previous-far', 'morning-new-near']);
```

Also prove that distance is skipped when `preferNearby` is false, unknown distance sorts last when it is true, and the default limit is three.

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npx vitest run src/bots/agent/lib/bookableOptions.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the option type and lexicographic comparator**

Use this public type:

```ts
export interface BookableOption {
  id: string;
  npi: string;
  practitionerId: string;
  scheduleId: string;
  doctorName: string;
  start: string;
  end: string;
  timeZone: string;
  previousDoctor: boolean;
  distanceMiles?: number;
}
```

Implement a stable copy-sort. Compare time match only when `preferences.timeOfDay` exists, previous doctor only when requested, and distance only when requested. Finish with `Date.parse(left.start) - Date.parse(right.start)` and `left.id.localeCompare(right.id)` so ties are deterministic. Return `.slice(0, limit)` with `limit = 3`.

- [ ] **Step 4: Run focused tests**

Run:

```powershell
npx vitest run src/bots/agent/lib/bookableOptions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/bots/agent/lib/bookableOptions.ts src/bots/agent/lib/bookableOptions.test.ts
git diff --cached --check
git commit -m "feat: rank bookable appointment options"
```

---

### Task 3: Add the `agent-find-bookable-options` tool

**Time box:** 65 minutes

**Files:**
- Create: `src/bots/agent/agent-find-bookable-options.ts`
- Create: `src/bots/agent/agent-find-bookable-options.test.ts`

**Interfaces:**
- Consumes: successful `IntakeResult`, `agent-find-doctors`, `ensurePractitionerAndSchedule`, `timezoneForState`, and `rankBookableOptions`.
- Produces: `FindBookableOptionsInput`, `FindBookableOptionsResult`, and `handler`.
- Consumed by: API dispatch in Task 4 and the page in Task 5.

- [ ] **Step 1: Define the public action contract in a failing test**

Use:

```ts
export type FindBookableOptionsInput = {
  patientId: string;
  complaintText: string;
};

export type FindBookableOptionsResult =
  | { needsClarification: true }
  | {
      options: BookableOption[];
      preferences: SchedulingPreferences;
      summaryCommunicationId: string;
    };
```

The UI must not receive `specialtyLabel`, `specialtyCode`, or ranking internals.

- [ ] **Step 2: Add dependency seams and orchestration tests**

Define injectable dependencies with production defaults:

```ts
interface Dependencies {
  intake: typeof intakeHandler;
  findDoctors: typeof findDoctorsHandler;
  ensureDoctor: typeof ensurePractitionerAndSchedule;
  now: () => Date;
}
```

Export `__setDependenciesForTests(overrides: Partial<Dependencies>)`. Tests must prove:

- clarification returns immediately without doctor search;
- `$find` receives `start = now` and `end = now + 7 days`;
- only the first five doctor candidates are provisioned;
- one failed candidate does not discard successful candidates;
- all candidate failures throw a generic action error;
- results are ranked and capped at three;
- no specialty appears in the returned object.

- [ ] **Step 3: Run the orchestration test and verify failure**

Run:

```powershell
npx vitest run src/bots/agent/agent-find-bookable-options.test.ts
```

Expected: FAIL because the handler does not exist.

- [ ] **Step 4: Compose the existing intake and doctor-search handlers**

Inside `handler`:

```ts
const intake = await dependencies.intake(medplum, event as BotEvent<IntakeInput>);
if ('needsClarification' in intake) {
  return intake;
}

const doctors = await dependencies.findDoctors(medplum, {
  ...event,
  input: { patientId: event.input.patientId, specialtyCode: intake.intent.specialtyCode },
} as BotEvent<FindDoctorsInput>);
```

Reuse the same `event.secrets`; do not make a second Gemini call.

- [ ] **Step 5: Fetch seven-day availability for a bounded candidate set**

For `doctors.candidates.slice(0, 5)`, call `ensurePractitionerAndSchedule(medplum, candidate.npi, candidate)`. Build the verified Medplum URL:

```ts
const findUrl = medplum.fhirUrl('Appointment', '$find');
findUrl.searchParams.set('service-type-reference', `HealthcareService/${healthcareServiceId}`);
findUrl.searchParams.set('schedule', `Schedule/${scheduleId}`);
findUrl.searchParams.set('start', start.toISOString());
findUrl.searchParams.set('end', end.toISOString());
findUrl.searchParams.set('_count', '100');
```

Map every proposed Appointment with `start` and `end` into `BookableOption`. Set:

```ts
id: `${practitionerId}|${scheduleId}|${appointment.start}|${appointment.end}`
doctorName: `Dr. ${candidate.firstName} ${candidate.lastName}`.trim()
previousDoctor: candidate.source === 'previous'
distanceMiles: candidate.distanceMiles
timeZone: timezoneForState(candidate.address.state)
```

Use `Promise.allSettled` across candidates. If at least one candidate succeeds, ignore failed candidates. If candidates exist and every candidate fails, throw `Unable to retrieve appointment availability`. Empty doctor results return an empty options array.

- [ ] **Step 6: Rank and return grounded results**

Return:

```ts
return {
  options: rankBookableOptions(allOptions, intake.preferences, 3),
  preferences: intake.preferences,
  summaryCommunicationId: intake.summaryCommunicationId,
};
```

Do not ask Gemini to rank or phrase doctor data.

- [ ] **Step 7: Run focused tests**

Run:

```powershell
npx vitest run src/bots/agent/lib/bookableOptions.test.ts src/bots/agent/agent-find-bookable-options.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/bots/agent/agent-find-bookable-options.ts src/bots/agent/agent-find-bookable-options.test.ts
git diff --cached --check
git commit -m "feat: find ranked bookable options"
```

---

### Task 4: Register the new action at the authenticated API boundary

**Time box:** 15 minutes

**Files:**
- Modify: `api/execute.ts`
- Modify: `api/execute.test.ts`

**Interfaces:**
- Consumes: `agent-find-bookable-options.handler` from Task 3.
- Produces: authenticated `/api/execute` dispatch for action name `agent-find-bookable-options` with `GEMINI_API_KEY` injected server-side.

- [ ] **Step 1: Add failing API tests**

Add `agent-find-bookable-options` to the expected allowlist. Add it to the parameterized Gemini-secret test and assert its handler receives `event.secrets.GEMINI_API_KEY`. Add it to the missing-key failure test. Retain the rule that `agent-book-appointment` receives no Gemini secret.

- [ ] **Step 2: Run focused API tests and verify failure**

Run:

```powershell
npx vitest run api/execute.test.ts
```

Expected: FAIL because the action is not registered.

- [ ] **Step 3: Register imports, action name, handler, and secret scope**

Apply these exact additions:

```ts
import { handler as agentFindBookableOptionsHandler } from '../src/bots/agent/agent-find-bookable-options.js';
import type { FindBookableOptionsInput } from '../src/bots/agent/agent-find-bookable-options.js';
```

Add `'agent-find-bookable-options'` to `ALLOWED_ACTIONS`, add it to `GEMINI_ACTIONS`, and add:

```ts
'agent-find-bookable-options': (medplum, event) =>
  agentFindBookableOptionsHandler(medplum, event as BotEvent<FindBookableOptionsInput>),
```

- [ ] **Step 4: Run API tests**

Run:

```powershell
npx vitest run api/execute.test.ts src/api/executeAction.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit only the new action hunks**

Both API files were already modified before this feature, so stage interactively:

```powershell
git add -p api/execute.ts api/execute.test.ts
git diff --cached --check
git commit -m "feat: expose bookable options action"
```

---

### Task 5: Build the patient agent response and confirmation flow

**Time box:** 65 minutes

**Files:**
- Create: `src/components/agent/BookableOptionCard.tsx`
- Create: `src/pages/agent/bookingAgentModel.ts`
- Create: `src/pages/agent/bookingAgentModel.test.ts`
- Modify: `src/pages/agent/PatientHistoryPage.tsx`

**Interfaces:**
- Consumes: `FindBookableOptionsResult`, `BookableOption`, existing `BookInput`, existing `BookResult`, and `executeAction`.
- Produces: the approved patient-facing flow on existing route `/agent/:patientId`.

- [ ] **Step 1: Write the deterministic state-model tests**

Define phases:

```ts
export type BookingAgentPhase =
  | 'collecting'
  | 'searching'
  | 'clarifying'
  | 'showing-options'
  | 'confirming'
  | 'booking'
  | 'error';
```

Tests must prove:

- the first ambiguous result enters `clarifying`;
- a second ambiguous result enters `error`;
- selecting an option enters `confirming` with that exact option;
- booking cannot start unless phase is `confirming` and a selected option exists;
- `slot_taken` removes the selected option and returns to remaining results;
- successful search stores `summaryCommunicationId` and at most three options.

- [ ] **Step 2: Run the model test and verify failure**

Run:

```powershell
npx vitest run src/pages/agent/bookingAgentModel.test.ts
```

Expected: FAIL because the model does not exist.

- [ ] **Step 3: Implement the minimal pure state model**

Export an initial state and pure transitions named:

```ts
initialBookingAgentState
searchStarted(state, complaintText)
clarificationRequested(state)
optionsReceived(state, result)
optionSelected(state, option)
bookingStarted(state)
slotTaken(state)
```

`bookingStarted` must throw `Booking confirmation is not pending` unless the state is in `confirming` with `selectedOption` and `summaryCommunicationId`.

- [ ] **Step 4: Create the grounded option card**

`BookableOptionCard` accepts `{ option, number, onSelect, disabled }`. It formats date and time with `Intl.DateTimeFormat` using `option.timeZone`, shows `Previously visited` or `New doctor`, shows distance only when defined, and renders one `Select option {number}` button. It contains no specialty, routing, search-window, or ranking copy.

- [ ] **Step 5: Replace the current handoff in `PatientHistoryPage`**

Keep `PatientSummary`, `EncounterHistoryList`, `ComplaintForm`, generic error handling, and the existing `/agent/:patientId` route. Remove `IntentCard` from the rendered agent response and stop navigating to `/doctors` after intake.

On complaint submission, call:

```ts
executeAction<FindBookableOptionsInput, FindBookableOptionsResult>(
  medplum,
  'agent-find-bookable-options',
  { patientId: patientId as string, complaintText }
)
```

When clarification is requested once, render the existing clarification alert and accept one more complaint submission. On a second clarification request, show `I couldn't match that request to a supported doctor category.` and disable further submission for that request.

When options exist, render exactly:

```text
Here are the best available options:
```

Then render numbered cards, followed by:

```text
Option 1 best matches your preferences.
Which option would you like to book?
```

Omit the Option 1 sentence when the result is empty. Empty results show `No appointments are available in the next seven days.`

- [ ] **Step 6: Add the explicit confirmation panel**

After selection, repeat the exact doctor, formatted date, time, previous/new status, and distance when known. Render:

```text
This appointment has not been booked yet. Do you confirm the booking?
```

Only the confirmation button may call:

```ts
executeAction<BookInput, BookResult>(medplum, 'agent-book-appointment', {
  patientId: patientId as string,
  practitionerId: selectedOption.practitionerId,
  scheduleId: selectedOption.scheduleId,
  start: selectedOption.start,
  end: selectedOption.end,
  summaryCommunicationId,
});
```

On success, navigate to the existing `/agent/${patientId}/confirmed/${appointment.id}` route. On `slot_taken`, remove the selected option, show `That appointment was just taken. Please choose one of the remaining options.`, and never report success.

- [ ] **Step 7: Run focused UI and action tests**

Run:

```powershell
npx vitest run src/pages/agent/bookingAgentModel.test.ts src/bots/agent/agent-find-bookable-options.test.ts src/bots/agent/agent-book-appointment.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/components/agent/BookableOptionCard.tsx src/pages/agent/bookingAgentModel.ts src/pages/agent/bookingAgentModel.test.ts src/pages/agent/PatientHistoryPage.tsx
git diff --cached --check
git commit -m "feat: add patient appointment concierge flow"
```

---

### Task 6: Run release gates and one end-to-end smoke test

**Time box:** 25 minutes

**Files:**
- Modify only files implicated by a failing gate.
- Record verification in the final handoff; do not create another report unless requested.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified build evidence and a working synthetic booking flow.

- [ ] **Step 1: Verify formatting and types**

Run:

```powershell
npx tsc --noEmit
npm run lint
```

Expected: both exit 0. If lint reports a pre-existing failure outside planned files, record it separately and do not alter unrelated code.

- [ ] **Step 2: Run focused and full tests**

Run:

```powershell
npx vitest run src/bots/agent/lib/schedulingPreferences.test.ts src/bots/agent/lib/bookableOptions.test.ts src/bots/agent/agent-intake.test.ts src/bots/agent/agent-find-bookable-options.test.ts src/bots/agent/agent-book-appointment.test.ts src/pages/agent/bookingAgentModel.test.ts api/execute.test.ts
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Run the production build**

Run:

```powershell
npm run build
```

Expected: TypeScript and Vite build exit 0 and produce `dist/`.

- [ ] **Step 4: Perform the synthetic end-to-end flow**

With the existing configured environment, open the patient agent and submit:

```text
I have had pain in my throat and constant coughing for the past two days. Find me a nearby doctor. I prefer mornings and someone I've seen before.
```

Verify all of the following:

- response begins with `Here are the best available options:`;
- no routing, seven-day, or ranking explanation appears;
- at most three factual doctor-and-time options appear;
- morning outranks previous doctor, previous doctor outranks proximity, and proximity outranks earliest where the fixture data creates those conflicts;
- selecting an option does not book it;
- confirmation repeats the exact selected details;
- only the confirmation control books;
- success opens the existing confirmation page and shows a real Appointment id;
- the new Appointment is present in Medplum with the selected practitioner, patient, start, end, reason, and complaint;
- cancellation or rescheduling behavior was not changed.

- [ ] **Step 5: Audit the final diff**

Run:

```powershell
git status --short
git diff --check
git diff --stat
```

Expected: only the files listed in this plan contain concierge changes; all pre-existing unrelated modifications remain preserved.

- [ ] **Step 6: Commit verification-only fixes when present**

If release gates required concierge-specific fixes, stage only those hunks and commit:

```powershell
git add -p
git diff --cached --check
git commit -m "fix: complete concierge verification"
```

If no fixes were required, do not create an empty commit.

## Four-Hour Critical Path

1. Task 1: 30 minutes.
2. Task 2: 25 minutes.
3. Task 3: 65 minutes.
4. Task 4: 15 minutes.
5. Task 5: 65 minutes.
6. Task 6: 25 minutes.

Total: 225 minutes, leaving a 15-minute buffer inside the four-hour deadline. Do not cut the explicit confirmation gate, booking revalidation, deterministic ranking tests, or final build.
