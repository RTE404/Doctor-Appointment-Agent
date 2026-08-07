# Doctor Appointment Agent Remaining Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Tasks 32–37, finish the safe local portion of Task 26, restore repository verification, and record sanitized live-target evidence.

**Architecture:** Keep the existing Medplum-native React application and Bot architecture. Put FHIR orchestration in page components, extract deterministic mapping and validation into small typed modules, and test those modules before wiring them into the UI. Treat seeding, Bot deployment, and end-to-end checks as explicit operational gates rather than inferring success from local builds.

**Tech Stack:** TypeScript 5.9, React 19, Vite 7, Vitest 4, Mantine 8, Medplum 5.1.27, PowerShell, ESLint 9.

## Global Constraints

- Work directly on the current `main` branch, as explicitly approved on 2026-08-07.
- Preserve the existing untracked `src/pages/agent/BookingConfirmationPage.tsx` as the Task 32 starting point.
- Keep all `@medplum/*` dependencies pinned to exactly `5.1.27`.
- The doctor NPI route is a display filter, not authentication or authorization.
- AI responses remain record-grounded and non-diagnostic; no triage, diagnosis, treatment, or clinical-advice behavior may be added.
- Do not expose `.env` values, client secrets, tokens, headers, or full authenticated responses in logs or reports.
- A Bot without its own ProjectMembership is not a successful deployment.
- Each production behavior change follows red-green-refactor; configuration-only and operational steps are verified by their owning commands.
- Commits must contain only the task-owned files and must preserve unrelated user changes.

---

### Task 1: Restore the automated verification baseline

**Files:**
- Create: `eslint.config.mjs`
- Modify: `tools/seed/specialty-resolver.test.ts`

**Interfaces:**
- Consumes: `@medplum/eslint-config` 5.1.27 and the existing 983-bundle corpus completeness test.
- Produces: a runnable `npm run lint` command and a corpus test with enough time to read the real dataset without weakening its assertions.

- [ ] **Step 1: Add the ESLint 9 flat configuration**

```javascript
// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { medplumEslintConfig } from '@medplum/eslint-config';
import { defineConfig } from 'eslint/config';

export default defineConfig(medplumEslintConfig);
```

- [ ] **Step 2: Prove the current corpus test timeout is environmental, not an assertion failure**

Run `npx vitest run tools/seed/specialty-resolver.test.ts --testTimeout=60000`.

Expected: all six tests pass, including the real-corpus completeness assertion.

- [ ] **Step 3: Make the corpus test timeout explicit at the test boundary**

Change only the completeness test call so its final argument is `60_000`. Do not change its resource enumeration, expected map, or assertions.

- [ ] **Step 4: Verify baseline tools**

Run `npm run lint` and `npm test`.

Expected: lint starts successfully and the full test suite has zero failures.

- [ ] **Step 5: Commit**

```powershell
git add eslint.config.mjs tools/seed/specialty-resolver.test.ts
git commit -m "fix(tooling): restore ESLint 9 and corpus test reliability"
```

---

### Task 2: Complete Task 32 booking confirmation

**Files:**
- Create: `src/pages/agent/bookingConfirmation.ts`
- Create: `src/pages/agent/bookingConfirmation.test.ts`
- Modify: `src/pages/agent/BookingConfirmationPage.tsx`

**Interfaces:**
- Consumes: an `Appointment` containing a Practitioner participant and a `Practitioner` containing an NPI identifier.
- Produces: `getPractitionerReference(appointment): string | undefined` and `getPractitionerNpi(practitioner): string | undefined`, plus the `/agent/:patientId/confirmed/:apptId` page.

- [ ] **Step 1: Write failing helper tests**

```typescript
import { getPractitionerNpi, getPractitionerReference } from './bookingConfirmation';

test('finds the practitioner participant without depending on participant order', () => {
  expect(getPractitionerReference({
    resourceType: 'Appointment',
    status: 'booked',
    participant: [
      { actor: { reference: 'Patient/p1' }, status: 'accepted' },
      { actor: { reference: 'Practitioner/pr1' }, status: 'accepted' },
    ],
  })).toBe('Practitioner/pr1');
});

test('returns only the US NPI identifier', () => {
  expect(getPractitionerNpi({
    resourceType: 'Practitioner',
    identifier: [
      { system: 'urn:other', value: 'wrong' },
      { system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' },
    ],
  })).toBe('1234567890');
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run `npx vitest run src/pages/agent/bookingConfirmation.test.ts`.

Expected: fail because `bookingConfirmation.ts` does not exist.

- [ ] **Step 3: Implement the two pure helpers**

Use the exact NPI system `http://hl7.org/fhir/sid/us-npi`. Return `undefined` for missing references or values.

- [ ] **Step 4: Run the helper tests and confirm GREEN**

Run `npx vitest run src/pages/agent/bookingConfirmation.test.ts` and expect both tests to pass.

- [ ] **Step 5: Wire the helpers into the existing page**

Preserve the current layout and copy action. Add a visible red `Alert` for a missing `apptId`, failed Appointment/Practitioner reads, missing practitioner participant, or missing NPI. The page must not remain on an indefinite loader after an error.

- [ ] **Step 6: Verify Task 32**

Run `npx tsc --noEmit` and the focused test.

- [ ] **Step 7: Commit**

```powershell
git add src/pages/agent/BookingConfirmationPage.tsx src/pages/agent/bookingConfirmation.ts src/pages/agent/bookingConfirmation.test.ts
git commit -m "feat(ui): complete booking confirmation with resilient NPI lookup"
```

---

### Task 3: Complete Task 33 doctor lookup

**Files:**
- Create: `src/pages/desk/doctorLookup.ts`
- Create: `src/pages/desk/doctorLookup.test.ts`
- Create: `src/pages/desk/DoctorLookupPage.tsx`

**Interfaces:**
- Produces: `normalizeNpi(value): string` and `isValidNpi(value): boolean`; `/desk` navigates only for a ten-digit NPI.

- [ ] **Step 1: Write failing validation tests**

```typescript
import { isValidNpi, normalizeNpi } from './doctorLookup';

test('normalizes spaces and hyphens from an NPI', () => {
  expect(normalizeNpi(' 12345-67890 ')).toBe('1234567890');
});

test('accepts exactly ten digits', () => {
  expect(isValidNpi('1234567890')).toBe(true);
  expect(isValidNpi('12345')).toBe(false);
  expect(isValidNpi('123456789A')).toBe(false);
});
```

- [ ] **Step 2: Confirm RED, implement minimal helpers, confirm GREEN**

Run `npx vitest run src/pages/desk/doctorLookup.test.ts` before and after creating the helpers.

- [ ] **Step 3: Implement `DoctorLookupPage.tsx`**

Use a controlled `TextInput`, an inline validation message after the field has content, and a disabled submit button until `isValidNpi` is true. Navigate to `/desk/${normalizeNpi(npi)}`. Retain explicit copy that the NPI is a display filter rather than authentication.

- [ ] **Step 4: Verify and commit**

Run TypeScript and the focused test, then commit the three Task 33 files with message `feat(ui): add validated doctor NPI lookup`.

---

### Task 4: Complete Task 34 appointment-keyed doctor queue

**Files:**
- Create: `src/components/desk/PatientBriefCard.tsx`
- Create: `src/components/desk/QueueTable.tsx`
- Create: `src/pages/desk/doctorQueue.ts`
- Create: `src/pages/desk/doctorQueue.test.ts`
- Create: `src/pages/desk/DoctorQueuePage.tsx`

**Interfaces:**
- Produces: `QueueEntry`, `buildQueueEntries(appointments, summaries, patients): QueueEntry[]`, and the `/desk/:npi` queue.
- The summary join key is the Appointment id from `Communication.about`, never Patient id.

- [ ] **Step 1: Write the failing duplicate-patient test**

Create two booked Appointments for the same Patient and Practitioner, two summary Communications whose `about` references point to different Appointment ids, and one Patient. Assert that `buildQueueEntries` returns two entries keyed by different `appointmentId` values and preserves the correct summary on each.

- [ ] **Step 2: Confirm RED**

Run `npx vitest run src/pages/desk/doctorQueue.test.ts` and expect a missing-module failure.

- [ ] **Step 3: Implement the pure join**

Index summaries by `communication.about?.[0]?.reference`, index patients by id, map one output per Appointment, ignore Appointments without both id and Patient reference, and retain `description`, `start`, and Patient display name.

- [ ] **Step 4: Confirm GREEN**

Run `npx vitest run src/pages/desk/doctorQueue.test.ts` and expect the duplicate-patient regression to pass.

- [ ] **Step 5: Implement queue presentation and loading**

`PatientBriefCard` renders patient name, stated issue, optional summary, and appointment date. `QueueTable` uses `appointmentId` as its React key. `DoctorQueuePage` validates `npi`, finds the Practitioner, fetches Appointments and summary Communications, loads unique Patients, passes all resources through `buildQueueEntries`, and renders distinct loading, empty, and error states.

- [ ] **Step 6: Verify and commit**

Run TypeScript and the focused test, then commit the five Task 34 files with message `fix(ui): join doctor queue summaries by appointment`.

---

### Task 5: Complete Task 35 record-grounded doctor chat

**Files:**
- Create: `src/components/desk/agentChat.ts`
- Create: `src/components/desk/agentChat.test.ts`
- Create: `src/components/desk/AgentChat.tsx`
- Create: `src/pages/desk/PatientAgentChatPage.tsx`

**Interfaces:**
- Produces: `prepareQuestion(value): string | undefined`, `ChatTurn`, the `AgentChat` component, and `/desk/:npi/patients/:patientId`.
- Consumes: `agent-patient-chat` with `{ npi, patientId, question, threadId }` and `{ answer, threadId }` output.

- [ ] **Step 1: Write failing question-boundary tests**

```typescript
import { prepareQuestion } from './agentChat';

test('trims a non-empty question', () => {
  expect(prepareQuestion('  What medications are they on?  ')).toBe('What medications are they on?');
});

test('rejects a whitespace-only question', () => {
  expect(prepareQuestion('   ')).toBeUndefined();
});
```

- [ ] **Step 2: Confirm RED, implement the helper, and confirm GREEN**

Run `npx vitest run src/components/desk/agentChat.test.ts` before and after creating the helper.

- [ ] **Step 3: Implement `AgentChat.tsx`**

Render the non-diagnostic notice, example questions, prior turns, loader, textarea, and submit button. Pass only `prepareQuestion` output to `onAsk`. Disable every submission control while a request is active and restore it in `finally`.

- [ ] **Step 4: Implement `PatientAgentChatPage.tsx`**

Validate both route parameters before calling the Bot. Preserve `threadId` across turns, append only successful responses, and show a visible normalized error without losing prior turns.

- [ ] **Step 5: Verify and commit**

Run TypeScript and the focused test, then commit the four Task 35 files with message `feat(ui): add guarded record-grounded doctor chat`.

---

### Task 6: Make Task 26 deployment fail closed and retry the live deployment

**Files:**
- Modify: `tools/deploy-bots-direct.ts`
- Create: `tools/deploy-bots-direct.test.ts`

**Interfaces:**
- Produces: `getOrCreateDeploymentBot(medplum, projectId, botName)` that either returns a properly initialized Bot or throws an actionable project-admin error.
- Removes: the bare `createResource(Bot)` fallback that creates a Bot without ProjectMembership.

- [ ] **Step 1: Write the failing forbidden-path test**

Construct an `OperationOutcomeError` whose outcome id is `forbidden`. Use a minimal client double where `searchOne` returns `undefined`, `post` rejects with that error, and `createResource` records if it is called. Assert that `getOrCreateDeploymentBot` rejects with `Project administrator access is required` and that `createResource` is never called.

- [ ] **Step 2: Confirm RED**

Run `npx vitest run tools/deploy-bots-direct.test.ts` and expect the helper export to be missing.

- [ ] **Step 3: Extract and implement fail-closed creation**

Export `getOrCreateDeploymentBot`. Search by Bot name first. When creation returns forbidden, throw an actionable error naming the Bot and required `admin: true` ProjectMembership. Never create a bare Bot. Add an ESM main-module guard so importing the file in the test does not execute deployment.

- [ ] **Step 4: Confirm GREEN and build all Bots**

Run the focused test and `npm run build:bots`.

- [ ] **Step 5: Run the deployment with sanitized output**

Run `npx tsx tools/deploy-bots-direct.ts`.

Expected success: seven `Deployed <name>` lines and exit code 0. If the target returns `Bots not enabled` or rejects project-admin Bot creation, capture only Bot names, HTTP/outcome status, and the administrator action; do not capture credentials or headers.

- [ ] **Step 6: Commit the safe deployment behavior**

Commit both deployment files with message `fix(deploy): require runnable bot memberships`.

---

### Task 7: Run Task 36 full-corpus seed with target-safe evidence

**Files:**
- Create: `docs/superpowers/reports/2026-08-07-completion-verification.md`

**Interfaces:**
- Consumes: `tools/seed/index.ts --slim --all`, `.env`, and all 983 source bundles.
- Produces: 983 manifest-complete uploads plus sanitized duplicate-NPI spot checks, or a precise live-target blocker.

- [ ] **Step 1: Identify the configured target without printing credentials**

Print only the base URL hostname, authenticated project id, current manifest entry count, and whether the current ProjectMembership has `admin: true`. Do not print client ids, secrets, tokens, headers, or full resources.

- [ ] **Step 2: Resolve manifest safety**

If the manifest cannot be proven to belong to the same project and current transform, move it to a timestamped file under the system temporary directory. Do not permanently delete it. Record the backup path in the verification report.

- [ ] **Step 3: Run the complete slim corpus**

Run `npx tsx tools/seed/index.ts --slim --all`.

Expected: `Done. Uploaded 983 bundles this run (983 total per manifest).`

- [ ] **Step 4: Verify five deterministic NPIs**

Choose five NPIs deterministically from the sorted seeded Practitioner identifiers. Search each through the target API and record only the NPI and result count. Every count must be exactly one.

- [ ] **Step 5: Record the outcome**

Add target hostname, project id, command, start/end timestamps, selected bundle count, completion status, and the five duplicate checks to the verification report. If blocked, record the sanitized outcome and required external action.

---

### Task 8: Execute Task 37 end-to-end verification and close the branch

**Files:**
- Modify: `docs/superpowers/reports/2026-08-07-completion-verification.md`
- Modify: `docs/superpowers/plans/2026-08-04-medplum-native-implementation.md`

**Interfaces:**
- Produces: pass/fail/blocked evidence for patient flow, doctor flow, conflict handling, native cancellation, rescheduling, and doctor-scoped availability blocking.

- [ ] **Step 1: Start and open the application**

Run `npm run dev -- --host 127.0.0.1 --port 5173`. Use the in-app browser with the existing signed-in state if available. Do not bypass authentication.

- [ ] **Step 2: Verify the complete patient flow**

Pick a seeded Patient, inspect history, submit a complaint, select a ranked doctor, load a slot, book it, and confirm the correct time and copyable NPI. Record the Patient, Practitioner NPI, and Appointment id only.

- [ ] **Step 3: Verify the complete doctor flow**

Enter the same NPI, confirm the Appointment-specific queue row and summary, ask one factual record question, and ask one diagnostic-framed question. Confirm the latter returns the fixed refusal and both successful turns persist as threaded Communications.

- [ ] **Step 4: Verify scheduling regressions**

Attempt the same slot for a second Patient and confirm `slot_taken`; cancel a disposable booking and confirm its Slot is deleted; attempt an unavailable reschedule and confirm the original remains booked; block one doctor's interval and confirm other doctors' Appointments remain unchanged.

- [ ] **Step 5: Run the full local gate**

Run `npm run lint`, `npm test`, `npm run build`, `git diff --check`, and `git status --short`.

Expected: all commands exit 0 and only the intended verification-report and progress-log changes remain.

- [ ] **Step 6: Update progress truthfully**

Update the original plan's progress log with Tasks 26–37. Mark operational tasks `done` only when live checks pass; otherwise mark them `externally blocked` and include the exact report link. Do not claim release readiness when a live gate is blocked.

- [ ] **Step 7: Commit verification evidence**

Commit the report and original progress log with message `docs: record remaining-task verification outcomes`.

---

## Self-Review

- **Spec coverage:** Tasks 2–5 implement original Tasks 32–35; Task 6 safely completes the local portion of Task 26; Task 7 covers Task 36; Task 8 covers Task 37 and final verification.
- **Repository health:** Task 1 owns the known ESLint 9 and corpus-timeout failures; Tasks 3–5 create the modules currently missing from `App.tsx`; Task 8 owns the combined clean gate.
- **Type consistency:** Queue entries are keyed by `appointmentId`; chat calls include both `npi` and `patientId`; confirmation resolves a Practitioner reference before NPI lookup; all Medplum packages remain pinned to 5.1.27.
- **Safety:** Live commands do not print secrets, manifest state is backed up rather than destroyed, bare Bot creation is removed, and external administrative blockers remain explicit.
