# Doctor Desk Synthetic Provider Identifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Doctor Desk to accept and preserve synthetic provider identifiers containing 1–10 digits while retaining the existing ten-digit NPPES workflow and appointment-relationship checks.

**Architecture:** Keep `doctorLookup.ts` as the single normalization and validation boundary. The lookup, queue, and chat routes will consume its normalized value; the existing queue loader and patient-chat handler remain responsible for exact FHIR identifier lookup and relationship enforcement.

**Tech Stack:** TypeScript, React 19, React Router 7, Medplum FHIR R4, Vitest 4, ESLint.

## Global Constraints

- Trim surrounding whitespace and remove spaces and hyphens.
- Accept only 1–10 normalized numeric digits and preserve them exactly without padding.
- Reject empty, alphabetic, unsupported-punctuation, and over-ten-digit values.
- Do not change seeded practitioners, booking, FHIR storage, Gemini behavior, or authorization boundaries.
- Work directly on `main`; do not create branches or worktrees.
- Preserve all unrelated dirty-tree changes and never stage with `git add .`.

---

### Task 1: Widen the shared identifier rule and route usage

**Files:**
- Modify: `src/pages/desk/doctorLookup.test.ts`
- Modify: `src/pages/desk/doctorLookup.ts`
- Modify: `src/pages/desk/DoctorLookupPage.tsx`
- Modify: `src/pages/desk/DoctorQueuePage.tsx`
- Modify: `src/pages/desk/PatientAgentChatPage.tsx`

**Interfaces:**
- Consumes: raw identifier text or a route parameter.
- Produces: `normalizeNpi(value: string): string` and `isValidNpi(value: string): boolean`; route consumers use the normalized value for FHIR lookup, navigation, and chat input.

- [x] **Step 1: Write the failing validator tests**

```typescript
test('accepts short synthetic and ten-digit NPPES identifiers', () => {
  expect(isValidNpi('12345')).toBe(true);
  expect(isValidNpi('1234567890')).toBe(true);
});

test.each(['', 'abc', '123.45', '12345678901'])('rejects unsupported identifier %j', (value) => {
  expect(isValidNpi(value)).toBe(false);
});
```

- [x] **Step 2: Run the validator test and verify RED**

Run: `npx vitest run src/pages/desk/doctorLookup.test.ts`

Expected: FAIL because `isValidNpi('12345')` still requires exactly ten digits.

- [x] **Step 3: Implement the minimal shared rule and route normalization**

```typescript
export function isValidNpi(value: string): boolean {
  return /^\d{1,10}$/.test(normalizeNpi(value));
}
```

In the queue and chat pages, import `normalizeNpi`, derive the normalized route value once, validate it, and pass only that normalized value to `loadDoctorQueueEntries`, patient navigation, and `agent-patient-chat`. Update Doctor Desk copy so short values are described as provider identifiers rather than genuine ten-digit NPIs.

- [x] **Step 4: Run the validator test and verify GREEN**

Run: `npx vitest run src/pages/desk/doctorLookup.test.ts`

Expected: PASS.

### Task 2: Prove the existing queue and relationship-checked chat pipeline with short identifiers

**Files:**
- Modify: `src/pages/desk/doctorQueue.test.ts`
- Modify carefully without disturbing existing dirty changes: `src/bots/agent/agent-patient-chat.test.ts`

**Interfaces:**
- Consumes: the exact normalized short identifier from Task 1.
- Produces: regression coverage proving that queue FHIR search and patient chat use the short value without bypassing the appointment relationship.

- [x] **Step 1: Change the queue relationship fixture to a short identifier**

Use the literal `12345` in the existing multi-practitioner queue test and continue asserting that the matching appointment and `ai-previsit-summary` communication are returned.

- [x] **Step 2: Change the successful and denied chat relationship fixtures to a short identifier**

Use the literal `12345` for one successful chat test and the no-booking-relationship test. Keep the rejection assertion `/no booking relationship/i` unchanged.

- [x] **Step 3: Run the downstream tests**

Run: `npx vitest run src/pages/desk/doctorQueue.test.ts src/bots/agent/agent-patient-chat.test.ts`

Expected: PASS because these downstream layers already search the exact identifier and enforce the appointment relationship independently of identifier length.

### Task 3: Verify the scoped implementation

**Files:**
- Review only: all files listed in Tasks 1 and 2.

**Interfaces:**
- Consumes: completed implementation and tests.
- Produces: verification evidence and a path-scoped diff that excludes unrelated work.

- [x] **Step 1: Run all focused tests together**

Run: `npx vitest run src/pages/desk/doctorLookup.test.ts src/pages/desk/doctorQueue.test.ts src/bots/agent/agent-patient-chat.test.ts`

Expected: all focused tests pass with zero failures.

- [x] **Step 2: Lint only the touched TypeScript files**

Run: `npx eslint src/pages/desk/doctorLookup.ts src/pages/desk/doctorLookup.test.ts src/pages/desk/DoctorLookupPage.tsx src/pages/desk/DoctorQueuePage.tsx src/pages/desk/PatientAgentChatPage.tsx src/pages/desk/doctorQueue.test.ts src/bots/agent/agent-patient-chat.test.ts`

Expected: exit code 0.

- [x] **Step 3: Build the application**

Run: `npm run build`

Expected: exit code 0 unless an unrelated dirty-tree change blocks the existing build; report any such blocker precisely.

- [x] **Step 4: Review the scoped diff and repository status**

Run: `git diff -- <all Task 1 and Task 2 paths>` and `git status --short --branch`.

Expected: only the approved identifier implementation appears in the scoped diff; unrelated dirty files remain preserved and unstaged.

- [x] **Step 5: Leave changes uncommitted unless the user explicitly requests a commit or push**

Do not stage unrelated files. If later asked to commit, stage only the exact feature paths and split any overlapping pre-existing test-file edits with a reviewed patch.
