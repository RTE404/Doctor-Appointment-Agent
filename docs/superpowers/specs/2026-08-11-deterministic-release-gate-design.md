# Deterministic Release Gate

## Problem

The release gate currently runs heavyweight synchronous work inside Vitest
tests with fixed wall-clock limits. Correct code can therefore fail solely
because the machine is slow or busy:

- `api/execute.test.ts` compiles the complete serverless Node-ESM import graph
  inside a 15-second test.
- `specialty-resolver.test.ts` reads and parses the repository's 1.14 GB FHIR
  corpus inside a 60-second test.
- `doctorQueue.test.ts` initializes large global Medplum definition indexes in
  a default-timeout hook even though the unit under test needs only three
  client methods.

The Gemini 3.1 migration did not modify these tests or their underlying heavy
inputs. Focused diagnosis confirmed the API compile check also exceeds its
deadline against the previous `origin/main` graph while producing zero
TypeScript diagnostics. The current gate therefore mixes correctness with
machine speed and blocks otherwise verified releases nondeterministically.

## Goals

- Make normal application tests pass or fail on assertions rather than machine
  speed.
- Preserve the Node-ESM serverless compilation check as an explicit release
  check.
- Preserve the full FHIR corpus-to-specialty completeness audit as an explicit
  data audit.
- Remove unnecessary global Medplum indexing from the doctor-queue unit tests.
- Provide one deterministic application release command.
- Change no production application behavior.

## Non-goals

- Raising Vitest timeouts until the current machine happens to pass.
- Dropping the Node-ESM compilation guarantee or the specialty completeness
  guarantee.
- Optimizing or rewriting the 1.14 GB FHIR corpus.
- Changing specialty mappings, FHIR seed data, doctor-queue behavior, Gemini
  behavior, or Vercel configuration.
- Introducing a new test framework or dependency.

## Design

### Normal application release gate

Add an `npm run verify` script that runs, in order:

1. the normal Vitest suite;
2. the explicit Node-ESM API compile check; and
3. the existing production build.

The command succeeds only when each child command exits successfully. It does
not impose in-test deadlines on synchronous compiler or corpus work. Existing
lint checks remain separate and are run against every changed TypeScript file
before publication.

### Node-ESM API compilation

Move the serverless import-graph compilation assertion out of
`api/execute.test.ts`. Add a dedicated `tsconfig.api.json` that uses the current
test's exact compiler semantics: ES2022 target, NodeNext module and resolution,
strict mode, no emit, and skipped library checking, with `api/execute.ts` as the
entrypoint.

Expose the check as `npm run verify:api-esm`. The TypeScript process exits
nonzero for real diagnostics and is allowed to take the time required by the
current machine. The remaining request-handler tests stay in
`api/execute.test.ts`.

### FHIR specialty corpus audit

Move the full-corpus completeness check out of the normal Vitest collection
into `tools/seed/verify-specialty-corpus.ts`. The command reads the FHIR bundle
files one at a time, collects every distinct `Encounter.type[].text`, and fails
if the distinct count is not 49 or any value lacks an
`ENCOUNTER_TYPE_SPECIALTY_MAP` entry.

Expose the audit as `npm run test:corpus`. It has no internal wall-clock
deadline and remains required whenever either of these change:

- any `fhir/*.json` corpus file; or
- `tools/seed/specialty-resolver.ts` encounter-type mappings.

It is not part of `npm test` or the release gate for unrelated application
changes. Add `npm run verify:all` as the explicit data-change gate; it runs the
normal `verify` command followed by `test:corpus`. The extraction and
validation logic will be separated from the CLI entrypoint so small synthetic
bundles can test the audit behavior without reading the real corpus.

### Doctor-queue tests

Replace the `MockClient` plus global Medplum definition indexing in
`doctorQueue.test.ts` with a small in-memory fake implementing only the methods
used by `loadDoctorQueueEntries`: `searchResources` and `readResource`.

The fake will return explicit Practitioner, Appointment, Communication, and
Patient fixtures according to the requested resource type and search filters.
The existing queue assertions remain unchanged in meaning: relationship lookup,
selection across duplicate NPIs, deduplication, patient loading, and summary
joining must still be covered. Production `doctorQueue.ts` is not modified.

## Error Handling

- `verify:api-esm` exits nonzero and prints TypeScript diagnostics when the
  serverless graph is invalid.
- `test:corpus` exits nonzero with the unexpected count and uncovered encounter
  types when the corpus and mapping drift.
- Malformed or unreadable corpus JSON fails the audit rather than being skipped.
- Unit-test fakes throw on unexpected resource types or operations so an
  unmodeled production dependency cannot silently pass.
- No test succeeds by suppressing, retrying, or ignoring a failed assertion.

## Testing and Release

Implementation will use test-first cycles for the corpus-audit helper and the
doctor-queue fake behavior. Verification must demonstrate:

1. `npm test` passes without the heavyweight corpus or in-test compiler work.
2. `npm run verify:api-esm` completes with zero diagnostics.
3. Focused corpus-audit tests pass on small fixtures, including uncovered types
   and malformed JSON.
4. `npm run test:corpus` completes successfully against the current full corpus.
5. `npm run verify` completes successfully.
6. `npm run verify:all` completes successfully when exercising the data-change
   gate during implementation.
7. TypeScript, changed-file lint, production build, and Git diff checks pass.

After independent task and whole-branch review, the deterministic gate repair
and the already completed Gemini 3.1 migration will be pushed together to
`main`. Vercel must report the pushed commit Ready before the user retries Find
a Doctor and the production `/api/execute` result is inspected.
