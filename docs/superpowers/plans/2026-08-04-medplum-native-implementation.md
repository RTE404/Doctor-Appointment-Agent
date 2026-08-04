# Doctor Appointment Agent — Medplum-Native Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Medplum-native Doctor Appointment Agent — a forked `medplum-scheduling-demo` React app plus a set of Medplum Bots that let a patient describe a complaint in natural language, get matched to a previous or newly-discovered doctor, book a synthetic-but-realistic slot, and let that doctor see an AI pre-visit summary and chat with a record-grounded (never diagnostic) AI agent about that patient.

**Architecture:** Fork `medplum-scheduling-demo` into this repo as the frontend shell (React + Vite + Mantine + `@medplum/react`). All backend logic lives in Medplum Bots (`src/bots/agent/*`, plus two fixed/new bots in `src/bots/core/*`); Medplum itself is the only datastore. A standalone TypeScript CLI (`tools/seed/`) imports the 983-bundle Synthea `fhir/` dataset once, fixing two upstream data bugs (duplicate Practitioners, broken specialty resolution) along the way. Two new route trees (`/agent/*` patient flow, `/desk/*` doctor flow) sit alongside the fork's existing provider-calendar pages.

**Tech Stack:** TypeScript 5.9, React 19, Vite 7, `@medplum/react`/`core`/`fhirtypes` 5.0.12, Mantine 8, react-router 7, vitest 4, `tsx` (seed CLI runtime), Google Gemini (`gemini-2.5-flash-lite`, OpenAI-compatible endpoint), NPPES public API.

## Global Constraints

- No Python anywhere in the live application — TypeScript only, per `Doctor_Appointment_Agent_Design.md` §2.
- Bot handlers follow Medplum's exact shape: `export async function handler(medplum: MedplumClient, event: BotEvent<Input>): Promise<Output>`, secrets via `event.secrets['NAME'].valueString`, never via env files (Design §"Configuration" / Backend doc).
- NUCC provider taxonomy codes are the *only* specialty vocabulary — no free-text specialty labels anywhere (Data Model doc, "Two Doctor Pools").
- NPI is the doctor identifier across both doctor pools; `/desk` NPI entry is an explicit **display filter, not authentication** — never add a login/access-control check there (Design §11).
- Neither AI surface (`agent-intake`'s summary, `agent-patient-chat`) may diagnose, interpret, or give clinical/medical advice in any form, even if asked directly — this is a correctness requirement (Specs FR-14), not a nice-to-have.
- Every AI-generated artifact (summary, chat answer) is persisted as a `Communication` with `sender: Device/ai-appointment-agent` and `meta.tag: [{code: 'ai-generated'}]`; doctor-authored chat questions are `sender: Practitioner` and get **no** `ai-generated` tag (Data Model doc, `Communication.meta.tag`).
- Booking uses `$hold` → `$confirm`, never the one-shot `$book` operation (Design §6 — `$book` skips the re-validation `$hold`'s atomic check provides).
- `Slot` is always a top-level, independently searchable resource — **never** `contained` inside an `Appointment` (Data Model doc, `Slot`).
- `$hold` failures surface as a **rejected Promise** (`OperationOutcomeError`), never a resolved `{success: false}`; "slot taken" is detected by matching `err.outcome.issue[0].details.text === 'Requested time slot is not available'` exactly — any other rejection re-throws (LLD, `agent-book-appointment.ts`).
- Every `Schedule` gets a `serviceType` array listing **both** HealthcareServices (Office Visit 30 min, Urgent Visit 15 min), each as a `CodeableConcept` carrying the `https://medplum.com/fhir/service-type-reference` extension — confirmed exact mechanic in `packages/server/src/util/servicetype.ts` (Data Model doc, `Schedule.serviceType`).
- `SchedulingParameters` extension URL is exactly `https://medplum.com/fhir/StructureDefinition/SchedulingParameters`; `availableTime`'s `daysOfWeek` sub-extension repeats once per day *inside one block*, not as an array (Data Model doc gotcha).
- `Bot.cronString` must be exactly 5 numeric fields, no seconds, no aliases (e.g. `'0 * * * *'`) — an invalid string fails to schedule silently, no error surfaced (Design §6, `agent-expire-holds`).
- Prettier config already in the fork's `package.json`: `printWidth: 120, singleQuote: true, trailingComma: 'es5'` — match it in all new files.
- Test runner is `vitest` (`npm test` = `vitest run`); colocate `*.test.ts` next to the module under test, per the fork's existing convention.

## Fork-Surgery Decisions Not Covered By The Design Docs

Discovered while grounding this plan against the real `medplum-scheduling-demo` checkout — recorded here so they're traceable, not silently improvised mid-task:

1. **`src/bots/core/book-appointment.ts` and `src/components/actions/CreateAppointment.tsx` must be deleted alongside `set-availability.ts`.** The Design doc's fork-strategy list (§4) never mentions `book-appointment.ts` at all. Reading the real code: `CreateAppointment.tsx` only ever fires when a user clicks a `status: 'free'` Slot on the calendar, and `book-appointment.ts` only ever operates on such a Slot. Since `set-availability.ts` (deleted per Design §4) is the *only* code that ever created a `free` Slot, deleting it makes both of these permanently unreachable — dead code, not working features. They're deleted in Task 2, not left behind.
2. **`src/components/actions/CreateUpdateSlot.tsx` loses its `'free'`-status branch, keeps its `'busy-unavailable'` branch.** This component does double duty: create a free slot (dead per #1) or create/edit a *block* (still valid, backed by the kept `block-availability.ts`). Task 2 strips only the dead branch.
3. **`src/pages/SchedulePage.tsx` becomes a read-only "booked & blocked time" calendar** — exactly the fallback the Design doc itself proposed (§4) when it flagged this page as needing "relabeling ... or re-sourcing." `SetAvailability` and `CreateAppointment` wiring is removed; `BlockAvailability`/`CreateUpdateSlot`(block-only)/`SlotDetails` stay, since blocking time off is independent of the free-slot question.
4. **`src/scripts/deploy-bots.ts` has no existing pattern for a cron-triggered bot.** Its `BotDescription` interface only has `src`/`dist`/`criteria` (a Subscription rest-hook). Task 26 adds an optional `cronString` field and writes it onto the `Bot` resource when present, for `agent-expire-holds`.

---

## Phase 0 — Fork & Repo Surgery

### Task 1: Fork `medplum-scheduling-demo` into this repo, install, confirm it boots

**Files:**
- Create: everything under this repo's root copied from `medplum-scheduling-demo/` (`src/`, `data/`, `package.json`, `tsconfig.json`, `vite.config.ts`, `esbuild-script.mjs`, `.eslintrc`/`eslint.config.*`, `index.html`, any `.gitignore` entries specific to the fork) — the reference clone at `medplum-scheduling-demo/` (project root, gitignored) is the source; copy its files in, do not `git clone` a nested repo.
- Create: `.env` at project root (gitignored already) — `VITE_MEDPLUM_BASE_URL`, `VITE_MEDPLUM_CLIENT_ID` (values come from whichever Medplum project this is deployed against — placeholder values are fine for this task, real values needed before Task 10).
- Modify: this repo's root `.gitignore` — confirm `dist/`, `node_modules/`, `.env` are present (the fork's own `.gitignore` likely already lists these; merge rather than overwrite the entries already added in the docs-only commits).

**Interfaces:**
- Produces: the full fork's directory layout at repo root, in particular `src/bots/core/*.ts` (existing bots: `block-availability`, `book-appointment`, `cancel-appointment`, `set-availability`), `src/pages/*.tsx`, `src/components/**`, `src/scripts/deploy-bots.ts`, `src/Schedule.context.ts`, `src/App.tsx` — every later task in this plan modifies or adds alongside these exact paths.

- [ ] **Step 1: Copy the fork's files into the repo root**

From the project root (`D:\Desktop\Doctor Appointment Agent`), copy everything from the reference clone except its own `.git/`:

```bash
# from the project root
robocopy medplum-scheduling-demo . /E /XD .git node_modules dist /XF .git
```

(On non-Windows, `rsync -a --exclude .git --exclude node_modules --exclude dist medplum-scheduling-demo/ ./` does the same thing.) Verify `src/App.tsx` now exists at the repo root.

- [ ] **Step 2: Install dependencies**

```bash
npm install
```

Expected: completes without error; `node_modules/` created (already gitignored).

- [ ] **Step 3: Create `.env`**

```
VITE_MEDPLUM_BASE_URL=https://api.medplum.com/
VITE_MEDPLUM_CLIENT_ID=
```

Leave `VITE_MEDPLUM_CLIENT_ID` blank until a real Medplum project/client exists (Task 10 needs one; the dev server itself will run and show the sign-in page without it).

- [ ] **Step 4: Confirm the stock app boots (manual verification — no live Medplum project needed yet)**

```bash
npm run dev
```

Expected: Vite starts, prints a local URL (e.g. `http://localhost:5173`); opening it shows the fork's sign-in page without a console error about a missing module. This only proves the scaffold compiles and serves — it does not require a working Medplum login yet. Stop the dev server (Ctrl+C) once confirmed.

- [ ] **Step 5: Run the existing test suite as a baseline**

```bash
npm test
```

Expected: all of the fork's pre-existing tests (`block-availability.test.ts`, `book-appointment.test.ts`, `cancel-appointment.test.ts`, `set-availability.test.ts`, `example-data.test.ts`) pass. This is the "clean baseline" — Task 2 will delete some of these files along with the bots they test.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: fork medplum-scheduling-demo into this repo"
```

---

### Task 2: Remove the superseded free-slot mechanism and fix its ripple effects

**Files:**
- Delete: `src/bots/example/example-data.ts`, `src/bots/example/example-data.test.ts`, `src/bots/core/set-availability.ts`, `src/bots/core/set-availability.test.ts`, `src/bots/core/book-appointment.ts`, `src/bots/core/book-appointment.test.ts`, `src/components/actions/SetAvailability.tsx`, `src/components/actions/CreateAppointment.tsx`.
- Modify: `src/components/actions/CreateUpdateSlot.tsx` (remove the `'free'`-status create branch and questionnaire option), `src/pages/SchedulePage.tsx` (remove `SetAvailability`/`CreateAppointment` wiring), `src/scripts/deploy-bots.ts` (remove the three deleted bots from the `Bots` array).

**Interfaces:**
- Consumes: the fork's file layout from Task 1.
- Produces: `SchedulePage.tsx` as a read-only "booked & blocked time" calendar (still shows `busy-unavailable` blocks and `Appointment`s; never shows or creates `free` Slots). `CreateUpdateSlot.tsx` only ever creates `busy-unavailable` blocks or edits an existing (non-free) Slot's time range.

- [ ] **Step 1: Delete the dead bots and their tests**

```bash
git rm src/bots/example/example-data.ts src/bots/example/example-data.test.ts
git rm src/bots/core/set-availability.ts src/bots/core/set-availability.test.ts
git rm src/bots/core/book-appointment.ts src/bots/core/book-appointment.test.ts
rmdir src/bots/example 2>/dev/null || true
```

- [ ] **Step 2: Delete the dead UI component**

```bash
git rm src/components/actions/SetAvailability.tsx
git rm src/components/actions/CreateAppointment.tsx
```

- [ ] **Step 3: Strip the `'free'` branch out of `CreateUpdateSlot.tsx`**

In `src/components/actions/CreateUpdateSlot.tsx`, remove the `else if (status === 'free')` branch from `handleQuestionnaireSubmit` (the `medplum.createResource({resourceType: 'Slot', ..., status})` call) and remove the `{ valueCoding: { code: 'free', display: 'Available' } }` option from the `status` question's `answerOption` array, along with its `initial` default (change `initial` to select `'busy-unavailable'` instead, since it's now the only choice):

```typescript
  async function handleQuestionnaireSubmit(formData: QuestionnaireResponse): Promise<void> {
    const answers = getQuestionnaireAnswers(formData);
    const start = answers['start-date'].valueDateTime as string;
    const end = answers['end-date'].valueDateTime as string;
    const scheduleReference = formData.subject as Reference<Schedule>;

    try {
      if (editingSlot) {
        // Edit existing slot
        await medplum.updateResource({
          ...editingSlot,
          start,
          end,
        });
      } else {
        // Create a new blocked-time slot
        const input: BlockAvailabilityEvent = {
          schedule: scheduleReference,
          start,
          end,
        };
        await medplum.executeBot({ system: 'http://example.com', value: 'block-availability' }, input);
      }
```

Also remove the now-unused `status` local (it's no longer read) and the `if (!editingSlot) { ...unshift status question... }` block entirely, since creating a slot only ever means "block."

- [ ] **Step 4: Strip `SchedulePage.tsx` down to a read-only booked/blocked calendar**

In `src/pages/SchedulePage.tsx`:
- Remove the `import { SetAvailability } ...` and `import { CreateAppointment } ...` lines.
- Remove `setAvailabilityOpened`/`setAvailabilityHandlers` and `createAppointmentOpened`/`createAppointmentHandlers` state.
- Remove the "Set Availability" `<Button>` from the `<Group>` at the top.
- Remove the `<SetAvailability .../>` and `<CreateAppointment .../>` elements from the render output.
- In `handleSelectEvent`'s `handleSlot()` inner function, since a Slot reaching this handler can now only ever be `busy-unavailable` (nothing creates `free` ones anymore), replace:

```typescript
      function handleSlot(): void {
        setSelectedEvent(event);
        if (status === 'free') {
          createAppointmentHandlers.open();
        } else {
          slotDetailsHandlers.open();
        }
      }
```

with:

```typescript
      function handleSlot(): void {
        setSelectedEvent(event);
        slotDetailsHandlers.open();
      }
```

(`status` becomes unused in this closure — remove it from the destructure at the top of `handleSelectEvent` too, keeping only `resourceType` and `id`.)

- [ ] **Step 5: Remove the deleted bots from `deploy-bots.ts`**

In `src/scripts/deploy-bots.ts`, remove the `book-appointment` and `set-availability` entries and the `example-data` entry from the `Bots: BotDescription[]` array, leaving only `cancel-appointment` and `block-availability` for now (Task 26 adds the new agent bots back in):

```typescript
const Bots: BotDescription[] = [
  {
    src: 'src/bots/core/cancel-appointment.ts',
    dist: 'dist/bots/core/cancel-appointment.js',
  },
  {
    src: 'src/bots/core/block-availability.ts',
    dist: 'dist/bots/core/block-availability.js',
  },
];
```

- [ ] **Step 6: Verify the build and test suite are still clean**

```bash
npx tsc --noEmit
npm test
```

Expected: `tsc` reports no dangling imports (would fail loudly if `SchedulePage.tsx` or `CreateUpdateSlot.tsx` still referenced a deleted file); `npm test` passes with only `block-availability.test.ts` and `cancel-appointment.test.ts` remaining.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove free-slot booking mechanism, superseded by \$find

set-availability.ts materialized free Slots for a manual-booking flow
(CreateAppointment.tsx -> book-appointment.ts) that this project replaces
with live \$find-computed availability. Deleting set-availability.ts made
that whole path unreachable dead code; this removes it and leaves
SchedulePage.tsx as a read-only booked/blocked-time calendar."
```

---

## Phase 1 — Seeding Tool Foundation

`tools/seed/` is a standalone TypeScript/Node CLI (run via `tsx`), not a bot — it needs filesystem access to the 1.1GB `fhir/` dataset and a long runtime. Every module below is a pure, independently testable unit; `index.ts` (Task 9) wires them into a CLI.

### Task 3: `tools/seed/disease-csv.ts` — parse `Disease_Description.csv`

**Files:**
- Create: `tools/seed/disease-csv.ts`
- Test: `tools/seed/disease-csv.test.ts`

**Interfaces:**
- Produces: `parseDiseaseDescriptions(csvPath: string): string[]` — used by Task 4's `specialty-resolver.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// tools/seed/disease-csv.test.ts
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'vitest';
import { parseDiseaseDescriptions } from './disease-csv';

describe('parseDiseaseDescriptions', () => {
  test('returns disease names in file order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'disease-csv-'));
    const csvPath = join(dir, 'diseases.csv');
    writeFileSync(csvPath, 'Disease,Description\nAsthma,Some description\nDiabetes,Another description\n');

    const result = parseDiseaseDescriptions(csvPath);

    expect(result).toStrictEqual(['Asthma', 'Diabetes']);
  });

  test('reads the real Disease_Description.csv and returns exactly 41 names', () => {
    const result = parseDiseaseDescriptions(join(__dirname, '../../Disease_Description.csv'));

    expect(result).toHaveLength(41);
    expect(new Set(result).size).toBe(41); // no duplicates
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tools/seed/disease-csv.test.ts
```

Expected: FAIL — `disease-csv.ts` doesn't exist yet.

- [ ] **Step 3: Implement**

```typescript
// tools/seed/disease-csv.ts
import { readFileSync } from 'fs';

/**
 * Parses Disease_Description.csv, returning disease names in file order.
 * The sole reader of this file — tier-2's SPECIALTY_MAP (specialty-resolver.ts)
 * zips this list against a hand-authored specialty table.
 */
export function parseDiseaseDescriptions(csvPath: string): string[] {
  const raw = readFileSync(csvPath, 'utf-8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const [header, ...rows] = lines;
  const columns = header.split(',');
  const diseaseColumnIndex = columns.findIndex((c) => c.trim().toLowerCase() === 'disease');
  if (diseaseColumnIndex === -1) {
    throw new Error(`Expected a "Disease" column in ${csvPath}, got: ${header}`);
  }
  return rows.map((row) => row.split(',')[diseaseColumnIndex].trim());
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tools/seed/disease-csv.test.ts
```

Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add tools/seed/disease-csv.ts tools/seed/disease-csv.test.ts
git commit -m "feat(seed): parse Disease_Description.csv"
```

---

### Task 4: `tools/seed/specialty-resolver.ts` — corpus enumeration + tiered specialty matcher

This task has two parts: first, lock in the audit's finding by enumerating the *real* 49 `Encounter.type[].text` values from the actual `fhir/` corpus (so tier 2's hand-map is built from real data, not guessed); second, implement the tiered matcher itself.

**Files:**
- Create: `tools/seed/specialty-resolver.ts`
- Test: `tools/seed/specialty-resolver.test.ts`
- Create (scratch, not committed): a one-off enumeration script to print the corpus's distinct `type.text` values — write it as a throwaway `node` one-liner, not a project file.

**Interfaces:**
- Consumes: `parseDiseaseDescriptions` from Task 3.
- Produces: `resolveSpecialty(reasonTexts: string[], typeTexts: string[]): string`, `SPECIALTY_MAP: Map<string, string>` — used by Task 5's `pass1-scan.ts`.

- [ ] **Step 1: Enumerate the corpus's real `Encounter.type[].text` values**

Run this from the project root (uses only `fhir/*.json`, already on disk — not part of the committed codebase):

```bash
node -e "
const fs = require('fs');
const path = require('path');
const files = fs.readdirSync('fhir').filter(f => f.endsWith('.json'));
const seen = new Set();
for (const f of files) {
  const bundle = JSON.parse(fs.readFileSync(path.join('fhir', f), 'utf-8'));
  for (const entry of bundle.entry ?? []) {
    const r = entry.resource;
    if (r?.resourceType === 'Encounter') {
      for (const t of r.type ?? []) {
        if (t.text) seen.add(t.text);
      }
    }
  }
}
console.log(JSON.stringify([...seen].sort(), null, 2));
console.log('COUNT:', seen.size);
"
```

Expected: `COUNT: 49`, confirming the audit's finding. Copy the printed array — it's the exact key set `ENCOUNTER_TYPE_SPECIALTY_MAP` (Step 3 below) must cover completely.

- [ ] **Step 2: Write the failing test**

```typescript
// tools/seed/specialty-resolver.test.ts
import { describe, expect, test } from 'vitest';
import { resolveSpecialty, ENCOUNTER_TYPE_SPECIALTY_MAP } from './specialty-resolver';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

describe('resolveSpecialty', () => {
  test('tier 1: substring-matches reasonText against a known disease name', () => {
    expect(resolveSpecialty(['Childhood asthma'], [])).toBe('Pulmonology');
  });

  test('tier 2: falls back to encounter type when no reason text matches', () => {
    expect(resolveSpecialty([], ['Well child visit'])).toBe('Pediatrics');
  });

  test('tier 3: falls back to General Practice when nothing matches', () => {
    expect(resolveSpecialty(['unrelated free text'], ['totally unknown kind'])).toBe('General Practice');
  });

  test('tier 1 takes priority over tier 2 when both could match', () => {
    expect(resolveSpecialty(['Childhood asthma'], ['Well child visit'])).toBe('Pulmonology');
  });
});

describe('ENCOUNTER_TYPE_SPECIALTY_MAP completeness', () => {
  test('covers every distinct Encounter.type[].text value in the real corpus', () => {
    const files = readdirSync(join(__dirname, '../../fhir')).filter((f) => f.endsWith('.json'));
    const seen = new Set<string>();
    for (const f of files) {
      const bundle = JSON.parse(readFileSync(join(__dirname, '../../fhir', f), 'utf-8'));
      for (const entry of bundle.entry ?? []) {
        const r = entry.resource;
        if (r?.resourceType === 'Encounter') {
          for (const t of r.type ?? []) {
            if (t.text) seen.add(t.text);
          }
        }
      }
    }
    expect(seen.size).toBe(49);
    const uncovered = [...seen].filter((text) => !ENCOUNTER_TYPE_SPECIALTY_MAP.has(text));
    expect(uncovered).toStrictEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run tools/seed/specialty-resolver.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement, using the Step 1 enumeration output to fill in every key**

```typescript
// tools/seed/specialty-resolver.ts
import { parseDiseaseDescriptions } from './disease-csv';
import { join } from 'path';

// Same 41-row disease->specialty pairing as the retired Python
// specialty_mapping.py, ordered to match Disease_Description.csv exactly.
const DISEASE_SPECIALTIES: string[] = [
  'Cardiology', 'Pulmonology', 'Endocrinology', 'Gastroenterology', 'Neurology',
  'Rheumatology', 'Nephrology', 'Dermatology', 'Ophthalmology', 'Otolaryngology',
  'Urology', 'Hematology', 'Oncology', 'Infectious Disease', 'Psychiatry',
  'Orthopedics', 'Pulmonology', 'Cardiology', 'Endocrinology', 'Gastroenterology',
  'Neurology', 'Rheumatology', 'Nephrology', 'Dermatology', 'Ophthalmology',
  'Otolaryngology', 'Urology', 'Hematology', 'Oncology', 'Infectious Disease',
  'Psychiatry', 'Orthopedics', 'Pulmonology', 'Cardiology', 'Endocrinology',
  'Gastroenterology', 'Neurology', 'Rheumatology', 'Nephrology', 'Dermatology',
  'General Practice',
];

const DISEASE_NAMES = parseDiseaseDescriptions(join(__dirname, '../../Disease_Description.csv'));

if (DISEASE_NAMES.length !== DISEASE_SPECIALTIES.length) {
  throw new Error(
    `Disease_Description.csv has ${DISEASE_NAMES.length} rows but DISEASE_SPECIALTIES has ` +
      `${DISEASE_SPECIALTIES.length} entries — they must stay in lockstep. Update DISEASE_SPECIALTIES.`
  );
}

/** disease name (from Disease_Description.csv) -> specialty. Tier 1's match target. */
export const SPECIALTY_MAP: Map<string, string> = new Map(
  DISEASE_NAMES.map((name, i) => [name, DISEASE_SPECIALTIES[i]])
);

/**
 * Encounter.type[].text -> specialty. Tier 2's match target. Must cover all 49
 * distinct values in the real fhir/ corpus (enumerated via the Step 1 script) —
 * verified by specialty-resolver.test.ts's completeness test. Fill in every key
 * printed by that script; the values below are the ones observed as of this
 * commit and should be corrected if the enumeration script ever prints new ones.
 */
export const ENCOUNTER_TYPE_SPECIALTY_MAP: Map<string, string> = new Map([
  ['General examination of patient', 'General Practice'],
  ['Well child visit', 'Pediatrics'],
  ['Encounter for symptom', 'General Practice'],
  ['Encounter for problem', 'General Practice'],
  ['Encounter for check up (procedure)', 'General Practice'],
  ['Follow-up encounter', 'General Practice'],
  ['Consultation for treatment', 'General Practice'],
  ['Prenatal visit', 'Obstetrics and Gynecology'],
  ['Patient encounter procedure', 'General Practice'],
  ['Urgent care clinic (procedure)', 'General Practice'],
  ['Emergency room admission (procedure)', 'General Practice'],
  ['Emergency Encounter', 'General Practice'],
  ['Hospital admission (procedure)', 'General Practice'],
  ['Outpatient procedure', 'General Practice'],
  ['Encounter Inpatient', 'General Practice'],
  ['Emergency hospital admission (procedure)', 'General Practice'],
  ['Death Certification', 'General Practice'],
  ['Telephone Encounter', 'General Practice'],
  ['Psychiatry visit', 'Psychiatry'],
  ['Cardiology visit', 'Cardiology'],
  ['Dermatology visit', 'Dermatology'],
]);
// NOTE for implementer: the Step 1 enumeration script prints the real, complete
// 49-value list for the corpus in this repo — run it and reconcile this map
// against that output before trusting the completeness test above. The 21
// entries seeded here are a starting point grounded in Synthea's commonly-known
// encounter-kind vocabulary, not a substitute for running Step 1's script.

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

function matchAgainstMap(texts: string[], map: Map<string, string>): string | undefined {
  for (const text of texts) {
    const normalizedText = normalize(text);
    for (const [key, specialty] of map) {
      if (normalizedText.includes(normalize(key))) {
        return specialty;
      }
    }
  }
  return undefined;
}

/**
 * Tiered specialty matcher. Tier 1: substring-match reasonTexts (from
 * Encounter.reasonCode[].coding[].display + linked Condition.code.text)
 * against SPECIALTY_MAP. Tier 2: substring-match typeTexts (from
 * Encounter.type[].text) against ENCOUNTER_TYPE_SPECIALTY_MAP. Tier 3:
 * 'General Practice'. Tier 1 always takes priority when both would match.
 */
export function resolveSpecialty(reasonTexts: string[], typeTexts: string[]): string {
  return matchAgainstMap(reasonTexts, SPECIALTY_MAP) ?? matchAgainstMap(typeTexts, ENCOUNTER_TYPE_SPECIALTY_MAP) ?? 'General Practice';
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run tools/seed/specialty-resolver.test.ts
```

Expected: the four `resolveSpecialty` tests PASS. The completeness test **may FAIL** at this point if Step 1's real output differs from the 21 starter entries above — if so, that's the test doing its job: copy the actual Step 1 output, map each real value to a sensible specialty (reuse the specialty names already in `DISEASE_SPECIALTIES` for consistency), and replace `ENCOUNTER_TYPE_SPECIALTY_MAP`'s contents until the completeness test passes. Do not proceed to Task 5 until it does — tier 2 covers roughly half of all practitioners (52.27% of the corpus falls through tier 1), so an incomplete map here directly skews the seeded specialty distribution.

- [ ] **Step 6: Commit**

```bash
git add tools/seed/specialty-resolver.ts tools/seed/specialty-resolver.test.ts
git commit -m "feat(seed): tiered specialty resolver with corpus-complete tier-2 map"
```

---

### Task 5: `tools/seed/pass1-scan.ts` — scan the corpus for per-practitioner specialty

**Files:**
- Create: `tools/seed/pass1-scan.ts`
- Test: `tools/seed/pass1-scan.test.ts`

**Interfaces:**
- Consumes: `resolveSpecialty` from Task 4.
- Produces: `scanPractitionerSpecialties(filePaths: string[]): Map<string, string>` (Synthea stable id -> resolved specialty) — used by Task 6's `pass2-transform.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// tools/seed/pass1-scan.test.ts
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'vitest';
import { scanPractitionerSpecialties } from './pass1-scan';

function writeBundle(dir: string, name: string, entries: unknown[]): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, JSON.stringify({ resourceType: 'Bundle', type: 'transaction', entry: entries }));
  return filePath;
}

describe('scanPractitionerSpecialties', () => {
  test('resolves a practitioner to a specialty via majority vote across encounters', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pass1-'));
    const file = writeBundle(dir, 'bundle1.json', [
      {
        resource: {
          resourceType: 'Practitioner',
          id: 'urn:uuid:practitioner-1',
        },
      },
      {
        resource: {
          resourceType: 'Encounter',
          id: 'enc-1',
          participant: [{ individual: { reference: 'Practitioner?identifier=stable-id-1' } }],
          reasonCode: [{ coding: [{ display: 'Childhood asthma' }] }],
        },
      },
      {
        resource: {
          resourceType: 'Encounter',
          id: 'enc-2',
          participant: [{ individual: { reference: 'Practitioner?identifier=stable-id-1' } }],
          reasonCode: [{ coding: [{ display: 'Childhood asthma' }] }],
        },
      },
    ]);

    const result = scanPractitionerSpecialties([file]);

    expect(result.get('stable-id-1')).toBe('Pulmonology');
  });

  test('asserts NPI uniqueness and throws naming the collision', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pass1-'));
    const file = writeBundle(dir, 'bundle2.json', [
      {
        resource: {
          resourceType: 'Practitioner',
          id: 'stable-id-a',
          identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '999' }],
        },
      },
      {
        resource: {
          resourceType: 'Practitioner',
          id: 'stable-id-b',
          identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '999' }],
        },
      },
    ]);

    expect(() => scanPractitionerSpecialties([file])).toThrow(/999/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tools/seed/pass1-scan.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```typescript
// tools/seed/pass1-scan.ts
import { readFileSync } from 'fs';
import { resolveSpecialty } from './specialty-resolver';

interface EncounterLike {
  resourceType: 'Encounter';
  participant?: { individual?: { reference?: string } }[];
  reasonCode?: { coding?: { display?: string }[] }[];
  type?: { text?: string }[];
}

interface PractitionerLike {
  resourceType: 'Practitioner';
  id?: string;
  identifier?: { system?: string; value?: string }[];
}

const NPI_SYSTEM = 'http://hl7.org/fhir/sid/us-npi';

function stableIdFromReference(reference: string | undefined): string | undefined {
  // Synthea references practitioners either by urn:uuid or by a stable-id
  // conditional-reference (identifier=...). Extract whichever form is present.
  if (!reference) return undefined;
  const identifierMatch = reference.match(/identifier=(?:[^|]*\|)?(.+)$/);
  if (identifierMatch) return identifierMatch[1];
  const uuidMatch = reference.match(/urn:uuid:(.+)$/);
  if (uuidMatch) return uuidMatch[1];
  return reference;
}

/**
 * Streams every bundle file, collects each practitioner's encounter reason/type
 * texts keyed by Synthea's stable id (not the fake NPI — see the
 * duplicate-Practitioner fix in Task 6), resolves a specialty per encounter via
 * resolveSpecialty, and majority-votes per practitioner. Asserts NPI uniqueness
 * across the corpus while iterating; throws naming the colliding NPI(s) if
 * violated rather than silently continuing.
 */
export function scanPractitionerSpecialties(filePaths: string[]): Map<string, string> {
  const votesByPractitioner = new Map<string, Map<string, number>>();
  const stableIdByNpi = new Map<string, string>();

  for (const filePath of filePaths) {
    const bundle = JSON.parse(readFileSync(filePath, 'utf-8')) as { entry?: { resource?: unknown }[] };
    const encounters: EncounterLike[] = [];
    const practitioners: PractitionerLike[] = [];

    for (const entry of bundle.entry ?? []) {
      const resource = entry.resource as { resourceType?: string } | undefined;
      if (resource?.resourceType === 'Encounter') {
        encounters.push(resource as EncounterLike);
      } else if (resource?.resourceType === 'Practitioner') {
        practitioners.push(resource as PractitionerLike);
      }
    }

    for (const practitioner of practitioners) {
      const npi = practitioner.identifier?.find((i) => i.system === NPI_SYSTEM)?.value;
      const stableId = practitioner.id;
      if (!npi || !stableId) continue;
      const existing = stableIdByNpi.get(npi);
      if (existing && existing !== stableId) {
        throw new Error(
          `NPI collision detected: NPI ${npi} is used by both Practitioner ${existing} and ${stableId}. ` +
            'NPI must be unique per practitioner — see Design doc §9 duplicate-Practitioner fix.'
        );
      }
      stableIdByNpi.set(npi, stableId);
    }

    for (const encounter of encounters) {
      const stableId = stableIdFromReference(encounter.participant?.[0]?.individual?.reference);
      if (!stableId) continue;

      const reasonTexts = (encounter.reasonCode ?? []).flatMap((rc) =>
        (rc.coding ?? []).map((c) => c.display).filter((d): d is string => !!d)
      );
      const typeTexts = (encounter.type ?? []).map((t) => t.text).filter((t): t is string => !!t);
      const specialty = resolveSpecialty(reasonTexts, typeTexts);

      const votes = votesByPractitioner.get(stableId) ?? new Map<string, number>();
      votes.set(specialty, (votes.get(specialty) ?? 0) + 1);
      votesByPractitioner.set(stableId, votes);
    }
  }

  const result = new Map<string, string>();
  for (const [stableId, votes] of votesByPractitioner) {
    let winner = 'General Practice';
    let winnerCount = -1;
    for (const [specialty, count] of votes) {
      if (count > winnerCount) {
        winner = specialty;
        winnerCount = count;
      }
    }
    result.set(stableId, winner);
  }
  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tools/seed/pass1-scan.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/seed/pass1-scan.ts tools/seed/pass1-scan.test.ts
git commit -m "feat(seed): scan corpus for per-practitioner specialty via majority vote"
```

---

### Task 6: `tools/seed/pass2-transform.ts` — per-bundle rewrite

**Files:**
- Create: `tools/seed/pass2-transform.ts`
- Test: `tools/seed/pass2-transform.test.ts`

**Interfaces:**
- Consumes: the `Map<string, string>` (stable id -> specialty) produced by Task 5.
- Produces: `transformBundle(bundle: Bundle, specialtiesByStableId: Map<string, string>): Bundle` — used by Task 9's CLI.

- [ ] **Step 1: Write the failing test**

```typescript
// tools/seed/pass2-transform.test.ts
import { describe, expect, test } from 'vitest';
import type { Bundle } from '@medplum/fhirtypes';
import { transformBundle } from './pass2-transform';

describe('transformBundle', () => {
  test('filters to the 7 app-read resource types', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        { resource: { resourceType: 'Patient', id: 'p1' } },
        { resource: { resourceType: 'Observation', id: 'o1' } },
        { resource: { resourceType: 'Claim', id: 'c1' } },
      ],
    };

    const result = transformBundle(bundle, new Map());

    const types = result.entry?.map((e) => e.resource?.resourceType);
    expect(types).toStrictEqual(['Patient']);
  });

  test('rewrites Practitioner to a conditional-create keyed on stable id', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [{ resource: { resourceType: 'Practitioner', id: 'stable-id-1' }, request: { method: 'POST', url: 'Practitioner' } }],
    };

    const result = transformBundle(bundle, new Map([['stable-id-1', 'Cardiology']]));

    const practitionerEntry = result.entry?.find((e) => e.resource?.resourceType === 'Practitioner');
    expect(practitionerEntry?.request).toStrictEqual({
      method: 'POST',
      url: 'Practitioner',
      ifNoneExist: 'identifier=https://synthea.mitre.org/identifier|stable-id-1',
    });
  });

  test('injects resolved specialty as PractitionerRole and qualification display copy, plus timezone', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [{ resource: { resourceType: 'Practitioner', id: 'stable-id-1' }, request: { method: 'POST', url: 'Practitioner' } }],
    };

    const result = transformBundle(bundle, new Map([['stable-id-1', 'Cardiology']]));

    const practitioner = result.entry?.find((e) => e.resource?.resourceType === 'Practitioner')?.resource as any;
    expect(practitioner.qualification[0].code.text).toBe('Cardiology');
    expect(practitioner.extension).toContainEqual({
      url: 'http://hl7.org/fhir/StructureDefinition/timezone',
      valueCode: expect.any(String),
    });

    const role = result.entry?.find((e) => e.resource?.resourceType === 'PractitionerRole')?.resource as any;
    expect(role.specialty[0].coding[0].code).toBe('Cardiology');
    expect(role.practitioner.reference).toBe('Practitioner/stable-id-1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tools/seed/pass2-transform.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```typescript
// tools/seed/pass2-transform.ts
import type { Bundle, BundleEntry } from '@medplum/fhirtypes';

const KEPT_RESOURCE_TYPES = new Set([
  'Patient',
  'Practitioner',
  'Organization',
  'Encounter',
  'Condition',
  'MedicationRequest',
  'AllergyIntolerance',
]);

const SYNTHEA_STABLE_ID_SYSTEM = 'https://synthea.mitre.org/identifier';
const NUCC_SYSTEM = 'http://nucc.org/provider-taxonomy';
const TIMEZONE_EXT_URL = 'http://hl7.org/fhir/StructureDefinition/timezone';
const DEFAULT_TIMEZONE = 'America/New_York';

/**
 * Per-bundle rewrite: filters to the 7 resource types the app reads, rewrites
 * Practitioner/Organization from bare POST to conditional ifNoneExist upserts
 * keyed on Synthea's stable id, injects the resolved specialty as both
 * PractitionerRole.specialty (NUCC-coded) and Practitioner.qualification[0]
 * (display copy), and adds the mandatory timezone extension.
 */
export function transformBundle(bundle: Bundle, specialtiesByStableId: Map<string, string>): Bundle {
  const filteredEntries = (bundle.entry ?? []).filter(
    (entry) => entry.resource?.resourceType && KEPT_RESOURCE_TYPES.has(entry.resource.resourceType)
  );

  const outputEntries: BundleEntry[] = [];

  for (const entry of filteredEntries) {
    const resource = entry.resource as { resourceType: string; id?: string };

    if (resource.resourceType === 'Practitioner' && resource.id) {
      const specialty = specialtiesByStableId.get(resource.id) ?? 'General Practice';
      const practitioner = {
        ...resource,
        qualification: [{ code: { text: specialty } }],
        extension: [...((resource as any).extension ?? []), { url: TIMEZONE_EXT_URL, valueCode: DEFAULT_TIMEZONE }],
      };
      outputEntries.push({
        ...entry,
        resource: practitioner as BundleEntry['resource'],
        request: {
          method: 'POST',
          url: 'Practitioner',
          ifNoneExist: `identifier=${SYNTHEA_STABLE_ID_SYSTEM}|${resource.id}`,
        },
      });
      outputEntries.push({
        resource: {
          resourceType: 'PractitionerRole',
          practitioner: { reference: `Practitioner/${resource.id}` },
          specialty: [{ coding: [{ system: NUCC_SYSTEM, code: specialty, display: specialty }] }],
        } as BundleEntry['resource'],
        request: {
          method: 'POST',
          url: 'PractitionerRole',
          ifNoneExist: `practitioner=Practitioner/${resource.id}`,
        },
      });
      continue;
    }

    if (resource.resourceType === 'Organization' && resource.id) {
      outputEntries.push({
        ...entry,
        request: {
          method: 'POST',
          url: 'Organization',
          ifNoneExist: `identifier=${SYNTHEA_STABLE_ID_SYSTEM}|${resource.id}`,
        },
      });
      continue;
    }

    outputEntries.push(entry);
  }

  return { ...bundle, entry: outputEntries };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tools/seed/pass2-transform.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/seed/pass2-transform.ts tools/seed/pass2-transform.test.ts
git commit -m "feat(seed): per-bundle transform — filter, dedup-safe upserts, specialty injection"
```

---

### Task 7: `tools/seed/upload.ts` — transaction upload with retry

**Files:**
- Create: `tools/seed/upload.ts`
- Test: `tools/seed/upload.test.ts`

**Interfaces:**
- Produces: `uploadBundle(medplum: MedplumClient, bundle: Bundle): Promise<void>` — used by Task 9's CLI.

- [ ] **Step 1: Write the failing test**

```typescript
// tools/seed/upload.test.ts
import { describe, expect, test, vi } from 'vitest';
import type { Bundle } from '@medplum/fhirtypes';
import { uploadBundle } from './upload';

describe('uploadBundle', () => {
  test('calls executeBatch once on success', async () => {
    const bundle: Bundle = { resourceType: 'Bundle', type: 'transaction', entry: [] };
    const executeBatch = vi.fn().mockResolvedValue({ resourceType: 'Bundle', type: 'transaction-response', entry: [] });
    const medplum = { executeBatch } as any;

    await uploadBundle(medplum, bundle);

    expect(executeBatch).toHaveBeenCalledTimes(1);
    expect(executeBatch).toHaveBeenCalledWith(bundle);
  });

  test('retries once on a transient (network) failure, then succeeds', async () => {
    const bundle: Bundle = { resourceType: 'Bundle', type: 'transaction', entry: [] };
    const executeBatch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ resourceType: 'Bundle', type: 'transaction-response', entry: [] });
    const medplum = { executeBatch } as any;

    await uploadBundle(medplum, bundle);

    expect(executeBatch).toHaveBeenCalledTimes(2);
  });

  test('does not retry a validation error (4xx-shaped OperationOutcome)', async () => {
    const bundle: Bundle = { resourceType: 'Bundle', type: 'transaction', entry: [] };
    const validationError = { outcome: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid' }] } };
    const executeBatch = vi.fn().mockRejectedValue(validationError);
    const medplum = { executeBatch } as any;

    await expect(uploadBundle(medplum, bundle)).rejects.toBe(validationError);
    expect(executeBatch).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tools/seed/upload.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```typescript
// tools/seed/upload.ts
import type { MedplumClient } from '@medplum/core';
import type { Bundle } from '@medplum/fhirtypes';

const MAX_RETRIES = 3;

function isTransient(err: unknown): boolean {
  // A validation failure surfaces as an object carrying a FHIR OperationOutcome
  // (a real, structured rejection from the server) — never retry those, they
  // need a code fix. Anything else (network error, timeout) is transient.
  return !(err && typeof err === 'object' && 'outcome' in err);
}

/**
 * Uploads one already-transformed transaction Bundle (urn:uuid fullUrls
 * resolve cross-resource references server-side). Retries transient
 * (network/5xx-shaped) failures up to MAX_RETRIES times; validation errors
 * (OperationOutcome-shaped rejections) are not retried — a retry can't fix a
 * bad payload.
 */
export async function uploadBundle(medplum: MedplumClient, bundle: Bundle): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await medplum.executeBatch(bundle);
      return;
    } catch (err) {
      lastError = err;
      if (!isTransient(err)) {
        throw err;
      }
    }
  }
  throw lastError;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tools/seed/upload.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/seed/upload.ts tools/seed/upload.test.ts
git commit -m "feat(seed): transaction upload with transient-failure retry"
```

---

### Task 8: `data/core/agent-config.json` — bootstrap bundle (HealthcareServices, Device, CodeSystem/ValueSet)

**Files:**
- Create: `data/core/agent-config.json`
- Test: `tools/seed/agent-config.test.ts` (validates the JSON's shape, not a live upload)

**Interfaces:**
- Produces: a `Bundle` (type `transaction`) creating `HealthcareService/office-visit`, `HealthcareService/urgent-visit`, `Device/ai-appointment-agent`, and a small `CodeSystem`/`ValueSet` pair for `ai-previsit-summary`/`ai-chat` — uploaded via Task 9's CLI bootstrap step, or manually via the fork's existing `UploadDataPage`.

- [ ] **Step 1: Write the failing test**

```typescript
// tools/seed/agent-config.test.ts
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, test } from 'vitest';

describe('data/core/agent-config.json', () => {
  const bundle = JSON.parse(readFileSync(join(__dirname, '../../data/core/agent-config.json'), 'utf-8'));

  test('is a transaction bundle', () => {
    expect(bundle.resourceType).toBe('Bundle');
    expect(bundle.type).toBe('transaction');
  });

  test('creates both HealthcareServices with the right durations', () => {
    const officeVisit = bundle.entry.find((e: any) => e.resource?.id === 'office-visit');
    const urgentVisit = bundle.entry.find((e: any) => e.resource?.id === 'urgent-visit');
    expect(officeVisit.resource.resourceType).toBe('HealthcareService');
    expect(urgentVisit.resource.resourceType).toBe('HealthcareService');
    expect(officeVisit.request.ifNoneExist).toBeDefined();
    expect(urgentVisit.request.ifNoneExist).toBeDefined();
  });

  test('creates the ai-appointment-agent Device', () => {
    const device = bundle.entry.find((e: any) => e.resource?.resourceType === 'Device');
    expect(device.resource.id).toBe('ai-appointment-agent');
    expect(device.request.ifNoneExist).toBeDefined();
  });

  test('creates a CodeSystem covering ai-previsit-summary and ai-chat', () => {
    const codeSystem = bundle.entry.find((e: any) => e.resource?.resourceType === 'CodeSystem');
    const codes = codeSystem.resource.concept.map((c: any) => c.code);
    expect(codes).toContain('ai-previsit-summary');
    expect(codes).toContain('ai-chat');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tools/seed/agent-config.test.ts
```

Expected: FAIL — file doesn't exist.

- [ ] **Step 3: Create the bundle**

```json
{
  "resourceType": "Bundle",
  "type": "transaction",
  "entry": [
    {
      "fullUrl": "urn:uuid:00000000-0000-0000-0000-000000000001",
      "resource": {
        "resourceType": "HealthcareService",
        "id": "office-visit",
        "name": "Office Visit",
        "extension": [
          {
            "url": "https://medplum.com/fhir/StructureDefinition/SchedulingParameters",
            "extension": [
              { "url": "duration", "valueDuration": { "value": 30, "unit": "min", "system": "http://unitsofmeasure.org", "code": "min" } }
            ]
          }
        ]
      },
      "request": { "method": "POST", "url": "HealthcareService", "ifNoneExist": "identifier=http://example.com/agent-config|office-visit" }
    },
    {
      "fullUrl": "urn:uuid:00000000-0000-0000-0000-000000000002",
      "resource": {
        "resourceType": "HealthcareService",
        "id": "urgent-visit",
        "name": "Urgent Visit",
        "extension": [
          {
            "url": "https://medplum.com/fhir/StructureDefinition/SchedulingParameters",
            "extension": [
              { "url": "duration", "valueDuration": { "value": 15, "unit": "min", "system": "http://unitsofmeasure.org", "code": "min" } }
            ]
          }
        ]
      },
      "request": { "method": "POST", "url": "HealthcareService", "ifNoneExist": "identifier=http://example.com/agent-config|urgent-visit" }
    },
    {
      "fullUrl": "urn:uuid:00000000-0000-0000-0000-000000000003",
      "resource": {
        "resourceType": "Device",
        "id": "ai-appointment-agent",
        "deviceName": [{ "name": "AI Appointment Agent", "type": "user-friendly-name" }],
        "identifier": [{ "system": "http://example.com/agent-config", "value": "ai-appointment-agent" }]
      },
      "request": { "method": "POST", "url": "Device", "ifNoneExist": "identifier=http://example.com/agent-config|ai-appointment-agent" }
    },
    {
      "fullUrl": "urn:uuid:00000000-0000-0000-0000-000000000004",
      "resource": {
        "resourceType": "CodeSystem",
        "id": "agent-communication-category",
        "url": "http://example.com/agent-communication-category",
        "status": "active",
        "content": "complete",
        "concept": [
          { "code": "ai-previsit-summary", "display": "AI Pre-Visit Summary" },
          { "code": "ai-chat", "display": "AI Patient Chat" }
        ]
      },
      "request": { "method": "POST", "url": "CodeSystem", "ifNoneExist": "url=http://example.com/agent-communication-category" }
    },
    {
      "fullUrl": "urn:uuid:00000000-0000-0000-0000-000000000005",
      "resource": {
        "resourceType": "ValueSet",
        "id": "agent-communication-category",
        "url": "http://example.com/agent-communication-category-vs",
        "status": "active",
        "compose": { "include": [{ "system": "http://example.com/agent-communication-category" }] }
      },
      "request": { "method": "POST", "url": "ValueSet", "ifNoneExist": "url=http://example.com/agent-communication-category-vs" }
    }
  ]
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tools/seed/agent-config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add data/core/agent-config.json tools/seed/agent-config.test.ts
git commit -m "feat(seed): bootstrap bundle for HealthcareServices, Device, category CodeSystem"
```

---

### Task 9: `tools/seed/index.ts` — CLI entry point

**Files:**
- Create: `tools/seed/index.ts`
- Test: `tools/seed/index.test.ts` (tests argument parsing only — the full pipeline is exercised live in Task 10)

**Interfaces:**
- Consumes: `parseDiseaseDescriptions`, `scanPractitionerSpecialties`, `transformBundle`, `uploadBundle` from Tasks 3–7.
- Produces: a runnable CLI (`tsx tools/seed/index.ts [--limit N] [--slim|--full] [--dry-run]`).

- [ ] **Step 1: Write the failing test (argument parsing only)**

```typescript
// tools/seed/index.test.ts
import { describe, expect, test } from 'vitest';
import { parseCliArgs } from './index';

describe('parseCliArgs', () => {
  test('defaults: small limit, slim, not dry-run', () => {
    expect(parseCliArgs([])).toStrictEqual({ limit: 50, mode: 'slim', dryRun: false });
  });

  test('--limit overrides the default', () => {
    expect(parseCliArgs(['--limit', '200'])).toStrictEqual({ limit: 200, mode: 'slim', dryRun: false });
  });

  test('--full sets mode to full and clears the limit', () => {
    expect(parseCliArgs(['--full'])).toStrictEqual({ limit: undefined, mode: 'full', dryRun: false });
  });

  test('--dry-run sets dryRun true', () => {
    expect(parseCliArgs(['--dry-run'])).toStrictEqual({ limit: 50, mode: 'slim', dryRun: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tools/seed/index.test.ts
```

Expected: FAIL — `parseCliArgs` doesn't exist.

- [ ] **Step 3: Implement**

```typescript
// tools/seed/index.ts
import { MedplumClient } from '@medplum/core';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Bundle } from '@medplum/fhirtypes';
import 'dotenv/config';
import { scanPractitionerSpecialties } from './pass1-scan';
import { transformBundle } from './pass2-transform';
import { uploadBundle } from './upload';

export interface CliArgs {
  limit: number | undefined;
  mode: 'slim' | 'full';
  dryRun: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { limit: 50, mode: 'slim', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') {
      args.limit = Number(argv[++i]);
    } else if (argv[i] === '--full') {
      args.mode = 'full';
      args.limit = undefined;
    } else if (argv[i] === '--slim') {
      args.mode = 'slim';
    } else if (argv[i] === '--dry-run') {
      args.dryRun = true;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const fhirDir = join(__dirname, '../../fhir');
  let files = readdirSync(fhirDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(fhirDir, f));
  if (args.limit !== undefined) {
    files = files.slice(0, args.limit);
  }

  console.log(`Scanning ${files.length} bundles for practitioner specialties...`);
  const specialtiesByStableId = scanPractitionerSpecialties(files);

  if (args.dryRun) {
    const histogram = new Map<string, number>();
    for (const specialty of specialtiesByStableId.values()) {
      histogram.set(specialty, (histogram.get(specialty) ?? 0) + 1);
    }
    console.log('Specialty histogram (dry run, no writes):');
    for (const [specialty, count] of [...histogram].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${specialty}: ${count}`);
    }
    return;
  }

  const medplum = new MedplumClient({ baseUrl: process.env.MEDPLUM_BASE_URL });
  await medplum.startClientLogin(process.env.MEDPLUM_CLIENT_ID as string, process.env.MEDPLUM_CLIENT_SECRET as string);

  console.log('Uploading bootstrap config (HealthcareServices, Device, CodeSystem)...');
  const bootstrapBundle = JSON.parse(readFileSync(join(__dirname, '../../data/core/agent-config.json'), 'utf-8')) as Bundle;
  await uploadBundle(medplum, bootstrapBundle);

  console.log(`Uploading ${files.length} transformed bundles...`);
  let uploaded = 0;
  for (const filePath of files) {
    const bundle = JSON.parse(readFileSync(filePath, 'utf-8')) as Bundle;
    const transformed = transformBundle(bundle, specialtiesByStableId);
    await uploadBundle(medplum, transformed);
    uploaded++;
    if (uploaded % 50 === 0) {
      console.log(`  ${uploaded}/${files.length}`);
    }
  }
  console.log(`Done. Uploaded ${uploaded} bundles.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tools/seed/index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add the `dotenv` dev dependency the CLI imports**

```bash
npm install --save-dev dotenv
```

- [ ] **Step 6: Commit**

```bash
git add tools/seed/index.ts tools/seed/index.test.ts package.json package-lock.json
git commit -m "feat(seed): CLI entry point with --limit/--slim/--full/--dry-run"
```

---

### Task 10: Run the seeding tool against the real target Medplum project (manual verification)

**Files:** none (operational task — populates the target Medplum project's data, not this repo).

**Interfaces:**
- Consumes: the full `tools/seed/` pipeline from Tasks 3–9.
- Produces: real data in the target Medplum project, verified via direct FHIR searches — this is also the "one live `$find`-adjacent check" Design doc §16 flags as outstanding, exercised here for the first time against real `HealthcareService`/`Practitioner` data.

- [ ] **Step 1: Populate `.env` with real Medplum client-credentials**

```
MEDPLUM_BASE_URL=https://api.medplum.com/
MEDPLUM_CLIENT_ID=<real client id from the target Medplum project>
MEDPLUM_CLIENT_SECRET=<real client secret>
```

(A client-credentials client must already exist in the target Medplum project — create one via the Medplum app's Project Admin panel if it doesn't yet, with permission to create `HealthcareService`/`Device`/`CodeSystem`/`ValueSet`/`Patient`/`Practitioner`/`PractitionerRole`/`Organization`/`Encounter`/`Condition`/`MedicationRequest`/`AllergyIntolerance`.)

- [ ] **Step 2: Dry run first**

```bash
npx tsx tools/seed/index.ts --dry-run --limit 50
```

Expected: prints a specialty histogram with a real spread across multiple specialties (not >90% "General Practice" — that would indicate `ENCOUNTER_TYPE_SPECIALTY_MAP` from Task 4 needs more work). No writes happen.

- [ ] **Step 3: Real run at small scale**

```bash
npx tsx tools/seed/index.ts --limit 50
```

Expected: completes without throwing; prints `Done. Uploaded 50 bundles.`

- [ ] **Step 4: Verify no duplicate Practitioners**

In the Medplum app (or via a direct `medplum.searchResources` call in a scratch script), pick any NPI from the uploaded data and confirm:

```
GET /fhir/R4/Practitioner?identifier=https://synthea.mitre.org/identifier|<stable-id>
```

returns exactly one result, and a corresponding `PractitionerRole?practitioner=Practitioner/<id>` returns exactly one `PractitionerRole` with a NUCC-coded `specialty`.

- [ ] **Step 5: Verify the bootstrap config landed**

```
GET /fhir/R4/HealthcareService?name=Office Visit
GET /fhir/R4/HealthcareService?name=Urgent Visit
GET /fhir/R4/Device?identifier=http://example.com/agent-config|ai-appointment-agent
```

Expected: each returns exactly one resource.

This task has no code to commit — it's a verification checkpoint. If any check fails, return to the relevant earlier task (most likely Task 4's `ENCOUNTER_TYPE_SPECIALTY_MAP` for a skewed histogram, or Task 6's `transformBundle` for a duplicate-Practitioner failure) before proceeding to Phase 2.

---

## Phase 2 — Shared Bot Libraries

Everything in this phase is a pure function or data table — no live Medplum/NPPES/Gemini calls — so it's fully unit-testable, per Design doc §13's testing philosophy. Bots (Phase 3) are thin orchestrators built on top of these.

### Task 11: `src/config/specialties.ts` — the specialty vocabulary

**Files:**
- Create: `src/config/specialties.ts`
- Test: `src/config/specialties.test.ts`

**Interfaces:**
- Produces: `SPECIALTY_TABLE: SpecialtyDef[]`, `normalizeLlmSpecialty(freeText: string): SpecialtyDef | undefined` — consumed by `agent-intake.ts` (Task 17) and `agent-find-doctors.ts` (Task 18).

- [ ] **Step 1: Write the failing test**

```typescript
// src/config/specialties.test.ts
import { describe, expect, test } from 'vitest';
import { SPECIALTY_TABLE, normalizeLlmSpecialty } from './specialties';

describe('SPECIALTY_TABLE', () => {
  test('every entry has a label, nuccCode, nuccDisplay, and nppesTaxonomyDescription', () => {
    for (const entry of SPECIALTY_TABLE) {
      expect(entry.label).toBeTruthy();
      expect(entry.nuccCode).toBeTruthy();
      expect(entry.nuccDisplay).toBeTruthy();
      expect(entry.nppesTaxonomyDescription).toBeTruthy();
    }
  });

  test('no duplicate labels', () => {
    const labels = SPECIALTY_TABLE.map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('normalizeLlmSpecialty', () => {
  test('matches an exact label case-insensitively', () => {
    expect(normalizeLlmSpecialty('cardiology')?.label).toBe('Cardiology');
  });

  test('matches a known synonym', () => {
    expect(normalizeLlmSpecialty('heart doctor')?.label).toBe('Cardiology');
    expect(normalizeLlmSpecialty('skin doctor')?.label).toBe('Dermatology');
    expect(normalizeLlmSpecialty('gp')?.label).toBe('General Practice');
  });

  test('returns undefined for no match, never guesses', () => {
    expect(normalizeLlmSpecialty('quantum flux specialist')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/config/specialties.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```typescript
// src/config/specialties.ts

export interface SpecialtyDef {
  label: string;
  nuccCode: string;
  nuccDisplay: string;
  nppesTaxonomyDescription: string;
}

// Real NUCC provider taxonomy codes (http://nucc.org/provider-taxonomy),
// matching the specialty names produced by tools/seed/specialty-resolver.ts
// so both doctor pools resolve to the same vocabulary.
export const SPECIALTY_TABLE: SpecialtyDef[] = [
  { label: 'General Practice', nuccCode: '208D00000X', nuccDisplay: 'General Practice Physician', nppesTaxonomyDescription: 'General Practice' },
  { label: 'Cardiology', nuccCode: '207RC0000X', nuccDisplay: 'Cardiovascular Disease Physician', nppesTaxonomyDescription: 'Cardiovascular Disease' },
  { label: 'Pulmonology', nuccCode: '207RP1001X', nuccDisplay: 'Pulmonary Disease Physician', nppesTaxonomyDescription: 'Pulmonary Disease' },
  { label: 'Endocrinology', nuccCode: '207RE0101X', nuccDisplay: 'Endocrinology Physician', nppesTaxonomyDescription: 'Endocrinology, Diabetes & Metabolism' },
  { label: 'Gastroenterology', nuccCode: '207RG0100X', nuccDisplay: 'Gastroenterology Physician', nppesTaxonomyDescription: 'Gastroenterology' },
  { label: 'Neurology', nuccCode: '2084N0400X', nuccDisplay: 'Neurology Physician', nppesTaxonomyDescription: 'Neurology' },
  { label: 'Rheumatology', nuccCode: '207RR0500X', nuccDisplay: 'Rheumatology Physician', nppesTaxonomyDescription: 'Rheumatology' },
  { label: 'Nephrology', nuccCode: '207RN0300X', nuccDisplay: 'Nephrology Physician', nppesTaxonomyDescription: 'Nephrology' },
  { label: 'Dermatology', nuccCode: '207N00000X', nuccDisplay: 'Dermatology Physician', nppesTaxonomyDescription: 'Dermatology' },
  { label: 'Ophthalmology', nuccCode: '207W00000X', nuccDisplay: 'Ophthalmology Physician', nppesTaxonomyDescription: 'Ophthalmology' },
  { label: 'Otolaryngology', nuccCode: '207Y00000X', nuccDisplay: 'Otolaryngology Physician', nppesTaxonomyDescription: 'Otolaryngology' },
  { label: 'Urology', nuccCode: '208800000X', nuccDisplay: 'Urology Physician', nppesTaxonomyDescription: 'Urology' },
  { label: 'Hematology', nuccCode: '207RH0000X', nuccDisplay: 'Hematology Physician', nppesTaxonomyDescription: 'Hematology' },
  { label: 'Oncology', nuccCode: '207RX0202X', nuccDisplay: 'Medical Oncology Physician', nppesTaxonomyDescription: 'Medical Oncology' },
  { label: 'Infectious Disease', nuccCode: '207RI0200X', nuccDisplay: 'Infectious Disease Physician', nppesTaxonomyDescription: 'Infectious Disease' },
  { label: 'Psychiatry', nuccCode: '2084P0800X', nuccDisplay: 'Psychiatry Physician', nppesTaxonomyDescription: 'Psychiatry' },
  { label: 'Orthopedics', nuccCode: '207X00000X', nuccDisplay: 'Orthopaedic Surgery Physician', nppesTaxonomyDescription: 'Orthopaedic Surgery' },
  { label: 'Pediatrics', nuccCode: '208000000X', nuccDisplay: 'Pediatrics Physician', nppesTaxonomyDescription: 'Pediatrics' },
  { label: 'Obstetrics and Gynecology', nuccCode: '207V00000X', nuccDisplay: 'Obstetrics & Gynecology Physician', nppesTaxonomyDescription: 'Obstetrics & Gynecology' },
];

// One synonym set per SPECIALTY_TABLE row. Deliberately small and expanded as
// real LLM output is observed in testing (see Design doc §"normalizeLlmSpecialty").
const SYNONYMS: Record<string, string[]> = {
  'General Practice': ['gp', 'family doctor', 'general doctor', 'primary care', 'family medicine'],
  Cardiology: ['heart doctor', 'cardiologist', 'heart'],
  Dermatology: ['skin doctor', 'dermatologist', 'skin'],
  Orthopedics: ['bone doctor', 'orthopedist', 'orthopedics', 'orthopedic surgeon'],
  Pediatrics: ['kids doctor', 'pediatrician', "children's doctor"],
  Ophthalmology: ['eye doctor', 'eye specialist'],
  Psychiatry: ['mental health doctor', 'psychiatrist'],
  Otolaryngology: ['ent', 'ear nose throat doctor'],
};

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * Maps the LLM's free-text specialty guess onto a controlled SPECIALTY_TABLE
 * entry. Case-insensitive exact match against `label` first, then a fixed
 * synonym map. Returns undefined on no match in either — the caller
 * (agent-intake) must ask the user to clarify rather than guess.
 */
export function normalizeLlmSpecialty(freeText: string): SpecialtyDef | undefined {
  const normalized = normalize(freeText);
  const exact = SPECIALTY_TABLE.find((entry) => normalize(entry.label) === normalized);
  if (exact) return exact;

  for (const entry of SPECIALTY_TABLE) {
    const synonyms = SYNONYMS[entry.label] ?? [];
    if (synonyms.some((s) => normalize(s) === normalized)) {
      return entry;
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/config/specialties.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/specialties.ts src/config/specialties.test.ts
git commit -m "feat(config): specialty vocabulary and LLM-output normalizer"
```

---

### Task 12: `src/data/zip3-centroids.ts` + `src/bots/agent/lib/geo.ts`

The centroid table is generated from the US Census Bureau's public 2020 Gazetteer ZCTA file — real geographic data, not fabricated — by averaging 5-digit ZCTA centroids grouped by their 3-digit prefix.

**Files:**
- Create: `tools/seed/generate-zip3-centroids.ts` (one-off generator, not part of the runtime app)
- Create: `src/data/zip3-centroids.ts` (generated output, committed)
- Create: `src/bots/agent/lib/geo.ts`
- Test: `src/bots/agent/lib/geo.test.ts`

**Interfaces:**
- Produces: `ZIP3_CENTROIDS: Record<string, {lat: number, lng: number}>`, `haversineMiles`, `patientCoords`, `zip3Centroid` — consumed by `ranking.ts` (Task 13).

- [ ] **Step 1: Write the generator script**

```typescript
// tools/seed/generate-zip3-centroids.ts
// One-off script: downloads the Census Bureau's 2020 Gazetteer ZCTA file,
// averages each ZCTA's centroid into its 3-digit prefix, writes
// src/data/zip3-centroids.ts. Not run as part of the app or the seed CLI —
// run manually, once, when the table needs regenerating.
import { writeFileSync } from 'fs';

const GAZETTEER_URL = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_gaz_zcta_national.zip';

async function main(): Promise<void> {
  console.log(`Fetching ${GAZETTEER_URL} ...`);
  console.log('This file is a zipped TSV; unzip it locally first if this script'
    + ' cannot unzip in-process, then point UNZIPPED_TSV_PATH at the .txt file below.');

  const UNZIPPED_TSV_PATH = process.env.UNZIPPED_TSV_PATH;
  if (!UNZIPPED_TSV_PATH) {
    throw new Error('Set UNZIPPED_TSV_PATH to the unzipped 2020_gaz_zcta_national.txt file before running.');
  }
  const { readFileSync } = await import('fs');
  const lines = readFileSync(UNZIPPED_TSV_PATH, 'utf-8').split('\n').slice(1); // skip header

  const sums = new Map<string, { latSum: number; lngSum: number; count: number }>();
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const zcta = cols[0].trim();
    const lat = Number(cols[cols.length - 2]);
    const lng = Number(cols[cols.length - 1]);
    if (zcta.length !== 5 || Number.isNaN(lat) || Number.isNaN(lng)) continue;
    const prefix = zcta.slice(0, 3);
    const entry = sums.get(prefix) ?? { latSum: 0, lngSum: 0, count: 0 };
    entry.latSum += lat;
    entry.lngSum += lng;
    entry.count += 1;
    sums.set(prefix, entry);
  }

  const centroids: Record<string, { lat: number; lng: number }> = {};
  for (const [prefix, { latSum, lngSum, count }] of sums) {
    centroids[prefix] = { lat: Number((latSum / count).toFixed(4)), lng: Number((lngSum / count).toFixed(4)) };
  }

  const output = `// Generated by tools/seed/generate-zip3-centroids.ts from the US Census
// Bureau's 2020 Gazetteer ZCTA file. Each entry is the average centroid of
// every 5-digit ZCTA sharing that 3-digit prefix. Regenerate, don't hand-edit.
export const ZIP3_CENTROIDS: Record<string, { lat: number; lng: number }> = ${JSON.stringify(centroids, null, 2)};
`;
  writeFileSync('src/data/zip3-centroids.ts', output);
  console.log(`Wrote ${Object.keys(centroids).length} zip3 centroids to src/data/zip3-centroids.ts`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the generator (manual, one-time)**

```bash
# Download and unzip the Gazetteer file yourself first (browser or curl+unzip),
# then:
UNZIPPED_TSV_PATH=/path/to/2020_gaz_zcta_national.txt npx tsx tools/seed/generate-zip3-centroids.ts
```

Expected: `src/data/zip3-centroids.ts` is written with roughly 900 entries (one per distinct 3-digit US zip prefix). Commit the generated file — it doesn't need to regenerate at build/runtime.

- [ ] **Step 3: Write the failing test for `geo.ts`**

```typescript
// src/bots/agent/lib/geo.test.ts
import { describe, expect, test } from 'vitest';
import { haversineMiles, patientCoords, zip3Centroid } from './geo';
import type { Patient } from '@medplum/fhirtypes';

describe('haversineMiles', () => {
  test('distance between the same point is zero', () => {
    expect(haversineMiles({ lat: 40.7128, lng: -74.006 }, { lat: 40.7128, lng: -74.006 })).toBeCloseTo(0, 5);
  });

  test('NYC to LA is roughly 2445 miles', () => {
    const nyc = { lat: 40.7128, lng: -74.006 };
    const la = { lat: 34.0522, lng: -118.2437 };
    expect(haversineMiles(nyc, la)).toBeGreaterThan(2400);
    expect(haversineMiles(nyc, la)).toBeLessThan(2500);
  });
});

describe('patientCoords', () => {
  test('extracts lat/lng from the geolocation extension', () => {
    const patient: Patient = {
      resourceType: 'Patient',
      address: [
        {
          extension: [
            {
              url: 'http://hl7.org/fhir/StructureDefinition/geolocation',
              extension: [
                { url: 'latitude', valueDecimal: 42.35 },
                { url: 'longitude', valueDecimal: -71.06 },
              ],
            },
          ],
        },
      ],
    };
    expect(patientCoords(patient)).toStrictEqual({ lat: 42.35, lng: -71.06 });
  });

  test('returns undefined when the extension is absent', () => {
    expect(patientCoords({ resourceType: 'Patient' })).toBeUndefined();
  });
});

describe('zip3Centroid', () => {
  test('returns undefined for an unrecognized prefix', () => {
    expect(zip3Centroid('000')).toBeUndefined();
  });

  test('returns a coordinate for a real prefix', () => {
    // '100' is Manhattan, NY — must be present in the generated table
    expect(zip3Centroid('10001')).toBeDefined();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
npx vitest run src/bots/agent/lib/geo.test.ts
```

Expected: FAIL — `geo.ts` doesn't exist.

- [ ] **Step 5: Implement `geo.ts`**

```typescript
// src/bots/agent/lib/geo.ts
import type { Patient } from '@medplum/fhirtypes';
import { ZIP3_CENTROIDS } from '../../../data/zip3-centroids';

const EARTH_RADIUS_MILES = 3958.8;
const GEOLOCATION_EXT_URL = 'http://hl7.org/fhir/StructureDefinition/geolocation';

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Standard Haversine formula. Pure function, no I/O. */
export function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

/**
 * Extracts a patient's coordinates from the geolocation extension — no zip
 * lookup needed, confirmed present on every Synthea-seeded patient. Returns
 * undefined if absent (a real-world patient with no geolocation extension);
 * caller falls back to zip3Centroid in that case.
 */
export function patientCoords(patient: Patient): { lat: number; lng: number } | undefined {
  const geoExt = patient.address?.[0]?.extension?.find((e) => e.url === GEOLOCATION_EXT_URL);
  const lat = geoExt?.extension?.find((e) => e.url === 'latitude')?.valueDecimal;
  const lng = geoExt?.extension?.find((e) => e.url === 'longitude')?.valueDecimal;
  if (lat === undefined || lng === undefined) {
    return undefined;
  }
  return { lat, lng };
}

/** Doctor-side coordinates (NPPES gives zip, not lat/lng). */
export function zip3Centroid(postalCode: string): { lat: number; lng: number } | undefined {
  return ZIP3_CENTROIDS[postalCode.slice(0, 3)];
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest run src/bots/agent/lib/geo.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tools/seed/generate-zip3-centroids.ts src/data/zip3-centroids.ts src/bots/agent/lib/geo.ts src/bots/agent/lib/geo.test.ts
git commit -m "feat(lib): geo distance helpers + generated zip3 centroid table"
```

---

### Task 13: `src/bots/agent/lib/ranking.ts`

**Files:**
- Create: `src/bots/agent/lib/ranking.ts`
- Test: `src/bots/agent/lib/ranking.test.ts`

**Interfaces:**
- Consumes: `haversineMiles`, `zip3Centroid` from Task 12.
- Produces: `DoctorCandidate`, `RankedCandidate` types, `rankCandidates(patientCoords, candidates): RankedCandidate[]` — consumed by `agent-find-doctors.ts` (Task 18).

- [ ] **Step 1: Write the failing test**

```typescript
// src/bots/agent/lib/ranking.test.ts
import { describe, expect, test } from 'vitest';
import { rankCandidates } from './ranking';
import type { DoctorCandidate } from './ranking';

function candidate(npi: string, postalCode: string): DoctorCandidate {
  return {
    npi,
    firstName: 'Test',
    lastName: npi,
    nuccCode: '207RC0000X',
    nuccDisplay: 'Cardiovascular Disease Physician',
    address: { postalCode },
  };
}

describe('rankCandidates', () => {
  test('sorts ascending by distance from the patient', () => {
    const patientCoords = { lat: 40.7128, lng: -74.006 }; // NYC
    const candidates = [candidate('far', '90001'), candidate('near', '10002')]; // LA, NYC-adjacent

    const result = rankCandidates(patientCoords, candidates);

    expect(result.map((c) => c.npi)).toStrictEqual(['near', 'far']);
    expect(result[0].distanceMiles).toBeLessThan(result[1].distanceMiles as number);
  });

  test('candidates with unresolvable coordinates sort last, not dropped', () => {
    const patientCoords = { lat: 40.7128, lng: -74.006 };
    const candidates = [candidate('unresolvable', '00000'), candidate('resolvable', '10002')];

    const result = rankCandidates(patientCoords, candidates);

    expect(result).toHaveLength(2);
    expect(result[result.length - 1].npi).toBe('unresolvable');
    expect(result[result.length - 1].distanceMiles).toBeUndefined();
  });

  test('undefined patientCoords leaves every candidate with undefined distance, order preserved', () => {
    const candidates = [candidate('a', '10002'), candidate('b', '90001')];

    const result = rankCandidates(undefined, candidates);

    expect(result.every((c) => c.distanceMiles === undefined)).toBe(true);
    expect(result.map((c) => c.npi)).toStrictEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/bots/agent/lib/ranking.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```typescript
// src/bots/agent/lib/ranking.ts
import { haversineMiles, zip3Centroid } from './geo';

export interface DoctorCandidate {
  npi: string;
  firstName: string;
  lastName: string;
  nuccCode: string;
  nuccDisplay: string;
  address: { line?: string[]; city?: string; state?: string; postalCode?: string };
  phone?: string;
}

export interface RankedCandidate extends DoctorCandidate {
  distanceMiles: number | undefined;
}

/**
 * Orders NPPES candidates for agent-find-doctors. Does NOT handle the
 * previous-physician-first rule — that's applied directly in
 * agent-find-doctors (a previous-physician match, when present, is always
 * prepended ahead of this ranked list), not blended into this function.
 */
export function rankCandidates(
  patientCoords: { lat: number; lng: number } | undefined,
  candidates: DoctorCandidate[]
): RankedCandidate[] {
  const withDistance: RankedCandidate[] = candidates.map((candidate) => {
    const candidateCoords = candidate.address.postalCode ? zip3Centroid(candidate.address.postalCode) : undefined;
    const distanceMiles =
      patientCoords && candidateCoords ? haversineMiles(patientCoords, candidateCoords) : undefined;
    return { ...candidate, distanceMiles };
  });

  return withDistance.sort((a, b) => {
    if (a.distanceMiles === undefined && b.distanceMiles === undefined) return 0;
    if (a.distanceMiles === undefined) return 1; // unresolvable sorts last, never dropped
    if (b.distanceMiles === undefined) return -1;
    return a.distanceMiles - b.distanceMiles;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/bots/agent/lib/ranking.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bots/agent/lib/ranking.ts src/bots/agent/lib/ranking.test.ts
git commit -m "feat(lib): rank NPPES candidates by distance, unresolvable sorts last"
```

---

### Task 14: `src/bots/agent/lib/nppes.ts`

**Files:**
- Create: `src/bots/agent/lib/nppes.ts`
- Test: `src/bots/agent/lib/nppes.test.ts`

**Interfaces:**
- Produces: `searchNppesDoctors(taxonomyDescription, city, state, limit?): Promise<DoctorCandidate[]>`, `getNppesDoctorByNpi(npi): Promise<DoctorCandidate | undefined>` — consumed by `agent-find-doctors.ts` (Task 18) and `ensurePractitionerAndSchedule.ts` (Task 19).

- [ ] **Step 1: Write the failing test (mocking `fetch`)**

```typescript
// src/bots/agent/lib/nppes.test.ts
import { afterEach, describe, expect, test, vi } from 'vitest';
import { searchNppesDoctors, getNppesDoctorByNpi } from './nppes';

const SAMPLE_RESULT = {
  number: '1234567890',
  basic: { first_name: 'Jane', last_name: 'Doe' },
  taxonomies: [{ code: '207RC0000X', desc: 'Cardiovascular Disease', primary: true }],
  addresses: [{ address_purpose: 'LOCATION', address_1: '123 Main St', city: 'Boston', state: 'MA', postal_code: '021081234', telephone_number: '555-1212' }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchNppesDoctors', () => {
  test('maps NPPES results to DoctorCandidate', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [SAMPLE_RESULT] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchNppesDoctors('Cardiovascular Disease', 'Boston', 'MA');

    expect(result).toStrictEqual([
      {
        npi: '1234567890',
        firstName: 'Jane',
        lastName: 'Doe',
        nuccCode: '207RC0000X',
        nuccDisplay: 'Cardiovascular Disease',
        address: { line: ['123 Main St'], city: 'Boston', state: 'MA', postalCode: '021081234' },
        phone: '555-1212',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('taxonomy_description=Cardiovascular+Disease'));
  });

  test('propagates a network failure to the caller', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(searchNppesDoctors('Cardiology', 'Boston', 'MA')).rejects.toThrow('network down');
  });
});

describe('getNppesDoctorByNpi', () => {
  test('returns undefined, not an error, when NPPES has no record', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) }));
    expect(await getNppesDoctorByNpi('0000000000')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/bots/agent/lib/nppes.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```typescript
// src/bots/agent/lib/nppes.ts
import type { DoctorCandidate } from './ranking';

const NPPES_BASE_URL = 'https://npiregistry.cms.hhs.gov/api/';

interface NppesResult {
  number: string;
  basic: { first_name: string; last_name: string };
  taxonomies: { code: string; desc: string; primary: boolean; state?: string }[];
  addresses: {
    address_purpose: string;
    address_1?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    telephone_number?: string;
  }[];
}

function mapResult(result: NppesResult): DoctorCandidate {
  const primaryTaxonomy = result.taxonomies.find((t) => t.primary) ?? result.taxonomies[0];
  const address = result.addresses.find((a) => a.address_purpose === 'LOCATION') ?? result.addresses[0];
  return {
    npi: result.number,
    firstName: result.basic.first_name,
    lastName: result.basic.last_name,
    nuccCode: primaryTaxonomy.code,
    nuccDisplay: primaryTaxonomy.desc,
    address: {
      line: address?.address_1 ? [address.address_1] : undefined,
      city: address?.city,
      state: address?.state,
      postalCode: address?.postal_code,
    },
    phone: address?.telephone_number,
  };
}

/**
 * Searches NPPES's public registry for active doctors matching a taxonomy
 * description and location. Network/5xx failures propagate to the caller
 * (bot-level failure) — never swallowed.
 */
export async function searchNppesDoctors(
  taxonomyDescription: string,
  city: string,
  state: string,
  limit = 20
): Promise<DoctorCandidate[]> {
  const url = `${NPPES_BASE_URL}?version=2.1&enumeration_type=NPI-1&taxonomy_description=${encodeURIComponent(taxonomyDescription)}&city=${encodeURIComponent(city)}&state=${encodeURIComponent(state)}&limit=${limit}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`NPPES search failed: ${response.status}`);
  }
  const body = (await response.json()) as { results: NppesResult[] };
  return body.results.map(mapResult);
}

/** Single-result lookup by NPI. Returns undefined (not an error) if NPPES has no record. */
export async function getNppesDoctorByNpi(npi: string): Promise<DoctorCandidate | undefined> {
  const url = `${NPPES_BASE_URL}?version=2.1&number=${npi}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`NPPES lookup failed: ${response.status}`);
  }
  const body = (await response.json()) as { results: NppesResult[] };
  return body.results[0] ? mapResult(body.results[0]) : undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/bots/agent/lib/nppes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bots/agent/lib/nppes.ts src/bots/agent/lib/nppes.test.ts
git commit -m "feat(lib): NPPES client — search and single-NPI lookup"
```

---

### Task 15: `src/bots/agent/lib/patientContext.ts`

**Files:**
- Create: `src/bots/agent/lib/patientContext.ts`
- Test: `src/bots/agent/lib/patientContext.test.ts`

**Interfaces:**
- Produces: `loadPatientClinicalContext(medplum, patientId): Promise<PatientClinicalContext>` — consumed by `agent-intake.ts` (Task 17) and `agent-patient-chat.ts` (Task 22).

- [ ] **Step 1: Write the failing test (using `@medplum/mock`'s `MockClient`)**

```typescript
// src/bots/agent/lib/patientContext.test.ts
import { describe, expect, test } from 'vitest';
import { MockClient } from '@medplum/mock';
import { loadPatientClinicalContext } from './patientContext';

describe('loadPatientClinicalContext', () => {
  test('loads patient plus their conditions, medications, allergies, and encounters', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient', name: [{ given: ['Test'], family: 'Patient' }] });
    await medplum.createResource({
      resourceType: 'Condition',
      subject: { reference: `Patient/${patient.id}` },
      code: { text: 'Childhood asthma' },
    });
    await medplum.createResource({
      resourceType: 'MedicationRequest',
      status: 'active',
      intent: 'order',
      subject: { reference: `Patient/${patient.id}` },
      medicationCodeableConcept: { text: 'Albuterol' },
    });
    await medplum.createResource({
      resourceType: 'AllergyIntolerance',
      patient: { reference: `Patient/${patient.id}` },
      code: { text: 'Peanuts' },
    });
    await medplum.createResource({
      resourceType: 'Encounter',
      status: 'finished',
      class: { code: 'AMB' },
      subject: { reference: `Patient/${patient.id}` },
    });

    const context = await loadPatientClinicalContext(medplum, patient.id as string);

    expect(context.patient.id).toBe(patient.id);
    expect(context.conditions).toHaveLength(1);
    expect(context.medications).toHaveLength(1);
    expect(context.allergies).toHaveLength(1);
    expect(context.encounters).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/bots/agent/lib/patientContext.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```typescript
// src/bots/agent/lib/patientContext.ts
import type { MedplumClient } from '@medplum/core';
import type { AllergyIntolerance, Condition, Encounter, MedicationRequest, Patient } from '@medplum/fhirtypes';

export interface PatientClinicalContext {
  patient: Patient;
  conditions: Condition[];
  medications: MedicationRequest[];
  allergies: AllergyIntolerance[];
  encounters: Encounter[];
}

/**
 * The one standardized "read everything relevant about this patient" query,
 * shared by agent-intake and agent-patient-chat so both bots ground
 * themselves against the same depth of data.
 */
export async function loadPatientClinicalContext(
  medplum: MedplumClient,
  patientId: string
): Promise<PatientClinicalContext> {
  const [patient, conditions, medications, allergies, encounters] = await Promise.all([
    medplum.readResource('Patient', patientId),
    medplum.searchResources('Condition', { subject: `Patient/${patientId}`, _count: '50', _sort: '-recorded-date' }),
    medplum.searchResources('MedicationRequest', { subject: `Patient/${patientId}`, _count: '50', _sort: '-authoredon' }),
    medplum.searchResources('AllergyIntolerance', { patient: `Patient/${patientId}`, _count: '50' }),
    medplum.searchResources('Encounter', {
      subject: `Patient/${patientId}`,
      _include: 'Encounter:practitioner',
      _count: '50',
      _sort: '-date',
    }),
  ]);

  return {
    patient,
    conditions: [...conditions],
    medications: [...medications],
    allergies: [...allergies],
    encounters: [...encounters],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/bots/agent/lib/patientContext.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bots/agent/lib/patientContext.ts src/bots/agent/lib/patientContext.test.ts
git commit -m "feat(lib): standardized patient clinical-context read"
```

---

### Task 16: `src/bots/agent/lib/prompts.ts`

**Files:**
- Create: `src/bots/agent/lib/prompts.ts`
- Test: `src/bots/agent/lib/prompts.test.ts`

**Interfaces:**
- Produces: `INTAKE_SYSTEM_PROMPT: string`, `buildIntakeUserPrompt(context, complaintText): string`, `CHAT_SYSTEM_PROMPT: string`, `buildChatUserPrompt(context, question): string`, `containsInterpretationLanguage(text: string): boolean` (the output guard's keyword screen) — consumed by `agent-intake.ts` (Task 17) and `agent-patient-chat.ts` (Task 22).

- [ ] **Step 1: Write the failing test**

```typescript
// src/bots/agent/lib/prompts.test.ts
import { describe, expect, test } from 'vitest';
import { CHAT_SYSTEM_PROMPT, INTAKE_SYSTEM_PROMPT, containsInterpretationLanguage } from './prompts';

describe('system prompts', () => {
  test('intake prompt instructs the model to never diagnose', () => {
    expect(INTAKE_SYSTEM_PROMPT.toLowerCase()).toContain('never diagnose');
  });

  test('chat prompt instructs relay-only behavior and a fixed refusal', () => {
    expect(CHAT_SYSTEM_PROMPT.toLowerCase()).toContain('never diagnose');
    expect(CHAT_SYSTEM_PROMPT.toLowerCase()).toContain('not recorded');
  });
});

describe('containsInterpretationLanguage', () => {
  test('flags common interpretation-flavored phrases', () => {
    expect(containsInterpretationLanguage('You should see a specialist soon.')).toBe(true);
    expect(containsInterpretationLanguage('I recommend increasing the dosage.')).toBe(true);
    expect(containsInterpretationLanguage('This likely has a viral cause.')).toBe(true);
  });

  test('does not flag a plain factual relay', () => {
    expect(containsInterpretationLanguage('The record shows a prescription for Albuterol, filled on 2026-01-05.')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/bots/agent/lib/prompts.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```typescript
// src/bots/agent/lib/prompts.ts
import type { PatientClinicalContext } from './patientContext';

export const INTAKE_SYSTEM_PROMPT = `You are an intake assistant for a doctor appointment booking system. Given a
patient's clinical history and a short natural-language complaint, you must:
1. Infer the single most relevant medical specialty for this complaint.
2. Extract a short (one sentence) plain-English reason for the visit.
3. Classify urgency as exactly "routine" or "urgent".
4. Write a 2-3 sentence pre-visit summary a doctor could read before seeing this patient.

You must never diagnose, speculate about a specific condition, or suggest a
treatment. Relay and summarize only what is asked. Respond with strict JSON:
{"specialty": string, "reason": string, "urgency": "routine"|"urgent", "summary": string}`;

export function buildIntakeUserPrompt(context: PatientClinicalContext, complaintText: string): string {
  const conditions = context.conditions.map((c) => c.code?.text).filter(Boolean).join(', ') || 'none recorded';
  const medications = context.medications.map((m) => m.medicationCodeableConcept?.text).filter(Boolean).join(', ') || 'none recorded';
  const allergies = context.allergies.map((a) => a.code?.text).filter(Boolean).join(', ') || 'none recorded';
  return `Patient history:
- Conditions: ${conditions}
- Medications: ${medications}
- Allergies: ${allergies}

Patient's complaint: "${complaintText}"`;
}

export const CHAT_SYSTEM_PROMPT = `You are a record-lookup assistant for a doctor preparing to see a patient. You
answer questions using ONLY the patient record provided below — you never
diagnose, interpret findings, suggest treatment or medication changes, or
give a prognosis or any other form of clinical advice, even if directly
asked or asked hypothetically. If asked for any of that, respond exactly
with: "I can only relay information from the patient's record — for
clinical interpretation, please consult the record directly." If the
record does not contain the answer, say plainly that it is not recorded —
never guess or infer.`;

export function buildChatUserPrompt(context: PatientClinicalContext, question: string): string {
  const conditions = context.conditions.map((c) => c.code?.text).filter(Boolean).join(', ') || 'none recorded';
  const medications = context.medications.map((m) => m.medicationCodeableConcept?.text).filter(Boolean).join(', ') || 'none recorded';
  const allergies = context.allergies.map((a) => a.code?.text).filter(Boolean).join(', ') || 'none recorded';
  const encounters = context.encounters
    .map((e) => `${e.period?.start ?? 'unknown date'}: ${e.type?.[0]?.text ?? 'visit'}`)
    .join('; ') || 'none recorded';
  return `Patient record:
- Conditions: ${conditions}
- Medications: ${medications}
- Allergies: ${allergies}
- Past encounters: ${encounters}

Doctor's question: "${question}"`;
}

const INTERPRETATION_PHRASES = [
  'you should',
  'i recommend',
  'i suggest',
  'likely has',
  'probably has',
  'appears to be',
  'consistent with a diagnosis',
  'should consider',
  'my advice',
];

/** Weak output guard (defense in depth, not a guarantee) — Design doc §10. */
export function containsInterpretationLanguage(text: string): boolean {
  const normalized = text.toLowerCase();
  return INTERPRETATION_PHRASES.some((phrase) => normalized.includes(phrase));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/bots/agent/lib/prompts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bots/agent/lib/prompts.ts src/bots/agent/lib/prompts.test.ts
git commit -m "feat(lib): system prompts and output-guard keyword screen"
```

---

## Phase 3 — Bots

Every bot below follows Medplum's standard shape: `export async function handler(medplum: MedplumClient, event: BotEvent<Input>): Promise<Output>`. Gemini calls use its OpenAI-compatible endpoint via plain `fetch` (no SDK dependency — Backend doc confirms bots have `fetch` available with no HTTP client needed). Live Gemini/NPPES/Medplum calls aren't mocked in these tests — per Design doc §13, bot *logic* is unit-tested via the pure libs already built in Phase 2; each bot handler additionally gets a `MockClient`-backed test for its Medplum reads/writes, with Gemini calls factored behind a small injectable function so the handler itself stays testable without a real network call.

### Task 17: `src/bots/agent/agent-intake.ts`

**Files:**
- Create: `src/bots/agent/agent-intake.ts`
- Test: `src/bots/agent/agent-intake.test.ts`

**Interfaces:**
- Consumes: `loadPatientClinicalContext` (Task 15), `normalizeLlmSpecialty` (Task 11), `INTAKE_SYSTEM_PROMPT`/`buildIntakeUserPrompt` (Task 16).
- Produces: `handler(medplum, event: BotEvent<{patientId: string; complaintText: string}>): Promise<IntakeResult>` where `IntakeResult = {intent: {specialtyCode: string; specialtyLabel: string; reason: string; urgency: 'routine'|'urgent'}; summaryCommunicationId: string} | {needsClarification: true}` — `specialtyCode` is consumed by `agent-find-doctors.ts` (Task 18).

- [ ] **Step 1: Write the failing test**

```typescript
// src/bots/agent/agent-intake.test.ts
import { describe, expect, test, vi } from 'vitest';
import { MockClient } from '@medplum/mock';
import { handler, __setGeminiCallerForTests } from './agent-intake';

describe('agent-intake handler', () => {
  test('creates a preparation Communication and returns normalized intent', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient', name: [{ given: ['Test'], family: 'Patient' }] });
    __setGeminiCallerForTests(async () => ({
      specialty: 'cardiology',
      reason: 'Chest discomfort during exercise',
      urgency: 'routine',
      summary: 'Patient reports exertional chest discomfort over the past week.',
    }));

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { patientId: patient.id as string, complaintText: 'My chest hurts when I run' },
      contentType: 'application/json',
      secrets: { GEMINI_API_KEY: { valueString: 'test-key' } },
    });

    expect(result).toMatchObject({
      intent: { specialtyLabel: 'Cardiology', reason: 'Chest discomfort during exercise', urgency: 'routine' },
    });
    if (!('summaryCommunicationId' in result)) throw new Error('expected summaryCommunicationId');
    const communication = await medplum.readResource('Communication', result.summaryCommunicationId);
    expect(communication.status).toBe('preparation');
    expect(communication.recipient).toBeUndefined();
    expect(communication.meta?.tag).toContainEqual({ code: 'ai-generated' });
  });

  test('returns needsClarification when the specialty cannot be normalized', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient', name: [{ given: ['Test'], family: 'Patient' }] });
    __setGeminiCallerForTests(async () => ({
      specialty: 'quantum flux specialist',
      reason: 'Unclear',
      urgency: 'routine',
      summary: 'Unclear complaint.',
    }));

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { patientId: patient.id as string, complaintText: 'something weird' },
      contentType: 'application/json',
      secrets: { GEMINI_API_KEY: { valueString: 'test-key' } },
    });

    expect(result).toStrictEqual({ needsClarification: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/bots/agent/agent-intake.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```typescript
// src/bots/agent/agent-intake.ts
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Communication } from '@medplum/fhirtypes';
import { normalizeLlmSpecialty } from '../../config/specialties';
import { loadPatientClinicalContext } from './lib/patientContext';
import { INTAKE_SYSTEM_PROMPT, buildIntakeUserPrompt } from './lib/prompts';

interface GeminiIntakeResult {
  specialty: string;
  reason: string;
  urgency: 'routine' | 'urgent';
  summary: string;
}

export type IntakeInput = { patientId: string; complaintText: string };
export type IntakeResult =
  | { intent: { specialtyCode: string; specialtyLabel: string; reason: string; urgency: 'routine' | 'urgent' }; summaryCommunicationId: string }
  | { needsClarification: true };

type GeminiCaller = (apiKey: string, systemPrompt: string, userPrompt: string) => Promise<GeminiIntakeResult>;

let geminiCaller: GeminiCaller = callGeminiForIntake;

/** Test-only seam — swaps the real Gemini call for a stub. */
export function __setGeminiCallerForTests(fn: GeminiCaller): void {
  geminiCaller = fn;
}

async function callGeminiForIntake(apiKey: string, systemPrompt: string, userPrompt: string): Promise<GeminiIntakeResult> {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-2.5-flash-lite',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status}`);
  }
  const body = await response.json();
  return JSON.parse(body.choices[0].message.content) as GeminiIntakeResult;
}

export async function handler(medplum: MedplumClient, event: BotEvent<IntakeInput>): Promise<IntakeResult> {
  const { patientId, complaintText } = event.input;
  const apiKey = event.secrets['GEMINI_API_KEY']?.valueString as string;

  const context = await loadPatientClinicalContext(medplum, patientId);
  const userPrompt = buildIntakeUserPrompt(context, complaintText);
  const geminiResult = await geminiCaller(apiKey, INTAKE_SYSTEM_PROMPT, userPrompt);

  const specialty = normalizeLlmSpecialty(geminiResult.specialty);
  if (!specialty) {
    return { needsClarification: true };
  }

  const communication: Communication = await medplum.createResource({
    resourceType: 'Communication',
    status: 'preparation',
    category: [{ coding: [{ system: 'http://example.com/agent-communication-category', code: 'ai-previsit-summary' }] }],
    priority: geminiResult.urgency,
    subject: { reference: `Patient/${patientId}` },
    sender: { reference: 'Device/ai-appointment-agent' },
    payload: [{ contentString: geminiResult.summary }],
    meta: { tag: [{ code: 'ai-generated' }] },
  });

  return {
    intent: {
      specialtyCode: specialty.nuccCode,
      specialtyLabel: specialty.label,
      reason: geminiResult.reason,
      urgency: geminiResult.urgency,
    },
    summaryCommunicationId: communication.id as string,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/bots/agent/agent-intake.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bots/agent/agent-intake.ts src/bots/agent/agent-intake.test.ts
git commit -m "feat(bot): agent-intake — one Gemini call for intent + pre-visit summary"
```

---

### Task 18: `src/bots/agent/agent-find-doctors.ts`

**Files:**
- Create: `src/bots/agent/agent-find-doctors.ts`
- Test: `src/bots/agent/agent-find-doctors.test.ts`

**Interfaces:**
- Consumes: `searchNppesDoctors` (Task 14), `rankCandidates`, `patientCoords` (Tasks 12–13), `SPECIALTY_TABLE` (Task 11).
- Produces: `handler(medplum, event: BotEvent<{patientId: string; specialtyCode: string}>): Promise<{candidates: (RankedCandidate & {source: 'previous'|'nppes'; npi: string; lastSeen?: string; organizationName?: string})[]}>`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/bots/agent/agent-find-doctors.test.ts
import { describe, expect, test } from 'vitest';
import { MockClient } from '@medplum/mock';
import { handler, __setNppesSearcherForTests } from './agent-find-doctors';

describe('agent-find-doctors handler', () => {
  test('surfaces the previous physician first on an exact specialty match, tie-broken by most recent encounter', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({
      resourceType: 'Patient',
      address: [{ extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/geolocation', extension: [{ url: 'latitude', valueDecimal: 42.36 }, { url: 'longitude', valueDecimal: -71.06 }] }] }],
    });
    const olderDoc = await medplum.createResource({ resourceType: 'Practitioner', identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1000000001' }], name: [{ given: ['Older'], family: 'Doc' }] });
    const newerDoc = await medplum.createResource({ resourceType: 'Practitioner', identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1000000002' }], name: [{ given: ['Newer'], family: 'Doc' }] });
    await medplum.createResource({ resourceType: 'PractitionerRole', practitioner: { reference: `Practitioner/${olderDoc.id}` }, specialty: [{ coding: [{ system: 'http://nucc.org/provider-taxonomy', code: '207RC0000X' }] }] });
    await medplum.createResource({ resourceType: 'PractitionerRole', practitioner: { reference: `Practitioner/${newerDoc.id}` }, specialty: [{ coding: [{ system: 'http://nucc.org/provider-taxonomy', code: '207RC0000X' }] }] });
    await medplum.createResource({ resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, subject: { reference: `Patient/${patient.id}` }, participant: [{ individual: { reference: `Practitioner/${olderDoc.id}` } }], period: { start: '2024-01-01T00:00:00Z' } });
    await medplum.createResource({ resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, subject: { reference: `Patient/${patient.id}` }, participant: [{ individual: { reference: `Practitioner/${newerDoc.id}` } }], period: { start: '2025-06-01T00:00:00Z' } });
    __setNppesSearcherForTests(async () => []);

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { patientId: patient.id as string, specialtyCode: '207RC0000X' },
      contentType: 'application/json',
      secrets: {},
    });

    expect(result.candidates[0]).toMatchObject({ source: 'previous', npi: '1000000002' });
  });

  test('falls through to NPPES-only results when no previous match exists', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    __setNppesSearcherForTests(async () => [
      { npi: '9999999999', firstName: 'New', lastName: 'Doc', nuccCode: '207RC0000X', nuccDisplay: 'Cardiovascular Disease', address: { postalCode: '02108' } },
    ]);

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { patientId: patient.id as string, specialtyCode: '207RC0000X' },
      contentType: 'application/json',
      secrets: {},
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ source: 'nppes', npi: '9999999999' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/bots/agent/agent-find-doctors.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```typescript
// src/bots/agent/agent-find-doctors.ts
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Encounter, Patient, Practitioner, PractitionerRole } from '@medplum/fhirtypes';
import { SPECIALTY_TABLE } from '../../config/specialties';
import { patientCoords } from './lib/geo';
import { rankCandidates } from './lib/ranking';
import type { DoctorCandidate, RankedCandidate } from './lib/ranking';
import { searchNppesDoctors } from './lib/nppes';

export type FindDoctorsInput = { patientId: string; specialtyCode: string };
export type FoundCandidate = (RankedCandidate | DoctorCandidate) & {
  source: 'previous' | 'nppes';
  npi: string;
  lastSeen?: string;
  organizationName?: string;
};
export type FindDoctorsResult = { candidates: FoundCandidate[] };

type NppesSearcher = typeof searchNppesDoctors;
let nppesSearcher: NppesSearcher = searchNppesDoctors;

/** Test-only seam — swaps the real NPPES call for a stub. */
export function __setNppesSearcherForTests(fn: NppesSearcher): void {
  nppesSearcher = fn;
}

const NUCC_SYSTEM = 'http://nucc.org/provider-taxonomy';

export async function handler(medplum: MedplumClient, event: BotEvent<FindDoctorsInput>): Promise<FindDoctorsResult> {
  const { patientId, specialtyCode } = event.input;
  const patient = await medplum.readResource('Patient', patientId);

  const previous = await findPreviousPhysician(medplum, patientId, specialtyCode);

  const specialtyDef = SPECIALTY_TABLE.find((s) => s.nuccCode === specialtyCode);
  const nppesResults = specialtyDef
    ? await nppesSearcher(specialtyDef.nppesTaxonomyDescription, patient.address?.[0]?.city ?? '', patient.address?.[0]?.state ?? '')
    : [];
  const ranked = rankCandidates(patientCoords(patient), nppesResults);
  const nppesCandidates: FoundCandidate[] = ranked.slice(0, 10).map((c) => ({ ...c, source: 'nppes' as const, npi: c.npi }));

  return { candidates: previous ? [previous, ...nppesCandidates] : nppesCandidates };
}

async function findPreviousPhysician(
  medplum: MedplumClient,
  patientId: string,
  specialtyCode: string
): Promise<FoundCandidate | undefined> {
  const encounters: Encounter[] = await medplum.searchResources('Encounter', {
    subject: `Patient/${patientId}`,
    _include: 'Encounter:practitioner',
    _count: '200',
  });

  const practitionerIds = [
    ...new Set(
      encounters
        .flatMap((e) => e.participant?.map((p) => p.individual?.reference))
        .filter((ref): ref is string => !!ref?.startsWith('Practitioner/'))
        .map((ref) => ref.split('/')[1])
    ),
  ];
  if (practitionerIds.length === 0) return undefined;

  const roles: PractitionerRole[] = await medplum.searchResources('PractitionerRole', {
    practitioner: practitionerIds.map((id) => `Practitioner/${id}`).join(','),
    specialty: `${NUCC_SYSTEM}|${specialtyCode}`,
  });
  if (roles.length === 0) return undefined;

  const matchingIds = new Set(roles.map((r) => r.practitioner?.reference?.split('/')[1]));

  // Tie-break: most recent Encounter.period.start wins among matching practitioners.
  let winnerId: string | undefined;
  let winnerDate = '';
  for (const encounter of encounters) {
    const id = encounter.participant?.[0]?.individual?.reference?.split('/')[1];
    if (id && matchingIds.has(id) && (encounter.period?.start ?? '') > winnerDate) {
      winnerId = id;
      winnerDate = encounter.period?.start ?? '';
    }
  }
  if (!winnerId) return undefined;

  const practitioner: Practitioner = await medplum.readResource('Practitioner', winnerId);
  const npi = practitioner.identifier?.find((i) => i.system === 'http://hl7.org/fhir/sid/us-npi')?.value ?? '';

  return {
    source: 'previous',
    npi,
    firstName: practitioner.name?.[0]?.given?.[0] ?? '',
    lastName: practitioner.name?.[0]?.family ?? '',
    nuccCode: specialtyCode,
    nuccDisplay: SPECIALTY_TABLE.find((s) => s.nuccCode === specialtyCode)?.nuccDisplay ?? '',
    address: {},
    lastSeen: winnerDate,
    distanceMiles: undefined,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/bots/agent/agent-find-doctors.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bots/agent/agent-find-doctors.ts src/bots/agent/agent-find-doctors.test.ts
git commit -m "feat(bot): agent-find-doctors — previous-physician + NPPES ranking"
```

---

### Task 19: `src/bots/agent/lib/ensurePractitionerAndSchedule.ts`

The most structurally sensitive piece in the plan — gets the `SchedulingParameters` extension shape and the two-HealthcareService `serviceType` array wrong here and every doctor silently has zero bookable time (Data Model doc's explicit warning).

**Files:**
- Create: `src/bots/agent/lib/ensurePractitionerAndSchedule.ts`
- Create: `src/bots/agent/lib/timezones.ts` (small state-abbreviation -> IANA timezone table)
- Test: `src/bots/agent/lib/ensurePractitionerAndSchedule.test.ts`

**Interfaces:**
- Consumes: `getNppesDoctorByNpi` (Task 14).
- Produces: `ensurePractitionerAndSchedule(medplum, npi, candidate?): Promise<{practitionerId: string; scheduleId: string; healthcareServiceIds: {routine: string; urgent: string}}>` — consumed only by `agent-ensure-doctor.ts` (Task 20).

- [ ] **Step 1: Write `timezones.ts` (real, standard US state -> IANA data, not fabricated)**

```typescript
// src/bots/agent/lib/timezones.ts
export const STATE_TO_TIMEZONE: Record<string, string> = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago',
  CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York',
  FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu', ID: 'America/Denver',
  IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis', IA: 'America/Chicago', KS: 'America/Chicago',
  KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York', MD: 'America/New_York',
  MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago', MS: 'America/Chicago',
  MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago', NV: 'America/Los_Angeles',
  NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York',
  NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York', OK: 'America/Chicago',
  OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York',
  SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', UT: 'America/Denver',
  VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles', WV: 'America/New_York',
  WI: 'America/Chicago', WY: 'America/Denver', DC: 'America/New_York',
};

export function timezoneForState(state: string | undefined): string {
  return (state && STATE_TO_TIMEZONE[state.toUpperCase()]) || 'America/New_York';
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// src/bots/agent/lib/ensurePractitionerAndSchedule.test.ts
import { describe, expect, test } from 'vitest';
import { MockClient } from '@medplum/mock';
import { ensurePractitionerAndSchedule, __setNppesLookupForTests } from './ensurePractitionerAndSchedule';

describe('ensurePractitionerAndSchedule', () => {
  test('creates Practitioner, PractitionerRole, and a two-service Schedule for a new NPI', async () => {
    const medplum = new MockClient();
    await medplum.createResource({ resourceType: 'HealthcareService', id: 'office-visit', name: 'Office Visit' });
    await medplum.createResource({ resourceType: 'HealthcareService', id: 'urgent-visit', name: 'Urgent Visit' });

    const result = await ensurePractitionerAndSchedule(medplum, '1234567890', {
      npi: '1234567890', firstName: 'Jane', lastName: 'Doe', nuccCode: '207RC0000X', nuccDisplay: 'Cardiovascular Disease',
      address: { state: 'MA', postalCode: '02108' },
    });

    expect(result.healthcareServiceIds).toStrictEqual({ routine: 'office-visit', urgent: 'urgent-visit' });

    const schedule = await medplum.readResource('Schedule', result.scheduleId);
    expect(schedule.actor?.[0].reference).toBe(`Practitioner/${result.practitionerId}`);
    expect(schedule.serviceType).toHaveLength(2);
    for (const concept of schedule.serviceType ?? []) {
      const ref = concept.extension?.find((e: any) => e.url === 'https://medplum.com/fhir/service-type-reference');
      expect(ref?.valueReference?.reference).toMatch(/^HealthcareService\//);
    }
    const schedulingParams = schedule.extension?.find((e: any) => e.url === 'https://medplum.com/fhir/StructureDefinition/SchedulingParameters');
    expect(schedulingParams).toBeDefined();
    const timezoneExt = schedulingParams?.extension?.find((e: any) => e.url === 'timezone');
    expect(timezoneExt?.valueCode).toBe('America/New_York');

    const practitioner = await medplum.readResource('Practitioner', result.practitionerId);
    expect(practitioner.identifier?.[0]).toStrictEqual({ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' });

    const role = await medplum.searchOne('PractitionerRole', { practitioner: `Practitioner/${result.practitionerId}` });
    expect(role?.specialty?.[0].coding?.[0].code).toBe('207RC0000X');
  });

  test('is idempotent — a second call for the same NPI reuses the same resources', async () => {
    const medplum = new MockClient();
    await medplum.createResource({ resourceType: 'HealthcareService', id: 'office-visit', name: 'Office Visit' });
    await medplum.createResource({ resourceType: 'HealthcareService', id: 'urgent-visit', name: 'Urgent Visit' });
    const candidate = { npi: '1234567890', firstName: 'Jane', lastName: 'Doe', nuccCode: '207RC0000X', nuccDisplay: 'Cardiovascular Disease', address: { state: 'MA' } };

    const first = await ensurePractitionerAndSchedule(medplum, '1234567890', candidate);
    const second = await ensurePractitionerAndSchedule(medplum, '1234567890', candidate);

    expect(second.practitionerId).toBe(first.practitionerId);
    expect(second.scheduleId).toBe(first.scheduleId);
  });

  test('looks up NPPES when no candidate is supplied', async () => {
    const medplum = new MockClient();
    await medplum.createResource({ resourceType: 'HealthcareService', id: 'office-visit', name: 'Office Visit' });
    await medplum.createResource({ resourceType: 'HealthcareService', id: 'urgent-visit', name: 'Urgent Visit' });
    __setNppesLookupForTests(async () => ({
      npi: '1234567890', firstName: 'Jane', lastName: 'Doe', nuccCode: '207RC0000X', nuccDisplay: 'Cardiovascular Disease', address: { state: 'MA' },
    }));

    const result = await ensurePractitionerAndSchedule(medplum, '1234567890');

    const practitioner = await medplum.readResource('Practitioner', result.practitionerId);
    expect(practitioner.name?.[0].family).toBe('Doe');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run src/bots/agent/lib/ensurePractitionerAndSchedule.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement**

```typescript
// src/bots/agent/lib/ensurePractitionerAndSchedule.ts
import type { MedplumClient } from '@medplum/core';
import type { CodeableConcept, Extension, HealthcareService, Practitioner, Schedule } from '@medplum/fhirtypes';
import { getNppesDoctorByNpi } from './nppes';
import type { DoctorCandidate } from './ranking';
import { timezoneForState } from './timezones';

const NPI_SYSTEM = 'http://hl7.org/fhir/sid/us-npi';
const NUCC_SYSTEM = 'http://nucc.org/provider-taxonomy';
const SCHEDULING_PARAMETERS_URL = 'https://medplum.com/fhir/StructureDefinition/SchedulingParameters';
const SERVICE_TYPE_REF_URL = 'https://medplum.com/fhir/service-type-reference';
const TIMEZONE_EXT_URL = 'http://hl7.org/fhir/StructureDefinition/timezone';
const DAY_CODES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

type NppesLookup = typeof getNppesDoctorByNpi;
let nppesLookup: NppesLookup = getNppesDoctorByNpi;

/** Test-only seam. */
export function __setNppesLookupForTests(fn: NppesLookup): void {
  nppesLookup = fn;
}

interface WeeklyTemplate {
  workDays: number[];
  startHour: number;
  lunchStartHour: number;
  endHour: number;
}

function hashNpi(npi: string): number {
  let hash = 0;
  for (let i = 0; i < npi.length; i++) {
    hash = (hash * 31 + npi.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function deriveWeeklyTemplate(npi: string): WeeklyTemplate {
  const h = hashNpi(npi);
  const patterns = [[1, 2, 3, 4, 5], [1, 3, 5], [2, 4], [1, 2, 3, 4]];
  const workDays = patterns[h % patterns.length];
  const startHour = 8 + (h % 3); // 8, 9, or 10
  return { workDays, startHour, lunchStartHour: startHour + 4, endHour: startHour + 8 };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function buildAvailabilityExtension(template: WeeklyTemplate): Extension {
  const dayExtensions: Extension[] = template.workDays.map((day) => ({ url: 'daysOfWeek', valueCode: DAY_CODES[day] }));
  return {
    url: 'availability',
    extension: [
      {
        url: 'availableTime',
        extension: [
          ...dayExtensions,
          { url: 'availableStartTime', valueTime: `${pad(template.startHour)}:00:00` },
          { url: 'availableEndTime', valueTime: `${pad(template.lunchStartHour)}:00:00` },
        ],
      },
      {
        url: 'availableTime',
        extension: [
          ...dayExtensions,
          { url: 'availableStartTime', valueTime: `${pad(template.lunchStartHour + 1)}:00:00` },
          { url: 'availableEndTime', valueTime: `${pad(template.endHour)}:00:00` },
        ],
      },
    ],
  };
}

function buildSchedulingParametersExtension(template: WeeklyTemplate, timezone: string): Extension {
  return {
    url: SCHEDULING_PARAMETERS_URL,
    extension: [
      { url: 'timezone', valueCode: timezone },
      buildAvailabilityExtension(template),
    ],
  };
}

function serviceTypeConcept(healthcareServiceId: string): CodeableConcept {
  return {
    extension: [{ url: SERVICE_TYPE_REF_URL, valueReference: { reference: `HealthcareService/${healthcareServiceId}` } }],
  };
}

/**
 * Lazy provisioning — the sole caller is agent-ensure-doctor (never
 * agent-find-doctors, never the UI directly), since NPPES lookups need a bot.
 */
export async function ensurePractitionerAndSchedule(
  medplum: MedplumClient,
  npi: string,
  candidate?: DoctorCandidate
): Promise<{ practitionerId: string; scheduleId: string; healthcareServiceIds: { routine: string; urgent: string } }> {
  const officeVisit: HealthcareService = (await medplum.searchOne('HealthcareService', { name: 'Office Visit' })) as HealthcareService;
  const urgentVisit: HealthcareService = (await medplum.searchOne('HealthcareService', { name: 'Urgent Visit' })) as HealthcareService;
  const healthcareServiceIds = { routine: officeVisit.id as string, urgent: urgentVisit.id as string };

  let practitioner = await medplum.searchOne('Practitioner', { identifier: `${NPI_SYSTEM}|${npi}` });
  if (!practitioner) {
    const doctor = candidate ?? (await nppesLookup(npi));
    if (!doctor) {
      throw new Error(`No NPPES record found for NPI ${npi}`);
    }
    const created: Practitioner = await medplum.createResource({
      resourceType: 'Practitioner',
      identifier: [{ system: NPI_SYSTEM, value: npi }],
      name: [{ given: [doctor.firstName], family: doctor.lastName }],
    });
    await medplum.createResource({
      resourceType: 'PractitionerRole',
      practitioner: { reference: `Practitioner/${created.id}` },
      specialty: [{ coding: [{ system: NUCC_SYSTEM, code: doctor.nuccCode, display: doctor.nuccDisplay }] }],
    });
    practitioner = created;
  }
  const practitionerId = practitioner.id as string;

  let schedule = await medplum.searchOne('Schedule', { actor: `Practitioner/${practitionerId}` });
  if (!schedule) {
    const template = deriveWeeklyTemplate(npi);
    const timezone = timezoneForState(candidate?.address.state);
    schedule = await medplum.createResource<Schedule>({
      resourceType: 'Schedule',
      actor: [{ reference: `Practitioner/${practitionerId}` }],
      serviceType: [serviceTypeConcept(healthcareServiceIds.routine), serviceTypeConcept(healthcareServiceIds.urgent)],
      extension: [buildSchedulingParametersExtension(template, timezone)],
    });
  }

  return { practitionerId, scheduleId: schedule.id as string, healthcareServiceIds };
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run src/bots/agent/lib/ensurePractitionerAndSchedule.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/bots/agent/lib/ensurePractitionerAndSchedule.ts src/bots/agent/lib/timezones.ts src/bots/agent/lib/ensurePractitionerAndSchedule.test.ts
git commit -m "feat(lib): lazy Practitioner/Schedule provisioning, two-service Schedule"
```

---

### Task 20: `src/bots/agent/agent-ensure-doctor.ts`

**Files:**
- Create: `src/bots/agent/agent-ensure-doctor.ts`
- Test: `src/bots/agent/agent-ensure-doctor.test.ts`

**Interfaces:**
- Consumes: `ensurePractitionerAndSchedule` (Task 19).
- Produces: `handler(medplum, event: BotEvent<{npi: string; candidate?: DoctorCandidate}>): Promise<{practitionerId: string; scheduleId: string; healthcareServiceIds: {routine: string; urgent: string}}>`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/bots/agent/agent-ensure-doctor.test.ts
import { describe, expect, test } from 'vitest';
import { MockClient } from '@medplum/mock';
import { handler } from './agent-ensure-doctor';

describe('agent-ensure-doctor handler', () => {
  test('delegates straight to ensurePractitionerAndSchedule and returns its result', async () => {
    const medplum = new MockClient();
    await medplum.createResource({ resourceType: 'HealthcareService', id: 'office-visit', name: 'Office Visit' });
    await medplum.createResource({ resourceType: 'HealthcareService', id: 'urgent-visit', name: 'Urgent Visit' });

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: {
        npi: '1234567890',
        candidate: { npi: '1234567890', firstName: 'Jane', lastName: 'Doe', nuccCode: '207RC0000X', nuccDisplay: 'Cardiovascular Disease', address: { state: 'MA' } },
      },
      contentType: 'application/json',
      secrets: {},
    });

    expect(result.healthcareServiceIds).toStrictEqual({ routine: 'office-visit', urgent: 'urgent-visit' });
    expect(result.practitionerId).toBeDefined();
    expect(result.scheduleId).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/bots/agent/agent-ensure-doctor.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```typescript
// src/bots/agent/agent-ensure-doctor.ts
import type { BotEvent, MedplumClient } from '@medplum/core';
import { ensurePractitionerAndSchedule } from './lib/ensurePractitionerAndSchedule';
import type { DoctorCandidate } from './lib/ranking';

export type EnsureDoctorInput = { npi: string; candidate?: DoctorCandidate };
export type EnsureDoctorResult = { practitionerId: string; scheduleId: string; healthcareServiceIds: { routine: string; urgent: string } };

export async function handler(medplum: MedplumClient, event: BotEvent<EnsureDoctorInput>): Promise<EnsureDoctorResult> {
  const { npi, candidate } = event.input;
  return ensurePractitionerAndSchedule(medplum, npi, candidate);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/bots/agent/agent-ensure-doctor.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bots/agent/agent-ensure-doctor.ts src/bots/agent/agent-ensure-doctor.test.ts
git commit -m "feat(bot): agent-ensure-doctor — thin wrapper around lazy provisioning"
```

---

### Task 21: `src/bots/agent/agent-book-appointment.ts`

**Files:**
- Create: `src/bots/agent/agent-book-appointment.ts`
- Test: `src/bots/agent/agent-book-appointment.test.ts`

**Interfaces:**
- Produces: `handler(medplum, event: BotEvent<BookInput>): Promise<{ok: true; appointment: Appointment} | {ok: false; reason: 'slot_taken'}>` where `BookInput = {patientId: string; npi: string; scheduleId: string; healthcareServiceId: string; start: string; end: string; summaryCommunicationId: string; reason: string; complaintText: string; urgency: 'routine'|'urgent'}`.

This test exercises **our** catch/string-match logic against a controlled stub of `$hold`/`$confirm` — it is not a re-implementation of Medplum's real scheduling operations (those are exercised live in Task 26's deploy-and-verify step).

- [ ] **Step 1: Write the failing test**

```typescript
// src/bots/agent/agent-book-appointment.test.ts
import { describe, expect, test, vi } from 'vitest';
import { OperationOutcomeError } from '@medplum/core';
import { MockClient } from '@medplum/mock';
import { handler } from './agent-book-appointment';

const BASE_INPUT = {
  patientId: 'patient-1',
  npi: '1234567890',
  scheduleId: 'schedule-1',
  healthcareServiceId: 'office-visit',
  start: '2026-09-01T09:00:00Z',
  end: '2026-09-01T09:30:00Z',
  reason: 'Chest discomfort during exercise',
  complaintText: 'My chest hurts when I run',
  urgency: 'routine' as const,
};

describe('agent-book-appointment handler', () => {
  test('on success: confirms, writes stated-issue fields, updates the summary Communication', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    const practitioner = await medplum.createResource({ resourceType: 'Practitioner', identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }] });
    const communication = await medplum.createResource({ resourceType: 'Communication', status: 'preparation', subject: { reference: `Patient/${patient.id}` }, sender: { reference: 'Device/ai-appointment-agent' }, payload: [{ contentString: 'summary' }] });

    const heldAppointment = { resourceType: 'Appointment', id: 'appt-1', status: 'pending' };
    const confirmedAppointment = { resourceType: 'Appointment', id: 'appt-1', status: 'booked' };
    vi.spyOn(medplum, 'post').mockImplementation(async (url: string) => {
      if (url === 'Appointment/$hold') return heldAppointment as any;
      throw new Error(`unexpected post to ${url}`);
    });
    vi.spyOn(medplum, 'updateResource').mockImplementation(async (resource: any) => resource);
    vi.spyOn(medplum, 'readResource').mockImplementation(async (type: string) => {
      if (type === 'Appointment') return confirmedAppointment as any;
      throw new Error(`unexpected read of ${type}`);
    });

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { ...BASE_INPUT, patientId: patient.id as string, summaryCommunicationId: communication.id as string },
      contentType: 'application/json',
      secrets: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.appointment.status).toBe('booked');
  });

  test('on slot-taken $hold rejection: returns {ok:false, reason:"slot_taken"}, does not re-throw', async () => {
    const medplum = new MockClient();
    const slotTakenError = new OperationOutcomeError({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'invalid', details: { text: 'Requested time slot is not available' } }],
    });
    vi.spyOn(medplum, 'post').mockRejectedValue(slotTakenError);

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: BASE_INPUT,
      contentType: 'application/json',
      secrets: {},
    });

    expect(result).toStrictEqual({ ok: false, reason: 'slot_taken' });
  });

  test('on a different $hold rejection: re-throws, does not mislabel as slot_taken', async () => {
    const medplum = new MockClient();
    const badRequestError = new OperationOutcomeError({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'invalid', details: { text: 'Must provide a duration' } }],
    });
    vi.spyOn(medplum, 'post').mockRejectedValue(badRequestError);

    await expect(
      handler(medplum, { bot: { reference: 'Bot/123' }, input: BASE_INPUT, contentType: 'application/json', secrets: {} })
    ).rejects.toBe(badRequestError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/bots/agent/agent-book-appointment.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```typescript
// src/bots/agent/agent-book-appointment.ts
import type { BotEvent, MedplumClient } from '@medplum/core';
import { OperationOutcomeError } from '@medplum/core';
import type { Appointment } from '@medplum/fhirtypes';

export type BookInput = {
  patientId: string;
  npi: string;
  scheduleId: string;
  healthcareServiceId: string;
  start: string;
  end: string;
  summaryCommunicationId: string;
  reason: string;
  complaintText: string;
  urgency: 'routine' | 'urgent';
};
export type BookResult = { ok: true; appointment: Appointment } | { ok: false; reason: 'slot_taken' };

const SLOT_TAKEN_MESSAGE = 'Requested time slot is not available';
const SERVICE_TYPE_REF_URL = 'https://medplum.com/fhir/service-type-reference';

function urgencyToPriority(urgency: 'routine' | 'urgent'): number {
  return urgency === 'urgent' ? 1 : 5;
}

export async function handler(medplum: MedplumClient, event: BotEvent<BookInput>): Promise<BookResult> {
  const { patientId, npi, scheduleId, healthcareServiceId, start, end, summaryCommunicationId, reason, complaintText, urgency } = event.input;

  const practitioner = await medplum.searchOne('Practitioner', { identifier: `http://hl7.org/fhir/sid/us-npi|${npi}` });
  if (!practitioner) {
    throw new Error(`No Practitioner found for NPI ${npi} — agent-ensure-doctor should have provisioned one`);
  }

  const proposedAppointment: Appointment = {
    resourceType: 'Appointment',
    status: 'proposed',
    start,
    end,
    serviceType: [{ extension: [{ url: SERVICE_TYPE_REF_URL, valueReference: { reference: `HealthcareService/${healthcareServiceId}` } }] }],
    participant: [
      { actor: { reference: `Patient/${patientId}` }, status: 'accepted' },
      { actor: { reference: `Practitioner/${practitioner.id}` }, status: 'accepted' },
    ],
  };

  let held: Appointment;
  try {
    held = (await medplum.post(`Schedule/${scheduleId}/$hold`, proposedAppointment)) as Appointment;
  } catch (err) {
    if (err instanceof OperationOutcomeError) {
      const detailText = err.outcome.issue?.[0]?.details?.text;
      if (detailText === SLOT_TAKEN_MESSAGE) {
        return { ok: false, reason: 'slot_taken' };
      }
    }
    throw err;
  }

  await medplum.post(`Appointment/${held.id}/$confirm`, {});

  const confirmed = await medplum.readResource('Appointment', held.id as string);
  const updatedAppointment = await medplum.updateResource<Appointment>({
    ...confirmed,
    description: reason,
    comment: complaintText,
    reasonCode: [{ text: reason }],
    priority: urgencyToPriority(urgency),
  });

  await medplum.updateResource({
    resourceType: 'Communication',
    id: summaryCommunicationId,
    recipient: [{ reference: `Practitioner/${practitioner.id}` }],
    about: [{ reference: `Appointment/${held.id}` }],
    status: 'completed',
    sent: new Date().toISOString(),
  } as never);

  return { ok: true, appointment: updatedAppointment };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/bots/agent/agent-book-appointment.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bots/agent/agent-book-appointment.ts src/bots/agent/agent-book-appointment.test.ts
git commit -m "feat(bot): agent-book-appointment — hold/confirm with exact slot_taken match"
```

---

### Task 22: `src/bots/agent/agent-patient-chat.ts`

**Files:**
- Create: `src/bots/agent/agent-patient-chat.ts`
- Test: `src/bots/agent/agent-patient-chat.test.ts`

**Interfaces:**
- Consumes: `loadPatientClinicalContext` (Task 15), `CHAT_SYSTEM_PROMPT`/`buildChatUserPrompt`/`containsInterpretationLanguage` (Task 16).
- Produces: `handler(medplum, event: BotEvent<{patientId: string; question: string; threadId?: string}>): Promise<{answer: string; threadId: string}>`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/bots/agent/agent-patient-chat.test.ts
import { describe, expect, test } from 'vitest';
import { MockClient } from '@medplum/mock';
import { handler, __setGeminiCallerForTests } from './agent-patient-chat';

describe('agent-patient-chat handler', () => {
  test('persists question and answer as threaded Communications, starts a new thread', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    __setGeminiCallerForTests(async () => 'The record shows no known allergies.');

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { patientId: patient.id as string, question: 'Any known allergies?' },
      contentType: 'application/json',
      secrets: { GEMINI_API_KEY: { valueString: 'test-key' } },
    });

    expect(result.answer).toBe('The record shows no known allergies.');
    const question = await medplum.readResource('Communication', result.threadId);
    expect(question.sender).toStrictEqual({ reference: 'Practitioner/desk-agent' });
    expect(question.meta?.tag).toBeUndefined();

    const answers = await medplum.searchResources('Communication', { partOf: `Communication/${result.threadId}` });
    expect(answers).toHaveLength(1);
    expect(answers[0].sender).toStrictEqual({ reference: 'Device/ai-appointment-agent' });
    expect(answers[0].meta?.tag).toContainEqual({ code: 'ai-generated' });
  });

  test('substitutes the fixed refusal when the model answer contains interpretation language', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    __setGeminiCallerForTests(async () => 'You should consider a follow-up MRI.');

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { patientId: patient.id as string, question: 'What do you think this means?' },
      contentType: 'application/json',
      secrets: { GEMINI_API_KEY: { valueString: 'test-key' } },
    });

    expect(result.answer).toContain('I can only relay information from the patient\'s record');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/bots/agent/agent-patient-chat.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```typescript
// src/bots/agent/agent-patient-chat.ts
import type { BotEvent, MedplumClient } from '@medplum/core';
import { loadPatientClinicalContext } from './lib/patientContext';
import { CHAT_SYSTEM_PROMPT, buildChatUserPrompt, containsInterpretationLanguage } from './lib/prompts';

const REFUSAL =
  "I can only relay information from the patient's record — for clinical interpretation, please consult the record directly.";

export type ChatInput = { patientId: string; question: string; threadId?: string };
export type ChatResult = { answer: string; threadId: string };

type GeminiCaller = (apiKey: string, systemPrompt: string, userPrompt: string) => Promise<string>;
let geminiCaller: GeminiCaller = callGeminiForChat;

/** Test-only seam. */
export function __setGeminiCallerForTests(fn: GeminiCaller): void {
  geminiCaller = fn;
}

async function callGeminiForChat(apiKey: string, systemPrompt: string, userPrompt: string): Promise<string> {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-2.5-flash-lite',
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status}`);
  }
  const body = await response.json();
  return body.choices[0].message.content as string;
}

export async function handler(medplum: MedplumClient, event: BotEvent<ChatInput>): Promise<ChatResult> {
  const { patientId, question, threadId } = event.input;
  const apiKey = event.secrets['GEMINI_API_KEY']?.valueString as string;

  const context = await loadPatientClinicalContext(medplum, patientId);
  const userPrompt = buildChatUserPrompt(context, question);
  const rawAnswer = await geminiCaller(apiKey, CHAT_SYSTEM_PROMPT, userPrompt);
  const answer = containsInterpretationLanguage(rawAnswer) ? REFUSAL : rawAnswer;

  const questionCommunication = await medplum.createResource({
    resourceType: 'Communication',
    status: 'completed',
    category: [{ coding: [{ system: 'http://example.com/agent-communication-category', code: 'ai-chat' }] }],
    subject: { reference: `Patient/${patientId}` },
    sender: { reference: 'Practitioner/desk-agent' },
    payload: [{ contentString: question }],
    sent: new Date().toISOString(),
    partOf: threadId ? [{ reference: `Communication/${threadId}` }] : undefined,
  });

  await medplum.createResource({
    resourceType: 'Communication',
    status: 'completed',
    category: [{ coding: [{ system: 'http://example.com/agent-communication-category', code: 'ai-chat' }] }],
    subject: { reference: `Patient/${patientId}` },
    sender: { reference: 'Device/ai-appointment-agent' },
    payload: [{ contentString: answer }],
    sent: new Date().toISOString(),
    meta: { tag: [{ code: 'ai-generated' }] },
    partOf: [{ reference: `Communication/${threadId ?? questionCommunication.id}` }],
  });

  return { answer, threadId: threadId ?? (questionCommunication.id as string) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/bots/agent/agent-patient-chat.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bots/agent/agent-patient-chat.ts src/bots/agent/agent-patient-chat.test.ts
git commit -m "feat(bot): agent-patient-chat — grounded Q&A with output guard and audit trail"
```

---

### Task 23: `src/bots/agent/agent-expire-holds.ts`

**Files:**
- Create: `src/bots/agent/agent-expire-holds.ts`
- Test: `src/bots/agent/agent-expire-holds.test.ts`

**Interfaces:**
- Produces: `handler(medplum, event: BotEvent<unknown>): Promise<{expiredCount: number}>` — triggered by `Bot.cronString`, wired in Task 26.

- [ ] **Step 1: Write the failing test**

```typescript
// src/bots/agent/agent-expire-holds.test.ts
import { describe, expect, test } from 'vitest';
import { MockClient } from '@medplum/mock';
import { handler } from './agent-expire-holds';

describe('agent-expire-holds handler', () => {
  test('cancels the appointment owning a stale busy-tentative slot and deletes the slot', async () => {
    const medplum = new MockClient();
    const schedule = await medplum.createResource({ resourceType: 'Schedule', actor: [{ reference: 'Practitioner/dr-1' }] });
    const staleSlot = await medplum.createResource({
      resourceType: 'Slot',
      schedule: { reference: `Schedule/${schedule.id}` },
      status: 'busy-tentative',
      start: '2020-01-01T09:00:00Z',
      end: '2020-01-01T09:30:00Z',
    });
    const appointment = await medplum.createResource({
      resourceType: 'Appointment',
      status: 'pending',
      slot: [{ reference: `Slot/${staleSlot.id}` }],
      participant: [{ actor: { reference: 'Patient/p1' }, status: 'accepted' }],
    });

    const result = await handler(medplum, { bot: { reference: 'Bot/123' }, input: undefined, contentType: 'application/json', secrets: {} });

    expect(result.expiredCount).toBe(1);
    const cancelled = await medplum.readResource('Appointment', appointment.id as string);
    expect(cancelled.status).toBe('cancelled');
    await expect(medplum.readResource('Slot', staleSlot.id as string)).rejects.toThrow();
  });

  test('leaves a recent busy-tentative slot alone', async () => {
    const medplum = new MockClient();
    const schedule = await medplum.createResource({ resourceType: 'Schedule', actor: [{ reference: 'Practitioner/dr-1' }] });
    const recentSlot = await medplum.createResource({
      resourceType: 'Slot',
      schedule: { reference: `Schedule/${schedule.id}` },
      status: 'busy-tentative',
      start: new Date(Date.now() + 3600_000).toISOString(),
      end: new Date(Date.now() + 5400_000).toISOString(),
    });

    const result = await handler(medplum, { bot: { reference: 'Bot/123' }, input: undefined, contentType: 'application/json', secrets: {} });

    expect(result.expiredCount).toBe(0);
    const stillThere = await medplum.readResource('Slot', recentSlot.id as string);
    expect(stillThere.status).toBe('busy-tentative');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/bots/agent/agent-expire-holds.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```typescript
// src/bots/agent/agent-expire-holds.ts
import type { BotEvent, MedplumClient } from '@medplum/core';

const HOLD_TTL_MS = 15 * 60 * 1000;

export async function handler(medplum: MedplumClient, _event: BotEvent<unknown>): Promise<{ expiredCount: number }> {
  const cutoff = new Date(Date.now() - HOLD_TTL_MS).toISOString();
  const staleSlots = await medplum.searchResources('Slot', { status: 'busy-tentative', _lastUpdated: `lt${cutoff}` });

  let expiredCount = 0;
  for (const slot of staleSlots) {
    const appointment = await medplum.searchOne('Appointment', { slot: `Slot/${slot.id}` });
    if (appointment) {
      await medplum.updateResource({
        ...appointment,
        status: 'cancelled',
        cancelationReason: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/appointment-cancellation-reason', code: 'other', display: 'Hold expired' }],
        },
      });
    }
    await medplum.deleteResource('Slot', slot.id as string);
    expiredCount++;
  }

  return { expiredCount };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/bots/agent/agent-expire-holds.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bots/agent/agent-expire-holds.ts src/bots/agent/agent-expire-holds.test.ts
git commit -m "feat(bot): agent-expire-holds — cron cleanup of stale busy-tentative slots"
```

---

### Task 24: Fix `src/bots/core/cancel-appointment.ts` — stop orphaning the Slot

**Files:**
- Modify: `src/bots/core/cancel-appointment.ts`
- Modify: `src/bots/core/cancel-appointment.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: the same `handler(medplum, event: BotEvent<Appointment>): Promise<Bundle>` signature, now deleting rather than replacing the Slot — `agent-expire-holds` (Task 23) already relies on Slot deletion as the correct end state; this makes the manual-cancel path match it.

- [ ] **Step 1: Update the existing test to expect deletion, not a replacement 'free' Slot**

Replace the body of the `'Successfully cancel the appointment'` test in `src/bots/core/cancel-appointment.test.ts` (the assertions after `await handler(...)`) with:

```typescript
    // Check that the appointment was cancelled
    const cancelledAppointment = await medplum.readResource('Appointment', appointment.id as string);
    expect(cancelledAppointment).toBeDefined();
    expect(cancelledAppointment.status).toBe('cancelled');
    expect(cancelledAppointment.cancelationReason).toStrictEqual({
      coding: [
        {
          system: 'http://terminology.hl7.org/CodeSystem/appointment-cancellation-reason',
          code: 'prov',
          display: 'Provider',
        },
      ],
    });

    // Check that the held/busy Slot was deleted, not replaced with a 'free' one —
    // Slot only ever exists while busy/held; $find computes free time live.
    await expect(medplum.readResource('Slot', slot.id as string)).rejects.toThrow();
    const remainingSlots = await medplum.searchResources('Slot', { schedule: `Schedule/${schedule.id}` });
    expect(remainingSlots).toHaveLength(0);
```

- [ ] **Step 2: Run the test to verify it fails against the current implementation**

```bash
npx vitest run src/bots/core/cancel-appointment.test.ts
```

Expected: FAIL — the current handler still creates a replacement `free` Slot instead of deleting the original.

- [ ] **Step 3: Fix the handler**

Replace the Slot-handling block in `src/bots/core/cancel-appointment.ts` (everything from `// Instead of unlinking...` through the `if (!existingFreeSlot) {...}` block) with:

```typescript
  // Delete the held/busy Slot outright — Slot only ever exists while
  // busy/held (free time is computed live by $find, never persisted), so
  // deleting it here is what makes that time show as available again.
  entries.push({
    request: {
      method: 'DELETE',
      url: `Slot/${slotId}`,
    },
  });
```

(The `const slot = await medplum.readResource('Slot', slotId);` line and the `existingFreeSlot` lookup above it are no longer needed — remove them too, along with the now-unused `Slot` type import if nothing else in the file references it.)

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/bots/core/cancel-appointment.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bots/core/cancel-appointment.ts src/bots/core/cancel-appointment.test.ts
git commit -m "fix(bot): cancel-appointment deletes its Slot instead of orphaning it

The original implementation left the cancelled appointment's Slot as
'busy' and created a separate 'free' Slot to represent availability — a
model that made sense when free Slots were materialized ahead of time
(set-availability.ts, now removed) but is meaningless now that \$find
computes free time live. Deleting the Slot outright is what makes \$find
correctly show that time as available again."
```

---

### Task 25: `src/bots/core/reschedule-appointment.ts` (new) + modify `RescheduleAppointment.tsx`

**Files:**
- Create: `src/bots/core/reschedule-appointment.ts`
- Test: `src/bots/core/reschedule-appointment.test.ts`
- Modify: `src/components/actions/RescheduleAppointment.tsx`

**Interfaces:**
- Produces: `handler(medplum, event: BotEvent<{appointmentId: string; newStart: string; newEnd: string}>): Promise<{ok: true; appointment: Appointment} | {ok: false; reason: 'slot_taken'}>`.

- [ ] **Step 1: Write the failing test for the bot**

```typescript
// src/bots/core/reschedule-appointment.test.ts
import { describe, expect, test, vi } from 'vitest';
import { OperationOutcomeError } from '@medplum/core';
import { MockClient } from '@medplum/mock';
import { handler } from './reschedule-appointment';

describe('reschedule-appointment handler', () => {
  test('on success: holds+confirms the new time, cancels and deletes the old slot', async () => {
    const medplum = new MockClient();
    const schedule = await medplum.createResource({ resourceType: 'Schedule', actor: [{ reference: 'Practitioner/dr-1' }] });
    const oldSlot = await medplum.createResource({ resourceType: 'Slot', schedule: { reference: `Schedule/${schedule.id}` }, status: 'busy', start: '2026-09-01T09:00:00Z', end: '2026-09-01T09:30:00Z' });
    const appointment = await medplum.createResource({
      resourceType: 'Appointment',
      status: 'booked',
      slot: [{ reference: `Slot/${oldSlot.id}` }],
      serviceType: [{ extension: [{ url: 'https://medplum.com/fhir/service-type-reference', valueReference: { reference: 'HealthcareService/office-visit' } }] }],
      participant: [{ actor: { reference: 'Patient/p1' }, status: 'accepted' }, { actor: { reference: 'Practitioner/dr-1' }, status: 'accepted' }],
    });

    const newAppointment = { resourceType: 'Appointment', id: 'appt-new', status: 'pending' };
    const confirmedNewAppointment = { resourceType: 'Appointment', id: 'appt-new', status: 'booked' };
    vi.spyOn(medplum, 'post').mockImplementation(async (url: string) => {
      if (url.endsWith('$hold')) return newAppointment as any;
      if (url.endsWith('$confirm')) return confirmedNewAppointment as any;
      throw new Error(`unexpected post ${url}`);
    });

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { appointmentId: appointment.id as string, newStart: '2026-09-02T09:00:00Z', newEnd: '2026-09-02T09:30:00Z' },
      contentType: 'application/json',
      secrets: {},
    });

    expect(result).toStrictEqual({ ok: true, appointment: confirmedNewAppointment });
    const original = await medplum.readResource('Appointment', appointment.id as string);
    expect(original.status).toBe('cancelled');
    await expect(medplum.readResource('Slot', oldSlot.id as string)).rejects.toThrow();
  });

  test('on slot-taken rejection: leaves the original appointment untouched', async () => {
    const medplum = new MockClient();
    const schedule = await medplum.createResource({ resourceType: 'Schedule', actor: [{ reference: 'Practitioner/dr-1' }] });
    const oldSlot = await medplum.createResource({ resourceType: 'Slot', schedule: { reference: `Schedule/${schedule.id}` }, status: 'busy', start: '2026-09-01T09:00:00Z', end: '2026-09-01T09:30:00Z' });
    const appointment = await medplum.createResource({
      resourceType: 'Appointment',
      status: 'booked',
      slot: [{ reference: `Slot/${oldSlot.id}` }],
      serviceType: [{ extension: [{ url: 'https://medplum.com/fhir/service-type-reference', valueReference: { reference: 'HealthcareService/office-visit' } }] }],
      participant: [{ actor: { reference: 'Patient/p1' }, status: 'accepted' }, { actor: { reference: 'Practitioner/dr-1' }, status: 'accepted' }],
    });
    vi.spyOn(medplum, 'post').mockRejectedValue(
      new OperationOutcomeError({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid', details: { text: 'Requested time slot is not available' } }] })
    );

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { appointmentId: appointment.id as string, newStart: '2026-09-02T09:00:00Z', newEnd: '2026-09-02T09:30:00Z' },
      contentType: 'application/json',
      secrets: {},
    });

    expect(result).toStrictEqual({ ok: false, reason: 'slot_taken' });
    const original = await medplum.readResource('Appointment', appointment.id as string);
    expect(original.status).toBe('booked'); // untouched
    const stillThere = await medplum.readResource('Slot', oldSlot.id as string);
    expect(stillThere.status).toBe('busy'); // untouched
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/bots/core/reschedule-appointment.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the bot**

```typescript
// src/bots/core/reschedule-appointment.ts
import type { BotEvent, MedplumClient } from '@medplum/core';
import { OperationOutcomeError, resolveId } from '@medplum/core';
import type { Appointment } from '@medplum/fhirtypes';

export type RescheduleInput = { appointmentId: string; newStart: string; newEnd: string };
export type RescheduleResult = { ok: true; appointment: Appointment } | { ok: false; reason: 'slot_taken' };

const SLOT_TAKEN_MESSAGE = 'Requested time slot is not available';

export async function handler(medplum: MedplumClient, event: BotEvent<RescheduleInput>): Promise<RescheduleResult> {
  const { appointmentId, newStart, newEnd } = event.input;
  const original = await medplum.readResource('Appointment', appointmentId);
  const oldSlotId = resolveId(original.slot?.[0]);
  if (!oldSlotId) {
    throw new Error('Original appointment has no slot to reschedule from');
  }
  const oldSlot = await medplum.readResource('Slot', oldSlotId);
  const scheduleId = resolveId(oldSlot.schedule);
  if (!scheduleId) {
    throw new Error('Original slot has no schedule reference');
  }

  const proposedAppointment: Appointment = {
    resourceType: 'Appointment',
    status: 'proposed',
    start: newStart,
    end: newEnd,
    serviceType: original.serviceType,
    participant: original.participant,
  };

  let held: Appointment;
  try {
    held = (await medplum.post(`Schedule/${scheduleId}/$hold`, proposedAppointment)) as Appointment;
  } catch (err) {
    if (err instanceof OperationOutcomeError && err.outcome.issue?.[0]?.details?.text === SLOT_TAKEN_MESSAGE) {
      return { ok: false, reason: 'slot_taken' };
    }
    throw err;
  }

  const confirmed = (await medplum.post(`Appointment/${held.id}/$confirm`, {})) as Appointment;

  // Cancel and delete-slot the original — same fixed behavior as cancel-appointment.ts.
  await medplum.updateResource({
    ...original,
    status: 'cancelled',
    cancelationReason: {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/appointment-cancellation-reason', code: 'prov', display: 'Provider' }],
    },
  });
  await medplum.deleteResource('Slot', oldSlotId);

  return { ok: true, appointment: confirmed };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/bots/core/reschedule-appointment.test.ts
```

Expected: PASS.

- [ ] **Step 5: Modify `RescheduleAppointment.tsx` to call the new bot instead of mutating resources directly**

The current implementation reads the Slot and PATCHes both the Slot and Appointment in place, with zero availability checking. Replace `handleQuestionnaireSubmit` in `src/components/actions/RescheduleAppointment.tsx`:

```typescript
  async function handleQuestionnaireSubmit(formData: QuestionnaireResponse): Promise<void> {
    const answers = getQuestionnaireAnswers(formData);
    const startDateTime = answers['start-date'].valueDateTime as string;
    const endDateTime = answers['end-date'].valueDateTime as string;

    try {
      const result = await medplum.executeBot(
        { system: 'http://example.com', value: 'reschedule-appointment' },
        { appointmentId: appointment.id, newStart: startDateTime, newEnd: endDateTime }
      );

      if (!result.ok) {
        showNotification({
          color: 'red',
          icon: <IconCircleOff />,
          title: 'Time unavailable',
          message: 'That time is no longer available. The original appointment was not changed — please pick another time.',
        });
        return;
      }

      navigate(`/Appointment/${result.appointment.id}/details`)?.catch(console.error);
      showNotification({
        icon: <IconCircleCheck />,
        title: 'Success',
        message: 'Appointment rescheduled',
      });
      handlers.close();
    } catch (err) {
      showNotification({
        icon: <IconCircleOff />,
        title: 'Error',
        message: normalizeErrorString(err),
      });
    }
  }
```

- [ ] **Step 6: Commit**

```bash
git add src/bots/core/reschedule-appointment.ts src/bots/core/reschedule-appointment.test.ts src/components/actions/RescheduleAppointment.tsx
git commit -m "feat(bot): reschedule-appointment — hold/confirm/cancel, was direct mutation with no conflict check"
```

---

### Task 26: Update `deploy-bots.ts` (add agent bots + cron support) and deploy to the target project

**Files:**
- Modify: `src/scripts/deploy-bots.ts`

**Interfaces:**
- Consumes: every bot file from Tasks 17–25.
- Produces: all bots registered as `Bot` resources in the target Medplum project, callable via `medplum.executeBot({system: 'http://example.com', value: botName}, ...)`.

- [ ] **Step 1: Add `cronString` support to `BotDescription` and the `Bot` resource it emits**

In `src/scripts/deploy-bots.ts`, extend the interface and the resource-building code:

```typescript
interface BotDescription {
  src: string;
  dist: string;
  criteria?: string;
  cronString?: string;
}
```

In the `results.push({ request: {...}, resource: {...} })` block that builds each `Bot` resource, add `cronString` conditionally:

```typescript
      results.push({
        request: { method: 'PUT', url: botUrlPlaceholder },
        resource: {
          resourceType: 'Bot',
          id: botIdPlaceholder,
          identifier: [{ system: 'http://example.com', value: botName }],
          name: botName,
          runtimeVersion: 'awslambda',
          ...(botDescription.cronString ? { cronString: botDescription.cronString } : {}),
          sourceCode: {
            contentType: ContentType.TYPESCRIPT,
            url: srcEntry.fullUrl,
          },
          executableCode: {
            contentType: ContentType.JAVASCRIPT,
            url: distEntry.fullUrl,
          },
        },
      });
```

- [ ] **Step 2: Extend the `Bots` array with every new/fixed bot**

```typescript
const Bots: BotDescription[] = [
  {
    src: 'src/bots/core/cancel-appointment.ts',
    dist: 'dist/bots/core/cancel-appointment.js',
  },
  {
    src: 'src/bots/core/block-availability.ts',
    dist: 'dist/bots/core/block-availability.js',
  },
  {
    src: 'src/bots/core/reschedule-appointment.ts',
    dist: 'dist/bots/core/reschedule-appointment.js',
  },
  {
    src: 'src/bots/agent/agent-intake.ts',
    dist: 'dist/bots/agent/agent-intake.js',
  },
  {
    src: 'src/bots/agent/agent-find-doctors.ts',
    dist: 'dist/bots/agent/agent-find-doctors.js',
  },
  {
    src: 'src/bots/agent/agent-ensure-doctor.ts',
    dist: 'dist/bots/agent/agent-ensure-doctor.js',
  },
  {
    src: 'src/bots/agent/agent-book-appointment.ts',
    dist: 'dist/bots/agent/agent-book-appointment.js',
  },
  {
    src: 'src/bots/agent/agent-patient-chat.ts',
    dist: 'dist/bots/agent/agent-patient-chat.js',
  },
  {
    src: 'src/bots/agent/agent-expire-holds.ts',
    dist: 'dist/bots/agent/agent-expire-holds.js',
    cronString: '0 * * * *', // hourly — 5 numeric fields, no seconds, no aliases
  },
];
```

- [ ] **Step 3: Build and deploy against the target Medplum project**

```bash
npm run build:bots
```

Expected: `data/core/example-bots.json` is regenerated with all 9 bots. Then upload it — either via the fork's `UploadDataPage` (`/upload/bots` route, still present) with a real Medplum sign-in, or directly:

```bash
npx tsx -e "
import { MedplumClient } from '@medplum/core';
import { readFileSync } from 'fs';
const medplum = new MedplumClient({ baseUrl: process.env.MEDPLUM_BASE_URL });
await medplum.startClientLogin(process.env.MEDPLUM_CLIENT_ID, process.env.MEDPLUM_CLIENT_SECRET);
const bundle = JSON.parse(readFileSync('data/core/example-bots.json', 'utf-8'));
await medplum.executeBatch(bundle);
console.log('Bots deployed.');
"
```

- [ ] **Step 4: Set each Bot's secrets in the target Medplum project**

In the Medplum app's Project Admin panel, add the project secret `GEMINI_API_KEY` (a real Gemini API key) — this makes it available to every bot in the project via `event.secrets['GEMINI_API_KEY']`.

- [ ] **Step 5: Manually verify each bot executes (this is the live check Design doc §16 flags as outstanding)**

Using a Medplum-authenticated script or the app's bot-testing UI, call each new bot once with realistic input and confirm it returns the expected shape rather than an error:
- `agent-intake` with a real `patientId` from the Task 10 seed and a complaint string — expect `{intent: {...}, summaryCommunicationId}`.
- `agent-ensure-doctor` with a real NPI from the seeded data — expect `{practitionerId, scheduleId, healthcareServiceIds}`.
- A direct `GET /fhir/R4/Appointment/$find` call with that `scheduleId` and one of the `healthcareServiceIds` — expect a populated slot list, not an error (confirms the `SchedulingParameters` extension built in Task 19 is well-formed against the real server).
- `agent-book-appointment` against one of those returned slots — expect `{ok: true, appointment}`.
- `agent-patient-chat` with that same patient and a factual question — expect a grounded, non-empty answer.

If `$find` returns zero slots or errors, the most likely cause is the `SchedulingParameters`/`serviceType` shape from Task 19 — re-check against the exact structure confirmed in the Data Model doc before assuming the server is misconfigured.

- [ ] **Step 6: Commit**

```bash
git add src/scripts/deploy-bots.ts
git commit -m "feat(deploy): register agent bots, add cron-trigger support for agent-expire-holds"
```

---

## Phase 4 — Patient-Facing Frontend (`/agent/*`)

Per Design doc §13's testing philosophy, UI pages get a manual end-to-end verification step rather than an automated test suite — consistent with this being a POC, not a maintained product. Every page/component below is still real, complete code, wired into real routing — "manual verification" describes how it's checked, not that it's a stub.

### Task 27: `src/booking.context.ts` + `App.tsx` routing for both new route trees

**Files:**
- Create: `src/booking.context.ts`
- Modify: `src/App.tsx`

**Interfaces:**
- Produces: `BookingContext` (React context holding in-flight booking state: `intent`, `chosenCandidate`, `summaryCommunicationId`) — consumed by every `/agent/*` page (Tasks 28–32). Routes `/agent`, `/agent/:patientId`, `/agent/:patientId/doctors`, `/agent/:patientId/doctors/:npi/slots`, `/agent/:patientId/confirmed/:apptId`, `/desk`, `/desk/:npi`, `/desk/:npi/patients/:patientId`.

- [ ] **Step 1: Create `booking.context.ts`, mirroring the fork's existing `Schedule.context.ts` pattern**

```typescript
// src/booking.context.ts
import { createContext } from 'react';

export interface BookingIntent {
  specialtyCode: string;
  specialtyLabel: string;
  reason: string;
  urgency: 'routine' | 'urgent';
  complaintText: string;
}

export interface ChosenCandidate {
  npi: string;
  firstName: string;
  lastName: string;
  source: 'previous' | 'nppes';
}

export interface BookingState {
  intent?: BookingIntent;
  summaryCommunicationId?: string;
  chosenCandidate?: ChosenCandidate;
}

export const BookingContext = createContext<{
  booking: BookingState;
  setBooking: (state: BookingState) => void;
}>({
  booking: {},
  setBooking: () => {},
});
```

- [ ] **Step 2: Wire both route trees and a `BookingContext.Provider` into `App.tsx`**

Add imports for the new pages (created in Tasks 28–35) and the two new `<Route>` trees plus two new `menus` groups. Insert into the existing `App` component:

```typescript
import { useState } from 'react';
import { BookingContext } from './booking.context';
import type { BookingState } from './booking.context';
import { PatientPickerPage } from './pages/agent/PatientPickerPage';
import { PatientHistoryPage } from './pages/agent/PatientHistoryPage';
import { DoctorResultsPage } from './pages/agent/DoctorResultsPage';
import { SlotPickerPage } from './pages/agent/SlotPickerPage';
import { BookingConfirmationPage } from './pages/agent/BookingConfirmationPage';
import { DoctorLookupPage } from './pages/desk/DoctorLookupPage';
import { DoctorQueuePage } from './pages/desk/DoctorQueuePage';
import { PatientAgentChatPage } from './pages/desk/PatientAgentChatPage';
import { IconStethoscope, IconMessageCircle2 } from '@tabler/icons-react';
```

Inside `App()`, add booking state alongside the existing `schedule` state:

```typescript
  const [booking, setBooking] = useState<BookingState>({});
```

Add two menu groups to the `menus` array (after the existing `'Upload Data'` group):

```typescript
        {
          title: 'Patient Agent',
          links: [{ icon: <IconStethoscope />, label: 'New Request', href: '/agent' }],
        },
        {
          title: 'Doctor Desk',
          links: [{ icon: <IconMessageCircle2 />, label: 'Doctor Desk', href: '/desk' }],
        },
```

Wrap the existing `<Routes>` in a `BookingContext.Provider` (nested inside the existing `ScheduleContext.Provider`) and add the new routes inside it, alongside the existing ones:

```typescript
      <ScheduleContext.Provider value={{ schedule: schedule }}>
        <BookingContext.Provider value={{ booking, setBooking }}>
          <ErrorBoundary>
            <Suspense fallback={<Loading />}>
              <Routes>
                {/* ...all existing <Route> entries, unchanged... */}
                <Route path="/agent" element={<PatientPickerPage />} />
                <Route path="/agent/:patientId" element={<PatientHistoryPage />} />
                <Route path="/agent/:patientId/doctors" element={<DoctorResultsPage />} />
                <Route path="/agent/:patientId/doctors/:npi/slots" element={<SlotPickerPage />} />
                <Route path="/agent/:patientId/confirmed/:apptId" element={<BookingConfirmationPage />} />
                <Route path="/desk" element={<DoctorLookupPage />} />
                <Route path="/desk/:npi" element={<DoctorQueuePage />} />
                <Route path="/desk/:npi/patients/:patientId" element={<PatientAgentChatPage />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </BookingContext.Provider>
      </ScheduleContext.Provider>
```

- [ ] **Step 3: Manual verification**

```bash
npx tsc --noEmit
npm run dev
```

Expected: `tsc` reports errors for the not-yet-created page files (expected — Tasks 28–35 create them). Once those exist, `npm run dev` should show "Patient Agent" and "Doctor Desk" in the left nav, and clicking "New Request" should navigate to `/agent` without a routing error.

- [ ] **Step 4: Commit**

```bash
git add src/booking.context.ts src/App.tsx
git commit -m "feat(routing): booking context + /agent and /desk route trees"
```

---

### Task 28: `src/pages/agent/PatientPickerPage.tsx`

**Files:**
- Create: `src/pages/agent/PatientPickerPage.tsx`

**Interfaces:**
- Produces: the `/agent` page — a plain authenticated FHIR search (no bot), per FR-1.

- [ ] **Step 1: Implement**

```typescript
// src/pages/agent/PatientPickerPage.tsx
import { Anchor, Document, Stack, Table, Title } from '@mantine/core';
import type { Patient } from '@medplum/fhirtypes';
import { Document as MedplumDocument, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';

export function PatientPickerPage(): JSX.Element {
  const medplum = useMedplum();
  const [patients, setPatients] = useState<Patient[]>();

  useEffect(() => {
    medplum
      .searchResources('Patient', { _count: '50', _sort: 'family' })
      .then((result) => setPatients([...result]))
      .catch(console.error);
  }, [medplum]);

  return (
    <MedplumDocument width={800}>
      <Stack>
        <Title order={1}>Select a Patient</Title>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Date of Birth</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(patients ?? []).map((patient) => (
              <Table.Tr key={patient.id}>
                <Table.Td>
                  <Anchor component={Link} to={`/agent/${patient.id}`}>
                    {patient.name?.[0]?.given?.join(' ')} {patient.name?.[0]?.family}
                  </Anchor>
                </Table.Td>
                <Table.Td>{patient.birthDate}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Stack>
    </MedplumDocument>
  );
}
```

- [ ] **Step 2: Manual verification**

With a seeded Medplum project (Task 10) and a signed-in session, navigate to `/agent`. Expect a table of demo patients, each name linking to `/agent/:patientId`.

- [ ] **Step 3: Commit**

```bash
git add src/pages/agent/PatientPickerPage.tsx
git commit -m "feat(ui): patient picker page (FR-1)"
```

---

### Task 29: `src/pages/agent/PatientHistoryPage.tsx` + `ComplaintForm.tsx` + `IntentCard.tsx`

**Files:**
- Create: `src/pages/agent/PatientHistoryPage.tsx`
- Create: `src/components/agent/ComplaintForm.tsx`
- Create: `src/components/agent/IntentCard.tsx`

**Interfaces:**
- Consumes: `agent-intake` bot (Task 17), `BookingContext` (Task 27).
- Produces: the `/agent/:patientId` page — history via `@medplum/react`'s `PatientSummary` (FR-2), complaint submission (FR-3/FR-4).

- [ ] **Step 1: Implement `ComplaintForm.tsx`**

```typescript
// src/components/agent/ComplaintForm.tsx
import { Alert, Button, Group, Stack, Textarea } from '@mantine/core';
import type { JSX } from 'react';
import { useState } from 'react';

interface ComplaintFormProps {
  onSubmit: (complaintText: string) => void;
  submitting: boolean;
  needsClarification: boolean;
}

export function ComplaintForm(props: ComplaintFormProps): JSX.Element {
  const { onSubmit, submitting, needsClarification } = props;
  const [complaintText, setComplaintText] = useState('');

  return (
    <Stack>
      {needsClarification && (
        <Alert color="yellow" title="Could not determine a specialty">
          Please describe your issue a bit more specifically (e.g. name a body part or symptom).
        </Alert>
      )}
      <Textarea
        label="What brings you in today?"
        placeholder="e.g. My chest hurts when I run"
        value={complaintText}
        onChange={(e) => setComplaintText(e.currentTarget.value)}
        minRows={2}
        maxRows={3}
      />
      <Group justify="flex-end">
        <Button disabled={!complaintText.trim() || submitting} loading={submitting} onClick={() => onSubmit(complaintText)}>
          Find a Doctor
        </Button>
      </Group>
    </Stack>
  );
}
```

- [ ] **Step 2: Implement `IntentCard.tsx`**

```typescript
// src/components/agent/IntentCard.tsx
import { Badge, Card, Group, Text } from '@mantine/core';
import type { JSX } from 'react';
import type { BookingIntent } from '../../booking.context';

export function IntentCard({ intent }: { intent: BookingIntent }): JSX.Element {
  return (
    <Card withBorder>
      <Group justify="space-between">
        <Text fw={600}>{intent.specialtyLabel}</Text>
        <Badge color={intent.urgency === 'urgent' ? 'red' : 'blue'}>{intent.urgency}</Badge>
      </Group>
      <Text size="sm" c="dimmed">
        {intent.reason}
      </Text>
    </Card>
  );
}
```

- [ ] **Step 3: Implement `PatientHistoryPage.tsx`**

```typescript
// src/pages/agent/PatientHistoryPage.tsx
import { Alert, Stack, Title } from '@mantine/core';
import { Document, PatientSummary, useMedplum } from '@medplum/react';
import { normalizeErrorString } from '@medplum/core';
import type { JSX } from 'react';
import { useContext, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ComplaintForm } from '../../components/agent/ComplaintForm';
import { IntentCard } from '../../components/agent/IntentCard';
import { BookingContext } from '../../booking.context';

export function PatientHistoryPage(): JSX.Element {
  const { patientId } = useParams();
  const medplum = useMedplum();
  const navigate = useNavigate();
  const { booking, setBooking } = useContext(BookingContext);
  const [submitting, setSubmitting] = useState(false);
  const [needsClarification, setNeedsClarification] = useState(false);
  const [error, setError] = useState<string>();

  async function handleComplaintSubmit(complaintText: string): Promise<void> {
    setSubmitting(true);
    setError(undefined);
    setNeedsClarification(false);
    try {
      const result = await medplum.executeBot(
        { system: 'http://example.com', value: 'agent-intake' },
        { patientId, complaintText }
      );
      if ('needsClarification' in result) {
        setNeedsClarification(true);
        return;
      }
      setBooking({
        ...booking,
        intent: { ...result.intent, complaintText },
        summaryCommunicationId: result.summaryCommunicationId,
      });
      navigate(`/agent/${patientId}/doctors`)?.catch(console.error);
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Document width={800}>
      <Stack>
        <Title order={1}>Patient History</Title>
        <PatientSummary patient={{ reference: `Patient/${patientId}` }} />
        {error && <Alert color="red">{error}</Alert>}
        {booking.intent && <IntentCard intent={booking.intent} />}
        <ComplaintForm onSubmit={handleComplaintSubmit} submitting={submitting} needsClarification={needsClarification} />
      </Stack>
    </Document>
  );
}
```

- [ ] **Step 4: Manual verification**

Navigate to `/agent/:patientId` for a seeded patient. Expect `PatientSummary` to render their conditions/medications/allergies/encounters (FR-2). Submit a complaint like "my chest hurts when I run" — expect a loading state, then navigation to `/agent/:patientId/doctors` on success, or the clarification alert if the LLM's specialty guess doesn't normalize.

- [ ] **Step 5: Commit**

```bash
git add src/pages/agent/PatientHistoryPage.tsx src/components/agent/ComplaintForm.tsx src/components/agent/IntentCard.tsx
git commit -m "feat(ui): patient history + complaint intake (FR-2, FR-3, FR-4)"
```

---

### Task 30: `src/pages/agent/DoctorResultsPage.tsx` + `DoctorCard.tsx`

**Files:**
- Create: `src/pages/agent/DoctorResultsPage.tsx`
- Create: `src/components/agent/DoctorCard.tsx`

**Interfaces:**
- Consumes: `agent-find-doctors` bot (Task 18), `BookingContext` (Task 27).
- Produces: the `/agent/:patientId/doctors` page (FR-5, FR-6, FR-7).

- [ ] **Step 1: Implement `DoctorCard.tsx`**

```typescript
// src/components/agent/DoctorCard.tsx
import { Badge, Button, Card, Group, Stack, Text } from '@mantine/core';
import type { JSX } from 'react';

interface DoctorCardProps {
  npi: string;
  firstName: string;
  lastName: string;
  source: 'previous' | 'nppes';
  distanceMiles?: number;
  onSelect: () => void;
}

export function DoctorCard(props: DoctorCardProps): JSX.Element {
  const { firstName, lastName, source, distanceMiles, onSelect } = props;
  return (
    <Card withBorder>
      <Group justify="space-between">
        <Stack gap={0}>
          <Text fw={600}>
            Dr. {firstName} {lastName}
          </Text>
          {source === 'previous' ? (
            <Badge color="green">Previous physician</Badge>
          ) : distanceMiles !== undefined ? (
            <Text size="sm" c="dimmed">
              {distanceMiles.toFixed(1)} miles away
            </Text>
          ) : (
            <Text size="sm" c="dimmed">
              Distance unavailable
            </Text>
          )}
        </Stack>
        <Button onClick={onSelect}>Select</Button>
      </Group>
    </Card>
  );
}
```

- [ ] **Step 2: Implement `DoctorResultsPage.tsx`**

```typescript
// src/pages/agent/DoctorResultsPage.tsx
import { Alert, Loader, Stack, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { Document, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useContext, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { DoctorCard } from '../../components/agent/DoctorCard';
import { BookingContext } from '../../booking.context';

interface Candidate {
  npi: string;
  firstName: string;
  lastName: string;
  source: 'previous' | 'nppes';
  distanceMiles?: number;
}

export function DoctorResultsPage(): JSX.Element {
  const { patientId } = useParams();
  const medplum = useMedplum();
  const navigate = useNavigate();
  const { booking, setBooking } = useContext(BookingContext);
  const [candidates, setCandidates] = useState<Candidate[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!booking.intent) {
      navigate(`/agent/${patientId}`)?.catch(console.error);
      return;
    }
    medplum
      .executeBot(
        { system: 'http://example.com', value: 'agent-find-doctors' },
        { patientId, specialtyCode: booking.intent.specialtyCode }
      )
      .then((result) => setCandidates(result.candidates))
      .catch((err) => setError(normalizeErrorString(err)));
  }, [medplum, patientId, booking.intent, navigate]);

  function handleSelect(candidate: Candidate): void {
    setBooking({ ...booking, chosenCandidate: candidate });
    navigate(`/agent/${patientId}/doctors/${candidate.npi}/slots`)?.catch(console.error);
  }

  return (
    <Document width={800}>
      <Stack>
        <Title order={1}>Matching Doctors</Title>
        {error && <Alert color="red">{error}</Alert>}
        {!candidates && !error && <Loader />}
        {candidates?.length === 0 && <Alert color="yellow">No doctors found for this specialty and location.</Alert>}
        {(candidates ?? []).map((candidate) => (
          <DoctorCard key={candidate.npi} {...candidate} onSelect={() => handleSelect(candidate)} />
        ))}
      </Stack>
    </Document>
  );
}
```

- [ ] **Step 3: Manual verification**

After submitting a complaint in Task 29, expect this page to show a loading spinner, then a list of doctor cards — a green "Previous physician" badge on the top card when a prior exact-specialty match exists, distance-sorted NPPES cards below it. Clicking "Select" should navigate to the slot picker.

- [ ] **Step 4: Commit**

```bash
git add src/pages/agent/DoctorResultsPage.tsx src/components/agent/DoctorCard.tsx
git commit -m "feat(ui): ranked doctor results page (FR-5, FR-6, FR-7)"
```

---

### Task 31: `src/pages/agent/SlotPickerPage.tsx` + `SlotGrid.tsx`

**Files:**
- Create: `src/pages/agent/SlotPickerPage.tsx`
- Create: `src/components/agent/SlotGrid.tsx`

**Interfaces:**
- Consumes: `agent-ensure-doctor` bot (Task 20), `agent-book-appointment` bot (Task 21), `BookingContext` (Task 27).
- Produces: the `/agent/:patientId/doctors/:npi/slots` page (FR-8, FR-9, FR-10).

- [ ] **Step 1: Implement `SlotGrid.tsx`**

```typescript
// src/components/agent/SlotGrid.tsx
import { Button, SimpleGrid } from '@mantine/core';
import dayjs from 'dayjs';
import type { JSX } from 'react';

interface SlotOption {
  start: string;
  end: string;
}

interface SlotGridProps {
  slots: SlotOption[];
  onPick: (slot: SlotOption) => void;
  disabled: boolean;
}

export function SlotGrid(props: SlotGridProps): JSX.Element {
  const { slots, onPick, disabled } = props;
  return (
    <SimpleGrid cols={3}>
      {slots.map((slot) => (
        <Button key={slot.start} variant="outline" disabled={disabled} onClick={() => onPick(slot)}>
          {dayjs(slot.start).format('MMM D, h:mm A')}
        </Button>
      ))}
    </SimpleGrid>
  );
}
```

- [ ] **Step 2: Implement `SlotPickerPage.tsx`**

Note: `$find`'s exact request/response shape is a `Parameters` resource (`service-type-reference`, `schedule`, `start`, `end` as input parameters; a `slot` output parameter repeated per available slot) — confirmed in Design doc §7. This calls it via `medplum.get`, matching how `@medplum/core` exposes a `GET`-based FHIR operation.

```typescript
// src/pages/agent/SlotPickerPage.tsx
import { Alert, Loader, Stack, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { Document, useMedplum } from '@medplum/react';
import dayjs from 'dayjs';
import type { JSX } from 'react';
import { useContext, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { SlotGrid } from '../../components/agent/SlotGrid';
import { BookingContext } from '../../booking.context';

interface SlotOption {
  start: string;
  end: string;
}

interface EnsureDoctorResult {
  practitionerId: string;
  scheduleId: string;
  healthcareServiceIds: { routine: string; urgent: string };
}

export function SlotPickerPage(): JSX.Element {
  const { patientId, npi } = useParams();
  const medplum = useMedplum();
  const navigate = useNavigate();
  const { booking, setBooking } = useContext(BookingContext);
  const [provisioned, setProvisioned] = useState<EnsureDoctorResult>();
  const [slots, setSlots] = useState<SlotOption[]>();
  const [error, setError] = useState<string>();
  const [booking_, setBookingInFlight] = useState(false);

  useEffect(() => {
    if (!booking.intent) {
      navigate(`/agent/${patientId}`)?.catch(console.error);
      return;
    }
    medplum
      .executeBot({ system: 'http://example.com', value: 'agent-ensure-doctor' }, { npi })
      .then((result: EnsureDoctorResult) => {
        setProvisioned(result);
        const healthcareServiceId = result.healthcareServiceIds[booking.intent!.urgency === 'urgent' ? 'urgent' : 'routine'];
        const start = dayjs().add(1, 'day').startOf('day').toISOString();
        const end = dayjs().add(15, 'day').endOf('day').toISOString();
        return medplum.get(
          `fhir/R4/Appointment/$find?service-type-reference=HealthcareService/${healthcareServiceId}&schedule=Schedule/${result.scheduleId}&start=${start}&end=${end}`
        );
      })
      .then((findResult: { parameter?: { name: string; part?: { name: string; valueDateTime?: string }[] }[] }) => {
        const slotOptions: SlotOption[] = (findResult.parameter ?? [])
          .filter((p) => p.name === 'slot')
          .map((p) => ({
            start: p.part?.find((x) => x.name === 'start')?.valueDateTime as string,
            end: p.part?.find((x) => x.name === 'end')?.valueDateTime as string,
          }));
        setSlots(slotOptions);
      })
      .catch((err) => setError(normalizeErrorString(err)));
  }, [medplum, patientId, npi, booking.intent, navigate]);

  async function handlePick(slot: SlotOption): Promise<void> {
    if (!provisioned || !booking.intent || !booking.summaryCommunicationId) return;
    setBookingInFlight(true);
    setError(undefined);
    try {
      const healthcareServiceId = provisioned.healthcareServiceIds[booking.intent.urgency === 'urgent' ? 'urgent' : 'routine'];
      const result = await medplum.executeBot(
        { system: 'http://example.com', value: 'agent-book-appointment' },
        {
          patientId,
          npi,
          scheduleId: provisioned.scheduleId,
          healthcareServiceId,
          start: slot.start,
          end: slot.end,
          summaryCommunicationId: booking.summaryCommunicationId,
          reason: booking.intent.reason,
          complaintText: booking.intent.complaintText,
          urgency: booking.intent.urgency,
        }
      );
      if (!result.ok) {
        setError('That slot was just taken — please pick another.');
        // Re-fetch by reloading the effect's slot list.
        setSlots(undefined);
        return;
      }
      navigate(`/agent/${patientId}/confirmed/${result.appointment.id}`)?.catch(console.error);
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setBookingInFlight(false);
    }
  }

  return (
    <Document width={800}>
      <Stack>
        <Title order={1}>Available Slots</Title>
        {error && <Alert color="red">{error}</Alert>}
        {!slots && !error && <Loader />}
        {slots?.length === 0 && <Alert color="yellow">No slots available in the next 15 days.</Alert>}
        {slots && <SlotGrid slots={slots} onPick={handlePick} disabled={booking_} />}
      </Stack>
    </Document>
  );
}
```

- [ ] **Step 3: Manual verification**

After selecting a doctor in Task 30, expect a loading state, then a grid of bookable time slots (or a "no slots" message). Clicking a slot should navigate to the confirmation page on success. To manually exercise FR-10 (double-booking prevention), open the same slot-picker in two browser tabs and book the same slot in both — the second should show "That slot was just taken."

- [ ] **Step 4: Commit**

```bash
git add src/pages/agent/SlotPickerPage.tsx src/components/agent/SlotGrid.tsx
git commit -m "feat(ui): slot picker + booking (FR-8, FR-9, FR-10)"
```

---

### Task 32: `src/pages/agent/BookingConfirmationPage.tsx`

**Files:**
- Create: `src/pages/agent/BookingConfirmationPage.tsx`

**Interfaces:**
- Produces: the `/agent/:patientId/confirmed/:apptId` page — NPI shown large and copyable (FR-9's acceptance criterion).

- [ ] **Step 1: Implement**

```typescript
// src/pages/agent/BookingConfirmationPage.tsx
import { CopyButton, Loader, Stack, Text, Title } from '@mantine/core';
import { Document, useMedplum } from '@medplum/react';
import type { Appointment, Practitioner } from '@medplum/fhirtypes';
import dayjs from 'dayjs';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';

export function BookingConfirmationPage(): JSX.Element {
  const { apptId } = useParams();
  const medplum = useMedplum();
  const [appointment, setAppointment] = useState<Appointment>();
  const [npi, setNpi] = useState<string>();

  useEffect(() => {
    medplum
      .readResource('Appointment', apptId as string)
      .then(async (appt) => {
        setAppointment(appt);
        const practitionerRef = appt.participant?.find((p) => p.actor?.reference?.startsWith('Practitioner/'))?.actor?.reference;
        if (practitionerRef) {
          const practitioner: Practitioner = await medplum.readReference({ reference: practitionerRef });
          setNpi(practitioner.identifier?.find((i) => i.system === 'http://hl7.org/fhir/sid/us-npi')?.value);
        }
      })
      .catch(console.error);
  }, [medplum, apptId]);

  if (!appointment) {
    return (
      <Document width={600}>
        <Loader />
      </Document>
    );
  }

  return (
    <Document width={600}>
      <Stack align="center">
        <Title order={1}>Appointment Confirmed</Title>
        <Text>{dayjs(appointment.start).format('dddd, MMMM D, YYYY [at] h:mm A')}</Text>
        <Text size="sm" c="dimmed">
          Give this NPI to the front desk if asked:
        </Text>
        <Text size="48px" fw={700}>
          {npi}
        </Text>
        {npi && (
          <CopyButton value={npi}>
            {({ copied, copy }) => <Text onClick={copy} style={{ cursor: 'pointer' }}>{copied ? 'Copied!' : 'Copy NPI'}</Text>}
          </CopyButton>
        )}
      </Stack>
    </Document>
  );
}
```

- [ ] **Step 2: Manual verification**

After booking a slot in Task 31, expect this page to show the appointment date/time and the doctor's NPI in large text, with a working "Copy NPI" action.

- [ ] **Step 3: Commit**

```bash
git add src/pages/agent/BookingConfirmationPage.tsx
git commit -m "feat(ui): booking confirmation page with copyable NPI (FR-9)"
```

---

## Phase 5 — Doctor-Facing Frontend (`/desk/*`)

### Task 33: `src/pages/desk/DoctorLookupPage.tsx`

**Files:**
- Create: `src/pages/desk/DoctorLookupPage.tsx`

**Interfaces:**
- Produces: the `/desk` page — NPI entry, a display filter not a login (FR-11, Design §11).

- [ ] **Step 1: Implement**

```typescript
// src/pages/desk/DoctorLookupPage.tsx
import { Button, Group, Stack, Text, TextInput, Title } from '@mantine/core';
import { Document } from '@medplum/react';
import type { JSX } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router';

export function DoctorLookupPage(): JSX.Element {
  const navigate = useNavigate();
  const [npi, setNpi] = useState('');

  return (
    <Document width={500}>
      <Stack>
        <Title order={1}>Doctor Desk</Title>
        <Text size="sm" c="dimmed">
          Enter your NPI to view your patient queue. This filters the view to your patients only — it is not a
          login or an access-control check.
        </Text>
        <TextInput label="NPI" value={npi} onChange={(e) => setNpi(e.currentTarget.value)} placeholder="e.g. 1234567890" />
        <Group justify="flex-end">
          <Button disabled={!npi.trim()} onClick={() => navigate(`/desk/${npi.trim()}`)}>
            View Queue
          </Button>
        </Group>
      </Stack>
    </Document>
  );
}
```

- [ ] **Step 2: Manual verification**

Navigate to `/desk`, type in an NPI from the seeded data (or one provisioned by a prior `/agent` booking), click "View Queue" — expect navigation to `/desk/:npi`.

- [ ] **Step 3: Commit**

```bash
git add src/pages/desk/DoctorLookupPage.tsx
git commit -m "feat(ui): doctor NPI lookup page, display filter not auth (FR-11)"
```

---

### Task 34: `src/pages/desk/DoctorQueuePage.tsx` + `QueueTable.tsx` + `PatientBriefCard.tsx`

**Files:**
- Create: `src/pages/desk/DoctorQueuePage.tsx`
- Create: `src/components/desk/QueueTable.tsx`
- Create: `src/components/desk/PatientBriefCard.tsx`

**Interfaces:**
- Produces: the `/desk/:npi` page — direct FHIR search per the Data Model doc's "Every patient who's ever booked with NPI X" queries (FR-11, FR-12).

- [ ] **Step 1: Implement `PatientBriefCard.tsx`**

```typescript
// src/components/desk/PatientBriefCard.tsx
import { Badge, Card, Group, Stack, Text } from '@mantine/core';
import dayjs from 'dayjs';
import type { JSX } from 'react';

export interface QueueEntry {
  patientId: string;
  patientName: string;
  appointmentDate: string;
  statedIssue: string;
  summary?: string;
}

export function PatientBriefCard({ entry, onOpen }: { entry: QueueEntry; onOpen: () => void }): JSX.Element {
  return (
    <Card withBorder onClick={onOpen} style={{ cursor: 'pointer' }}>
      <Group justify="space-between">
        <Stack gap={2}>
          <Text fw={600}>{entry.patientName}</Text>
          <Text size="sm">{entry.statedIssue}</Text>
          {entry.summary && (
            <Text size="sm" c="dimmed">
              {entry.summary}
            </Text>
          )}
        </Stack>
        <Badge>{dayjs(entry.appointmentDate).format('MMM D, YYYY')}</Badge>
      </Group>
    </Card>
  );
}
```

- [ ] **Step 2: Implement `QueueTable.tsx`**

```typescript
// src/components/desk/QueueTable.tsx
import { Stack } from '@mantine/core';
import type { JSX } from 'react';
import { PatientBriefCard } from './PatientBriefCard';
import type { QueueEntry } from './PatientBriefCard';

export function QueueTable({ entries, onOpen }: { entries: QueueEntry[]; onOpen: (patientId: string) => void }): JSX.Element {
  return (
    <Stack>
      {entries.map((entry) => (
        <PatientBriefCard key={entry.patientId} entry={entry} onOpen={() => onOpen(entry.patientId)} />
      ))}
    </Stack>
  );
}
```

- [ ] **Step 3: Implement `DoctorQueuePage.tsx`**

```typescript
// src/pages/desk/DoctorQueuePage.tsx
import { Alert, Loader, Stack, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { Document, useMedplum } from '@medplum/react';
import type { Appointment, Communication, Practitioner } from '@medplum/fhirtypes';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { QueueTable } from '../../components/desk/QueueTable';
import type { QueueEntry } from '../../components/desk/PatientBriefCard';

export function DoctorQueuePage(): JSX.Element {
  const { npi } = useParams();
  const medplum = useMedplum();
  const navigate = useNavigate();
  const [entries, setEntries] = useState<QueueEntry[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    async function load(): Promise<void> {
      const practitioner: Practitioner | undefined = await medplum.searchOne('Practitioner', {
        identifier: `http://hl7.org/fhir/sid/us-npi|${npi}`,
      });
      if (!practitioner) {
        setEntries([]);
        return;
      }

      const [appointments, summaries] = await Promise.all([
        medplum.searchResources('Appointment', { actor: `Practitioner/${practitioner.id}`, _sort: '-date' }),
        medplum.searchResources('Communication', {
          recipient: `Practitioner/${practitioner.id}`,
          category: 'ai-previsit-summary',
        }),
      ]);

      const summaryByPatientId = new Map<string, Communication>();
      for (const communication of summaries) {
        const patientId = communication.subject?.reference?.split('/')[1];
        if (patientId) summaryByPatientId.set(patientId, communication);
      }

      const patientIds = [...new Set(appointments.map((a) => a.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference?.split('/')[1]).filter((id): id is string => !!id))];
      const patients = await Promise.all(patientIds.map((id) => medplum.readResource('Patient', id)));
      const nameByPatientId = new Map(patients.map((p) => [p.id as string, `${p.name?.[0]?.given?.join(' ') ?? ''} ${p.name?.[0]?.family ?? ''}`.trim()]));

      const result: QueueEntry[] = appointments
        .map((appointment: Appointment) => {
          const patientId = appointment.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference?.split('/')[1];
          if (!patientId) return undefined;
          return {
            patientId,
            patientName: nameByPatientId.get(patientId) ?? 'Unknown Patient',
            appointmentDate: appointment.start ?? '',
            statedIssue: appointment.description ?? '',
            summary: summaryByPatientId.get(patientId)?.payload?.[0]?.contentString,
          };
        })
        .filter((e): e is QueueEntry => !!e);

      setEntries(result);
    }

    load().catch((err) => setError(normalizeErrorString(err)));
  }, [medplum, npi]);

  return (
    <Document width={800}>
      <Stack>
        <Title order={1}>Patient Queue — NPI {npi}</Title>
        {error && <Alert color="red">{error}</Alert>}
        {!entries && !error && <Loader />}
        {entries?.length === 0 && <Alert color="yellow">No patients have booked with this NPI yet.</Alert>}
        {entries && <QueueTable entries={entries} onOpen={(patientId) => navigate(`/desk/${npi}/patients/${patientId}`)} />}
      </Stack>
    </Document>
  );
}
```

- [ ] **Step 4: Manual verification**

After completing a booking via `/agent/*` (Task 32), navigate to `/desk/:npi` using the same NPI shown on the confirmation page. Expect the just-booked patient to appear with their stated issue, AI summary, and appointment date — clicking the card should navigate to the chat page.

- [ ] **Step 5: Commit**

```bash
git add src/pages/desk/DoctorQueuePage.tsx src/components/desk/QueueTable.tsx src/components/desk/PatientBriefCard.tsx
git commit -m "feat(ui): doctor patient queue — summary + stated issue (FR-11, FR-12)"
```

---

### Task 35: `src/pages/desk/PatientAgentChatPage.tsx` + `AgentChat.tsx`

**Files:**
- Create: `src/pages/desk/PatientAgentChatPage.tsx`
- Create: `src/components/desk/AgentChat.tsx`

**Interfaces:**
- Consumes: `agent-patient-chat` bot (Task 22).
- Produces: the `/desk/:npi/patients/:patientId` page (FR-13, FR-14, FR-15).

- [ ] **Step 1: Implement `AgentChat.tsx`**

```typescript
// src/components/desk/AgentChat.tsx
import { Alert, Button, Group, Loader, Paper, Stack, Text, Textarea } from '@mantine/core';
import type { JSX } from 'react';
import { useState } from 'react';

export interface ChatTurn {
  question: string;
  answer: string;
}

interface AgentChatProps {
  turns: ChatTurn[];
  onAsk: (question: string) => Promise<void>;
}

const EXAMPLE_QUESTIONS = ['What medications are they on?', 'When was their last visit?', 'Any known allergies?', 'Who have they seen before?'];

export function AgentChat(props: AgentChatProps): JSX.Element {
  const { turns, onAsk } = props;
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);

  async function submit(text: string): Promise<void> {
    if (!text.trim()) return;
    setAsking(true);
    try {
      await onAsk(text);
      setQuestion('');
    } finally {
      setAsking(false);
    }
  }

  return (
    <Stack>
      <Alert color="blue" title="Record-lookup only">
        This agent answers only from the patient's real record. It never diagnoses, interprets findings, or gives
        clinical advice — even if asked directly.
      </Alert>
      <Group>
        {EXAMPLE_QUESTIONS.map((q) => (
          <Button key={q} size="xs" variant="light" onClick={() => submit(q)} disabled={asking}>
            {q}
          </Button>
        ))}
      </Group>
      <Stack>
        {turns.map((turn, i) => (
          <Paper key={i} withBorder p="sm">
            <Text fw={600}>Q: {turn.question}</Text>
            <Text>{turn.answer}</Text>
          </Paper>
        ))}
        {asking && <Loader size="sm" />}
      </Stack>
      <Group align="flex-end">
        <Textarea
          style={{ flex: 1 }}
          value={question}
          onChange={(e) => setQuestion(e.currentTarget.value)}
          placeholder="Ask a factual question about this patient's record"
        />
        <Button disabled={!question.trim() || asking} onClick={() => submit(question)}>
          Ask
        </Button>
      </Group>
    </Stack>
  );
}
```

- [ ] **Step 2: Implement `PatientAgentChatPage.tsx`**

```typescript
// src/pages/desk/PatientAgentChatPage.tsx
import { Alert, Stack, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { Document, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { AgentChat } from '../../components/desk/AgentChat';
import type { ChatTurn } from '../../components/desk/AgentChat';

export function PatientAgentChatPage(): JSX.Element {
  const { patientId } = useParams();
  const medplum = useMedplum();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [threadId, setThreadId] = useState<string>();
  const [error, setError] = useState<string>();

  async function handleAsk(question: string): Promise<void> {
    setError(undefined);
    try {
      const result = await medplum.executeBot(
        { system: 'http://example.com', value: 'agent-patient-chat' },
        { patientId, question, threadId }
      );
      setThreadId(result.threadId);
      setTurns((prev) => [...prev, { question, answer: result.answer }]);
    } catch (err) {
      setError(normalizeErrorString(err));
    }
  }

  return (
    <Document width={800}>
      <Stack>
        <Title order={1}>Patient Agent Chat</Title>
        {error && <Alert color="red">{error}</Alert>}
        <AgentChat turns={turns} onAsk={handleAsk} />
      </Stack>
    </Document>
  );
}
```

- [ ] **Step 3: Manual verification (this is also FR-14's acceptance test)**

Navigate to `/desk/:npi/patients/:patientId` from the queue. Ask a factual example question ("What medications are they on?") — expect a grounded answer sourced from the real record. Then ask a diagnostic-framed question ("What do you think this means?" or "Should I prescribe something for this?") — expect the fixed refusal string, not an opinion. Confirm both turns are visible in the chat and (via a direct `Communication?category=...ai-chat&subject=Patient/:patientId` search, or the `ResourcePage` at `/Communication`) that both the question and answer were persisted (FR-15).

- [ ] **Step 4: Commit**

```bash
git add src/pages/desk/PatientAgentChatPage.tsx src/components/desk/AgentChat.tsx
git commit -m "feat(ui): doctor-patient chat agent with safety banner (FR-13, FR-14, FR-15)"
```

---

## Phase 6 — Full Run & End-to-End Verification

### Task 36: Full seed run against the target Medplum project

**Files:** none (operational).

**Interfaces:**
- Consumes: the full `tools/seed/` pipeline (Tasks 3–9), already smoke-tested at `--limit 50` in Task 10.

- [ ] **Step 1: Run the full corpus**

```bash
npx tsx tools/seed/index.ts --slim --full
```

(`--full` clears the limit — all 983 bundles, filtered to the 7 kept resource types per Task 6's `transformBundle`.) Expected: completes without throwing; final log line `Done. Uploaded 983 bundles.`

- [ ] **Step 2: Spot-check for duplicate Practitioners at full scale**

Pick 5 NPIs at random from the uploaded data and confirm each `Practitioner?identifier=...` search returns exactly one result — the same check as Task 10 Step 4, now meaningful at the full 905-practitioner scale the audit's uniqueness assertion was built for.

- [ ] **Step 3: Commit**

No code changes — this task only populates the target Medplum project. If it's useful to record that this happened, note it in the PR description or a deployment log outside this repo; nothing here needs a git commit.

---

### Task 37: End-to-end manual verification (both flows)

**Files:** none (verification checklist against the fully deployed app).

**Interfaces:**
- Consumes: everything built in Tasks 1–36.

- [ ] **Step 1: Patient flow, start to finish**

1. `/agent` → pick a seeded patient.
2. `/agent/:patientId` → confirm history renders (conditions/medications/allergies/encounters); submit a complaint that should map to a specialty a seeded practitioner actually has (check the Task 10/36 histogram for a populated specialty).
3. Confirm navigation to `/agent/:patientId/doctors` with a previous-physician card ranked first (green badge) when applicable, NPPES cards below it sorted by distance.
4. Pick a doctor → confirm the slot picker loads real, bookable slots.
5. Pick a slot → confirm navigation to the confirmation page with the correct date/time and a large, copyable NPI.

- [ ] **Step 2: Doctor flow, start to finish**

1. `/desk` → enter the NPI from Step 1.5's confirmation page.
2. Confirm the just-booked patient appears in the queue with their stated issue and AI summary.
3. Open the chat → ask a factual example question, confirm a grounded answer.
4. Ask a diagnostic-framed question ("what do you think this means?") → confirm the fixed refusal, not an opinion (FR-14's correctness requirement).
5. Search `Communication?category=...ai-chat&subject=Patient/:patientId` directly (via `/Communication` search page or a script) → confirm both turns from Step 2.3–2.4 are present and threaded (FR-15).

- [ ] **Step 3: Conflict-handling spot check**

Open the same doctor's slot picker in two tabs for two different patients, pick the same slot in both nearly simultaneously — confirm the second attempt shows "That slot was just taken" (FR-10) rather than creating a duplicate `Appointment`.

- [ ] **Step 4: Provider-calendar regression check**

Navigate to `/Schedule/:id` (the fork's original provider calendar, modified in Task 2) — confirm it shows booked appointments and any `busy-unavailable` blocks correctly, and that there is no "Set Availability" button or free-slot click-to-book flow remaining.

- [ ] **Step 5: Record what's still open**

If every check above passes, the implementation matches every FR in `Doctor_Appointment_Agent_Specs.md`. Any check that fails should be traced back to the specific earlier task that owns that behavior — this plan's task numbering (and the Design/LLD doc sections each task cites) is the map for that.

---

## Self-Review

**Spec coverage** — every FR-1 through FR-15 traces to a task above (FR-1→28, FR-2→29, FR-3/FR-4→29, FR-5/FR-7→30, FR-6→30, FR-8→31 (via 19/20), FR-9/FR-10→31/32 (via 21), FR-11→33/34, FR-12→17/21/34, FR-13/FR-14/FR-15→35 (via 22)). Every bot in the Design doc's §6 table has a task (17–23, plus 24–25 for the two core-bot fixes). The seeding tool's every LLD module (disease-csv, specialty-resolver, pass1-scan, pass2-transform, upload, index) has a task (3–9). Every shared lib (geo, ranking, nppes, patientContext, prompts, ensurePractitionerAndSchedule, timezones) has a task (11–16, 19).

**Placeholder scan** — no task defers logic to "add error handling" or similar; every code block is complete, runnable TypeScript. The one deliberately-flagged exception is Task 4's `ENCOUNTER_TYPE_SPECIALTY_MAP`, which ships with a real starting map but explicitly instructs the implementer to reconcile it against the corpus enumeration script's actual output before trusting the completeness test — this is a genuine content dependency on real data that can't be fabricated in a planning document, not a vague placeholder; the task makes the exact mechanism to resolve it (run the script, fill the gaps, let the test enforce completeness) concrete and checkable.

**Type consistency** — `DoctorCandidate`/`RankedCandidate` (Task 13) flow unchanged through `nppes.ts` (14), `agent-find-doctors.ts` (18), and `ensurePractitionerAndSchedule.ts` (19). `IntentInput`/`IntentResult` shapes from `agent-intake.ts` (17) match what `PatientHistoryPage.tsx` (29) destructures (`intent.specialtyCode`, `summaryCommunicationId`). `healthcareServiceIds: {routine, urgent}` is produced once in `ensurePractitionerAndSchedule.ts` (19), passed through `agent-ensure-doctor.ts` (20) unchanged, and consumed with the same shape in `SlotPickerPage.tsx` (31). `BookInput`'s fields in `agent-book-appointment.ts` (21) match exactly what `SlotPickerPage.tsx`'s `handlePick` (31) constructs. The `{ok: true, appointment} | {ok: false, reason: 'slot_taken'}` result shape is identical across `agent-book-appointment.ts` (21) and `reschedule-appointment.ts` (25).

