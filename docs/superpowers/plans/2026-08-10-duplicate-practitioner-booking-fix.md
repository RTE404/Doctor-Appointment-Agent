# Duplicate Practitioner Booking Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent concurrent doctor provisioning from creating duplicate FHIR resources and make existing duplicate-NPI bookings visible and usable in Doctor Desk.

**Architecture:** Use Medplum conditional creates for Practitioner, PractitionerRole, and Schedule. Read all Practitioner resources matching an NPI in Doctor Desk and patient chat, then combine or select the records that own the relevant Appointment relationships without rewriting existing data.

**Tech Stack:** TypeScript 5.9, React 19, Medplum 5.1, FHIR R4, Vitest 4, `@medplum/mock`.

## Global Constraints

- Preserve existing FHIR resources; do not delete, merge, or rewrite duplicates.
- Keep NPI entry as a display filter, not authentication.
- Do not remove React Strict Mode.
- Preserve unrelated working-tree changes, especially existing Gemini model edits.
- Observe a focused RED test before each production change.

---

### Task 1: Concurrency-safe doctor provisioning

**Files:**
- Modify: `src/bots/agent/lib/ensurePractitionerAndSchedule.test.ts`
- Modify: `src/bots/agent/lib/ensurePractitionerAndSchedule.ts:119-166`

**Interfaces:**
- Consumes: `MedplumClient.createResourceIfNoneExist<T>(resource, query)`.
- Produces: unchanged `ensurePractitionerAndSchedule(...)` return type with concurrent idempotency.

- [ ] **Step 1: Write the failing concurrent regression test**

Run two calls in `Promise.all` for the same candidate and assert identical returned Practitioner and Schedule IDs plus exactly one matching Practitioner and Schedule in `MockClient`:

```ts
const [first, second] = await Promise.all([
  ensurePractitionerAndSchedule(medplum, candidate.npi, candidate),
  ensurePractitionerAndSchedule(medplum, candidate.npi, candidate),
]);
const practitioners = await medplum.searchResources('Practitioner', {
  identifier: 'http://hl7.org/fhir/sid/us-npi|1234567890',
});
const schedules = await medplum.searchResources('Schedule', {
  actor: `Practitioner/${first.practitionerId}`,
});
expect(second.practitionerId).toBe(first.practitionerId);
expect(second.scheduleId).toBe(first.scheduleId);
expect(practitioners).toHaveLength(1);
expect(schedules).toHaveLength(1);
```

- [ ] **Step 2: Verify RED**

Run `npx vitest run src/bots/agent/lib/ensurePractitionerAndSchedule.test.ts`.

Expected: the concurrent test observes different IDs or multiple resources because creation is a separate step after lookup.

- [ ] **Step 3: Implement conditional creation**

Add:

```ts
function conditionalQuery(parameters: Record<string, string>): string {
  return new URLSearchParams(parameters).toString();
}
```

Keep the fast Practitioner lookup, but use `createResourceIfNoneExist` when absent with:

```ts
conditionalQuery({ identifier: `${NPI_SYSTEM}|${npi}` })
```

After Practitioner resolution, search PractitionerRole by `Practitioner/<id>`. When absent, resolve NPPES metadata if needed and conditionally create with:

```ts
conditionalQuery({
  practitioner: practitionerReference,
  specialty: `${NUCC_SYSTEM}|${doctor.nuccCode}`,
})
```

Conditionally create the Schedule when absent with:

```ts
conditionalQuery({ actor: practitionerReference })
```

Use the resolved doctor's state for timezone when it is available.

- [ ] **Step 4: Verify GREEN**

Run `npx vitest run src/bots/agent/lib/ensurePractitionerAndSchedule.test.ts`.

Expected: all provisioning tests pass, including sequential and concurrent idempotency.

- [ ] **Step 5: Commit Task 1**

Stage only the two Task 1 files, run `git diff --cached --check`, inspect the staged diff, and commit as `fix: make doctor provisioning concurrency-safe`.

### Task 2: Duplicate-aware Doctor Desk queue

**Files:**
- Modify: `src/pages/desk/doctorQueue.test.ts`
- Modify: `src/pages/desk/doctorQueue.ts`
- Modify: `src/pages/desk/DoctorQueuePage.tsx:3-57`

**Interfaces:**
- Consumes: `MedplumClient`, an NPI, and existing `buildQueueEntries`.
- Produces: `loadDoctorQueueEntries(medplum: MedplumClient, npi: string): Promise<QueueEntry[]>`.

- [ ] **Step 1: Write failing queue tests**

Initialize full FHIR search indexes as in the provisioning tests. Create two Practitioners sharing one NPI, attach the Patient and Appointment only to the second, and assert:

```ts
const entries = await loadDoctorQueueEntries(medplum, '1234567890');
expect(entries).toHaveLength(1);
expect(entries[0]).toMatchObject({ appointmentId: appointment.id, patientId: patient.id });
```

Add a second case where one Appointment references both matching Practitioners and assert one queue entry, proving ID-based deduplication.

- [ ] **Step 2: Verify RED**

Run `npx vitest run src/pages/desk/doctorQueue.test.ts`.

Expected: FAIL because `loadDoctorQueueEntries` does not exist.

- [ ] **Step 3: Implement queue loading**

In `doctorQueue.ts`, add an ID-based resource deduplication helper and implement this data flow:

```ts
const practitioners = await medplum.searchResources('Practitioner', {
  identifier: `http://hl7.org/fhir/sid/us-npi|${npi}`,
});
const references = practitioners.flatMap((resource) =>
  resource.id ? [`Practitioner/${resource.id}`] : []
);
const resultSets = await Promise.all(
  references.map(async (reference) => {
    const [appointments, summaries] = await Promise.all([
      medplum.searchResources('Appointment', { actor: reference, _sort: '-date' }),
      medplum.searchResources('Communication', {
        recipient: reference,
        category: 'ai-previsit-summary',
      }),
    ]);
    return { appointments, summaries };
  })
);
```

Deduplicate flattened Appointments and Communications by FHIR ID, load the distinct referenced Patients, and pass them to `buildQueueEntries`. Return `[]` when no Practitioner matches.

Replace the current `DoctorQueuePage` loader body with:

```ts
setEntries(await loadDoctorQueueEntries(medplum, npi));
```

- [ ] **Step 4: Verify GREEN**

Run `npx vitest run src/pages/desk/doctorQueue.test.ts`.

Expected: all queue tests pass and duplicate Practitioner matches yield one visible entry.

- [ ] **Step 5: Commit Task 2**

Stage only the three queue files, run `git diff --cached --check`, inspect the staged diff, and commit as `fix: load doctor queue across duplicate NPIs`.

### Task 3: Duplicate-aware patient chat relationship

**Files:**
- Modify: `src/bots/agent/agent-patient-chat.test.ts`
- Modify: `src/bots/agent/agent-patient-chat.ts:41-59`

**Interfaces:**
- Consumes: every Practitioner matching `ChatInput.npi` and Appointment lookup by actor plus patient.
- Produces: unchanged `handler(...)`, using the relationship-bearing Practitioner as question sender.

- [ ] **Step 1: Write the failing chat regression test**

Create two Practitioners with the same NPI. Attach the Appointment only to the second, configure the Device and Gemini test seam, invoke the handler, then assert:

```ts
const question = await medplum.readResource('Communication', result.threadId);
expect(question.sender).toStrictEqual({
  reference: `Practitioner/${relationshipPractitioner.id}`,
});
```

- [ ] **Step 2: Verify RED**

Run `npx vitest run src/bots/agent/agent-patient-chat.test.ts`.

Expected: the new test fails with “No booking relationship” because the current `searchOne` resolves the first duplicate.

- [ ] **Step 3: Select the relationship-bearing Practitioner**

Replace the single Practitioner lookup with `searchResources`. Preserve the existing missing-Practitioner error when the array is empty. Iterate over candidates, searching:

```ts
await medplum.searchOne('Appointment', {
  actor: `Practitioner/${candidate.id}`,
  patient: `Patient/${patientId}`,
});
```

Select the first candidate with a relationship, preserve the current missing-relationship error when none match, and use the selected Practitioner as the Communication sender. Leave the existing Gemini model change untouched.

- [ ] **Step 4: Verify GREEN**

Run `npx vitest run src/bots/agent/agent-patient-chat.test.ts`.

Expected: all chat tests pass, including model selection, rejection without a relationship, and duplicate-aware resolution.

- [ ] **Step 5: Commit only the duplicate-resolution hunks**

Because both files contain pre-existing Gemini edits, stage only the new duplicate-resolution test and implementation hunks. Inspect `git diff --cached` and confirm it contains no model-version change. Run `git diff --cached --check`, then commit as `fix: resolve duplicate NPI booking relationships`.

### Task 4: Full verification

**Files:**
- Verify only; no planned production edits.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: full regression and build evidence.

- [ ] **Step 1: Run all tests**

Run `npm test` and require every Vitest file and test to pass.

- [ ] **Step 2: Run static gates**

Run `npx tsc --noEmit` and `npm run lint`; both must exit 0.

- [ ] **Step 3: Run the production build**

Run `npm run build`; TypeScript and Vite must complete successfully.

- [ ] **Step 4: Verify scope**

Run `git diff --check`, `git status --short`, and `git log -4 --oneline`. Confirm unrelated pre-existing changes remain present and uncommitted and only intended fix commits were added.

