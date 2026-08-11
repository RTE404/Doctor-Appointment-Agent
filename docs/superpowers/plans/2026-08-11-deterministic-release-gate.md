# Deterministic Release Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace machine-speed-dependent Vitest deadlines with deterministic API compilation, corpus auditing, and queue unit-test boundaries so the Gemini 3.1 release can pass a trustworthy gate.

**Architecture:** Keep fast application assertions in Vitest, move Node-ESM graph compilation to a dedicated TypeScript project, and move the 1.14 GB FHIR audit to an explicit command backed by testable helpers. Replace doctor-queue tests' global Medplum initialization with a narrow in-memory client; production application modules remain unchanged.

**Tech Stack:** TypeScript 5.9, Vitest 4, Node.js 22, `tsx`, npm scripts, Medplum/FHIR R4 fixtures.

## Global Constraints

- Do not change production application behavior, Gemini behavior, Vercel configuration, specialty mappings, or FHIR corpus data.
- Do not solve timing failures by raising Vitest test or hook timeouts.
- Preserve the Node-ESM guarantee with ES2022, NodeNext modules and resolution, strict mode, no emit, and skipped library checking.
- Preserve the corpus guarantee: exactly 49 distinct `Encounter.type[].text` values and no uncovered value.
- `npm test` must not compile the serverless graph or scan the full FHIR corpus.
- `npm run test:corpus` is mandatory when `fhir/*.json` or `tools/seed/specialty-resolver.ts` encounter mappings change.
- `npm run verify` must run normal tests, the API ESM check, and the production build.
- `npm run verify:all` must run `verify` followed by the full corpus audit.
- Test fakes must throw on unexpected resource types and operations.
- Preserve every reviewed Gemini migration commit and the safe production failure classifier.

---

### Task 1: Move the API Node-ESM Check Out of Vitest

**Files:**

- Create: `tsconfig.api.json`
- Modify: `package.json`
- Modify: `api/execute.test.ts:1-47`

**Interfaces:**

- Consumes: `api/execute.ts` as the serverless graph entrypoint.
- Produces: `npm run verify:api-esm`, which exits nonzero only for TypeScript diagnostics or command failure.

- [ ] **Step 1: Verify the explicit API check does not exist yet**

Run:

```powershell
npm run verify:api-esm
```

Expected: npm exits nonzero with `Missing script: "verify:api-esm"`. This is the user-approved configuration-only TDD exception; behavior is verified by executing the script after it is added rather than by searching source text.

- [ ] **Step 2: Add the compiler configuration and script**

Create `tsconfig.api.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "files": ["api/execute.ts"]
}
```

Add to `package.json`:

```json
"verify:api-esm": "tsc --project tsconfig.api.json"
```

- [ ] **Step 3: Remove the synchronous compiler test from Vitest**

Delete the `fileURLToPath` and `typescript` imports and the complete test named `compiles the serverless runtime graph with Node ESM import semantics` from `api/execute.test.ts`. Do not alter request-handler tests.

- [ ] **Step 4: Verify the new behavior and commit**

```powershell
npm test -- api/execute.test.ts --maxWorkers=1 --no-file-parallelism
npm run verify:api-esm
git add -- tsconfig.api.json package.json api/execute.test.ts
git diff --cached --check
git commit -m "test: make API ESM verification deterministic"
```

Expected: request-handler tests and TypeScript exit 0; the commit contains exactly the three Task 1 files.

---

### Task 2: Extract the Full FHIR Corpus Audit

**Files:**

- Create: `tools/seed/specialty-corpus.ts`
- Create: `tools/seed/specialty-corpus.test.ts`
- Create: `tools/seed/verify-specialty-corpus.ts`
- Modify: `tools/seed/specialty-resolver.test.ts`
- Modify: `package.json`

**Interfaces:**

- Produces `collectEncounterTypeTexts(bundlePaths: string[]): Set<string>`.
- Produces `validateEncounterTypeCoverage(encounterTypes: ReadonlySet<string>, mapping: ReadonlyMap<string, string>, expectedCount: number): void`.
- Produces `npm run test:corpus`.

- [ ] **Step 1: Write the failing helper tests**

Create `tools/seed/specialty-corpus.test.ts` with four tests:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { collectEncounterTypeTexts, validateEncounterTypeCoverage } from './specialty-corpus';

const temporaryDirectories: string[] = [];
function writeBundle(contents: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'specialty-corpus-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'bundle.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}
afterEach(() => temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe('specialty corpus audit', () => {
  test('collects distinct Encounter type text values', () => {
    const path = writeBundle({ entry: [
      { resource: { resourceType: 'Encounter', type: [{ text: 'Office Visit' }] } },
      { resource: { resourceType: 'Encounter', type: [{ text: 'Office Visit' }, { text: 'Emergency Encounter' }] } },
      { resource: { resourceType: 'Patient' } },
    ] });
    expect([...collectEncounterTypeTexts([path])].sort()).toStrictEqual(['Emergency Encounter', 'Office Visit']);
  });

  test('accepts the expected count when every type is mapped', () => {
    expect(() => validateEncounterTypeCoverage(
      new Set(['Office Visit', 'Emergency Encounter']),
      new Map([['Office Visit', 'General Practice'], ['Emergency Encounter', 'General Practice']]),
      2
    )).not.toThrow();
  });

  test('reports unexpected counts and uncovered types', () => {
    expect(() => validateEncounterTypeCoverage(
      new Set(['Office Visit', 'Unmapped Encounter']),
      new Map([['Office Visit', 'General Practice']]),
      49
    )).toThrow(/expected 49.*found 2.*Unmapped Encounter/i);
  });

  test('fails on malformed corpus JSON', () => {
    const directory = mkdtempSync(join(tmpdir(), 'specialty-corpus-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'broken.json');
    writeFileSync(path, '{');
    expect(() => collectEncounterTypeTexts([path])).toThrow();
  });
});
```

- [ ] **Step 2: Run the helper test and verify RED**

```powershell
npm test -- tools/seed/specialty-corpus.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL because `./specialty-corpus` does not exist.

- [ ] **Step 3: Implement the helper**

Create `tools/seed/specialty-corpus.ts`:

```ts
import { readFileSync } from 'node:fs';

interface BundleLike {
  entry?: Array<{ resource?: { resourceType?: string; type?: Array<{ text?: string }> } }>;
}

export function collectEncounterTypeTexts(bundlePaths: string[]): Set<string> {
  const encounterTypes = new Set<string>();
  for (const path of bundlePaths) {
    const bundle = JSON.parse(readFileSync(path, 'utf8')) as BundleLike;
    for (const entry of bundle.entry ?? []) {
      if (entry.resource?.resourceType !== 'Encounter') continue;
      for (const type of entry.resource.type ?? []) if (type.text) encounterTypes.add(type.text);
    }
  }
  return encounterTypes;
}

export function validateEncounterTypeCoverage(
  encounterTypes: ReadonlySet<string>,
  mapping: ReadonlyMap<string, string>,
  expectedCount: number
): void {
  const uncovered = [...encounterTypes].filter((text) => !mapping.has(text)).sort();
  if (encounterTypes.size !== expectedCount || uncovered.length > 0) {
    throw new Error(`Expected ${expectedCount} distinct encounter types but found ${encounterTypes.size}; uncovered: ${uncovered.length ? uncovered.join(', ') : 'none'}`);
  }
}
```

- [ ] **Step 4: Create the full-corpus CLI**

Create `tools/seed/verify-specialty-corpus.ts`:

```ts
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectEncounterTypeTexts, validateEncounterTypeCoverage } from './specialty-corpus.js';
import { ENCOUNTER_TYPE_SPECIALTY_MAP } from './specialty-resolver.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const corpusDirectory = join(currentDirectory, '../../fhir');
const bundlePaths = readdirSync(corpusDirectory).filter((name) => name.endsWith('.json')).sort().map((name) => join(corpusDirectory, name));
const encounterTypes = collectEncounterTypeTexts(bundlePaths);
validateEncounterTypeCoverage(encounterTypes, ENCOUNTER_TYPE_SPECIALTY_MAP, 49);
console.log(`Verified ${encounterTypes.size} encounter types across ${bundlePaths.length} FHIR bundles.`);
```

- [ ] **Step 5: Verify the corpus command is absent, then add it**

Run:

```powershell
npm run test:corpus
```

Expected: npm exits nonzero with `Missing script: "test:corpus"`. Add to `package.json`:

```json
"test:corpus": "tsx tools/seed/verify-specialty-corpus.ts"
```

Delete the filesystem/path imports, `__dirname`, and full `ENCOUNTER_TYPE_SPECIALTY_MAP completeness` describe block from `specialty-resolver.test.ts`. Remove `ENCOUNTER_TYPE_SPECIALTY_MAP` from that file's import because the remaining tests do not use it. Retain resolver and NUCC tests.

- [ ] **Step 6: Verify GREEN, audit the real corpus, and commit**

```powershell
npm test -- tools/seed/specialty-corpus.test.ts tools/seed/specialty-resolver.test.ts --maxWorkers=1 --no-file-parallelism
npm run test:corpus
git add -- tools/seed/specialty-corpus.ts tools/seed/specialty-corpus.test.ts tools/seed/verify-specialty-corpus.ts tools/seed/specialty-resolver.test.ts package.json
git diff --cached --check
git commit -m "test: separate full FHIR corpus audit"
```

Expected: focused tests pass; audit prints `Verified 49 encounter types across 983 FHIR bundles.`; commit contains the five Task 2 files.

---

### Task 3: Replace Doctor-Queue Global Indexing with a Narrow Fake

**Files:**

- Modify: `src/pages/desk/doctorQueue.test.ts`
- Verify unchanged: `src/pages/desk/doctorQueue.ts`

**Interfaces:**

- Consumes explicit Practitioner, Appointment, Communication, and Patient fixtures.
- Produces a test-local `createQueueClient(resources): MedplumClient` supporting only `searchResources` and `readResource`.

- [ ] **Step 1: Record the passing baseline**

```powershell
npm test -- src/pages/desk/doctorQueue.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: 1 file passes with 4 tests.

- [ ] **Step 2: Replace expensive setup with the narrow fake**

Replace the Medplum indexing, definitions, `MockClient`, `beforeAll`, `Bundle`, and `SearchParameter` imports with these exact type imports:

```ts
import type { MedplumClient } from '@medplum/core';
import type { Appointment, Communication, Patient, Practitioner } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
```

Add this fake above the describe block:

```ts
type QueueFixture = Practitioner | Appointment | Communication | Patient;

function createQueueClient(resources: QueueFixture[]): MedplumClient {
  return {
    searchResources: async (resourceType: string, filters: Record<string, string>) => {
      if (resourceType === 'Practitioner') {
        return resources.filter((resource): resource is Practitioner => resource.resourceType === 'Practitioner')
          .filter((practitioner) => practitioner.identifier?.some((id) => `${id.system}|${id.value}` === filters.identifier));
      }
      if (resourceType === 'Appointment') {
        return resources.filter((resource): resource is Appointment => resource.resourceType === 'Appointment')
          .filter((appointment) => appointment.participant.some((part) => part.actor?.reference === filters.actor));
      }
      if (resourceType === 'Communication') {
        return resources.filter((resource): resource is Communication => resource.resourceType === 'Communication')
          .filter((communication) => communication.recipient?.some((recipient) => recipient.reference === filters.recipient))
          .filter((communication) => communication.category?.some((category) => category.coding?.some((coding) => coding.code === filters.category)));
      }
      throw new Error(`Unexpected search resource type: ${resourceType}`);
    },
    readResource: async (resourceType: string, id: string) => {
      if (resourceType !== 'Patient') throw new Error(`Unexpected read resource type: ${resourceType}`);
      const patient = resources.find((resource): resource is Patient => resource.resourceType === 'Patient' && resource.id === id);
      if (!patient) throw new Error(`Patient/${id} not found`);
      return patient;
    },
  } as unknown as MedplumClient;
}
```

Only `searchResources` and `readResource` are exposed; an unexpected method call therefore fails instead of silently succeeding. Replace the two async tests with explicit fixtures:

```ts
test('loads an appointment attached to any Practitioner sharing the NPI', async () => {
  const firstPractitioner: Practitioner = {
    resourceType: 'Practitioner',
    id: 'practitioner-1',
    identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }],
  };
  const relationshipPractitioner: Practitioner = {
    resourceType: 'Practitioner',
    id: 'practitioner-2',
    identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }],
  };
  const patient: Patient = {
    resourceType: 'Patient',
    id: 'patient-1',
    name: [{ given: ['Ada'], family: 'Lovelace' }],
  };
  const appointment: Appointment = {
    resourceType: 'Appointment',
    id: 'appointment-1',
    status: 'booked',
    start: '2026-08-11T13:00:00Z',
    description: 'Follow-up visit',
    participant: [
      { actor: { reference: 'Patient/patient-1' }, status: 'accepted' },
      { actor: { reference: 'Practitioner/practitioner-2' }, status: 'accepted' },
    ],
  };
  const summary: Communication = {
    resourceType: 'Communication',
    id: 'summary-1',
    status: 'completed',
    category: [{ coding: [{ code: 'ai-previsit-summary' }] }],
    recipient: [{ reference: 'Practitioner/practitioner-2' }],
    about: [{ reference: 'Appointment/appointment-1' }],
    payload: [{ contentString: 'Prepared summary' }],
  };
  const medplum = createQueueClient([
    firstPractitioner,
    relationshipPractitioner,
    patient,
    appointment,
    summary,
  ]);

  const entries = await loadDoctorQueueEntries(medplum, '1234567890');

  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    appointmentId: 'appointment-1',
    patientId: 'patient-1',
    summary: 'Prepared summary',
  });
});

test('deduplicates an appointment returned for multiple matching Practitioners', async () => {
  const firstPractitioner: Practitioner = {
    resourceType: 'Practitioner',
    id: 'practitioner-1',
    identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }],
  };
  const secondPractitioner: Practitioner = {
    resourceType: 'Practitioner',
    id: 'practitioner-2',
    identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }],
  };
  const patient: Patient = { resourceType: 'Patient', id: 'patient-1' };
  const appointment: Appointment = {
    resourceType: 'Appointment',
    id: 'appointment-1',
    status: 'booked',
    participant: [
      { actor: { reference: 'Patient/patient-1' }, status: 'accepted' },
      { actor: { reference: 'Practitioner/practitioner-1' }, status: 'accepted' },
      { actor: { reference: 'Practitioner/practitioner-2' }, status: 'accepted' },
    ],
  };
  const medplum = createQueueClient([firstPractitioner, secondPractitioner, patient, appointment]);

  const entries = await loadDoctorQueueEntries(medplum, '1234567890');

  expect(entries).toHaveLength(1);
  expect(entries[0].appointmentId).toBe('appointment-1');
});
```

- [ ] **Step 3: Verify behavior, boundary, and commit**

```powershell
npm test -- src/pages/desk/doctorQueue.test.ts --maxWorkers=1 --no-file-parallelism
git diff --exit-code -- src/pages/desk/doctorQueue.ts
git add -- src/pages/desk/doctorQueue.test.ts
git diff --cached --check
git commit -m "test: isolate doctor queue fixtures"
```

Expected: 4 tests pass, production file is unchanged, and the commit contains only the test file.

---

### Task 4: Add and Exercise the Deterministic Release Commands

**Files:**

- Modify: `package.json`

**Interfaces:**

- Consumes: `npm test`, `verify:api-esm`, `npm run build`, and `test:corpus` from Tasks 1-2.
- Produces `npm run verify` and `npm run verify:all`.

- [ ] **Step 1: Verify the release commands do not exist yet**

```powershell
npm run verify
npm run verify:all
```

Expected: each command exits nonzero with its corresponding `Missing script` message. This is the user-approved configuration-only TDD exception; the scripts are verified by actually running their behavior after creation.

- [ ] **Step 2: Add the exact scripts**

Add to `package.json`:

```json
"verify": "npm test && npm run verify:api-esm && npm run build",
"verify:all": "npm run verify && npm run test:corpus"
```

- [ ] **Step 3: Run every gate**

```powershell
npm run verify
npm run verify:all
```

Expected: normal Vitest, API ESM check, production build, and corpus audit pass. `verify:all` prints the 49-type/983-bundle line.

- [ ] **Step 4: Run static checks and commit**

```powershell
npx tsc --noEmit
npx eslint api/execute.test.ts src/pages/desk/doctorQueue.test.ts tools/seed/specialty-corpus.ts tools/seed/specialty-corpus.test.ts tools/seed/verify-specialty-corpus.ts tools/seed/specialty-resolver.test.ts
git diff --check
git add -- package.json
git diff --cached --check
git commit -m "test: add deterministic release commands"
```

Expected: all commands exit 0 and the commit contains only `package.json`.

---

### Task 5: Review, Publish, and Validate the Combined Release

**Files:**

- Commit: `docs/superpowers/plans/2026-08-11-deterministic-release-gate.md`
- Verify: all files changed since `origin/main`.
- Do not modify additional production files.

**Interfaces:**

- Consumes: reviewed Gemini migration and deterministic-gate commits.
- Produces: a clean fast-forward `main` push, a Ready Vercel deployment, and one user-triggered production retry.

- [ ] **Step 1: Commit this implementation plan**

```powershell
git add -- docs/superpowers/plans/2026-08-11-deterministic-release-gate.md
git diff --cached --check
git commit -m "docs: plan deterministic release gate"
```

- [ ] **Step 2: Review the exact branch state**

```powershell
git status -sb
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: status is clean and the diff contains only approved Gemini migration and deterministic-gate docs, tests, and configuration.

- [ ] **Step 3: Re-run the application release gate**

```powershell
npm run verify
```

Expected: normal Vitest, API ESM checking, and production build exit 0.

- [ ] **Step 4: Fetch and verify fast-forward safety**

```powershell
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git status --short
```

Expected: ancestor check exits 0 and status is empty. If `origin/main` advanced, stop and reconcile before pushing.

- [ ] **Step 5: Stop at the independent whole-branch review boundary**

Do not push yet. Return the current HEAD, clean-status evidence, `npm run verify` result, and fast-forward-safety result to the root controller. The controller must generate the full `origin/main..HEAD` review package and obtain a clean independent whole-branch review before resuming this task.

Expected: no remote state changes; the branch is ready for independent final review.

- [ ] **Step 6: Push to main after final-review approval**

```powershell
git push origin HEAD:main
```

Expected: Git reports a successful fast-forward update.

- [ ] **Step 7: Confirm Vercel readiness**

Record the pushed commit and inspect the deployed branch URL with the authenticated Vercel CLI:

```powershell
$releaseCommit = git rev-parse HEAD
npx vercel inspect https://doctor-appointment-agent-git-main-rte404s-projects.vercel.app
Write-Output "Expected Git commit: $releaseCommit"
```

Expected: `vercel inspect` reports `status: Ready`. Confirm its Git source commit equals `$releaseCommit`; if it does not, wait for the matching deployment instead of testing an older build. Record the resolved deployment URL, commit, and status.

- [ ] **Step 8: Validate the production symptom**

Have the user click Find a Doctor once, then query the resulting production logs:

```powershell
npx vercel logs https://doctor-appointment-agent-git-main-rte404s-projects.vercel.app --since 5m --json
```

Expected: the new `/api/execute` request does not emit `gemini-http-404`. If it fails with a different safe code, retain that evidence and return to root-cause investigation rather than changing another model speculatively.
