# Doctor Appointment Agent — Medplum-Native Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Medplum-native Doctor Appointment Agent — a forked `medplum-scheduling-demo` React app plus a set of Medplum Bots that let a patient describe a complaint in natural language, get matched to a previous or newly-discovered doctor, book a synthetic-but-realistic slot, and let that doctor see an AI pre-visit summary and chat with a record-grounded (never diagnostic) AI agent about that patient.

**Architecture:** Fork `medplum-scheduling-demo` into this repo as the frontend shell (React + Vite + Mantine + `@medplum/react`). All backend logic lives in Medplum Bots (`src/bots/agent/*`, plus two fixed/new bots in `src/bots/core/*`); Medplum itself is the only datastore. A standalone TypeScript CLI (`tools/seed/`) imports the 983-bundle Synthea `fhir/` dataset once, fixing two upstream data bugs (duplicate Practitioners, broken specialty resolution) along the way. Two new route trees (`/agent/*` patient flow, `/desk/*` doctor flow) sit alongside the fork's existing provider-calendar pages.

**Tech Stack:** TypeScript 5.9, React 19, Vite 7, every `@medplum/*` package pinned to `5.1.27`, Mantine 8, react-router 7, vitest 4, `tsx` (seed CLI runtime), Google Gemini (`gemini-2.5-flash-lite`, OpenAI-compatible endpoint), NPPES public API.

## Global Constraints

- No Python anywhere in the live application — TypeScript only, per `Doctor_Appointment_Agent_Design.md` §2.
- Bot handlers follow Medplum's exact shape: `export async function handler(medplum: MedplumClient, event: BotEvent<Input>): Promise<Output>`, secrets via `event.secrets['NAME'].valueString`, never via env files (Design §"Configuration" / Backend doc).
- NUCC provider taxonomy codes are the *only* specialty vocabulary — no free-text specialty labels anywhere (Data Model doc, "Two Doctor Pools").
- NPI is the doctor identifier across both doctor pools; `/desk` NPI entry is an explicit **display filter, not authentication** — never add a login/access-control check there (Design §11).
- Neither AI surface (`agent-intake`'s summary, `agent-patient-chat`) may diagnose, interpret, or give clinical/medical advice in any form, even if asked directly — this is a correctness requirement (Specs FR-14), not a nice-to-have.
- Every AI-generated artifact (summary, chat answer) is persisted as a `Communication` with `sender: Device/ai-appointment-agent` and `meta.tag: [{code: 'ai-generated'}]`; doctor-authored chat questions are `sender: Practitioner` and get **no** `ai-generated` tag (Data Model doc, `Communication.meta.tag`).
- Booking uses `$book` directly, applied to the exact proposed `Appointment` object returned by a fresh **Bot-side** `$find` (never accepted from the browser or hand-reconstructed) — **not** `$hold`→`$confirm`. Confirmed by reading Medplum's real source (`hold.ts`, `book.ts`, `scheduling.ts`): `$book` runs through the identical `createProposedAppointment`/`validateProposedAppointment`/`validateAllAvailability` path as `$hold`, inside the same `serializable: true` transaction — it does **not** skip revalidation. Since this app confirms immediately after a slot is picked (no separate "hold while deciding" UX exists anywhere in the design), the two-phase hold/confirm bought nothing but an extra failure mode and a stale-hold cleanup job — both removed. All maintained design documents are synchronized to this contract.
- Every scheduling operation call (`$find`, `$book`, `$cancel`) uses Medplum's **real, verified `5.1.27` request/response contract**, not an assumed one. `$find` and `$book` are `Appointment` type-level operations at `/fhir/R4/Appointment/$find` and `/fhir/R4/Appointment/$book`; their HTTP responses are **bare `Bundle` resources**, because Medplum's single `return` output bypasses a `Parameters` wrapper. Only the `$book` **request** is a `Parameters` resource whose `appointment` input wraps the proposed `Appointment`. A proposed Appointment posted to `$book` must contain the `Slot` returned by a fresh server-side `$find`; browser-supplied Appointment objects are never trusted. Build every operation URL with `medplum.fhirUrl(...)` so it cannot accidentally resolve against the non-FHIR API root.
- `Slot` only ever exists as `contained` inside a **proposed** Appointment (pre-booking, from `$find`'s output) or as a real top-level resource once `$book` has actually created it (confirmed: `$book`'s transaction-response Bundle includes both the booked `Appointment` and its `Slot` as separate persisted resources) — never `contained` inside an already-`booked` Appointment.
- Cancellation uses Medplum's **native** `POST /fhir/R4/Appointment/{id}/$cancel` directly — confirmed to run atomically (serializable transaction: update status to `cancelled`, delete every referenced Slot) in `cancel.ts`. No custom cancellation bot exists in this plan; hand-rolling that logic was unnecessary risk once the native operation was actually checked.
- Every `Schedule` carries **two separate `SchedulingParameters` extensions**, one per HealthcareService, each with its own `service` sub-extension (`valueReference` to that `HealthcareService`) plus `duration`/`alignmentInterval`/`timezone`/`availability`. Confirmed directly in `scheduling-parameters.ts`: a Schedule-level extension is matched against the *specific requested* HealthcareService via its `service` sub-extension — an extension with no `service` sub-extension matches nothing and is silently ignored (falls back to HealthcareService-level defaults instead of throwing). A single "one extension covers both services" design (this plan's original approach) would have made the NPI-seeded weekly template never actually apply. `alignmentInterval` is explicitly set to match each service's own `duration` (30 min / 15 min) — confirmed the default when unset is 60 minutes, and `$find` steps candidate start times by this interval independent of the requested duration, so leaving it unset would silently offer only one start time per hour for either service.
- `Schedule.serviceType` still lists **both** HealthcareServices (Office Visit 30 min, Urgent Visit 15 min) as `CodeableConcept`s carrying the `https://medplum.com/fhir/service-type-reference` extension — confirmed exact mechanic in `packages/server/src/util/servicetype.ts` (Data Model doc, `Schedule.serviceType`) — this part was already correct.
- NUCC provider taxonomy codes are the *only* specialty vocabulary, and this means **real codes, not the specialty's plain-English label**, must land in `PractitionerRole.specialty.coding.code` — a seeding bug in an earlier pass of this plan wrote strings like `"Cardiology"` into that field instead of `207RC0000X`. `SPECIALTY_TABLE` (`src/config/specialties.ts`) is the single place label↔NUCC-code translation happens; the seeder imports it rather than re-inventing the mapping.
- Every seeded resource has a deterministic FHIR id and is written with an unconditional `PUT ResourceType/{id}` upsert. Medplum replaces caller ids on `POST`, including Bundle-entry POSTs, so the seeder must never infer a final reference from a POSTed source id. Deterministic PUT is the verified identity-preserving path: references such as `Patient/{synthea-id}` remain valid, retries are idempotent, and fixed bootstrap references such as `Device/ai-appointment-agent` resolve exactly.
- All `@medplum/*` packages are pinned to the same exact version, `5.1.27`. This is the current official package line and matches the source used to verify these contracts. Do not mix Medplum package versions. Before seeding, the server must pass Task 10's version/identity preflight; before release, it must also pass Task 26's live `$find`/`$book`/`$cancel`/`SchedulingParameters` preflight. A hosted target need not expose the same patch number, but it must demonstrate the same behavior.
- `SchedulingParameters` extension URL is exactly `https://medplum.com/fhir/StructureDefinition/SchedulingParameters`; `availableTime`'s `daysOfWeek` sub-extension repeats once per day *inside one block*, not as an array (Data Model doc gotcha).
- Prettier config already in the fork's `package.json`: `printWidth: 120, singleQuote: true, trailingComma: 'es5'` — match it in all new files.
- Test runner is `vitest` (`npm test` = `vitest run`); colocate `*.test.ts` next to the module under test, per the fork's existing convention.

## Fork-Surgery Decisions Grounded During Planning

Discovered while grounding this plan against the real
`medplum-scheduling-demo` checkout. They are recorded here for task-level
traceability and are now also reflected in the maintained design documents:

1. **`src/bots/core/book-appointment.ts` and `src/components/actions/CreateAppointment.tsx` must be deleted alongside `set-availability.ts`.** The Design doc's fork-strategy list (§4) never mentions `book-appointment.ts` at all. Reading the real code: `CreateAppointment.tsx` only ever fires when a user clicks a `status: 'free'` Slot on the calendar, and `book-appointment.ts` only ever operates on such a Slot. Since `set-availability.ts` (deleted per Design §4) is the *only* code that ever created a `free` Slot, deleting it makes both of these permanently unreachable — dead code, not working features. They're deleted in Task 2, not left behind.
2. **`src/components/actions/CreateUpdateSlot.tsx` loses its `'free'`-status branch, keeps its `'busy-unavailable'` branch.** This component does double duty: create a free slot (dead per #1) or create/edit a *block* (still valid, backed by the kept `block-availability.ts`). Task 2 strips only the dead branch.
3. **`src/pages/SchedulePage.tsx` becomes a read-only "booked & blocked time" calendar** — exactly the fallback the Design doc itself proposed (§4) when it flagged this page as needing "relabeling ... or re-sourcing." `SetAvailability` and `CreateAppointment` wiring is removed; `BlockAvailability`/`CreateUpdateSlot`(block-only)/`SlotDetails` stay, since blocking time off is independent of the free-slot question.
4. **`src/bots/core/cancel-appointment.ts` is deleted, not fixed.** An earlier pass of this plan hand-rolled a fix for its orphaned-Slot bug. Once Medplum's own native `$cancel` was actually checked against source, it turned out to already do exactly that — atomically, in a transaction — making the custom bot pure unnecessary risk. `AppointmentActions.tsx`'s cancel button now calls `$cancel` directly.
5. **`src/bots/core/block-availability.ts` is modified, not kept untouched.** It searches booked Appointments to cancel with `date=lt${end}&date=ge${start}&status=booked` — **no** actor/Schedule filter — so blocking one doctor's afternoon can cancel every overlapping Appointment for every doctor in the project. Fixed in Task 2 to filter by the blocking Schedule's actor.
6. **`data/core/UploadDataPage.tsx`'s `checkBotsUploaded` hard-codes a 5-name bot list** (`book-appointment`, `cancel-appointment`, `set-availability`, `block-availability`, `example-data`) to decide whether the "Upload Example Bots" button is disabled. Three of those five no longer exist in this plan's bot roster. Task 26 updates the list to match.
7. **No cron-triggered bot exists in this plan.** An earlier pass added `agent-expire-holds` (a hold-expiry cron) and a `cronString` field to `deploy-bots.ts`'s `BotDescription` to support it. Once booking switched from `$hold`→`$confirm` to a single `$book` call, there is no hold state to ever expire — the bot, the cron-support code, and this whole category of failure mode are removed, not fixed.

---

## Phase 0 — Fork & Repo Surgery

### Task 1: Fork `medplum-scheduling-demo` into this repo, upgrade Medplum coherently, install, confirm it boots

**Files:**
- Create: everything under this repo's root copied from `medplum-scheduling-demo/` (`src/`, `data/`, `package.json`, `tsconfig.json`, `vite.config.ts`, `esbuild-script.mjs`, `.eslintrc`/`eslint.config.*`, `index.html`) — the reference clone at `medplum-scheduling-demo/` (project root, gitignored) is the source; copy its files in, do not `git clone` a nested repo. **The fork's own `.gitignore` is explicitly excluded from this copy** (see Step 1a) — it doesn't ignore `.claude/`/`medplum/`/`medplum-scheduling-demo/` (paths that only make sense at this outer repo's root) and it ignores `package-lock.json`, which this repo needs tracked.
- Create: `.env` at project root (gitignored already) — `VITE_MEDPLUM_BASE_URL`, `VITE_MEDPLUM_CLIENT_ID` (values come from whichever Medplum project this is deployed against — placeholder values are fine for this task, real values needed before Task 10).
- Modify: this repo's root `.gitignore` — **merge in**, don't overwrite, the fork-specific entries it's missing.
- Modify: root `package.json` and `package-lock.json` — pin every copied `@medplum/*` dependency and devDependency to exactly `5.1.27` before establishing the baseline.

**Interfaces:**
- Produces: the full fork's directory layout at repo root, in particular `src/bots/core/*.ts` (existing bots: `block-availability`, `book-appointment`, `cancel-appointment`, `set-availability`), `src/pages/*.tsx`, `src/components/**`, `src/scripts/deploy-bots.ts`, `src/Schedule.context.ts`, `src/App.tsx` — every later task in this plan modifies or adds alongside these exact paths.

- [ ] **Step 1: Copy the fork's files into the repo root, excluding its `.gitignore`**

From the project root (`D:\Desktop\Doctor Appointment Agent`), copy everything from the reference clone except its own `.git/` **and its `.gitignore`** — the root repo's existing `.gitignore` (which protects `.claude/`, `medplum/`, `medplum-scheduling-demo/`) must not be overwritten by a blind copy:

```bash
# from the project root
robocopy medplum-scheduling-demo . /E /XD .git node_modules dist /XF .git .gitignore
```

(On non-Windows, `rsync -a --exclude .git --exclude node_modules --exclude dist --exclude .gitignore medplum-scheduling-demo/ ./` does the same thing.) Verify `src/App.tsx` now exists at the repo root, and that root `.gitignore` still contains its original `.claude/`/`medplum/`/`medplum-scheduling-demo/` entries (`cat .gitignore`).

- [ ] **Step 1a: Merge in the fork's `.gitignore` entries the root file is missing**

Read the fork's `.gitignore` (`medplum-scheduling-demo/.gitignore`) and add any entries it has that the root `.gitignore` doesn't — specifically `logs`, `*.log`, `npm-debug.log*`, `dist-ssr`, `*.local`, `data/core/example-bots.json`, `.vscode/*`, `!.vscode/extensions.json`, `.idea`, `.DS_Store`. **Do not add `package-lock.json`** — this repo needs its lockfile tracked for reproducible installs, unlike the fork (which is meant to be cloned repeatedly as a template). Append these as a new section rather than replacing the file's existing content.

- [ ] **Step 2: Pin the complete Medplum package family to `5.1.27`**

In the copied root `package.json`, change every dependency or devDependency whose name starts with `@medplum/` to the exact string `"5.1.27"`. Do not use `^`, `~`, `latest`, or mixed patch versions. This includes `@medplum/bot-layer`, `core`, `definitions`, `eslint-config`, `fhirtypes`, `mock`, and `react`.

The choice is deliberate: official npm currently publishes `5.1.27` across the Medplum package family, the checked source is exactly `5.1.27`, and this plan uses scheduling behavior added after the fork's old pin (including `$find` `_count` support and later scheduling corrections). Keeping the copied package versions would preserve a known mismatch between the plan and the runtime it describes.

- [ ] **Step 3: Install dependencies and generate the lockfile**

```bash
npm install
```

Expected: completes without error; `node_modules/` created (already gitignored).

Verify the lockfile resolved one Medplum version family:

```bash
npm ls @medplum/core @medplum/react @medplum/fhirtypes @medplum/mock @medplum/bot-layer
```

Expected: every listed package resolves to `5.1.27`; no `invalid` or mixed-version entry appears.

- [ ] **Step 4: Create `.env`**

```
VITE_MEDPLUM_BASE_URL=https://api.medplum.com/
VITE_MEDPLUM_CLIENT_ID=
```

Leave `VITE_MEDPLUM_CLIENT_ID` blank until a real Medplum project/client exists (Task 10 needs one; the dev server itself will run and show the sign-in page without it).

- [ ] **Step 5: Confirm the stock app boots (manual verification — no live Medplum project needed yet)**

```bash
npm run dev
```

Expected: Vite starts, prints a local URL (e.g. `http://localhost:5173`); opening it shows the fork's sign-in page without a console error about a missing module. This only proves the scaffold compiles and serves — it does not require a working Medplum login yet. Stop the dev server (Ctrl+C) once confirmed.

- [ ] **Step 6: Run the existing test suite as a baseline**

```bash
npm test
```

Expected: all of the fork's pre-existing tests (`block-availability.test.ts`, `book-appointment.test.ts`, `cancel-appointment.test.ts`, `set-availability.test.ts`, `example-data.test.ts`) pass. This is the "clean baseline" — Task 2 will delete some of these files along with the bots they test.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: fork scheduling demo and pin Medplum 5.1.27"
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

- [ ] **Step 3a: Fix `block-availability.ts`'s unscoped Appointment cancellation**

`src/bots/core/block-availability.ts` searches for booked Appointments to cancel with `date=lt${end}&date=ge${start}&status=booked` — no filter on which Schedule/practitioner the block applies to, so blocking one doctor's afternoon cancels *every* overlapping booked Appointment in the entire project, for every doctor. Fix the search to scope by the blocking Schedule's actor:

```typescript
  // Cancel booked appointments that overlap the period, for THIS schedule's
  // practitioner only — the original search had no actor/schedule scope at
  // all, so blocking one doctor's time could cancel every other doctor's
  // overlapping appointments too.
  const scheduleResource = await medplum.readReference(schedule);
  const appointmentsToCancel: Appointment[] = await medplum.searchResources(
    'Appointment',
    `date=lt${end}&date=ge${start}&status=booked&actor=${scheduleResource.actor?.[0]?.reference}`
  );
```

(`schedule` is already the function's existing `BlockAvailabilityEvent.schedule` parameter — `Reference<Schedule>` — so `medplum.readReference` resolves it to get the actor. Add `readReference` to the existing `@medplum/core` import if not already present.)

Update `block-availability.test.ts`'s existing test fixture to include a `Schedule` with an `actor`, and add a new test asserting that a booked Appointment on a *different* schedule's actor, overlapping the same time window, is **not** cancelled.

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
import { resolveSpecialty, ENCOUNTER_TYPE_SPECIALTY_MAP, SPECIALTY_NUCC_CODES, allPossibleSpecialtyLabels } from './specialty-resolver';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

describe('resolveSpecialty', () => {
  test('tier 1: substring-matches reasonText against a known disease name', () => {
    // 'Bronchial Asthma' is a real row in Disease_Description.csv (-> Pulmonology);
    // the reason text is a realistic superstring containing it verbatim.
    expect(resolveSpecialty(['Patient reports symptoms of Bronchial Asthma'], [])).toBe('Pulmonology');
  });

  test('tier 2: falls back to encounter type when no reason text matches', () => {
    expect(resolveSpecialty([], ['Well child visit'])).toBe('Pediatrics');
  });

  test('tier 3: falls back to General Practice when nothing matches', () => {
    expect(resolveSpecialty(['unrelated free text'], ['totally unknown kind'])).toBe('General Practice');
  });

  test('tier 1 takes priority over tier 2 when both could match', () => {
    expect(resolveSpecialty(['Patient reports symptoms of Bronchial Asthma'], ['Well child visit'])).toBe('Pulmonology');
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

describe('SPECIALTY_NUCC_CODES completeness', () => {
  test('has a real NUCC code for every specialty label the resolver can produce', () => {
    for (const label of allPossibleSpecialtyLabels()) {
      expect(SPECIALTY_NUCC_CODES[label], `missing NUCC code for "${label}"`).toBeDefined();
    }
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

// Ported VERBATIM (by row order, not by guessing) from the retired Python
// specialty_mapping.py's SPECIALTIES_IN_FILE_ORDER — a correction pass
// caught that an earlier version of this array was invented without
// actually reading Disease_Description.csv's real row order, producing
// nonsense pairings (Drug Reaction -> Cardiology, Malaria -> Pulmonology).
// This array's row order matches the CSV exactly; each comment is the
// disease name at that row, kept so a future re-check doesn't have to
// cross-reference two files by hand.
const DISEASE_SPECIALTIES: string[] = [
  'Allergy and Immunology',  // Drug Reaction
  'Infectious Disease',      // Malaria
  'Allergy and Immunology',  // Allergy
  'Endocrinology',           // Hypothyroidism
  'Dermatology',             // Psoriasis
  'Gastroenterology',        // GERD
  'Gastroenterology',        // Chronic cholestasis
  'Gastroenterology',        // hepatitis A
  'Orthopedics',             // Osteoarthristis
  'Otolaryngology',          // (vertigo) Paroymsal Positional Vertigo
  'Endocrinology',           // Hypoglycemia
  'Dermatology',             // Acne
  'Endocrinology',           // Diabetes
  'Dermatology',             // Impetigo
  'Cardiology',              // Hypertension
  'Gastroenterology',        // Peptic ulcer diseae
  'General Surgery',         // Dimorphic hemorrhoids(piles)
  'General Practice',        // Common Cold
  'Infectious Disease',      // Chicken pox
  'Orthopedics',             // Cervical spondylosis
  'Endocrinology',           // Hyperthyroidism
  'Urology',                 // Urinary tract infection
  'Vascular Surgery',        // Varicose veins
  'Infectious Disease',      // AIDS
  'Neurology',                // Paralysis (brain hemorrhage)
  'Infectious Disease',      // Typhoid
  'Gastroenterology',        // Hepatitis B
  'Dermatology',             // Fungal infection
  'Gastroenterology',        // Hepatitis C
  'Neurology',                // Migraine
  'Pulmonology',              // Bronchial Asthma
  'Gastroenterology',        // Alcoholic hepatitis
  'Gastroenterology',        // Jaundice
  'Gastroenterology',        // Hepatitis E
  'Infectious Disease',      // Dengue
  'Gastroenterology',        // Hepatitis D
  'Cardiology',               // Heart attack
  'Pulmonology',               // Pneumonia
  'Rheumatology',              // Arthritis
  'Gastroenterology',         // Gastroenteritis
  'Pulmonology',               // Tuberculosis
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

/**
 * Real NUCC provider taxonomy codes for every specialty label this resolver
 * can produce. Deliberately duplicated from (not imported from)
 * `src/config/specialties.ts`'s `SPECIALTY_TABLE` — `tools/seed/` stays a
 * fully standalone CLI with no dependency on `src/` (Backend doc's module
 * boundary), and this module's own specialty vocabulary is a strict subset
 * of that table's, kept in sync by the completeness test below rather than
 * a shared import. Codes are the same NUCC registry either way.
 */
export const SPECIALTY_NUCC_CODES: Record<string, string> = {
  'Allergy and Immunology': '207K00000X',
  Cardiology: '207RC0000X',
  Dermatology: '207N00000X',
  Endocrinology: '207RE0101X',
  Gastroenterology: '207RG0100X',
  'General Practice': '208D00000X',
  'General Surgery': '208600000X',
  'Infectious Disease': '207RI0200X',
  Neurology: '2084N0400X',
  'Obstetrics and Gynecology': '207V00000X',
  Orthopedics: '207X00000X',
  Otolaryngology: '207Y00000X',
  Pediatrics: '208000000X',
  Psychiatry: '2084P0800X',
  Pulmonology: '207RP1001X',
  Rheumatology: '207RR0500X',
  Urology: '208800000X',
  'Vascular Surgery': '2086S0129X',
};

/** Every label DISEASE_SPECIALTIES/ENCOUNTER_TYPE_SPECIALTY_MAP can produce, for the completeness test. */
export function allPossibleSpecialtyLabels(): string[] {
  return [...new Set([...DISEASE_SPECIALTIES, ...ENCOUNTER_TYPE_SPECIALTY_MAP.values(), 'General Practice'])];
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
    // Reference shape matches the REAL corpus, verified directly against
    // fhir/*.json: Encounter.participant[0].individual.reference is a bare
    // urn:uuid:{uuid} — the exact same uuid as the Practitioner resource's
    // own `id` (Synthea sets Practitioner.id to the uuid portion of its own
    // fullUrl) — never a `Practitioner?identifier=...` conditional reference.
    const dir = mkdtempSync(join(tmpdir(), 'pass1-'));
    const file = writeBundle(dir, 'bundle1.json', [
      {
        resource: {
          resourceType: 'Practitioner',
          id: '0000016d-3a85-4cca-0000-000000000122',
        },
      },
      {
        resource: {
          resourceType: 'Encounter',
          id: 'enc-1',
          participant: [{ individual: { reference: 'urn:uuid:0000016d-3a85-4cca-0000-000000000122' } }],
          reasonCode: [{ coding: [{ display: 'Patient reports symptoms of Bronchial Asthma' }] }],
        },
      },
      {
        resource: {
          resourceType: 'Encounter',
          id: 'enc-2',
          participant: [{ individual: { reference: 'urn:uuid:0000016d-3a85-4cca-0000-000000000122' } }],
          reasonCode: [{ coding: [{ display: 'Patient reports symptoms of Bronchial Asthma' }] }],
        },
      },
    ]);

    const result = scanPractitionerSpecialties([file]);

    expect(result.get('0000016d-3a85-4cca-0000-000000000122')).toBe('Pulmonology');
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

A correction pass found two real bugs here that would have made every seed
run duplicate data: some types were conditional-created against identifiers
they did not carry while five other types were unconditional POSTs. More
importantly, Medplum's Bundle preprocessor replaces `resource.id` for every
POST create, so even a correctly conditional-created resource cannot use its
submitted Synthea id as the final reference target. This task fixes both
problems by attaching the source identifier for audit/search purposes while
writing every resource through deterministic `PUT ResourceType/{synthea-id}`
upserts. Also fixed: `PractitionerRole.specialty.coding.code` was writing
the specialty's plain-English label (`"Cardiology"`) instead of a real NUCC
code — it now looks the code up from `SPECIALTY_TABLE`. And `mode`
(`'slim' | 'full'`) is now an actual parameter that controls whether the
7-type filter runs at all, instead of being computed by the CLI and never
passed anywhere.

A second, independent re-audit of the seeded corpus found a much bigger
problem this task must also fix: real Synthea bundles carry thousands of
**clinical-to-clinical** references (`Condition.encounter`,
`MedicationRequest.encounter`, `MedicationRequest.reasonReference` →
`Condition`, `MedicationRequest.requester` → `Practitioner`) — a scan of
all 983 bundles found 26,268 such references corpus-wide. The original
design only rewrote `subject`/`patient`/`serviceProvider`/
`participant.individual` **after** a live upload, using the server's
response to learn real ids — a mechanism that only ever covered
identity-wave references and would leave every clinical-to-clinical
reference dangling (`urn:uuid:...`, resolving to nothing) once clinical
resources are split across separate chunk uploads.

The identity rule is now explicit and source-verified: `POST` is
server-assigned and therefore unsuitable here; unconditional `PUT` to
`ResourceType/{id}` is the FHIR update-as-create path that preserves that
exact id. Since every source id is known before upload, every URN can safely
be rewritten client-side only because the corresponding Bundle entry is
also rewritten to deterministic PUT. Task 7 may still split large bundles;
the final reference does not depend on response ordering or chunk placement.

**Files:**
- Create: `tools/seed/pass2-transform.ts`
- Test: `tools/seed/pass2-transform.test.ts`

**Interfaces:**
- Consumes: the `Map<string, string>` (stable id -> specialty label) produced by Task 5; `SPECIALTY_NUCC_CODES` from Task 4's `specialty-resolver.ts` for label -> NUCC code (kept within `tools/seed/`, not imported from `src/`, to preserve the seed tool's standalone module boundary).
- Produces: `transformBundle(bundle: Bundle, specialtiesByStableId: Map<string, string>, mode: 'slim' | 'full'): Bundle` — every reference in the returned Bundle is already a plain, resolved `ResourceType/id` reference, never a `urn:uuid:` — used by Task 9's CLI and Task 7's (now much simpler) upload orchestration.

- [ ] **Step 1: Write the failing test**

```typescript
// tools/seed/pass2-transform.test.ts
import { describe, expect, test } from 'vitest';
import type { Bundle } from '@medplum/fhirtypes';
import { transformBundle } from './pass2-transform';

describe('transformBundle', () => {
  test("filters to the 7 app-read resource types in 'slim' mode", () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        { resource: { resourceType: 'Patient', id: 'p1' } },
        { resource: { resourceType: 'Observation', id: 'o1' } },
        { resource: { resourceType: 'Claim', id: 'c1' } },
      ],
    };

    const result = transformBundle(bundle, new Map(), 'slim');

    const types = result.entry?.map((e) => e.resource?.resourceType);
    expect(types).toStrictEqual(['Patient']);
  });

  test("keeps every resource type in 'full' mode", () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        { resource: { resourceType: 'Patient', id: 'p1' } },
        { resource: { resourceType: 'Observation', id: 'o1' } },
      ],
    };

    const result = transformBundle(bundle, new Map(), 'full');

    const types = result.entry?.map((e) => e.resource?.resourceType);
    expect(types).toContain('Observation');
  });

  test('attaches a stable-id identifier and deterministically upserts every kept resource', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        { resource: { resourceType: 'Patient', id: 'patient-1' }, request: { method: 'POST', url: 'Patient' } },
        {
          resource: { resourceType: 'Condition', id: 'cond-1', subject: { reference: 'urn:uuid:patient-1' } },
          request: { method: 'POST', url: 'Condition' },
        },
      ],
    };

    const result = transformBundle(bundle, new Map(), 'slim');

    const patientEntry = result.entry?.find((e) => e.resource?.resourceType === 'Patient');
    expect((patientEntry?.resource as any).identifier).toContainEqual({
      system: 'https://synthea.mitre.org/identifier',
      value: 'patient-1',
    });
    expect(patientEntry?.request).toStrictEqual({
      method: 'PUT',
      url: 'Patient/patient-1',
    });

    const conditionEntry = result.entry?.find((e) => e.resource?.resourceType === 'Condition');
    expect((conditionEntry?.resource as any).identifier).toContainEqual({
      system: 'https://synthea.mitre.org/identifier',
      value: 'cond-1',
    });
    expect(conditionEntry?.request).toStrictEqual({ method: 'PUT', url: 'Condition/cond-1' });
    // The plain reference is valid because the corresponding resource is
    // deterministically upserted at this exact id, never POST-created.
    expect((conditionEntry?.resource as any).subject.reference).toBe('Patient/patient-1');
  });

  test('resolves clinical-to-clinical references (Condition.encounter, MedicationRequest.encounter/requester/reasonReference) — the real corpus has 26,268 of these', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        { resource: { resourceType: 'Patient', id: 'patient-1' }, request: { method: 'POST', url: 'Patient' } },
        { resource: { resourceType: 'Practitioner', id: 'pract-1' }, request: { method: 'POST', url: 'Practitioner' } },
        {
          resource: { resourceType: 'Encounter', id: 'enc-1', subject: { reference: 'urn:uuid:patient-1' } },
          request: { method: 'POST', url: 'Encounter' },
        },
        {
          resource: {
            resourceType: 'Condition',
            id: 'cond-1',
            subject: { reference: 'urn:uuid:patient-1' },
            encounter: { reference: 'urn:uuid:enc-1' },
          },
          request: { method: 'POST', url: 'Condition' },
        },
        {
          resource: {
            resourceType: 'MedicationRequest',
            id: 'med-1',
            subject: { reference: 'urn:uuid:patient-1' },
            encounter: { reference: 'urn:uuid:enc-1' },
            requester: { reference: 'urn:uuid:pract-1' },
            reasonReference: [{ reference: 'urn:uuid:cond-1' }],
          },
          request: { method: 'POST', url: 'MedicationRequest' },
        },
      ],
    };

    const result = transformBundle(bundle, new Map(), 'slim');

    const condition = result.entry?.find((e) => e.resource?.resourceType === 'Condition')?.resource as any;
    expect(condition.encounter.reference).toBe('Encounter/enc-1');

    const medReq = result.entry?.find((e) => e.resource?.resourceType === 'MedicationRequest')?.resource as any;
    expect(medReq.encounter.reference).toBe('Encounter/enc-1');
    expect(medReq.requester.reference).toBe('Practitioner/pract-1');
    expect(medReq.reasonReference[0].reference).toBe('Condition/cond-1');
  });

  test('rewrites Practitioner to deterministic PUT while retaining its source identifier', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [{ resource: { resourceType: 'Practitioner', id: 'stable-id-1' }, request: { method: 'POST', url: 'Practitioner' } }],
    };

    const result = transformBundle(bundle, new Map([['stable-id-1', 'Cardiology']]), 'slim');

    const practitionerEntry = result.entry?.find((e) => e.resource?.resourceType === 'Practitioner');
    expect(practitionerEntry?.request).toStrictEqual({
      method: 'PUT',
      url: 'Practitioner/stable-id-1',
    });
    expect((practitionerEntry?.resource as any).identifier).toContainEqual({
      system: 'https://synthea.mitre.org/identifier',
      value: 'stable-id-1',
    });
  });

  test('injects the resolved specialty as a real NUCC code (not the label) on PractitionerRole, plus qualification display copy and timezone', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [{ resource: { resourceType: 'Practitioner', id: 'stable-id-1' }, request: { method: 'POST', url: 'Practitioner' } }],
    };

    const result = transformBundle(bundle, new Map([['stable-id-1', 'Cardiology']]), 'slim');

    const practitioner = result.entry?.find((e) => e.resource?.resourceType === 'Practitioner')?.resource as any;
    expect(practitioner.qualification[0].code.text).toBe('Cardiology');
    expect(practitioner.extension).toContainEqual({
      url: 'http://hl7.org/fhir/StructureDefinition/timezone',
      valueCode: expect.any(String),
    });

    const role = result.entry?.find((e) => e.resource?.resourceType === 'PractitionerRole')?.resource as any;
    expect(role.specialty[0].coding[0].code).toBe('207RC0000X'); // real NUCC code for Cardiology, not the label
    expect(role.specialty[0].coding[0].display).toBe('Cardiology');
    expect(role.practitioner.reference).toBe('Practitioner/stable-id-1');
    expect(role.id).toBe('stable-id-1-role');
    const roleEntry = result.entry?.find((e) => e.resource?.resourceType === 'PractitionerRole');
    expect(roleEntry?.request).toStrictEqual({ method: 'PUT', url: 'PractitionerRole/stable-id-1-role' });
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
import type { Bundle, BundleEntry, Identifier, Reference } from '@medplum/fhirtypes';
import { SPECIALTY_NUCC_CODES } from './specialty-resolver';

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

function nuccCodeForLabel(label: string): string {
  return SPECIALTY_NUCC_CODES[label] ?? SPECIALTY_NUCC_CODES['General Practice'];
}

/**
 * Every kept resource retains an explicit source identifier for audit and
 * lookup. Idempotence itself comes from deterministic PUT, not from a POST
 * conditional-create whose server-assigned id would differ from stableId.
 */
function withStableIdentifier<T extends { identifier?: Identifier[] }>(resource: T, stableId: string): T {
  return { ...resource, identifier: [...(resource.identifier ?? []), { system: SYNTHEA_STABLE_ID_SYSTEM, value: stableId }] };
}

function deterministicUpsert(resourceType: string, stableId: string): BundleEntry['request'] {
  return { method: 'PUT', url: `${resourceType}/${stableId}` };
}

/**
 * Maps every entry's urn:uuid fullUrl to the deterministic reference used
 * by its PUT request. This is valid only because transformBundle rewrites
 * every retained entry to `PUT ResourceType/{sourceId}`. Medplum replaces
 * ids on POST; changing these requests back to POST would invalidate every
 * reference produced by this index.
 */
function buildFullUrlIndex(bundle: Bundle): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of bundle.entry ?? []) {
    if (entry.fullUrl && entry.resource?.resourceType && entry.resource.id) {
      index.set(entry.fullUrl, `${entry.resource.resourceType}/${entry.resource.id}`);
    }
  }
  return index;
}

function rewriteRef(ref: Reference | undefined, index: Map<string, string>): void {
  if (ref?.reference && index.has(ref.reference)) {
    ref.reference = index.get(ref.reference);
  }
}

/**
 * Rewrites every reference field the 7 kept resource types actually use —
 * both to identity resources (Patient/Practitioner/Organization) and to
 * each other (Condition.encounter, MedicationRequest.encounter/requester/
 * reasonReference) — confirmed against a full-corpus scan of all 983
 * bundles (26,268 clinical-to-clinical references corpus-wide; the four
 * fields below account for all of them). Mutates and returns the resource.
 */
function resolveReferences<T extends Record<string, unknown>>(resource: T, index: Map<string, string>): T {
  const r = resource as any;
  rewriteRef(r.subject, index);
  rewriteRef(r.patient, index);
  rewriteRef(r.serviceProvider, index);
  rewriteRef(r.encounter, index);
  rewriteRef(r.requester, index);
  for (const p of r.participant ?? []) rewriteRef(p.individual, index);
  for (const rr of r.reasonReference ?? []) rewriteRef(rr, index);
  return resource;
}

/**
 * Per-bundle rewrite. In 'slim' mode, filters to the 7 resource types the
 * app reads; in 'full' mode, keeps everything. Every kept resource is
 * deterministically PUT-upserted at its source id, and every reference field it carries —
 * to an identity resource or to another clinical resource — is resolved to
 * its final, real form before this function returns (see
 * `buildFullUrlIndex`'s doc comment for why that's already knowable).
 * Practitioner additionally gets the resolved specialty injected as a real
 * NUCC-coded PractitionerRole plus a Practitioner.qualification[0] display
 * copy, and the mandatory timezone extension.
 */
export function transformBundle(bundle: Bundle, specialtiesByStableId: Map<string, string>, mode: 'slim' | 'full'): Bundle {
  const fullUrlIndex = buildFullUrlIndex(bundle);
  const candidateEntries =
    mode === 'full' ? (bundle.entry ?? []) : (bundle.entry ?? []).filter((entry) => entry.resource?.resourceType && KEPT_RESOURCE_TYPES.has(entry.resource.resourceType));

  const outputEntries: BundleEntry[] = [];

  for (const entry of candidateEntries) {
    const resource = resolveReferences(entry.resource as { resourceType: string; id?: string }, fullUrlIndex);
    if (!resource.id) throw new Error(`Cannot seed ${resource.resourceType} without a deterministic source id`);

    if (resource.resourceType === 'Practitioner') {
      const specialtyLabel = specialtiesByStableId.get(resource.id) ?? 'General Practice';
      const nuccCode = nuccCodeForLabel(specialtyLabel);
      const practitioner = withStableIdentifier(
        {
          ...resource,
          qualification: [{ code: { text: specialtyLabel } }],
          extension: [...((resource as any).extension ?? []), { url: TIMEZONE_EXT_URL, valueCode: DEFAULT_TIMEZONE }],
        },
        resource.id
      );
      outputEntries.push({ ...entry, resource: practitioner as BundleEntry['resource'], request: deterministicUpsert('Practitioner', resource.id) });
      // PractitionerRole.practitioner is already a plain, resolved
      // reference (Practitioner/{resource.id}) — no urn:uuid involved
      // here at all, since this entry is created fresh by this function,
      // not sourced from Synthea.
      outputEntries.push({
        resource: {
          resourceType: 'PractitionerRole',
          id: `${resource.id}-role`,
          practitioner: { reference: `Practitioner/${resource.id}` },
          specialty: [{ coding: [{ system: NUCC_SYSTEM, code: nuccCode, display: specialtyLabel }] }],
        } as BundleEntry['resource'],
        request: deterministicUpsert('PractitionerRole', `${resource.id}-role`),
      });
      continue;
    }

    // Every other retained type uses the same deterministic PUT identity.
    outputEntries.push({
      ...entry,
      resource: withStableIdentifier(resource as any, resource.id) as BundleEntry['resource'],
      request: deterministicUpsert(resource.resourceType, resource.id),
    });
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
git commit -m "fix(seed): deterministic PUT identities and complete reference rewrite"
```

---

### Task 7: `tools/seed/upload.ts` + `tools/seed/chunk-bundle.ts` — chunked upload with retry

A correction pass measured the real corpus directly: after the 7-type
filter, the two largest patient bundles are 2.42MB and 2.24MB. Medplum's
default JSON request body limit (`config.maxJsonSize`) is `1mb`, and —
confirmed by reading `app.ts` — that default limit applies to a normal
synchronous `executeBatch()` call (the larger `maxBatchSize` limit only
applies to the opt-in async-batch path, which requires a project feature
flag and changes the upload from synchronous to a polled job). At least
those two patients' transactions would fail outright against an
unconfigured/default server. Rather than depend on every deployment target
raising its config (not possible at all on some managed hosting), this
plan splits each patient's bundle into an **identity wave**
(Patient/Practitioner/Organization/PractitionerRole — always small) and one
or more **clinical chunks** (Encounter/Condition/MedicationRequest/
AllergyIntolerance). Task 6 has already changed every retained entry to a
deterministic `PUT ResourceType/{id}` and every reference to that exact id,
so cross-chunk references remain valid without reading ids from an earlier
response. Clinical chunks are safe to upload as separate `batch` requests
capped well under the size limit.

Also fixed here: `isTransient`'s retry classification incorrectly treated
*any* structured `OperationOutcome`-carrying error as non-retryable —
including a transient 5xx that still returns a well-formed OperationOutcome
body. It now inspects the outcome's actual FHIR issue code.

**Files:**
- Create: `tools/seed/upload.ts`
- Create: `tools/seed/chunk-bundle.ts`
- Test: `tools/seed/upload.test.ts`
- Test: `tools/seed/chunk-bundle.test.ts`

**Interfaces:**
- Produces: `uploadBundle(medplum: MedplumClient, bundle: Bundle): Promise<Bundle>` (returns the response Bundle, and throws if any individual entry in a `batch`-type bundle failed — see fix below); `splitForUpload(bundle: Bundle): {identityBundle: Bundle, clinicalChunks: Bundle[]}` (no reference-rewriting step anymore — Task 6 already resolved every reference before this function ever sees the bundle); `uploadPatientBundle(medplum: MedplumClient, transformedBundle: Bundle): Promise<void>` (the orchestrator) — used by Task 9's CLI.

- [ ] **Step 1: Write the failing tests for `upload.ts`**

```typescript
// tools/seed/upload.test.ts
import { describe, expect, test, vi } from 'vitest';
import type { Bundle } from '@medplum/fhirtypes';
import { uploadBundle } from './upload';

describe('uploadBundle', () => {
  test('calls executeBatch once on success and returns the response', async () => {
    const bundle: Bundle = { resourceType: 'Bundle', type: 'transaction', entry: [] };
    const response: Bundle = { resourceType: 'Bundle', type: 'transaction-response', entry: [] };
    const executeBatch = vi.fn().mockResolvedValue(response);
    const medplum = { executeBatch } as any;

    const result = await uploadBundle(medplum, bundle);

    expect(executeBatch).toHaveBeenCalledTimes(1);
    expect(executeBatch).toHaveBeenCalledWith(bundle);
    expect(result).toBe(response);
  });

  test('retries a raw network failure (no structured outcome), then succeeds', async () => {
    const bundle: Bundle = { resourceType: 'Bundle', type: 'transaction', entry: [] };
    const executeBatch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ resourceType: 'Bundle', type: 'transaction-response', entry: [] });
    const medplum = { executeBatch } as any;

    await uploadBundle(medplum, bundle);

    expect(executeBatch).toHaveBeenCalledTimes(2);
  });

  test('retries a transient OperationOutcome (e.g. timeout), then succeeds', async () => {
    const bundle: Bundle = { resourceType: 'Bundle', type: 'transaction', entry: [] };
    const transientError = { outcome: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'timeout' }] } };
    const executeBatch = vi
      .fn()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce({ resourceType: 'Bundle', type: 'transaction-response', entry: [] });
    const medplum = { executeBatch } as any;

    await uploadBundle(medplum, bundle);

    expect(executeBatch).toHaveBeenCalledTimes(2);
  });

  test('does not retry a validation error (a real, non-transient OperationOutcome issue code)', async () => {
    const bundle: Bundle = { resourceType: 'Bundle', type: 'transaction', entry: [] };
    const validationError = { outcome: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid' }] } };
    const executeBatch = vi.fn().mockRejectedValue(validationError);
    const medplum = { executeBatch } as any;

    await expect(uploadBundle(medplum, bundle)).rejects.toBe(validationError);
    expect(executeBatch).toHaveBeenCalledTimes(1);
  });

  test('throws if any entry in a batch response failed, even though the overall HTTP call resolved — a batch response can carry per-entry failures without the request itself rejecting', async () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'batch',
      entry: [
        { resource: { resourceType: 'Condition', id: 'c1' }, request: { method: 'PUT', url: 'Condition/c1' } },
        { resource: { resourceType: 'Condition', id: 'c2' }, request: { method: 'PUT', url: 'Condition/c2' } },
      ],
    };
    const response: Bundle = {
      resourceType: 'Bundle',
      type: 'batch-response',
      entry: [
        { response: { status: '201' } },
        { response: { status: '400', outcome: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid' }] } } },
      ],
    };
    const executeBatch = vi.fn().mockResolvedValue(response);
    const medplum = { executeBatch } as any;

    await expect(uploadBundle(medplum, bundle)).rejects.toThrow(/1 failed entr/);
  });

  test('a fully successful batch response does not throw', async () => {
    const bundle: Bundle = { resourceType: 'Bundle', type: 'batch', entry: [{ resource: { resourceType: 'Condition', id: 'c1' }, request: { method: 'PUT', url: 'Condition/c1' } }] };
    const response: Bundle = { resourceType: 'Bundle', type: 'batch-response', entry: [{ response: { status: '200' } }] };
    const medplum = { executeBatch: vi.fn().mockResolvedValue(response) } as any;

    await expect(uploadBundle(medplum, bundle)).resolves.toBe(response);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tools/seed/upload.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `upload.ts`**

```typescript
// tools/seed/upload.ts
import type { MedplumClient } from '@medplum/core';
import type { Bundle } from '@medplum/fhirtypes';

const MAX_RETRIES = 3;

// FHIR IssueType codes that represent a transient, retry-worthy condition —
// NOT the presence of an OperationOutcome at all, which was the earlier bug:
// a genuine 5xx can still come back as a well-formed OperationOutcome, and
// treating "has an outcome" as "never retry" silently ate those retries.
const TRANSIENT_ISSUE_CODES = new Set(['timeout', 'transient', 'throttled', 'lock-error']);

function isTransient(err: unknown): boolean {
  if (!(err && typeof err === 'object' && 'outcome' in err)) {
    return true; // no structured outcome at all -> raw network/timeout failure
  }
  const outcome = (err as { outcome?: { issue?: { code?: string }[] } }).outcome;
  const code = outcome?.issue?.[0]?.code;
  return code !== undefined && TRANSIENT_ISSUE_CODES.has(code);
}

/**
 * A `batch`-type Bundle can resolve with HTTP 200 while individual entries
 * inside it failed (4xx/5xx) — the overall request succeeding says nothing
 * about whether every entry did. `executeBatch` resolving is not evidence
 * of success; this is. (A `transaction`-type Bundle doesn't need this
 * check — Medplum's server already makes it all-or-nothing, so a partial
 * failure there surfaces as a thrown error instead.)
 */
function assertNoFailedEntries(request: Bundle, response: Bundle): void {
  const failures: string[] = [];
  (response.entry ?? []).forEach((entry, i) => {
    const status = entry.response?.status;
    if (!status?.startsWith('2')) {
      const resourceType = request.entry?.[i]?.resource?.resourceType ?? 'unknown';
      const outcomeText = entry.response?.outcome ? ` — ${JSON.stringify(entry.response.outcome)}` : '';
      failures.push(`entry ${i} (${resourceType}): status ${status ?? '(none)'}${outcomeText}`);
    }
  });
  if (failures.length > 0) {
    throw new Error(`Batch upload had ${failures.length} failed entr${failures.length === 1 ? 'y' : 'ies'}:\n${failures.join('\n')}`);
  }
}

/**
 * Uploads one Bundle (transaction or batch). Retries transient failures
 * (raw network errors, a structured OperationOutcome whose issue code
 * indicates a transient server condition, or a batch response with failed
 * entries — safe to retry since every entry is a deterministic PUT,
 * confirmed idempotent) up to MAX_RETRIES times; a real validation error
 * is not retried — a retry can't fix a bad payload. Returns the response
 * Bundle so callers can read created-resource ids.
 */
export async function uploadBundle(medplum: MedplumClient, bundle: Bundle): Promise<Bundle> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await medplum.executeBatch(bundle);
      if (bundle.type === 'batch') {
        assertNoFailedEntries(bundle, response);
      }
      return response;
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

- [ ] **Step 5: Write the failing tests for `chunk-bundle.ts`**

```typescript
// tools/seed/chunk-bundle.test.ts
import { describe, expect, test } from 'vitest';
import type { Bundle } from '@medplum/fhirtypes';
import { splitForUpload, uploadPatientBundle } from './chunk-bundle';

// References are already resolved to plain, real form by this point
// (Task 6's transformBundle) — chunk-bundle.ts never sees a urn:uuid.
const TRANSFORMED_BUNDLE: Bundle = {
  resourceType: 'Bundle',
  type: 'transaction',
  entry: [
    { resource: { resourceType: 'Patient', id: 'patient-1' }, request: { method: 'PUT', url: 'Patient/patient-1' } },
    { resource: { resourceType: 'Organization', id: 'org-1' }, request: { method: 'PUT', url: 'Organization/org-1' } },
    { resource: { resourceType: 'Practitioner', id: 'pract-1' }, request: { method: 'PUT', url: 'Practitioner/pract-1' } },
    {
      resource: { resourceType: 'PractitionerRole', id: 'role-1', practitioner: { reference: 'Practitioner/pract-1' } },
      request: { method: 'PUT', url: 'PractitionerRole/role-1' },
    },
    {
      resource: { resourceType: 'Encounter', id: 'enc-1', subject: { reference: 'Patient/patient-1' }, serviceProvider: { reference: 'Organization/org-1' } },
      request: { method: 'PUT', url: 'Encounter/enc-1' },
    },
    {
      resource: { resourceType: 'Condition', id: 'cond-1', subject: { reference: 'Patient/patient-1' } },
      request: { method: 'PUT', url: 'Condition/cond-1' },
    },
  ],
};

describe('splitForUpload', () => {
  test('separates identity resources (including PractitionerRole) from clinical resources', () => {
    const { identityBundle, clinicalChunks } = splitForUpload(TRANSFORMED_BUNDLE);

    expect(identityBundle.type).toBe('transaction');
    // PractitionerRole must be in the identity wave — an earlier version of
    // this split silently dropped it (matched neither IDENTITY_TYPES nor
    // CLINICAL_TYPES), and a full-corpus scan found 2,484 Practitioner
    // occurrences whose corresponding generated roles would all be lost.
    expect(identityBundle.entry?.map((e) => e.resource?.resourceType)).toStrictEqual(['Patient', 'Organization', 'Practitioner', 'PractitionerRole']);
    expect(clinicalChunks).toHaveLength(1);
    expect(clinicalChunks[0].type).toBe('batch');
    expect(clinicalChunks[0].entry?.map((e) => e.resource?.resourceType)).toStrictEqual(['Encounter', 'Condition']);
  });

  test('splits clinical resources into multiple chunks once past the per-chunk cap', () => {
    const manyEntries = Array.from({ length: 650 }, (_, i) => ({
      resource: { resourceType: 'Condition' as const, id: `cond-${i}`, subject: { reference: 'Patient/patient-1' } },
      request: { method: 'PUT' as const, url: `Condition/cond-${i}` },
    }));
    const bigBundle: Bundle = { resourceType: 'Bundle', type: 'transaction', entry: [TRANSFORMED_BUNDLE.entry![0], ...manyEntries] };

    const { clinicalChunks } = splitForUpload(bigBundle);

    expect(clinicalChunks.length).toBeGreaterThan(1);
    expect(clinicalChunks.every((c) => (c.entry?.length ?? 0) <= 300)).toBe(true);
  });

  test("'full' mode's extra resource types (outside the 7-type/PractitionerRole allowlists) land in a third chunk group, not dropped", () => {
    const bundleWithExtra: Bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [...TRANSFORMED_BUNDLE.entry!, { resource: { resourceType: 'Observation', id: 'obs-1' }, request: { method: 'PUT', url: 'Observation/obs-1' } }],
    };

    const { otherChunks } = splitForUpload(bundleWithExtra);

    expect(otherChunks.length).toBeGreaterThan(0);
    expect(otherChunks[0].entry?.map((e) => e.resource?.resourceType)).toContain('Observation');
  });
});

describe('uploadPatientBundle', () => {
  test('uploads the identity bundle first, then each clinical chunk — no rewriting step, references are already resolved', async () => {
    const calls: Bundle[] = [];
    const medplum = {
      executeBatch: async (b: Bundle) => {
        calls.push(b);
        return b.type === 'transaction'
          ? ({ resourceType: 'Bundle', type: 'transaction-response', entry: (b.entry ?? []).map(() => ({ response: { status: '201' } })) } as Bundle)
          : ({ resourceType: 'Bundle', type: 'batch-response', entry: (b.entry ?? []).map(() => ({ response: { status: '201' } })) } as Bundle);
      },
    } as any;

    await uploadPatientBundle(medplum, TRANSFORMED_BUNDLE);

    expect(calls).toHaveLength(2); // one identity transaction, one clinical chunk
    expect(calls[0].type).toBe('transaction');
    expect(calls[0].entry?.map((e) => e.resource?.resourceType)).toContain('PractitionerRole');
    expect(calls[1].type).toBe('batch');
    const encounter = calls[1].entry?.find((e) => e.resource?.resourceType === 'Encounter')?.resource as any;
    expect(encounter.subject.reference).toBe('Patient/patient-1'); // already resolved, untouched
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

```bash
npx vitest run tools/seed/chunk-bundle.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 7: Implement `chunk-bundle.ts`**

```typescript
// tools/seed/chunk-bundle.ts
import type { MedplumClient } from '@medplum/core';
import type { Bundle } from '@medplum/fhirtypes';
import { uploadBundle } from './upload';

// PractitionerRole belongs here — Task 6 creates it fresh, referencing a
// Practitioner in this same wave, and it's always small in count. An
// earlier version of this split checked only Patient/Practitioner/
// Organization and silently dropped every generated PractitionerRole.
const IDENTITY_TYPES = new Set(['Patient', 'Practitioner', 'Organization', 'PractitionerRole']);
const CLINICAL_TYPES = new Set(['Encounter', 'Condition', 'MedicationRequest', 'AllergyIntolerance']);
const MAX_CHUNK_ENTRIES = 300;

export interface SplitBundles {
  identityBundle: Bundle;
  clinicalChunks: Bundle[];
  /** Any resource type outside both allowlists — only ever populated in 'full' mode. */
  otherChunks: Bundle[];
}

/**
 * Splits one patient's transformed bundle into an identity wave (small,
 * uploaded as a single transaction), clinical chunks (Encounter/Condition/
 * MedicationRequest/AllergyIntolerance), and — in 'full' mode only — an
 * "other" bucket for every resource type outside both allowlists (e.g.
 * Observation, Claim), so 'full' mode actually keeps everything Task 6
 * decided to keep, instead of silently re-dropping it here. No reference
 * rewriting happens in this function — Task 6's transformBundle already
 * resolved every reference to its final, real form before this function
 * ever sees the bundle. The referenced ids are guaranteed because every
 * entry is an unconditional deterministic PUT, not a POST create whose id
 * Medplum would replace. Chunking exists purely because a single patient's full
 * transaction can exceed Medplum's default 1MB JSON body limit (largest
 * observed slim bundle: 2.42MB, measured directly against the real
 * corpus) — this avoids depending on a non-default server config that
 * isn't available on every hosting option.
 */
export function splitForUpload(bundle: Bundle): SplitBundles {
  const identityEntries = (bundle.entry ?? []).filter((e) => e.resource?.resourceType && IDENTITY_TYPES.has(e.resource.resourceType));
  const clinicalEntries = (bundle.entry ?? []).filter((e) => e.resource?.resourceType && CLINICAL_TYPES.has(e.resource.resourceType));
  const otherEntries = (bundle.entry ?? []).filter(
    (e) => e.resource?.resourceType && !IDENTITY_TYPES.has(e.resource.resourceType) && !CLINICAL_TYPES.has(e.resource.resourceType)
  );

  const identityBundle: Bundle = { resourceType: 'Bundle', type: 'transaction', entry: identityEntries };

  function chunk(entries: typeof clinicalEntries): Bundle[] {
    const chunks: Bundle[] = [];
    for (let i = 0; i < entries.length; i += MAX_CHUNK_ENTRIES) {
      chunks.push({ resourceType: 'Bundle', type: 'batch', entry: entries.slice(i, i + MAX_CHUNK_ENTRIES) });
    }
    return chunks;
  }

  return { identityBundle, clinicalChunks: chunk(clinicalEntries), otherChunks: chunk(otherEntries) };
}

/**
 * Full per-patient upload orchestration: identity transaction first, then
 * each clinical chunk, then each "other" chunk (empty in 'slim' mode).
 * This is what Task 9's CLI calls per bundle file — callers never call
 * uploadBundle directly for a whole transformed patient bundle.
 */
export async function uploadPatientBundle(medplum: MedplumClient, transformedBundle: Bundle): Promise<void> {
  const { identityBundle, clinicalChunks, otherChunks } = splitForUpload(transformedBundle);
  await uploadBundle(medplum, identityBundle);
  for (const chunk of [...clinicalChunks, ...otherChunks]) {
    if (chunk.entry?.length) {
      await uploadBundle(medplum, chunk);
    }
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

```bash
npx vitest run tools/seed/chunk-bundle.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add tools/seed/upload.ts tools/seed/upload.test.ts tools/seed/chunk-bundle.ts tools/seed/chunk-bundle.test.ts
git commit -m "fix(seed): chunk uploads under the 1MB limit, detect batch entry failures, keep PractitionerRole, don't drop full-mode's extra types"
```

---

### Task 8: `data/core/agent-config.json` — bootstrap bundle (HealthcareServices, Device, CodeSystem/ValueSet)

A correction pass found a deeper identity problem than the original
`ifNoneExist` mismatch: Medplum replaces caller-supplied ids for every POST
create in a Bundle. That means the Bots' fixed reference to
`Device/ai-appointment-agent` and the Scheduling code's fixed
HealthcareService references would be broken even on the first upload.
Every bootstrap entry therefore uses an unconditional deterministic PUT to
its declared id. The identifiers remain useful for audit/search, but they
are not the identity mechanism.

**Files:**
- Create: `data/core/agent-config.json`
- Test: `tools/seed/agent-config.test.ts` (validates the JSON's shape, not a live upload)

**Interfaces:**
- Produces: a `Bundle` (type `transaction`) deterministically upserting `HealthcareService/office-visit`, `HealthcareService/urgent-visit`, `Device/ai-appointment-agent`, and a small `CodeSystem`/`ValueSet` pair for `ai-previsit-summary`/`ai-chat` — uploaded via Task 9's CLI bootstrap step, or manually via the fork's existing `UploadDataPage`.

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

  test('upserts both HealthcareServices at their fixed ids', () => {
    const officeVisit = bundle.entry.find((e: any) => e.resource?.id === 'office-visit');
    const urgentVisit = bundle.entry.find((e: any) => e.resource?.id === 'urgent-visit');
    expect(officeVisit.resource.resourceType).toBe('HealthcareService');
    expect(urgentVisit.resource.resourceType).toBe('HealthcareService');
    expect(officeVisit.request).toStrictEqual({ method: 'PUT', url: 'HealthcareService/office-visit' });
    expect(urgentVisit.request).toStrictEqual({ method: 'PUT', url: 'HealthcareService/urgent-visit' });
    expect(officeVisit.resource.identifier).toContainEqual({ system: 'http://example.com/agent-config', value: 'office-visit' });
    expect(urgentVisit.resource.identifier).toContainEqual({ system: 'http://example.com/agent-config', value: 'urgent-visit' });
  });

  test('creates the ai-appointment-agent Device', () => {
    const device = bundle.entry.find((e: any) => e.resource?.resourceType === 'Device');
    expect(device.resource.id).toBe('ai-appointment-agent');
    expect(device.request).toStrictEqual({ method: 'PUT', url: 'Device/ai-appointment-agent' });
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
        "identifier": [{ "system": "http://example.com/agent-config", "value": "office-visit" }],
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
      "request": { "method": "PUT", "url": "HealthcareService/office-visit" }
    },
    {
      "fullUrl": "urn:uuid:00000000-0000-0000-0000-000000000002",
      "resource": {
        "resourceType": "HealthcareService",
        "id": "urgent-visit",
        "identifier": [{ "system": "http://example.com/agent-config", "value": "urgent-visit" }],
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
      "request": { "method": "PUT", "url": "HealthcareService/urgent-visit" }
    },
    {
      "fullUrl": "urn:uuid:00000000-0000-0000-0000-000000000003",
      "resource": {
        "resourceType": "Device",
        "id": "ai-appointment-agent",
        "deviceName": [{ "name": "AI Appointment Agent", "type": "user-friendly-name" }],
        "identifier": [{ "system": "http://example.com/agent-config", "value": "ai-appointment-agent" }]
      },
      "request": { "method": "PUT", "url": "Device/ai-appointment-agent" }
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
      "request": { "method": "PUT", "url": "CodeSystem/agent-communication-category" }
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
      "request": { "method": "PUT", "url": "ValueSet/agent-communication-category" }
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
git commit -m "feat(seed): deterministically upsert HealthcareServices, Device, and category vocabulary"
```

---

### Task 9: `tools/seed/index.ts` — CLI entry point

A correction pass fixed three bugs here: `mode` was computed by
`parseCliArgs` and never actually passed to `transformBundle` (so
`--slim`/`--full` had no effect at all); per-patient uploads called
`uploadBundle` directly on the whole transformed bundle instead of Task 7's
new `uploadPatientBundle` (which is what actually keeps each upload under
the size limit); and `require.main === module` — a CJS-only idiom with no
reliable ESM equivalent — is replaced with the standard ESM "was this
module run directly" check. A simple upload manifest is also added so an
interrupted run can resume without re-uploading files it already finished
(on top of, not instead of, Task 6's deterministic PUT upserts — useful
for resuming an interrupted large run without re-uploading completed files).

**Files:**
- Create: `tools/seed/index.ts`
- Test: `tools/seed/index.test.ts` (tests argument parsing only — the full pipeline is exercised live in Task 10)

**Interfaces:**
- Consumes: `parseDiseaseDescriptions`, `scanPractitionerSpecialties`, `transformBundle` (Tasks 3–6), `uploadBundle`/`uploadPatientBundle` (Task 7).
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
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { Bundle } from '@medplum/fhirtypes';
import 'dotenv/config';
import { scanPractitionerSpecialties } from './pass1-scan';
import { transformBundle } from './pass2-transform';
import { uploadBundle } from './upload';
import { uploadPatientBundle } from './chunk-bundle';

// ESM has no __dirname; this is the standard replacement.
const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(__dirname, '../../.seed-manifest.json');

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

/** Filenames already successfully uploaded in a prior run — lets a resumed run skip them. */
function loadManifest(): Set<string> {
  if (!existsSync(MANIFEST_PATH)) return new Set();
  return new Set(JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as string[]);
}

function saveManifest(uploadedFileNames: Set<string>): void {
  writeFileSync(MANIFEST_PATH, JSON.stringify([...uploadedFileNames], null, 2));
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

  // Validate, don't cast — a missing credential silently became the
  // literal string "undefined" in an earlier version of this function,
  // producing a confusing auth failure instead of a clear configuration error.
  const { MEDPLUM_BASE_URL, MEDPLUM_CLIENT_ID, MEDPLUM_CLIENT_SECRET } = process.env;
  if (!MEDPLUM_BASE_URL || !MEDPLUM_CLIENT_ID || !MEDPLUM_CLIENT_SECRET) {
    throw new Error('Missing required environment variables: MEDPLUM_BASE_URL, MEDPLUM_CLIENT_ID, MEDPLUM_CLIENT_SECRET (see .env)');
  }

  const medplum = new MedplumClient({ baseUrl: MEDPLUM_BASE_URL });
  await medplum.startClientLogin(MEDPLUM_CLIENT_ID, MEDPLUM_CLIENT_SECRET);

  console.log('Uploading bootstrap config (HealthcareServices, Device, CodeSystem)...');
  const bootstrapBundle = JSON.parse(readFileSync(join(__dirname, '../../data/core/agent-config.json'), 'utf-8')) as Bundle;
  await uploadBundle(medplum, bootstrapBundle);

  const alreadyUploaded = loadManifest();
  console.log(`Uploading ${files.length} transformed bundles (${alreadyUploaded.size} already done per manifest)...`);
  let uploaded = 0;
  for (const filePath of files) {
    if (alreadyUploaded.has(filePath)) {
      continue;
    }
    const bundle = JSON.parse(readFileSync(filePath, 'utf-8')) as Bundle;
    const transformed = transformBundle(bundle, specialtiesByStableId, args.mode);
    await uploadPatientBundle(medplum, transformed);
    alreadyUploaded.add(filePath);
    uploaded++;
    if (uploaded % 50 === 0) {
      console.log(`  ${uploaded}/${files.length - (alreadyUploaded.size - uploaded)}`);
      saveManifest(alreadyUploaded); // checkpoint periodically, not just at the end
    }
  }
  saveManifest(alreadyUploaded);
  console.log(`Done. Uploaded ${uploaded} bundles this run (${alreadyUploaded.size} total per manifest).`);
}

// ESM-safe "was this module run directly" check. A correction pass found
// the original version of this check (`import.meta.url ===
// \`file://${process.argv[1]}\``) is silently false on Windows: argv[1] is
// a raw path with backslashes (D:\...\index.ts), while import.meta.url is
// a proper URL with forward slashes and percent-encoding
// (file:///D:/...%20.../index.ts) — the two never match, so main() never
// ran on this workspace. pathToFileURL() normalizes argv[1] into the same
// URL form import.meta.url already uses, on every platform.
const isMainModule = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

`uploadBundle` (from `./upload`) is used only for the single small bootstrap bundle; every per-patient file goes through `uploadPatientBundle` (from `./chunk-bundle`), which internally calls `uploadBundle` per identity/clinical-chunk piece.

- [ ] **Step 3a: Add `.seed-manifest.json` to `.gitignore`**

Append `.seed-manifest.json` to the root `.gitignore` — it's per-machine upload progress (which files have already been uploaded to whichever target project), not something to commit.

- [ ] **Step 3b: Extend `tsconfig.json`'s `include` to cover `tools/`**

The inherited `tsconfig.json` (from the fork) has `"include": ["src"]` — confirmed directly. Every `npx tsc --noEmit` check earlier in this plan (Task 2's Step 6) only ever typechecked `src/`; `tools/seed/**` — everything built in this phase — has never actually been typechecked by that gate. Update `tsconfig.json`:

```json
{
  "include": ["src", "tools"]
}
```

(Merge into the existing config — don't replace unrelated fields like `compilerOptions`.) Run `npx tsc --noEmit` once now and fix any type errors it surfaces in `tools/seed/` — this is the first time these files have actually been checked.

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
git add tools/seed/index.ts tools/seed/index.test.ts package.json package-lock.json .gitignore
git commit -m "fix(seed): CLI entry point — Windows-safe main-module check, validate credentials, typecheck tools/"
```

---

### Task 10: Run the seeding tool against the real target Medplum project (manual verification)

**Use a disposable/test Medplum project for this task, not the final target project.** This `--limit 50` smoke test computes practitioner specialties from a majority vote over only 50 bundles, so its results are intentionally incomplete even though deterministic PUT would let a later full run correct them. Keeping smoke-test and final datasets separate makes verification unambiguous. Point `.env` at a throwaway project here; point it at the real target only for Task 36.

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

- [ ] **Step 2: Run the target version and deterministic-id preflight**

Use an authenticated `MedplumClient` scratch script to:

1. Print `GET /fhir/R4/metadata`'s `software.version` and record it with the run. The application packages must remain exactly `5.1.27`; a hosted server may report a different patch only if all behavioral probes pass.
2. Unconditionally update-as-create a disposable `Patient/seed-contract-probe` with `medplum.updateResource`, read it back, and assert its id is exactly `seed-contract-probe`.
3. Update the same Patient again and assert the search/read result is still one resource, proving retry-safe deterministic PUT semantics.
4. Delete only that explicitly named disposable probe after the assertions.

Stop before uploading real seed data if any assertion fails. This directly
tests the identity property on which every reference in Tasks 6–9 depends;
package metadata alone is not sufficient evidence.

- [ ] **Step 3: Dry run first**

```bash
npx tsx tools/seed/index.ts --dry-run --limit 50
```

Expected: prints a specialty histogram with a real spread across multiple specialties (not >90% "General Practice" — that would indicate `ENCOUNTER_TYPE_SPECIALTY_MAP` from Task 4 needs more work). No writes happen.

- [ ] **Step 4: Real run at small scale**

```bash
npx tsx tools/seed/index.ts --limit 50
```

Expected: completes without throwing; prints `Done. Uploaded 50 bundles.`

- [ ] **Step 5: Verify no duplicate Practitioners**

In the Medplum app (or via a direct `medplum.searchResources` call in a scratch script), pick any NPI from the uploaded data and confirm:

```
GET /fhir/R4/Practitioner?identifier=https://synthea.mitre.org/identifier|<stable-id>
```

returns exactly one result, and a corresponding `PractitionerRole?practitioner=Practitioner/<id>` returns exactly one `PractitionerRole` with a NUCC-coded `specialty`.

- [ ] **Step 6: Verify the bootstrap config landed at its exact ids**

```
GET /fhir/R4/HealthcareService?name=Office Visit
GET /fhir/R4/HealthcareService?name=Urgent Visit
GET /fhir/R4/Device?identifier=http://example.com/agent-config|ai-appointment-agent
```

Expected: each returns exactly one resource.

Also read `HealthcareService/office-visit`,
`HealthcareService/urgent-visit`, and `Device/ai-appointment-agent`
directly. Each read must succeed at that exact id; a name/identifier search
alone would not prove that fixed references used elsewhere can resolve.

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
  // These three were absent from an earlier version of this table even
  // though the retired Python specialty_mapping.py — the source this
  // whole vocabulary is meant to match — uses them. Added during a
  // correction pass so the previous-physician pool can't be seeded with a
  // specialty this table has no NUCC code for.
  { label: 'Allergy and Immunology', nuccCode: '207K00000X', nuccDisplay: 'Allergy & Immunology Physician', nppesTaxonomyDescription: 'Allergy & Immunology' },
  { label: 'General Surgery', nuccCode: '208600000X', nuccDisplay: 'Surgery Physician', nppesTaxonomyDescription: 'General Surgery' },
  { label: 'Vascular Surgery', nuccCode: '2086S0129X', nuccDisplay: 'Surgery, Vascular Surgery Physician', nppesTaxonomyDescription: 'Vascular Surgery' },
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

A correction pass found a real bug confirmed against the corpus itself:
**all 983 seeded patients store `address.state` as the full name
`"Massachusetts"`, never the 2-letter code `"MA"`** — and NPPES's public
API requires a 2-letter state code. Passing the patient's raw state value
straight through (an earlier version of `agent-find-doctors.ts`, Task 18)
would make every NPPES search silently fail to match anything for every
seeded patient. Fixed by normalizing full state names to their postal
codes inside `searchNppesDoctors` itself, so every caller benefits without
needing to know about this. Also added: a fallback when an exact
city+state search returns zero results, retrying with state alone —
otherwise a real but sparse metro area could show "no doctors found" even
when NPPES has matching providers elsewhere in the state.

**Files:**
- Create: `src/bots/agent/lib/nppes.ts`
- Test: `src/bots/agent/lib/nppes.test.ts`

**Interfaces:**
- Produces: `searchNppesDoctors(taxonomyDescription, city, state, limit?): Promise<DoctorCandidate[]>` (accepts either a 2-letter code or a full US state name — normalizes internally), `getNppesDoctorByNpi(npi): Promise<DoctorCandidate | undefined>` — consumed by `agent-find-doctors.ts` (Task 18) and `ensurePractitionerAndSchedule.ts` (Task 19).

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

  test('normalizes a full state name to its 2-letter code — every seeded patient stores the full name, and NPPES requires the code', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [SAMPLE_RESULT] }) });
    vi.stubGlobal('fetch', fetchMock);

    await searchNppesDoctors('Cardiovascular Disease', 'Boston', 'Massachusetts');

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('state=MA'));
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('Massachusetts'));
  });

  test('falls back to a state-only search when an exact city+state search returns zero results', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [SAMPLE_RESULT] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchNppesDoctors('Cardiovascular Disease', 'Nowheresville', 'MA');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('city=Nowheresville');
    expect(fetchMock.mock.calls[1][0]).not.toContain('city=');
    expect(result).toHaveLength(1);
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

// Full US state/territory name -> 2-letter postal code, the format NPPES
// requires. Every seeded patient's address.state is the full name (e.g.
// "Massachusetts") — confirmed directly against the real corpus — so this
// normalization runs unconditionally; a value already in 2-letter form
// passes through the lookup miss and is used as-is (see normalizeState).
const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC',
};

function normalizeState(state: string): string {
  if (state.length === 2) return state.toUpperCase();
  return STATE_NAME_TO_CODE[state.toLowerCase().trim()] ?? state;
}

async function nppesFetch(taxonomyDescription: string, city: string | undefined, state: string, limit: number): Promise<NppesResult[]> {
  const params = new URLSearchParams({
    version: '2.1',
    enumeration_type: 'NPI-1',
    taxonomy_description: taxonomyDescription,
    state,
    limit: String(limit),
  });
  if (city) params.set('city', city);
  const response = await fetch(`${NPPES_BASE_URL}?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`NPPES search failed: ${response.status}`);
  }
  const body = (await response.json()) as { results: NppesResult[] };
  return body.results;
}

/**
 * Searches NPPES's public registry for active doctors matching a taxonomy
 * description and location. `state` may be a 2-letter code or a full US
 * state name (normalized automatically — every seeded patient stores the
 * full name, and NPPES requires the code). Falls back to a state-only
 * search if an exact city+state search returns nothing, rather than
 * reporting "no doctors found" when NPPES actually has matches elsewhere
 * in the state. Network/5xx failures propagate to the caller (bot-level
 * failure) — never swallowed.
 */
export async function searchNppesDoctors(
  taxonomyDescription: string,
  city: string,
  state: string,
  limit = 20
): Promise<DoctorCandidate[]> {
  const normalizedState = normalizeState(state);
  let results = await nppesFetch(taxonomyDescription, city, normalizedState, limit);
  if (results.length === 0 && city) {
    results = await nppesFetch(taxonomyDescription, undefined, normalizedState, limit);
  }
  return results.map(mapResult);
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
git commit -m "fix(lib): NPPES client — normalize full state names, fall back on empty city search"
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

The preparation `Communication` is the server-side source of truth for the
later booking. It stores the normalized specialty, booking reason, original
complaint, urgency, and generated summary. The browser receives the id for
navigation, but Task 21 re-reads and validates this resource instead of
trusting clinical metadata echoed back by the browser.

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
    expect(communication.reasonCode).toStrictEqual([{ text: 'Chest discomfort during exercise' }]);
    expect(communication.note).toStrictEqual([{ text: 'My chest hurts when I run' }]);
    expect(communication.topic?.coding).toContainEqual({
      system: 'http://nucc.org/provider-taxonomy',
      code: '207RC0000X',
      display: 'Cardiology',
    });
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
    reasonCode: [{ text: geminiResult.reason }],
    note: [{ text: complaintText }],
    topic: {
      coding: [{ system: 'http://nucc.org/provider-taxonomy', code: specialty.nuccCode, display: specialty.label }],
    },
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

The most structurally sensitive piece in the plan — gets the `SchedulingParameters` extension shape and the two-HealthcareService `serviceType` array wrong here and every doctor silently has zero bookable time (Data Model doc's explicit warning). A correction pass confirmed exactly that failure mode against real source: a `SchedulingParameters` extension is matched to a specific HealthcareService request via a nested `service` sub-extension (`valueReference` pointing at that `HealthcareService`) — an extension with no `service` sub-extension matches nothing and is silently skipped (Medplum falls back to HealthcareService-level defaults instead of throwing), so an earlier version of this function's single, service-less extension would never actually apply. The fix: **one `SchedulingParameters` extension per HealthcareService**, each carrying its own `service` reference and `duration` (30 min for Office Visit, 15 for Urgent Visit), both sharing the same NPI-seeded weekly template and timezone.

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

    // Two separate SchedulingParameters extensions — one per HealthcareService,
    // each with its own `service` sub-extension. A single service-less
    // extension (an earlier version of this function) is silently ignored
    // by Medplum's actual matching logic — this is what makes it apply at all.
    const schedulingParamsExtensions = (schedule.extension ?? []).filter(
      (e: any) => e.url === 'https://medplum.com/fhir/StructureDefinition/SchedulingParameters'
    );
    expect(schedulingParamsExtensions).toHaveLength(2);

    const officeVisitParams = schedulingParamsExtensions.find((e: any) =>
      e.extension?.some((sub: any) => sub.url === 'service' && sub.valueReference?.reference === 'HealthcareService/office-visit')
    );
    expect(officeVisitParams).toBeDefined();
    expect(officeVisitParams?.extension?.find((e: any) => e.url === 'duration')?.valueDuration?.value).toBe(30);
    expect(officeVisitParams?.extension?.find((e: any) => e.url === 'alignmentInterval')?.valueDuration?.value).toBe(30);
    expect(officeVisitParams?.extension?.find((e: any) => e.url === 'timezone')?.valueCode).toBe('America/New_York');

    const urgentVisitParams = schedulingParamsExtensions.find((e: any) =>
      e.extension?.some((sub: any) => sub.url === 'service' && sub.valueReference?.reference === 'HealthcareService/urgent-visit')
    );
    expect(urgentVisitParams).toBeDefined();
    expect(urgentVisitParams?.extension?.find((e: any) => e.url === 'duration')?.valueDuration?.value).toBe(15);

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

/**
 * Builds ONE SchedulingParameters extension scoped to a single
 * HealthcareService via its `service` sub-extension — confirmed directly
 * against Medplum's matching logic (scheduling-parameters.ts): a Schedule
 * extension with no `service` sub-extension never matches any requested
 * HealthcareService and is silently skipped. The caller builds one of
 * these per HealthcareService (see ensurePractitionerAndSchedule below) —
 * never a single shared one.
 */
function buildSchedulingParametersExtension(
  template: WeeklyTemplate,
  timezone: string,
  healthcareServiceId: string,
  durationMinutes: number
): Extension {
  return {
    url: SCHEDULING_PARAMETERS_URL,
    extension: [
      { url: 'service', valueReference: { reference: `HealthcareService/${healthcareServiceId}` } },
      { url: 'duration', valueDuration: { value: durationMinutes, unit: 'min', system: 'http://unitsofmeasure.org', code: 'min' } },
      // Confirmed default is 60 minutes if unset (SERVICE_DEFAULTS in
      // scheduling-parameters.ts) — $find steps candidate start times by
      // this interval, independent of duration, so leaving it unset would
      // silently offer only one start time per hour (hiding 3 of 4 real
      // 15-minute slots, half of every 30-minute slot). Set explicitly to
      // match this service's own duration so every real opening is offered.
      { url: 'alignmentInterval', valueDuration: { value: durationMinutes, unit: 'min', system: 'http://unitsofmeasure.org', code: 'min' } },
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
      // TWO SchedulingParameters extensions, not one — see the function's
      // doc comment. Multiple extensions sharing the same url is valid
      // FHIR and exactly what Medplum's own matching logic expects here
      // (it explicitly handles "more than one match" as an error case,
      // implying more than one extension present-but-non-matching is normal).
      extension: [
        buildSchedulingParametersExtension(template, timezone, healthcareServiceIds.routine, 30),
        buildSchedulingParametersExtension(template, timezone, healthcareServiceIds.urgent, 15),
      ],
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

A correction pass rewrote this bot's booking mechanism after checking
Medplum's real scheduling contracts against source. A second pass closes a
trust-boundary bug: the browser no longer submits a mutable Appointment or
clinical metadata and asks the Bot to trust it. The browser sends only
identifiers and the selected time. The Bot reads the authoritative FHIR
resources, re-runs `$find`, selects the matching server proposal, validates
it, and only then calls `$book`.

1. **`$hold`→`$confirm` replaced with a single `$book` call**, applied to
   the exact proposed `Appointment` object from a fresh, Bot-side `$find`
   response (never reconstructed or accepted from the browser).
   `$book` is `POST /fhir/R4/Appointment/$book`, and its **request** body
   is a `Parameters` resource wrapping an `appointment` parameter.
2. **The proposed Appointment must already have a `contained` Slot** or
   `$book` throws `'Appointment has no contained Slot resources'` —
   confirmed in Medplum's `scheduling.ts`. This is why the Bot re-runs
   `$find` and uses its exact result rather than building one from times.
3. **The `$book` *response* is a bare `Bundle`, not a `Parameters`
   envelope** — a correction to the correction. Confirmed directly in
   `buildOutputParameters` (`packages/server/src/fhir/operations/utils/parameters.ts`):
   when an operation declares exactly one `out` parameter named `return`
   (both `find` and `book` do), the function bypasses the `Parameters`
   wrapper entirely and sends the resource — here, the `Bundle` — directly
   as the HTTP response body. The official Medplum example client code
   (`packages/examples/src/scheduling/book.ts`) confirms this by treating
   both `$find` and `$book` responses as bare Bundles with no unwrapping
   step. (Medplum's own `appointment-find.md` doc is stale and describes
   the wrong, `Parameters`-wrapped shape — it disagrees with the server's
   actual source and with the sibling `appointment-book.md` doc, which
   documents the correct bare-Bundle shape. Don't trust that one page.)
   An earlier pass of this fix mistakenly unwrapped a `Parameters.return`
   that the real response never has.
4. **`$find`'s output never includes a Patient participant** — confirmed
   directly in `find.ts`: the proposed Appointment's `participant` array is
   built purely from `Schedule.actor` (the Practitioner). Passing that
   object straight to `$book` would create an Appointment with no Patient
   participant at all — breaking the confirmation page, the doctor queue
   (Task 34 filters out any Appointment without a `Patient/` participant),
   and the chat relationship check (Task 22). The bot now adds the Patient
   participant itself before booking.
5. **Appointment metadata is included before `$book`.** Reason, complaint,
   and priority are derived from the trusted Communication and added to the
   proposal that `$book` persists. This avoids a second non-atomic
   Appointment write. If the remaining post-book Communication link fails,
   it is logged rather than falsely reporting that the booking failed.
6. **The Communication update reads-and-spreads the existing resource**
   instead of constructing a bare object with only 5 fields.
   `medplum.updateResource()` is a full replacement (FHIR `PUT` semantics),
   not a patch — a bare-object update would have silently wiped the
   summary's `category`, `subject`, `sender`, `payload` (the actual summary
   text), and `meta.tag` the moment a booking completed.
7. **All clinical fields are server-derived.** The Bot validates that the
   preparation Communication belongs to the Patient and was created by the
   intake flow, derives urgency/service/reason/complaint from it, validates
   that the Schedule belongs to the requested Practitioner and service,
   and rejects a `$find` proposal with unexpected participants or Slot data.

**Files:**
- Create: `src/bots/agent/agent-book-appointment.ts`
- Test: `src/bots/agent/agent-book-appointment.test.ts`

**Interfaces:**
- Consumes: `BookInput = {patientId: string; practitionerId: string; scheduleId: string; start: string; end: string; summaryCommunicationId: string}`. These are lookup/selection values, not trusted clinical content.
- Produces: `handler(medplum, event: BotEvent<BookInput>): Promise<{ok: true; appointment: Appointment} | {ok: false; reason: 'slot_taken'}>`.

This test exercises **our** authoritative reads, fresh `$find`,
request-building, response extraction, and slot-taken detection logic
against controlled stubs — it is
not a re-implementation of Medplum's real scheduling operations (those are
exercised live in Task 26's deploy-and-verify step).

- [ ] **Step 1: Write the failing test**

```typescript
// src/bots/agent/agent-book-appointment.test.ts
import { describe, expect, test, vi } from 'vitest';
import { MockClient } from '@medplum/mock';
import { handler } from './agent-book-appointment';
import type { Appointment } from '@medplum/fhirtypes';

const PROPOSED_APPOINTMENT: Appointment = {
  resourceType: 'Appointment',
  status: 'proposed',
  start: '2026-09-01T09:00:00Z',
  end: '2026-09-01T09:30:00Z',
  serviceType: [{ extension: [{ url: 'https://medplum.com/fhir/service-type-reference', valueReference: { reference: 'HealthcareService/office-visit' } }] }],
  participant: [
    { actor: { reference: 'Practitioner/practitioner-1' }, status: 'accepted' },
  ],
  contained: [{ resourceType: 'Slot', status: 'busy', start: '2026-09-01T09:00:00Z', end: '2026-09-01T09:30:00Z', schedule: { reference: 'Schedule/schedule-1' } }],
};

const BASE_INPUT = {
  patientId: 'patient-1',
  practitionerId: 'practitioner-1',
  scheduleId: 'schedule-1',
  start: '2026-09-01T09:00:00Z',
  end: '2026-09-01T09:30:00Z',
  summaryCommunicationId: 'summary-1',
};

describe('agent-book-appointment handler', () => {
  test('re-reads trusted resources, re-runs $find, then books its exact proposal', async () => {
    const medplum = new MockClient();
    const patient = await medplum.updateResource({ resourceType: 'Patient', id: 'patient-1' });
    await medplum.updateResource({ resourceType: 'Practitioner', id: 'practitioner-1' });
    await medplum.createResource({
      resourceType: 'PractitionerRole',
      practitioner: { reference: 'Practitioner/practitioner-1' },
      specialty: [{ coding: [{ system: 'http://nucc.org/provider-taxonomy', code: '207RC0000X' }] }],
    });
    await medplum.updateResource({ resourceType: 'HealthcareService', id: 'office-visit', active: true });
    await medplum.updateResource({
      resourceType: 'Schedule',
      id: 'schedule-1',
      active: true,
      actor: [{ reference: 'Practitioner/practitioner-1' }],
      serviceType: [{ extension: [{ url: 'https://medplum.com/fhir/service-type-reference', valueReference: { reference: 'HealthcareService/office-visit' } }] }],
    });
    const communication = await medplum.createResource({
      resourceType: 'Communication',
      status: 'preparation',
      category: [{ coding: [{ system: 'http://example.com/agent-communication-category', code: 'ai-previsit-summary' }] }],
      priority: 'routine',
      reasonCode: [{ text: 'Chest discomfort during exercise' }],
      note: [{ text: 'My chest hurts when I run' }],
      topic: { coding: [{ system: 'http://nucc.org/provider-taxonomy', code: '207RC0000X' }] },
      subject: { reference: `Patient/${patient.id}` },
      sender: { reference: 'Device/ai-appointment-agent' },
      payload: [{ contentString: 'This patient reports exertional chest discomfort.' }],
      meta: { tag: [{ code: 'ai-generated' }] },
    });

    const bookedAppointment: Appointment = {
      ...PROPOSED_APPOINTMENT,
      id: 'appt-1',
      status: 'booked',
      contained: undefined,
      slot: [{ reference: 'Slot/slot-1' }],
      description: 'Chest discomfort during exercise',
      comment: 'My chest hurts when I run',
      reasonCode: [{ text: 'Chest discomfort during exercise' }],
      priority: 5,
    };
    // $book's real response is a BARE Bundle — no Parameters envelope.
    const bookResponseBundle = {
      resourceType: 'Bundle',
      type: 'transaction-response',
      entry: [{ resource: bookedAppointment }, { resource: { resourceType: 'Slot', id: 'slot-1', status: 'busy' } }],
    };
    let capturedRequest: any;
    const originalGet = medplum.get.bind(medplum);
    const getSpy = vi.spyOn(medplum, 'get').mockImplementation(async (url: string | URL, options?: any) => {
      if (url.toString().includes('/fhir/R4/Appointment/$find')) {
        return { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: PROPOSED_APPOINTMENT }] } as any;
      }
      return originalGet(url as any, options);
    });
    vi.spyOn(medplum, 'post').mockImplementation(async (url: string | URL, body: any) => {
      if (url.toString() === medplum.fhirUrl('Appointment', '$book').toString()) {
        capturedRequest = body;
        return bookResponseBundle as any;
      }
      throw new Error(`unexpected post to ${url}`);
    });

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { ...BASE_INPUT, patientId: patient.id as string, summaryCommunicationId: communication.id as string },
      contentType: 'application/json',
      secrets: {},
    });

    expect(getSpy.mock.calls.some(([url]) => url.toString().includes('/fhir/R4/Appointment/$find'))).toBe(true);
    // The request is a Parameters resource wrapping the newly fetched
    // proposal, with the Patient participant added server-side.
    expect(capturedRequest.resourceType).toBe('Parameters');
    expect(capturedRequest.parameter[0].name).toBe('appointment');
    expect(capturedRequest.parameter[0].resource.contained).toBeDefined();
    expect(capturedRequest.parameter[0].resource.participant).toContainEqual({
      actor: { reference: `Patient/${patient.id}` },
      status: 'accepted',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.appointment.status).toBe('booked');
    expect(result.appointment.description).toBe('Chest discomfort during exercise');
    expect(result.appointment.comment).toBe('My chest hurts when I run');

    const updatedCommunication = await medplum.readResource('Communication', communication.id as string);
    // The fields agent-book-appointment is responsible for changed...
    expect(updatedCommunication.status).toBe('completed');
    expect(updatedCommunication.recipient?.[0].reference).toBe('Practitioner/practitioner-1');
    // ...but everything else survived the update, unlike a bare-object
    // PATCH that would have wiped these.
    expect(updatedCommunication.payload?.[0].contentString).toBe('This patient reports exertional chest discomfort.');
    expect(updatedCommunication.sender).toStrictEqual({ reference: 'Device/ai-appointment-agent' });
    expect(updatedCommunication.category?.[0].coding?.[0].code).toBe('ai-previsit-summary');
    expect(updatedCommunication.meta?.tag).toContainEqual({ code: 'ai-generated' });
  });

  test('rejects a summary that belongs to another Patient before $find or $book', async () => {
    const medplum = new MockClient();
    await medplum.updateResource({ resourceType: 'Patient', id: 'patient-1' });
    await medplum.updateResource({ resourceType: 'Practitioner', id: 'practitioner-1' });
    await medplum.updateResource({
      resourceType: 'Schedule',
      id: 'schedule-1',
      active: true,
      actor: [{ reference: 'Practitioner/practitioner-1' }],
    });
    await medplum.updateResource({
      resourceType: 'Communication',
      id: 'summary-1',
      status: 'preparation',
      subject: { reference: 'Patient/another-patient' },
      sender: { reference: 'Device/ai-appointment-agent' },
    });
    const getSpy = vi.spyOn(medplum, 'get');
    const postSpy = vi.spyOn(medplum, 'post');

    await expect(
      handler(medplum, { bot: { reference: 'Bot/123' }, input: BASE_INPUT, contentType: 'application/json', secrets: {} })
    ).rejects.toThrow(/not an authoritative preparation summary/);
    expect(getSpy.mock.calls.some(([url]) => url.toString().includes('/fhir/R4/Appointment/$find'))).toBe(false);
    expect(postSpy).not.toHaveBeenCalled();
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
import type { Appointment, Bundle, Communication, HealthcareService, Patient, Practitioner, Schedule, Slot } from '@medplum/fhirtypes';

export type BookInput = {
  patientId: string;
  practitionerId: string;
  scheduleId: string;
  start: string;
  end: string;
  summaryCommunicationId: string;
};
export type BookResult = { ok: true; appointment: Appointment } | { ok: false; reason: 'slot_taken' };

const SLOT_TAKEN_MESSAGE = 'Requested time slot is not available';

function urgencyToPriority(urgency: 'routine' | 'urgent'): number {
  return urgency === 'urgent' ? 1 : 5;
}

function hasCategory(communication: Communication, code: string): boolean {
  return communication.category?.some((category) =>
    category.coding?.some((coding) => coding.system === 'http://example.com/agent-communication-category' && coding.code === code)
  ) === true;
}

function hasService(schedule: Schedule, serviceId: string): boolean {
  return schedule.serviceType?.some((serviceType) =>
    serviceType.extension?.some(
      (extension) =>
        extension.url === 'https://medplum.com/fhir/service-type-reference' &&
        extension.valueReference?.reference === `HealthcareService/${serviceId}`
    )
  ) === true;
}

function validateProposal(appointment: Appointment, practitionerId: string, scheduleId: string, start: string, end: string): Slot {
  if (appointment.start !== start || appointment.end !== end) {
    throw new Error('$find returned a proposal with unexpected times');
  }
  const patientParticipant = appointment.participant?.find((participant) => participant.actor?.reference?.startsWith('Patient/'));
  if (patientParticipant) {
    throw new Error('$find proposal unexpectedly contains a Patient participant');
  }
  const practitionerParticipants = appointment.participant?.filter(
    (participant) => participant.actor?.reference === `Practitioner/${practitionerId}`
  );
  if (practitionerParticipants?.length !== 1 || appointment.participant?.length !== 1) {
    throw new Error('$find proposal participants do not match the requested Practitioner');
  }
  const slot = appointment.contained?.find((resource) => resource.resourceType === 'Slot') as Slot | undefined;
  if (!slot || slot.schedule.reference !== `Schedule/${scheduleId}` || slot.start !== start || slot.end !== end) {
    throw new Error('$find proposal Slot does not match the selected Schedule and time');
  }
  return slot;
}

/**
 * Extracts the booked Appointment from $book's real response — a BARE
 * Bundle, never a Parameters envelope. Confirmed directly in
 * buildOutputParameters (packages/server/src/fhir/operations/utils/parameters.ts):
 * an operation with exactly one 'return' output parameter (both $find and
 * $book declare this) bypasses the Parameters wrapper and sends the
 * resource itself — here, the Bundle — as the HTTP response body.
 */
function extractBookedAppointment(bundle: Bundle): Appointment {
  const appointment = bundle.entry?.find((e) => e.resource?.resourceType === 'Appointment')?.resource as Appointment | undefined;
  if (!appointment) {
    throw new Error('$book response did not contain a booked Appointment — unexpected response shape');
  }
  return appointment;
}

export async function handler(medplum: MedplumClient, event: BotEvent<BookInput>): Promise<BookResult> {
  const { patientId, practitionerId, scheduleId, start, end, summaryCommunicationId } = event.input;

  // All authority comes from server-side FHIR resources. These reads also
  // prove that every submitted id resolves in the active project.
  await medplum.readResource<Patient>('Patient', patientId);
  await medplum.readResource<Practitioner>('Practitioner', practitionerId);
  const schedule = await medplum.readResource<Schedule>('Schedule', scheduleId);
  const summary = await medplum.readResource<Communication>('Communication', summaryCommunicationId);

  if (
    summary.status !== 'preparation' ||
    summary.subject?.reference !== `Patient/${patientId}` ||
    summary.sender?.reference !== 'Device/ai-appointment-agent' ||
    !hasCategory(summary, 'ai-previsit-summary') ||
    !summary.meta?.tag?.some((tag) => tag.code === 'ai-generated')
  ) {
    throw new Error('The intake Communication is not an authoritative preparation summary for this Patient');
  }
  const urgency = summary.priority;
  if (urgency !== 'routine' && urgency !== 'urgent') {
    throw new Error('The intake Communication has no valid booking urgency');
  }
  const reason = summary.reasonCode?.[0]?.text;
  const complaintText = summary.note?.[0]?.text;
  const specialtyCode = summary.topic?.coding?.find((coding) => coding.system === 'http://nucc.org/provider-taxonomy')?.code;
  if (!reason || !complaintText || !specialtyCode) {
    throw new Error('The intake Communication is missing its booking reason, original complaint, or normalized specialty');
  }
  const practitionerRoles = await medplum.searchResources('PractitionerRole', {
    practitioner: `Practitioner/${practitionerId}`,
  });
  const specialtyMatches = practitionerRoles.some((role) =>
    role.specialty?.some((specialty) =>
      specialty.coding?.some(
        (coding) => coding.system === 'http://nucc.org/provider-taxonomy' && coding.code === specialtyCode
      )
    )
  );
  if (!specialtyMatches) {
    throw new Error('The requested Practitioner does not match the intake-selected specialty');
  }

  const serviceId = urgency === 'urgent' ? 'urgent-visit' : 'office-visit';
  await medplum.readResource<HealthcareService>('HealthcareService', serviceId);
  if (schedule.actor?.some((actor) => actor.reference === `Practitioner/${practitionerId}`) !== true) {
    throw new Error('The Schedule does not belong to the requested Practitioner');
  }
  if (!hasService(schedule, serviceId)) {
    throw new Error('The Schedule does not offer the intake-selected service');
  }

  // The browser's earlier $find was display-only. Re-run it here so the
  // proposal and contained Slot cross the trust boundary from Medplum,
  // not from a mutable client payload.
  const findUrl = medplum.fhirUrl('Appointment', '$find');
  findUrl.searchParams.set('schedule', `Schedule/${scheduleId}`);
  findUrl.searchParams.set('service-type-reference', `HealthcareService/${serviceId}`);
  findUrl.searchParams.set('start', start);
  findUrl.searchParams.set('end', end);
  findUrl.searchParams.set('_count', '20');
  const findBundle = await medplum.get<Bundle<Appointment>>(findUrl);
  const proposedAppointment = (findBundle.entry ?? [])
    .map((entry) => entry.resource)
    .find((resource): resource is Appointment => resource?.resourceType === 'Appointment' && resource.start === start && resource.end === end);
  if (!proposedAppointment) {
    return { ok: false, reason: 'slot_taken' };
  }
  validateProposal(proposedAppointment, practitionerId, scheduleId, start, end);

  const appointmentToBook: Appointment = {
    ...proposedAppointment,
    participant: [...(proposedAppointment.participant ?? []), { actor: { reference: `Patient/${patientId}` }, status: 'accepted' }],
    description: reason,
    comment: complaintText,
    reasonCode: [{ text: reason }],
    priority: urgencyToPriority(urgency),
  };

  let bookedAppointment: Appointment;
  try {
    const response = (await medplum.post(medplum.fhirUrl('Appointment', '$book'), {
      resourceType: 'Parameters',
      parameter: [{ name: 'appointment', resource: appointmentToBook }],
    })) as Bundle;
    bookedAppointment = extractBookedAppointment(response);
  } catch (err) {
    if (err instanceof OperationOutcomeError) {
      const detailText = err.outcome.issue?.[0]?.details?.text;
      if (detailText === SLOT_TAKEN_MESSAGE) {
        return { ok: false, reason: 'slot_taken' };
      }
    }
    throw err;
  }

  // The Appointment is now genuinely booked, including the clinical
  // metadata placed on the proposal before the atomic $book call.
  // Everything below is only summary Communication linkage — a
  // failure here must NEVER be reported back to the caller as a booking
  // failure, since the booking already succeeded. Log and continue rather
  // than throw, so a flaky follow-up write can't make the UI tell the
  // patient their appointment didn't happen when it did.
  try {
    const practitionerRef = appointmentToBook.participant?.find((p) => p.actor?.reference?.startsWith('Practitioner/'))?.actor?.reference;

    // Read-and-spread — updateResource is a full replacement, not a patch.
    // A bare {id, recipient, about, status, sent} object here would
    // silently wipe category, subject, sender, payload (the summary text
    // itself), and meta.tag.
    await medplum.updateResource<Communication>({
      ...summary,
      recipient: practitionerRef ? [{ reference: practitionerRef }] : summary.recipient,
      about: [{ reference: `Appointment/${bookedAppointment.id}` }],
      status: 'completed',
      sent: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Booking succeeded but the post-booking metadata update failed:', err);
  }

  return { ok: true, appointment: bookedAppointment };
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
git commit -m "fix(bot): make booking server-authoritative and use the native scheduling contract"
```

---

### Task 22: `src/bots/agent/agent-patient-chat.ts`

A correction pass fixed a real gap: the bot's `sender` on every chat-question
`Communication` was the hard-coded, nonexistent reference
`Practitioner/desk-agent`, and the route's NPI was never even sent to the
bot — so the audit trail attributed every question to a fake practitioner
regardless of who was actually asking, and nothing checked that the NPI
querying a patient's chat had ever actually booked with that patient. The
NPI-as-display-filter model (Design §11) stays exactly what it is — this
isn't real authentication, and isn't meant to become it — but "does a
booking relationship between this NPI and this patient exist at all" is a
cheap, real check that was simply missing, and the `sender` should at
least be the real practitioner, not a placeholder string.

**Files:**
- Create: `src/bots/agent/agent-patient-chat.ts`
- Test: `src/bots/agent/agent-patient-chat.test.ts`

**Interfaces:**
- Consumes: `loadPatientClinicalContext` (Task 15), `CHAT_SYSTEM_PROMPT`/`buildChatUserPrompt`/`containsInterpretationLanguage` (Task 16).
- Produces: `handler(medplum, event: BotEvent<{npi: string; patientId: string; question: string; threadId?: string}>): Promise<{answer: string; threadId: string}>`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/bots/agent/agent-patient-chat.test.ts
import { describe, expect, test } from 'vitest';
import { MockClient } from '@medplum/mock';
import { handler, __setGeminiCallerForTests } from './agent-patient-chat';

describe('agent-patient-chat handler', () => {
  test('persists question and answer as threaded Communications, sender is the real practitioner, starts a new thread', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    const practitioner = await medplum.createResource({ resourceType: 'Practitioner', identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }] });
    await medplum.createResource({
      resourceType: 'Appointment',
      status: 'booked',
      participant: [{ actor: { reference: `Patient/${patient.id}` }, status: 'accepted' }, { actor: { reference: `Practitioner/${practitioner.id}` }, status: 'accepted' }],
    });
    __setGeminiCallerForTests(async () => 'The record shows no known allergies.');

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { npi: '1234567890', patientId: patient.id as string, question: 'Any known allergies?' },
      contentType: 'application/json',
      secrets: { GEMINI_API_KEY: { valueString: 'test-key' } },
    });

    expect(result.answer).toBe('The record shows no known allergies.');
    const question = await medplum.readResource('Communication', result.threadId);
    expect(question.sender).toStrictEqual({ reference: `Practitioner/${practitioner.id}` });
    expect(question.meta?.tag).toBeUndefined();

    const answers = await medplum.searchResources('Communication', { partOf: `Communication/${result.threadId}` });
    expect(answers).toHaveLength(1);
    expect(answers[0].sender).toStrictEqual({ reference: 'Device/ai-appointment-agent' });
    expect(answers[0].meta?.tag).toContainEqual({ code: 'ai-generated' });
  });

  test('throws when no booking relationship exists between this NPI and this patient', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    await medplum.createResource({ resourceType: 'Practitioner', identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }] });
    // No Appointment created — no relationship exists.

    await expect(
      handler(medplum, {
        bot: { reference: 'Bot/123' },
        input: { npi: '1234567890', patientId: patient.id as string, question: 'Any known allergies?' },
        contentType: 'application/json',
        secrets: { GEMINI_API_KEY: { valueString: 'test-key' } },
      })
    ).rejects.toThrow(/no booking relationship/i);
  });

  test('substitutes the fixed refusal when the model answer contains interpretation language', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    const practitioner = await medplum.createResource({ resourceType: 'Practitioner', identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }] });
    await medplum.createResource({
      resourceType: 'Appointment',
      status: 'booked',
      participant: [{ actor: { reference: `Patient/${patient.id}` }, status: 'accepted' }, { actor: { reference: `Practitioner/${practitioner.id}` }, status: 'accepted' }],
    });
    __setGeminiCallerForTests(async () => 'You should consider a follow-up MRI.');

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { npi: '1234567890', patientId: patient.id as string, question: 'What do you think this means?' },
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

export type ChatInput = { npi: string; patientId: string; question: string; threadId?: string };
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
  const { npi, patientId, question, threadId } = event.input;
  const apiKey = event.secrets['GEMINI_API_KEY']?.valueString as string;

  const practitioner = await medplum.searchOne('Practitioner', { identifier: `http://hl7.org/fhir/sid/us-npi|${npi}` });
  if (!practitioner) {
    throw new Error(`No Practitioner found for NPI ${npi}`);
  }

  // Cheap, real relationship check — not authentication (NPI entry stays a
  // display filter, per Design §11), but "has this NPI ever actually
  // booked with this patient" is a fact worth checking before answering,
  // and was simply absent before.
  const relationship = await medplum.searchOne('Appointment', {
    actor: `Practitioner/${practitioner.id}`,
    patient: `Patient/${patientId}`,
  });
  if (!relationship) {
    throw new Error(`No booking relationship between NPI ${npi} and patient ${patientId}`);
  }

  const context = await loadPatientClinicalContext(medplum, patientId);
  const userPrompt = buildChatUserPrompt(context, question);
  const rawAnswer = await geminiCaller(apiKey, CHAT_SYSTEM_PROMPT, userPrompt);
  const answer = containsInterpretationLanguage(rawAnswer) ? REFUSAL : rawAnswer;

  const questionCommunication = await medplum.createResource({
    resourceType: 'Communication',
    status: 'completed',
    category: [{ coding: [{ system: 'http://example.com/agent-communication-category', code: 'ai-chat' }] }],
    subject: { reference: `Patient/${patientId}` },
    sender: { reference: `Practitioner/${practitioner.id}` },
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
git commit -m "fix(bot): agent-patient-chat — real practitioner sender, verify booking relationship"
```

---

### Task 23: REMOVED — `agent-expire-holds` no longer needed

A correction pass removed this bot entirely (not fixed, deleted from the
plan). It existed to clean up stale `busy-tentative` holds left behind by
the old `$hold`→`$confirm` two-step booking flow. Booking now goes through
a single `$book` call (Task 21) — there is no intermediate hold state, and
therefore nothing that can ever go stale. This also removes the
`Bot.cronString` requirement from `deploy-bots.ts` (Task 26) — no bot in
this plan needs a cron trigger.

---

### Task 24: Delete `src/bots/core/cancel-appointment.ts` — use Medplum's native `$cancel` instead

A correction pass found that Medplum already provides a native
`POST /fhir/R4/Appointment/{id}/$cancel` operation that does exactly what
the hand-rolled `cancel-appointment.ts` bot was fixed to do in an earlier
pass — atomically, inside a `serializable: true` transaction: set
`Appointment.status = 'cancelled'` and delete every `Slot` the Appointment
referenced (confirmed directly in Medplum's `cancel.ts`). Hand-rolling that
logic was unnecessary risk once the native operation was actually checked
against source — this deletes the custom bot and its test, and points the
one caller directly at `$cancel`.

**Files:**
- Delete: `src/bots/core/cancel-appointment.ts`, `src/bots/core/cancel-appointment.test.ts`
- Modify: `src/components/actions/AppointmentActions.tsx`

**Interfaces:**
- Produces: `AppointmentActions.tsx`'s cancel button calls the fully qualified FHIR operation URL from `medplum.fhirUrl('Appointment', id, '$cancel')`, no bot involved.

- [ ] **Step 1: Delete the bot and its test**

```bash
git rm src/bots/core/cancel-appointment.ts src/bots/core/cancel-appointment.test.ts
```

- [ ] **Step 2: Modify `AppointmentActions.tsx`'s cancel handler**

Replace `handleCancelAppointment` in `src/components/actions/AppointmentActions.tsx`:

```typescript
  async function handleCancelAppointment(): Promise<void> {
    try {
      // Call Medplum's native $cancel operation directly — no custom bot.
      // Confirmed atomic (serializable transaction): cancels the Appointment
      // and deletes its Slot(s) in one step.
      await medplum.post(medplum.fhirUrl('Appointment', appointment.id as string, '$cancel'), {});

      navigate('/Appointment/upcoming')?.catch(console.error);
      showNotification({
        icon: <IconCircleCheck />,
        title: 'Success',
        message: 'Appointment cancelled',
      });
    } catch (err) {
      showNotification({
        icon: <IconCircleOff />,
        title: 'Error',
        message: normalizeErrorString(err),
      });
    }
  }
```

- [ ] **Step 3: Remove `cancel-appointment` from `deploy-bots.ts`'s `Bots` array**

It's covered again explicitly in Task 26's full rewrite of that array — no separate edit needed here if Task 26 runs after this one, but if verifying incrementally, confirm the entry from Task 2's interim array is gone.

- [ ] **Step 4: Verify the build is clean**

```bash
npx tsc --noEmit
```

Expected: no dangling imports of the deleted bot file.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: delete cancel-appointment.ts, call Medplum's native \$cancel directly

Medplum's own \$cancel operation already does — atomically — exactly what
the hand-rolled bot was fixed to do in an earlier pass (cancel + delete
Slots in one transaction). Confirmed by reading cancel.ts directly.
Hand-rolling it was unnecessary risk."
```

---

### Task 25: `src/bots/core/reschedule-appointment.ts` (new) + modify `RescheduleAppointment.tsx`

A correction pass rewrote this bot to use `$book` (with a self-constructed
proposed Appointment carrying a `contained` Slot at the requested new time)
instead of `$hold`→`$confirm`, and to release the original appointment via
Medplum's native `$cancel` instead of hand-rolled cancel-and-delete logic —
consistent with the same two fixes applied to `agent-book-appointment.ts`
(Task 21) and `cancel-appointment.ts`'s deletion (Task 24). Unlike Task 21,
this bot builds its own proposed Appointment rather than receiving one from
`$find` — `RescheduleAppointment.tsx`'s UI is a plain date/time
questionnaire, not a slot-picker, so there's no discovered `$find` result
to pass through; `$book`'s own availability validation (the same
`validateAllAvailability` path Task 21 relies on) is what determines
success or `slot_taken` here. A second, independent re-audit found two
further bugs, both fixed here: `$book`'s response was (again) parsed as a
`Parameters` envelope instead of the bare `Bundle` it actually is (same
correction as Task 21); and the new Appointment previously copied only
`serviceType`/`participant` from the original, silently dropping
`description`/`comment`/`reasonCode`/`priority` and leaving the summary
Communication's `about` pointed at the now-cancelled original Appointment
instead of the new one.

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

const SERVICE_TYPE = [{ extension: [{ url: 'https://medplum.com/fhir/service-type-reference', valueReference: { reference: 'HealthcareService/office-visit' } }] }];
const PARTICIPANTS = [{ actor: { reference: 'Patient/p1' }, status: 'accepted' as const }, { actor: { reference: 'Practitioner/dr-1' }, status: 'accepted' as const }];

describe('reschedule-appointment handler', () => {
  test('on success: books the new time via $book (parsing its real bare-Bundle response), copies stated-issue metadata, re-links the summary Communication, cancels the original via native $cancel', async () => {
    const medplum = new MockClient();
    const schedule = await medplum.createResource({ resourceType: 'Schedule', actor: [{ reference: 'Practitioner/dr-1' }] });
    const oldSlot = await medplum.createResource({ resourceType: 'Slot', schedule: { reference: `Schedule/${schedule.id}` }, status: 'busy', start: '2026-09-01T09:00:00Z', end: '2026-09-01T09:30:00Z' });
    const communication = await medplum.createResource({
      resourceType: 'Communication',
      status: 'completed',
      subject: { reference: 'Patient/p1' },
      sender: { reference: 'Device/ai-appointment-agent' },
      payload: [{ contentString: 'summary' }],
      about: [{ reference: 'placeholder' }],
    });
    const appointment = await medplum.createResource({
      resourceType: 'Appointment',
      status: 'booked',
      slot: [{ reference: `Slot/${oldSlot.id}` }],
      serviceType: SERVICE_TYPE,
      participant: PARTICIPANTS,
      description: 'Chest discomfort during exercise',
      comment: 'My chest hurts when I run',
      reasonCode: [{ text: 'Chest discomfort during exercise' }],
      priority: 5,
    });
    await medplum.updateResource({ ...communication, about: [{ reference: `Appointment/${appointment.id}` }] });

    const bookedAppointment = { resourceType: 'Appointment', id: 'appt-new', status: 'booked' };
    // $book's real response is a BARE Bundle — no Parameters envelope.
    const bookResponseBundle = { resourceType: 'Bundle', type: 'transaction-response', entry: [{ resource: bookedAppointment }] };
    const posted: { url: string; body: any }[] = [];
    vi.spyOn(medplum, 'post').mockImplementation(async (url: string | URL, body: any) => {
      const resolvedUrl = url.toString();
      posted.push({ url: resolvedUrl, body });
      if (resolvedUrl === medplum.fhirUrl('Appointment', '$book').toString()) return bookResponseBundle as any;
      if (resolvedUrl === medplum.fhirUrl('Appointment', appointment.id as string, '$cancel').toString()) return { resourceType: 'Appointment', id: appointment.id, status: 'cancelled' } as any;
      throw new Error(`unexpected post ${resolvedUrl}`);
    });

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { appointmentId: appointment.id as string, newStart: '2026-09-02T09:00:00Z', newEnd: '2026-09-02T09:30:00Z' },
      contentType: 'application/json',
      secrets: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.appointment.description).toBe('Chest discomfort during exercise');
    expect(result.appointment.comment).toBe('My chest hurts when I run');
    expect(result.appointment.priority).toBe(5);

    const bookCall = posted.find((p) => p.url === medplum.fhirUrl('Appointment', '$book').toString());
    const proposedAppointment = bookCall?.body.parameter[0].resource;
    expect(proposedAppointment.contained[0]).toMatchObject({ resourceType: 'Slot', start: '2026-09-02T09:00:00Z', end: '2026-09-02T09:30:00Z', schedule: { reference: `Schedule/${schedule.id}` } });
    expect(posted.some((p) => p.url === medplum.fhirUrl('Appointment', appointment.id as string, '$cancel').toString())).toBe(true);

    const updatedCommunication = await medplum.readResource('Communication', communication.id as string);
    expect(updatedCommunication.about?.[0].reference).toBe('Appointment/appt-new'); // re-linked to the NEW appointment, not the cancelled one
  });

  test('on slot-taken $book rejection: leaves the original appointment untouched, does not call $cancel', async () => {
    const medplum = new MockClient();
    const schedule = await medplum.createResource({ resourceType: 'Schedule', actor: [{ reference: 'Practitioner/dr-1' }] });
    const oldSlot = await medplum.createResource({ resourceType: 'Slot', schedule: { reference: `Schedule/${schedule.id}` }, status: 'busy', start: '2026-09-01T09:00:00Z', end: '2026-09-01T09:30:00Z' });
    const appointment = await medplum.createResource({
      resourceType: 'Appointment',
      status: 'booked',
      slot: [{ reference: `Slot/${oldSlot.id}` }],
      serviceType: SERVICE_TYPE,
      participant: PARTICIPANTS,
    });
    const posted: string[] = [];
    vi.spyOn(medplum, 'post').mockImplementation(async (url: string | URL) => {
      posted.push(url.toString());
      throw new OperationOutcomeError({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid', details: { text: 'Requested time slot is not available' } }] });
    });

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { appointmentId: appointment.id as string, newStart: '2026-09-02T09:00:00Z', newEnd: '2026-09-02T09:30:00Z' },
      contentType: 'application/json',
      secrets: {},
    });

    expect(result).toStrictEqual({ ok: false, reason: 'slot_taken' });
    const original = await medplum.readResource('Appointment', appointment.id as string);
    expect(original.status).toBe('booked'); // untouched
    expect(posted).not.toContain(medplum.fhirUrl('Appointment', appointment.id as string, '$cancel').toString());
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
import type { Appointment, Bundle, Communication, Slot } from '@medplum/fhirtypes';

export type RescheduleInput = { appointmentId: string; newStart: string; newEnd: string };
export type RescheduleResult = { ok: true; appointment: Appointment } | { ok: false; reason: 'slot_taken' };

const SLOT_TAKEN_MESSAGE = 'Requested time slot is not available';

/** $book's real response is a bare Bundle — see agent-book-appointment.ts's identical fix. */
function extractBookedAppointment(bundle: Bundle): Appointment {
  const appointment = bundle.entry?.find((e) => e.resource?.resourceType === 'Appointment')?.resource as Appointment | undefined;
  if (!appointment) {
    throw new Error('$book response did not contain a booked Appointment');
  }
  return appointment;
}

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

  const proposedSlot: Slot = {
    resourceType: 'Slot',
    status: 'busy',
    start: newStart,
    end: newEnd,
    schedule: { reference: `Schedule/${scheduleId}` },
  };
  const proposedAppointment: Appointment = {
    resourceType: 'Appointment',
    status: 'proposed',
    start: newStart,
    end: newEnd,
    serviceType: original.serviceType,
    participant: original.participant, // already includes both Patient and Practitioner — this is a real already-booked Appointment, unlike agent-book-appointment's $find-sourced proposal
    contained: [proposedSlot],
  };

  let bookedAppointment: Appointment;
  try {
    const response = (await medplum.post(medplum.fhirUrl('Appointment', '$book'), {
      resourceType: 'Parameters',
      parameter: [{ name: 'appointment', resource: proposedAppointment }],
    })) as Bundle;
    bookedAppointment = extractBookedAppointment(response);
  } catch (err) {
    if (err instanceof OperationOutcomeError && err.outcome.issue?.[0]?.details?.text === SLOT_TAKEN_MESSAGE) {
      return { ok: false, reason: 'slot_taken' };
    }
    throw err;
  }

  // Copy the stated-issue metadata forward — the original's description/
  // comment/reasonCode/priority would otherwise be silently dropped, and
  // the new Appointment would show up on the doctor's queue with none of
  // the context the original had.
  const finalAppointment = await medplum.updateResource<Appointment>({
    ...bookedAppointment,
    description: original.description,
    comment: original.comment,
    reasonCode: original.reasonCode,
    priority: original.priority,
  });

  // Re-link the summary Communication to the NEW Appointment. Communication:about
  // is a real field but confirmed not searchable — found the same way the
  // doctor queue does (Data Model doc): search by subject/category (both
  // real search parameters), then filter in memory on `about`.
  const patientRef = original.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
  if (patientRef) {
    const candidateSummaries = await medplum.searchResources('Communication', {
      subject: patientRef,
      category: 'ai-previsit-summary',
    });
    const summary = candidateSummaries.find((c) => c.about?.[0]?.reference === `Appointment/${appointmentId}`);
    if (summary) {
      await medplum.updateResource<Communication>({ ...summary, about: [{ reference: `Appointment/${bookedAppointment.id}` }] });
    }
  }

  // Release the original via Medplum's native $cancel — confirmed atomic
  // (cancels + deletes its Slot in one transaction), same as Task 24.
  await medplum.post(medplum.fhirUrl('Appointment', appointmentId, '$cancel'), {});

  return { ok: true, appointment: finalAppointment };
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
git commit -m "feat(bot): reschedule-appointment — \$book + native \$cancel, was direct mutation with no conflict check"
```

---

### Task 26: Update `deploy-bots.ts` (add agent bots), fix the direct-deploy path, and deploy to the target project

A correction pass found the original problems here, and a second,
independent re-audit found that the *fix* for one of them was itself
broken — worth calling out plainly rather than glossing over:

1. The original "direct deploy" script just submitted the generated
   bundle with its `$bot-{name}-reference`/`$bot-{name}-id` placeholders
   unresolved and never called each Bot's `$deploy` operation —
   `UploadDataPage.tsx`'s real upload handler does both, confirmed by
   reading it directly, and skipping either step leaves the Bots created
   but not actually runnable.
2. The fix for #1 introduced a **new** bug: it matched each bot's compiled
   code with `bundle.entry.find(e => resourceType==='Binary' &&
   contentType==='text/javascript')` **inside** a per-bot loop, but that
   predicate doesn't reference the bot at all — it always finds the same
   first JavaScript `Binary` in the bundle, so every bot would receive
   identical code. The real `UploadDataPage.tsx` avoids this by matching
   each Bot's own `executableCode.url` to the Binary entry whose `fullUrl`
   equals it — confirmed directly by reading its source — and that's what
   this fix now does too.
3. Creating a missing Bot via a bare `medplum.createResource({resourceType:
   'Bot', ...})` is also incomplete — confirmed against
   `packages/server/src/fhir/operations/botinit.ts`: the Medplum app's own
   admin bot-creation flow (`admin/projects/{id}/bot`) additionally
   creates a `ProjectMembership` linking the Bot as a runnable actor in the
   project, which a bare `createResource` call skips entirely — a bot
   created that way likely can't authenticate/execute. The fix uses the
   same admin endpoint the Medplum app itself uses.
4. `UploadDataPage.tsx`'s `checkBotsUploaded` hard-codes a 5-name list
   (`book-appointment`, `cancel-appointment`, `set-availability`,
   `block-availability`, `example-data`) to decide whether the "Upload
   Example Bots" button is disabled — three of those five no longer exist
   in this plan's bot roster, so the button would never correctly reflect
   whether this plan's bots are actually uploaded.
5. No cron-triggered bot exists in this plan anymore (Task 23), so the
   `cronString` support an earlier pass added to `BotDescription` is
   removed, not kept unused.

**Files:**
- Modify: `src/scripts/deploy-bots.ts`
- Modify: `src/pages/UploadDataPage.tsx`

**Interfaces:**
- Consumes: every bot file from Tasks 17–25.
- Produces: all bots registered as `Bot` resources in the target Medplum project, **and actually deployed** (`$deploy` called with compiled JS) — callable via `medplum.executeBot({system: 'http://example.com', value: botName}, ...)`.

- [ ] **Step 1: Extend the `Bots` array with every new/fixed bot**

```typescript
const Bots: BotDescription[] = [
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
];
```

(`cancel-appointment` is gone — deleted in Task 24 in favor of native `$cancel`. `agent-expire-holds` is gone — removed in Task 23, no hold state to expire once booking is a single `$book` call. No `cronString` field anywhere in this array or the `BotDescription` interface — nothing in this plan needs a cron trigger.)

- [ ] **Step 2: Build and deploy against the target Medplum project, resolving placeholders and calling `$deploy`**

```bash
npm run build:bots
```

Expected: `data/core/example-bots.json` is regenerated with all 7 bots (still containing the `$bot-{name}-reference`/`$bot-{name}-id` placeholders `deploy-bots.ts`'s existing pattern emits — resolving those is this step's job, not `build:bots`'s).

Deploy with a script that replicates exactly what `UploadDataPage.tsx`'s real upload handler does — resolve each bot's placeholders against a created-or-found `Bot` resource, upload, **then call `$deploy`** with the compiled JS (skipping `$deploy` leaves the Bot resource created but not actually runnable):

```bash
npx tsx -e "
import { MedplumClient, getReferenceString } from '@medplum/core';
import { readFileSync } from 'fs';

const medplum = new MedplumClient({ baseUrl: process.env.MEDPLUM_BASE_URL });
await medplum.startClientLogin(process.env.MEDPLUM_CLIENT_ID, process.env.MEDPLUM_CLIENT_SECRET);

const bundle = JSON.parse(readFileSync('data/core/example-bots.json', 'utf-8'));
const botEntries = bundle.entry.filter((e) => e.resource?.resourceType === 'Bot');

// Get the current project id for the admin bot-creation endpoint — a bare
// createResource({resourceType:'Bot',...}) skips the ProjectMembership
// the admin endpoint creates, which a Bot needs to actually run as an
// authenticated actor (confirmed against botinit.ts).
const activeLogin = medplum.getActiveLogin();
const projectId = activeLogin?.project?.reference?.split('/')[1];
if (!projectId) {
  throw new Error('Could not determine the active project id from the current login');
}

let bundleString = JSON.stringify(bundle);
const botIds = {};
for (const entry of botEntries) {
  const botName = entry.resource.name;
  let bot = await medplum.searchOne('Bot', { name: botName });
  if (!bot) {
    bot = await medplum.post('admin/projects/' + projectId + '/bot', { name: botName });
  }
  botIds[botName] = bot.id;
  bundleString = bundleString
    .replaceAll('\$bot-' + botName + '-reference', getReferenceString(bot))
    .replaceAll('\$bot-' + botName + '-id', bot.id);
}

await medplum.executeBatch(JSON.parse(bundleString));

// Match each bot's OWN executableCode.url to its own Binary entry by
// fullUrl — the earlier version of this script grabbed 'the first
// JavaScript Binary' once, outside this loop, so every bot got the same
// code. This is exactly the pattern UploadDataPage.tsx's real upload
// handler uses (confirmed by reading it directly).
for (const entry of botEntries) {
  const botName = entry.resource.name;
  const distUrl = entry.resource.executableCode?.url;
  const distBinaryEntry = bundle.entry.find((e) => e.fullUrl === distUrl);
  if (!distBinaryEntry?.resource?.data) {
    throw new Error('Could not find compiled code Binary for bot: ' + botName);
  }
  const code = Buffer.from(distBinaryEntry.resource.data, 'base64').toString('utf-8');
  await medplum.post(medplum.fhirUrl('Bot', botIds[botName], '\$deploy'), { code });
  console.log('Deployed', botName);
}
"
```

(Alternatively, sign into the deployed frontend and use the fork's existing `UploadDataPage` at `/upload/bots`, which already does all of the above correctly — confirmed by reading its source — including the per-bot Binary matching and proper admin-endpoint bot creation. Step 3 fixes its bot-count check so that path also works correctly with this plan's 7-bot roster. The script above exists for CI/scripted deployment; prefer the UI page if signing in manually is convenient.)

- [ ] **Step 3: Fix `checkBotsUploaded`'s hard-coded bot list in `UploadDataPage.tsx`**

```typescript
function checkBotsUploaded(medplum: MedplumClient): boolean {
  const bots = medplum.searchResources('Bot').read();
  const exampleBots = bots.filter(
    (bot) =>
      bot.name &&
      [
        'block-availability',
        'reschedule-appointment',
        'agent-intake',
        'agent-find-doctors',
        'agent-ensure-doctor',
        'agent-book-appointment',
        'agent-patient-chat',
      ].includes(bot.name)
  );
  if (exampleBots.length === 7) {
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Set each Bot's secrets in the target Medplum project**

In the Medplum app's Project Admin panel, add the project secret `GEMINI_API_KEY` (a real Gemini API key) — this makes it available to every bot in the project via `event.secrets['GEMINI_API_KEY']`.

- [ ] **Step 5: Manually verify each bot executes (this is the live check Design doc §16 flags as outstanding)**

Using a Medplum-authenticated script or the app's bot-testing UI, call each new bot once with realistic input and confirm it returns the expected shape rather than an error:
- `agent-intake` with a real `patientId` from the Task 10 seed and a complaint string — expect `{intent: {...}, summaryCommunicationId}`.
- `agent-ensure-doctor` with a real NPI from the seeded data — expect `{practitionerId, scheduleId, healthcareServiceIds}`.
- A direct call using `medplum.fhirUrl('Appointment', '$find')` with that `scheduleId` and one of the `healthcareServiceIds` — expect a bare `Bundle` response containing at least one proposed `Appointment` with a `contained` Slot. Confirm that Task 19's two per-service `SchedulingParameters` extensions are honored and that their explicit 30-minute/15-minute `alignmentInterval` values produce the expected grid.
- `agent-book-appointment`, passing only `patientId`, `practitionerId`, `scheduleId`, the selected `start`/`end`, and `summaryCommunicationId` — expect `{ok: true, appointment}` and confirm its own fresh `$find` occurred before `$book`.
- Cancel that disposable Appointment with `medplum.post(medplum.fhirUrl('Appointment', appointmentId, '$cancel'), {})` and confirm the Appointment is cancelled and its Slot is gone. This is the target-runtime check for the native `$cancel` contract.
- `agent-patient-chat` with that same patient's NPI and a factual question — expect a grounded, non-empty answer (and confirm the relationship check added in Task 22 rejects a mismatched NPI/patient pair).

If `$find` returns zero slots or errors, the most likely cause is the `SchedulingParameters`/`serviceType` shape from Task 19 — re-check against the exact structure confirmed in the Data Model doc before assuming the server is misconfigured.

- [ ] **Step 6: Commit**

```bash
git add src/scripts/deploy-bots.ts src/pages/UploadDataPage.tsx
git commit -m "fix(deploy): register final agent bot roster, fix direct-deploy to resolve placeholders and call \$deploy, fix UploadDataPage's bot count check"
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
import { Anchor, Stack, Table, Title } from '@mantine/core';
import type { Patient } from '@medplum/fhirtypes';
import { Document, useMedplum } from '@medplum/react';
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
    <Document width={800}>
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
    </Document>
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

### Task 29: `src/pages/agent/PatientHistoryPage.tsx` + `ComplaintForm.tsx` + `IntentCard.tsx` + `EncounterHistoryList.tsx`

A correction pass found that `@medplum/react`'s `PatientSummary` alone
doesn't satisfy FR-2: its default sections are Demographics, Insurance,
Allergies, ProblemList, Medications, Labs, and a few others — confirmed
directly against its source — but **no Encounter-history section exists
in the component at all**, and FR-2 explicitly requires past encounters
with practitioner, specialty, and organization. `EncounterHistoryList.tsx`
is a new component built specifically for that requirement, alongside
`PatientSummary` rather than replacing it. Also added: a static
"if this is a medical emergency, call 911" line on the complaint form —
cheap, and worth having given the urgency classification this flow does
(Task 17) is explicitly a *scheduling* signal, not a clinical triage
judgment, and should never be mistaken for one.

**Files:**
- Create: `src/pages/agent/PatientHistoryPage.tsx`
- Create: `src/components/agent/ComplaintForm.tsx`
- Create: `src/components/agent/IntentCard.tsx`
- Create: `src/components/agent/EncounterHistoryList.tsx`

**Interfaces:**
- Consumes: `agent-intake` bot (Task 17), `BookingContext` (Task 27).
- Produces: the `/agent/:patientId` page — history via `@medplum/react`'s `PatientSummary` plus the new `EncounterHistoryList` (FR-2), complaint submission (FR-3/FR-4).

- [ ] **Step 1: Implement `ComplaintForm.tsx`**

```typescript
// src/components/agent/ComplaintForm.tsx
import { Alert, Button, Group, Stack, Text, Textarea } from '@mantine/core';
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
      <Text size="xs" c="dimmed">
        This only helps schedule the right kind of visit — it is not a medical evaluation. If this is a medical
        emergency, call 911 or go to the nearest emergency room instead of using this form.
      </Text>
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

- [ ] **Step 3: Implement `EncounterHistoryList.tsx`**

```typescript
// src/components/agent/EncounterHistoryList.tsx
import { Stack, Table, Text, Title } from '@mantine/core';
import type { Encounter, Organization, Practitioner, PractitionerRole } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import dayjs from 'dayjs';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';

interface HistoryRow {
  date: string;
  practitionerName: string;
  specialty: string;
  organizationName: string;
}

/**
 * PatientSummary (from @medplum/react) does not render an Encounter-history
 * section at all — confirmed directly against its source. This satisfies
 * FR-2's requirement for past encounters with practitioner, specialty, and
 * organization, which PatientSummary alone cannot.
 */
export function EncounterHistoryList({ patientId }: { patientId: string }): JSX.Element {
  const medplum = useMedplum();
  const [rows, setRows] = useState<HistoryRow[]>();

  useEffect(() => {
    async function load(): Promise<void> {
      // medplum.search() (not searchResources()) is used deliberately — it
      // returns the raw Bundle including the _include'd Practitioner/
      // Organization entries, which searchResources() would filter out.
      const bundle = await medplum.search('Encounter', {
        subject: `Patient/${patientId}`,
        _include: ['Encounter:practitioner', 'Encounter:service-provider'],
        _sort: '-date',
        _count: '50',
      });
      const entries = bundle.entry ?? [];
      const encounters = entries.filter((e) => e.resource?.resourceType === 'Encounter').map((e) => e.resource as Encounter);
      const practitioners = new Map<string, Practitioner>(
        entries.filter((e) => e.resource?.resourceType === 'Practitioner').map((e) => [e.resource!.id as string, e.resource as Practitioner])
      );
      const organizations = new Map<string, Organization>(
        entries.filter((e) => e.resource?.resourceType === 'Organization').map((e) => [e.resource!.id as string, e.resource as Organization])
      );

      const practitionerIds = [...practitioners.keys()];
      const roles: PractitionerRole[] = practitionerIds.length
        ? await medplum.searchResources('PractitionerRole', { practitioner: practitionerIds.map((id) => `Practitioner/${id}`).join(',') })
        : [];
      const specialtyByPractitionerId = new Map(
        roles.map((r) => [r.practitioner?.reference?.split('/')[1], r.specialty?.[0]?.coding?.[0]?.display ?? r.specialty?.[0]?.coding?.[0]?.code])
      );

      setRows(
        encounters.map((encounter) => {
          const practitionerId = encounter.participant?.[0]?.individual?.reference?.split('/')[1];
          const organizationId = encounter.serviceProvider?.reference?.split('/')[1];
          const practitioner = practitionerId ? practitioners.get(practitionerId) : undefined;
          return {
            date: encounter.period?.start ? dayjs(encounter.period.start).format('MMM D, YYYY') : 'Unknown date',
            practitionerName: practitioner
              ? `Dr. ${practitioner.name?.[0]?.given?.join(' ') ?? ''} ${practitioner.name?.[0]?.family ?? ''}`.trim()
              : 'Unknown',
            specialty: (practitionerId && specialtyByPractitionerId.get(practitionerId)) || 'Unknown specialty',
            organizationName: (organizationId && organizations.get(organizationId)?.name) || 'Unknown organization',
          };
        })
      );
    }
    load().catch(console.error);
  }, [medplum, patientId]);

  return (
    <Stack>
      <Title order={3}>Past Encounters</Title>
      {!rows && (
        <Text size="sm" c="dimmed">
          Loading...
        </Text>
      )}
      {rows?.length === 0 && (
        <Text size="sm" c="dimmed">
          No past encounters on record.
        </Text>
      )}
      {rows && rows.length > 0 && (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Date</Table.Th>
              <Table.Th>Practitioner</Table.Th>
              <Table.Th>Specialty</Table.Th>
              <Table.Th>Organization</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row, i) => (
              <Table.Tr key={i}>
                <Table.Td>{row.date}</Table.Td>
                <Table.Td>{row.practitionerName}</Table.Td>
                <Table.Td>{row.specialty}</Table.Td>
                <Table.Td>{row.organizationName}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
```

- [ ] **Step 4: Implement `PatientHistoryPage.tsx`**

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
import { EncounterHistoryList } from '../../components/agent/EncounterHistoryList';
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
        <EncounterHistoryList patientId={patientId as string} />
        {error && <Alert color="red">{error}</Alert>}
        {booking.intent && <IntentCard intent={booking.intent} />}
        <ComplaintForm onSubmit={handleComplaintSubmit} submitting={submitting} needsClarification={needsClarification} />
      </Stack>
    </Document>
  );
}
```

- [ ] **Step 5: Manual verification**

Navigate to `/agent/:patientId` for a seeded patient. Expect `PatientSummary` to render conditions/medications/allergies, and the new `EncounterHistoryList` to render past encounters with practitioner name, specialty, and organization (FR-2 — `PatientSummary` alone does not cover the latter). Submit a complaint like "my chest hurts when I run" — expect a loading state, then navigation to `/agent/:patientId/doctors` on success, or the clarification alert if the LLM's specialty guess doesn't normalize.

- [ ] **Step 6: Commit**

```bash
git add src/pages/agent/PatientHistoryPage.tsx src/components/agent/ComplaintForm.tsx src/components/agent/IntentCard.tsx src/components/agent/EncounterHistoryList.tsx
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

A correction pass fixed the response parsing twice now — the first fix
still had it wrong. All confirmed against Medplum's actual `$find` source:

1. **`$find`'s response is a BARE `Bundle`, not a `Parameters` envelope.**
   Confirmed directly in `buildOutputParameters`
   (`packages/server/src/fhir/operations/utils/parameters.ts`): an
   operation with exactly one `out` parameter named `return` (both `find`
   and `book` declare this) bypasses the `Parameters` wrapper entirely and
   sends the resource itself as the HTTP response body. A prior pass of
   this fix assumed the response was `Parameters.return.resource` — that
   was itself wrong, just a different wrong shape than the original
   `slot`-output-parameter assumption it replaced. (Medplum's own
   `appointment-find.md` doc is stale and describes the `Parameters`
   shape — it disagrees with the server's actual source, with the
   official example client code, and with the sibling
   `appointment-book.md` doc, which correctly documents the bare-`Bundle`
   shape. Don't trust that one page.) The Bundle's entries are proposed
   `Appointment` resources, each carrying `contained: Slot[]`.
2. **`_count` was never passed** (in the original version of this task),
   so `$find` silently capped at its default of 20 results.
3. **The browser's `$find` result is display state, not booking authority.**
   The slot picker retains only `start`/`end` plus the server-provisioned
   Practitioner/Schedule ids. Task 21 receives those minimal values,
   re-runs `$find` inside the Bot, validates the fresh proposal's contained
   Slot and participants, and sends that server-sourced object to `$book`.

Also fixed: after a `slot_taken` response, the page called `setSlots(undefined)`
hoping the effect would refetch — but nothing in the effect's dependency
array changes when that happens, so it never re-runs and the UI is stuck
on a permanent loading spinner. The fetch logic is now a named function the
retry path calls directly.

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

export interface SlotOption {
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

```typescript
// src/pages/agent/SlotPickerPage.tsx
import { Alert, Loader, Stack, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { Document, useMedplum } from '@medplum/react';
import type { Appointment, Bundle } from '@medplum/fhirtypes';
import dayjs from 'dayjs';
import type { JSX } from 'react';
import { useCallback, useContext, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { SlotGrid } from '../../components/agent/SlotGrid';
import type { SlotOption } from '../../components/agent/SlotGrid';
import { BookingContext } from '../../booking.context';

interface EnsureDoctorResult {
  practitionerId: string;
  scheduleId: string;
  healthcareServiceIds: { routine: string; urgent: string };
}

export function SlotPickerPage(): JSX.Element {
  const { patientId, npi } = useParams();
  const medplum = useMedplum();
  const navigate = useNavigate();
  const { booking } = useContext(BookingContext);
  const [slots, setSlots] = useState<SlotOption[]>();
  const [provisioned, setProvisioned] = useState<EnsureDoctorResult>();
  const [error, setError] = useState<string>();
  const [bookingInFlight, setBookingInFlight] = useState(false);

  const fetchSlots = useCallback(async (): Promise<void> => {
    if (!booking.intent) {
      navigate(`/agent/${patientId}`)?.catch(console.error);
      return;
    }
    setSlots(undefined);
    setError(undefined);
    try {
      const provisioned: EnsureDoctorResult = await medplum.executeBot(
        { system: 'http://example.com', value: 'agent-ensure-doctor' },
        { npi }
      );
      setProvisioned(provisioned);
      const healthcareServiceId = provisioned.healthcareServiceIds[booking.intent.urgency === 'urgent' ? 'urgent' : 'routine'];
      const start = dayjs().add(1, 'day').startOf('day').toISOString();
      const end = dayjs().add(15, 'day').endOf('day').toISOString();

      // $find's response is a BARE Bundle of proposed Appointments (each
      // with a contained Slot) — confirmed directly in Medplum's
      // buildOutputParameters: an operation with exactly one 'return'
      // output parameter (both $find and $book declare this) bypasses the
      // Parameters wrapper and sends the Bundle directly as the HTTP
      // response body. Medplum's own appointment-find.md doc is stale and
      // describes the wrong, Parameters-wrapped shape — don't trust it;
      // the official example client code and the sibling
      // appointment-book.md doc both confirm the bare-Bundle shape.
      const findUrl = medplum.fhirUrl('Appointment', '$find');
      findUrl.searchParams.set('service-type-reference', `HealthcareService/${healthcareServiceId}`);
      findUrl.searchParams.set('schedule', `Schedule/${provisioned.scheduleId}`);
      findUrl.searchParams.set('start', start);
      findUrl.searchParams.set('end', end);
      findUrl.searchParams.set('_count', '100');
      const bundle: Bundle<Appointment> = await medplum.get(findUrl);
      const proposedAppointments = (bundle.entry ?? []).map((e) => e.resource as Appointment).filter(Boolean);

      setSlots(
        proposedAppointments.map((appointment) => ({
          start: appointment.start as string,
          end: appointment.end as string,
        }))
      );
    } catch (err) {
      setError(normalizeErrorString(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [medplum, patientId, npi, booking.intent, navigate]);

  useEffect(() => {
    fetchSlots().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchSlots]);

  async function handlePick(slot: SlotOption): Promise<void> {
    if (!booking.intent || !booking.summaryCommunicationId || !provisioned) return;
    setBookingInFlight(true);
    setError(undefined);
    try {
      const result = await medplum.executeBot(
        { system: 'http://example.com', value: 'agent-book-appointment' },
        {
          patientId,
          practitionerId: provisioned.practitionerId,
          scheduleId: provisioned.scheduleId,
          start: slot.start,
          end: slot.end,
          summaryCommunicationId: booking.summaryCommunicationId,
        }
      );
      if (!result.ok) {
        setError('That slot was just taken — please pick another.');
        await fetchSlots(); // actually re-fetch, not just clear-and-hope
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
        {slots && <SlotGrid slots={slots} onPick={handlePick} disabled={bookingInFlight} />}
      </Stack>
    </Document>
  );
}
```

- [ ] **Step 3: Manual verification**

After selecting a doctor in Task 30, expect a loading state, then a grid of bookable time slots (or a "no slots" message). Clicking a slot should navigate to the confirmation page on success. To manually exercise FR-10 (double-booking prevention), open the same slot-picker in two browser tabs and book the same slot in both — the second should show "That slot was just taken" **and the grid should actually refresh**, not hang on a permanent loader.

- [ ] **Step 4: Commit**

```bash
git add src/pages/agent/SlotPickerPage.tsx src/components/agent/SlotGrid.tsx
git commit -m "fix(ui): slot picker — real \$find response shape, pass through the proposed Appointment, fix stuck loader on retry"
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

A correction pass fixed the join between Appointments and their summary
Communications: it was keyed by `patientId` alone via a
`Map<patientId, Communication>`, so a patient who booked with the same
doctor more than once had one summary silently overwrite another, an
older Appointment could display the newer visit's summary, and the React
key (`entry.patientId`) collided across the two bookings. The fix keys
every queue row by `appointmentId` (a patient with two bookings correctly
gets two rows — that's what actually happened, a "queue" here means
upcoming/past appointments, not deduplicated patients) and joins each
Appointment to *its own* summary via the Communication's `about` reference
(a real field, confirmed not searchable — so it's still fetched via
`recipient`/`category`, just matched in memory against `about[0].reference`
instead of blindly keying on patient).

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
  appointmentId: string;
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
        // Keyed by appointmentId, not patientId — a patient who booked
        // with this doctor more than once correctly gets one row per
        // booking, not one collapsed row.
        <PatientBriefCard key={entry.appointmentId} entry={entry} onOpen={() => onOpen(entry.patientId)} />
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

      // Joined by the Appointment this Communication is actually 'about',
      // not by patient — a patient with two bookings has two separate
      // summaries, and each Appointment must show its own, not whichever
      // one happened to be uploaded/matched last.
      const summaryByAppointmentId = new Map<string, Communication>();
      for (const communication of summaries) {
        const appointmentId = communication.about?.[0]?.reference?.split('/')[1];
        if (appointmentId) summaryByAppointmentId.set(appointmentId, communication);
      }

      const patientIds = [
        ...new Set(
          appointments
            .map((a) => a.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference?.split('/')[1])
            .filter((id): id is string => !!id)
        ),
      ];
      const patients = await Promise.all(patientIds.map((id) => medplum.readResource('Patient', id)));
      const nameByPatientId = new Map(patients.map((p) => [p.id as string, `${p.name?.[0]?.given?.join(' ') ?? ''} ${p.name?.[0]?.family ?? ''}`.trim()]));

      const result: QueueEntry[] = appointments
        .map((appointment: Appointment) => {
          const patientId = appointment.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference?.split('/')[1];
          if (!patientId || !appointment.id) return undefined;
          return {
            appointmentId: appointment.id,
            patientId,
            patientName: nameByPatientId.get(patientId) ?? 'Unknown Patient',
            appointmentDate: appointment.start ?? '',
            statedIssue: appointment.description ?? '',
            summary: summaryByAppointmentId.get(appointment.id)?.payload?.[0]?.contentString,
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

After completing a booking via `/agent/*` (Task 32), navigate to `/desk/:npi` using the same NPI shown on the confirmation page. Expect the just-booked patient to appear with their stated issue, AI summary, and appointment date — clicking the card should navigate to the chat page. Book a second appointment for the *same* patient with the *same* doctor and confirm the queue now shows two distinct rows, each with its own summary — not one row with either summary overwritten.

- [ ] **Step 5: Commit**

```bash
git add src/pages/desk/DoctorQueuePage.tsx src/components/desk/QueueTable.tsx src/components/desk/PatientBriefCard.tsx
git commit -m "fix(ui): doctor patient queue — join summaries by appointment, not patient (FR-11, FR-12)"
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
  const { npi, patientId } = useParams();
  const medplum = useMedplum();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [threadId, setThreadId] = useState<string>();
  const [error, setError] = useState<string>();

  async function handleAsk(question: string): Promise<void> {
    setError(undefined);
    try {
      // npi is required now — agent-patient-chat (Task 22) verifies a real
      // booking relationship between this NPI and this patient before
      // answering, and uses the real Practitioner as the question's sender
      // instead of a hard-coded placeholder.
      const result = await medplum.executeBot(
        { system: 'http://example.com', value: 'agent-patient-chat' },
        { npi, patientId, question, threadId }
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

A correction pass fixed a genuine self-contradiction: this task's command
used to read `--slim --full` with prose claiming it "filters to the 7 kept
resource types" — but `parseCliArgs` (Task 9) processes flags left to
right and the last one wins, so passing both together actually selects
`full` mode (keep *every* resource type — Observation, Claim,
ExplanationOfBenefit, everything), the opposite of what the prose
described and the opposite of this project's actual goal (the 7-type
filter is what gives the ~90% volume reduction the seeding tool exists
for). `--slim` and `--full` were always meant to be mutually exclusive
alternatives, not stackable flags — the real full-*corpus* run (all 983
files) uses **slim mode** (the default), not `--full`.

Also flagged and addressed: the resumability manifest (`.seed-manifest.json`,
Task 9) is keyed only by absolute file path — it has no awareness of which
Medplum project/base URL it was built against, which `mode` was used, or
which version of the transform code produced it. Running against a
different project, switching `--slim`/`--full`, or changing the transform
rules between runs can cause a stale manifest to incorrectly skip files
that were never actually uploaded to *this* target. And a `--limit 50`
smoke test run (Task 10) computes practitioner specialties from a majority
vote over only those 50 bundles. Deterministic PUT means a later full run
can correct the affected `PractitionerRole`s, but mixing a partial smoke
dataset with the final dataset still makes verification unnecessarily
ambiguous, so Task 10 continues to require a disposable project.

**Files:** none (operational).

**Interfaces:**
- Consumes: the full `tools/seed/` pipeline (Tasks 3–9).

- [ ] **Step 1: Confirm Task 10's smoke test ran against a disposable/test project, not this one**

If Task 10's `--limit 50` run was ever pointed at the same Medplum project this task is about to seed, use a fresh project for the final run. A full deterministic-PUT rerun can technically correct the same ids, but a clean target is the auditable release path: smoke-test against a disposable project, seed the real target once in full.

- [ ] **Step 2: Delete any stale manifest for this target**

```bash
rm -f .seed-manifest.json
```

The manifest isn't scoped by target project/mode/transform version — if there's any doubt whether an existing `.seed-manifest.json` was built against a different project or an earlier version of this plan's transform code, delete it rather than risk it silently skipping files that were never actually uploaded to *this* target.

- [ ] **Step 3: Run the full corpus in slim mode**

```bash
npx tsx tools/seed/index.ts --slim
```

(No `--limit` — every file in `fhir/`. `--slim` is the default, spelled out here to be explicit about the actual intent: keep only the 7 app-read resource types, not `--full`, which would ingest Observations/Claims/etc. this application never reads.) Expected: completes without throwing; final log line `Done. Uploaded 983 bundles this run (983 total per manifest).`

- [ ] **Step 4: Spot-check for duplicate Practitioners at full scale**

Pick 5 NPIs at random from the uploaded data and confirm each `Practitioner?identifier=...` search returns exactly one result — the same check as Task 10 Step 4, now meaningful at the full 905-practitioner scale the audit's uniqueness assertion was built for.

- [ ] **Step 5: Commit**

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

Navigate to `/Schedule/:id` (the fork's original provider calendar, modified in Task 2) — confirm it shows booked appointments and any `busy-unavailable` blocks correctly, and that there is no "Set Availability" button or free-slot click-to-book flow remaining. From an `/Appointment/:id/details` page, exercise **Cancel** (confirm it calls the native `$cancel` operation — Task 24 — and both the Appointment status and its Slot are gone) and **Reschedule** (confirm it goes through `$book` — Task 25 — including the case where the new time is unavailable: confirm the original booking is untouched, not double-cancelled or left in a half-changed state). Also re-run **Step 3, Block Availability**: block one doctor's afternoon and confirm only *that* doctor's overlapping appointments are cancelled, not every doctor's (Task 2's `block-availability.ts` scoping fix).

- [ ] **Step 5: Record what's still open**

If every check above passes, the implementation matches every FR in `Doctor_Appointment_Agent_Specs.md`. Any check that fails should be traced back to the specific earlier task that owns that behavior — this plan's task numbering (and the Design/LLD doc sections each task cites) is the map for that.

---

## Correction Passes (final synchronized revision)

This plan was independently audited in multiple passes against real Medplum source
(`hold.ts`, `find.ts`, `book.ts`, `cancel.ts`, `scheduling.ts`,
`scheduling-parameters.ts`), the real fork source, and the real 983-bundle
corpus after its first draft. See `docs/Issues_Audit_Response.md` and
`docs/Issues_Audit_Response_Round2.md` for the historical evidence trail.
The final resolutions are:

1. Booking contract: `$hold`→`$confirm` is replaced with `$book` against the exact result of a fresh Bot-side `$find`; Task 23 is removed entirely.
2. Operation contract: URLs use `medplum.fhirUrl(...)`; `$book` takes a `Parameters` request; `$find` and `$book` return bare Bundles.
3. Trust boundary: the browser supplies only resource ids and start/end; the Bot re-reads and validates all authoritative resources before its own `$find`.
4. $book's revalidation claim corrected — Global Constraints.
5. SchedulingParameters needs a `service` sub-extension and explicit matching `alignmentInterval` per HealthcareService — Task 19.
6. Specialty table was wrong (real Disease_Description.csv order never read) — Task 4, Task 11.
7. Seed identity uses deterministic ids and unconditional PUT for every retained and bootstrap resource; no POST id preservation or conditional-create lookup is assumed — Tasks 6, 8.
8. Seed bundles exceed the default 1 MB limit — Task 7 adds ordered, size-bounded chunking and per-entry failure checks; Task 9 orchestrates it.
9. Task 1 could stage `.claude/`/reference repos — Task 1.
10. Direct bot deploy skipped placeholder resolution and `$deploy` — Task 26.
11. Booking validates and reads the authoritative summary Communication, derives Appointment metadata before `$book`, and uses a read-and-spread update for its post-book link — Task 21.
12. `block-availability` could cancel other doctors' appointments — Task 2.
13. FR-2 history gap + a real compile error — Task 29, Task 28.
14. Queue summaries joined by patient instead of appointment — Task 34.
15. Every `@medplum/*` dependency is pinned to exact `5.1.27`, with identity/version and live scheduling-contract preflights — Tasks 1, 10, 26.
16. Direct cancellation uses atomic native `$cancel`; the custom cancellation Bot is deleted — Task 24.

Also fixed along the way (found while implementing the above, not
originally flagged): the real `Encounter.participant.individual.reference`
shape is a bare `urn:uuid:`, not a conditional reference — Task 5's test
fixture now matches the real corpus; `upload.ts`'s retry logic treated any
structured `OperationOutcome` as non-retryable, including transient 5xxs — Task 7; `agent-patient-chat`'s sender was a hard-coded fake reference and the route's NPI was never checked against a real booking relationship — Task 22, Task 35; a stuck-loader bug in `SlotPickerPage.tsx` after a `slot_taken` response — Task 31; `require.main === module` (a CJS-only idiom) in the ESM seed CLI — Task 9; an emergency-disclaimer line on the complaint form, given the urgency classification this flow does is a scheduling signal, not a clinical judgment — Task 29.

## Self-Review

**Spec coverage** — every FR-1 through FR-15 traces to a task above (FR-1→28, FR-2→29, FR-3/FR-4→29, FR-5/FR-7→30, FR-6→30, FR-8→31 (via 19/20), FR-9/FR-10→31/32 (via 21), FR-11→33/34, FR-12→17/21/34, FR-13/FR-14/FR-15→35 (via 22)). Every bot in the corrected roster has a task (17–22, 25–26); Task 23 is a deliberate removal (documented, not a gap) and Task 24 deliberately deletes a bot in favor of a native operation. The seeding tool's every module (disease-csv, specialty-resolver, pass1-scan, pass2-transform, upload, chunk-bundle, index) has a task (3–9). Every shared lib (geo, ranking, nppes, patientContext, prompts, ensurePractitionerAndSchedule, timezones) has a task (11–16, 19).

**Placeholder scan** — no task defers logic to "add error handling" or similar; every code block is complete, runnable TypeScript. The one deliberately-flagged exception is Task 4's `ENCOUNTER_TYPE_SPECIALTY_MAP`, which ships with a real starting map but explicitly instructs the implementer to reconcile it against the corpus enumeration script's actual output before trusting the completeness test — this is a genuine content dependency on real data that can't be fabricated in a planning document, not a vague placeholder; the task makes the exact mechanism to resolve it (run the script, fill the gaps, let the test enforce completeness) concrete and checkable.

**Type consistency** — `DoctorCandidate`/`RankedCandidate` (Task 13) flow unchanged through `nppes.ts` (14), `agent-find-doctors.ts` (18), and `ensurePractitionerAndSchedule.ts` (19). `IntentInput`/`IntentResult` shapes from `agent-intake.ts` (17) match what `PatientHistoryPage.tsx` (29) destructures (`intent.specialtyCode`, `summaryCommunicationId`). `healthcareServiceIds: {routine, urgent}` is produced once in `ensurePractitionerAndSchedule.ts` (19), passed through `agent-ensure-doctor.ts` (20) unchanged, and consumed with the same shape in `SlotPickerPage.tsx` (31). Task 31 sends exactly Task 21's minimal `BookInput` fields (`patientId`, `practitionerId`, `scheduleId`, `start`, `end`, `summaryCommunicationId`); `SlotOption` carries only display times, while the Bot obtains the authoritative Appointment and clinical metadata from Medplum. The `{ok: true, appointment} | {ok: false, reason: 'slot_taken'}` result shape is identical across `agent-book-appointment.ts` (21) and `reschedule-appointment.ts` (25), both keyed off the same confirmed `'Requested time slot is not available'` string.
