# Doctor Appointment Agent — Definitive Re-scan (Round 3)

> ## ROUND 4 RE-VERIFICATION — 2026-08-06 (superseding notice)
>
> Every finding in this file was independently re-checked against the actual
> Medplum source and the current state of
> `docs/superpowers/plans/2026-08-04-medplum-native-implementation.md` at
> commit `f77666d` (`main`). Two commits landed after this file was written —
> `3c9ed87` ("docs: synchronize design set with implementation plan") and
> `f77666d` ("fix: correct 4 confirmed defects from the round-3/round-4
> re-scan") — and fixed most of what is flagged below **without updating this
> file**. A status tag (`FIXED`, `STILL OPEN`, `PARTIALLY FIXED`, or `DOES NOT
> HOLD`) has been added under each finding's heading recording what was found
> on re-check. The original round-3 body text below is left intact as the
> historical record of what was true when it was written.
>
> **Round 4 headline result: all 5 P0 blockers are now fixed.** The original
> verdict immediately below ("NOT CLEARED... not safe to implement") no
> longer applies to the P0 tier. It is retained for historical record only —
> see the **Round 4 Re-verification Summary** near the end of this file for
> the current bottom line and the revised closure order.

**Re-scan date:** 2026-08-05

**Repository commit reviewed:** `7c78b05` (`main`, 6 commits ahead of `origin/main`)

**Verdict (round 3, historical — see Round 4 banner above):** **NOT CLEARED — keep this file. The current plan is not safe to implement as written.**

The latest correction pass did fix several findings from the previous report.
It did not fix everything, and it introduced or exposed new release blockers.
In particular:

- the seed design is based on the opposite of Medplum's actual POST-ID behavior;
- every planned `$book`/`$cancel` POST uses a non-FHIR URL and will hit the
  wrong endpoint;
- the documented “983-bundle slim run” can only select 50 bundles;
- the seed CLI still imports an ESM module that uses undefined `__dirname`;
- the documented direct Bot deployment command is broken in this repository's
  PowerShell environment.

There is also still no application at the repository root: no `package.json`
and no `src/` directory exist. The 6,579-line implementation plan contains
proposed code, not executed code. No root build, test suite, UI, seed run, Bot
deployment, or live Medplum workflow currently exists to verify.

## What this repository is trying to build

A Medplum-native synthetic-data POC with two connected surfaces:

- **Patient flow:** select a Synthea patient, view history, describe a
  complaint, obtain an LLM-generated specialty/reason/urgency/summary, rank a
  prior physician plus NPPES candidates, synthesize a Schedule, find slots, and
  book through Medplum scheduling operations.
- **Doctor flow:** enter an NPI, see appointments and pre-visit summaries for
  that Practitioner, and ask a record-grounded AI assistant factual questions
  about a patient.
- **Runtime/data:** React/Vite frontend forked from
  `medplum-scheduling-demo`; Medplum as the only datastore/backend; Medplum
  Bots for server-side logic; 983 Synthea Bundles for demo data; NPPES for
  directory data; Gemini for intake and chat.

That goal is coherent as a synthetic demonstration. The current written
implementation cannot produce it reliably yet.

## Status of the previous round's 12 P0 findings

| Prior finding | Current status | Re-scan result |
|---|---|---|
| `$find`/`$book` response parsing | **Code fixed; prose stale** | Tasks 21, 25, and 31 now parse direct Bundles correctly. Global Constraint line 20 still says the outputs are Parameters. |
| Missing Patient participant | **Partly fixed** | Task 21 appends a Patient participant. It does not validate or replace caller-supplied Patient participants, proposal ownership, Schedule, service, Practitioner, or summary ownership. |
| Post-book failure reported as booking failure | **Symptom fixed; consistency unresolved** | Errors are swallowed after `$book`, so the UI is no longer told the booking failed. The Appointment metadata and Communication link can now be silently lost with no retry/recovery marker. |
| Generated PractitionerRoles dropped | **Retention fixed; references still broken** | Task 7 now retains PractitionerRole in the identity wave. Task 6 still points it at an ID Medplum does not preserve. |
| Chunk references dangling | **Field coverage fixed; identity premise wrong** | The new rewriter covered all 171,157 internal references found in the current 983-bundle scan, but rewrites every one to a client ID that Medplum replaces. |
| Batch entry failures ignored | **Mostly fixed** | Batch response statuses are inspected. Missing response entries, retry classification, delay/backoff, and contextual recovery remain open. |
| Slim/full behavior and manifest | **Partly fixed; new blocker** | Extra full-mode types are no longer dropped and the contradictory `--slim --full` command was removed. The replacement `--slim` command still selects only the default 50 files. Manifest scoping remains manual. |
| Bootstrap idempotency/fixed references | **HealthcareServices fixed; Device not fixed** | Both HealthcareServices now carry their conditional identifiers. `Device/ai-appointment-agent` still relies on a client ID Medplum overwrites. |
| Windows seed CLI startup | **Main check fixed; imported module still crashes** | `pathToFileURL(process.argv[1])` and credential validation are correct. `specialty-resolver.ts` still uses bare `__dirname` under `"type": "module"`. |
| Every Bot deployed with same Binary | **Matching logic fixed; Windows command broken** | Binary matching and the admin Bot-creation endpoint are corrected. PowerShell expands the script's `\$bot`/`\$deploy` text, and the command does not load `.env`. |
| NPPES state handling | **Core state bug fixed; result correctness open** | Full state names are normalized and state-only fallback exists. Taxonomy selection, deactivation, validation, timeout/retry, and provider-status semantics remain open. |
| Conflicting authoritative documents | **Precedence improved; not reconciled** | Seven banners establish precedence. Their bodies remain knowingly stale, two audit responses still claim completion, and the latest plan now contradicts itself. |

---

## P0 — current execution blockers

### P0-01 — the seed reference model is based on a false Medplum ID assumption

> **Round 4 status: FIXED (commit `3c9ed87`).** Task 6 was rewritten to stop
> assuming POST preserves a client-supplied id. It now writes every retained
> and bootstrap resource via deterministic, unconditional `PUT
> ResourceType/{stableId}` and attaches `identifier` only for audit/search —
> "no POST id preservation or conditional-create lookup is assumed" (plan
> correction-pass note, current file). The Medplum-side finding
> (`resolveCreateIdentity()` regenerates ids on POST) is still correct and
> version-stable; it's just no longer relevant because the plan no longer
> relies on POST for identity-bearing creates.

Task 6 repeatedly states that a client-supplied `resource.id` is preserved for
a POST inside either a batch or transaction Bundle (plan lines 906–917,
1,150–1,156, 1,635–1,639, and 1,704–1,708). It therefore rewrites source URNs
before upload to references such as `Patient/{synthea-id}` and
`Practitioner/{synthea-id}`.

Medplum does the opposite. In
[`batch.ts`](medplum/packages/fhir-router/src/batch.ts),
`resolveCreateIdentity()` assigns `entry.resource.id = this.repo.generateId()`
for a POST that is not resolved to an existing conditional-create match (line
543 in the inspected checkout). The same statement exists in the exact
`v5.0.12` tag pinned by the fork. The later `{batch: true}`/`assignedId` path
preserves the ID that the bundle preprocessor just generated; it does not
restore the caller's original ID.

Fresh corpus verification:

| Current corpus fact | Count |
|---|---:|
| Parsed Bundles | 983 / 983 |
| Total Bundle entries | 432,827 |
| Entries kept by slim mode | 63,065 |
| Internal URN references in kept resources | 171,157 |
| Internal references covered by Task 6's listed rewrite fields | 171,157 |
| Internal references targeting another kept resource | 171,157 |

The rewrite coverage is now complete for this corpus, but all 171,157
references are rewritten to the wrong final identity. Consequences:

- every Patient/Practitioner/Organization/Encounter/Condition/
  MedicationRequest/AllergyIntolerance relationship can be dangling;
- generated PractitionerRoles point at `Practitioner/{synthea-id}`, not the
  created or conditionally-found Practitioner;
- the PractitionerRole `ifNoneExist` query uses the same wrong reference;
- repeat runs do not fix the links because a conditional-create match maps the
  entry `fullUrl` to the existing server ID, while the plan has already removed
  that URN from its references;
- the bootstrap Device's literal `id: ai-appointment-agent` is also replaced,
  so every hard-coded `sender: Device/ai-appointment-agent` is invalid.

**Required correction:** retain transaction `fullUrl` references wherever
resources are created together, and create a real source-identity → server-ID
map from response Bundles for later waves/chunks; or use a verified assigned-ID
update/upsert design. Test it against a live `v5.0.12`-compatible server,
including repeat upload and a zero-dangling-reference audit. Do not infer final
IDs from source IDs when using POST.

### P0-02 — all planned `$book` and `$cancel` POSTs target the wrong URL

> **Round 4 status: FIXED (commit `3c9ed87`).** A whole-file check for bare
> `medplum.post('...')` strings turns up exactly one hit today, and it's the
> unrelated (and correct) admin bot-creation endpoint. Every `$book`/`$cancel`
> call in Tasks 21, 24, and 25 now uses `medplum.fhirUrl('Appointment',
> '$book')` / `medplum.fhirUrl('Appointment', id, '$cancel')`, and the tests
> assert against the resolved URL rather than a stub string.

The plan calls:

- `medplum.post('Appointment/$book', ...)` in Tasks 21 and 25 (lines 4,247
  and 4,822);
- ``medplum.post(`Appointment/${id}/$cancel`, {})`` in Tasks 24 and 25
  (lines 4,583 and 4,864).

`MedplumClient.post()` is a low-level URL call. For a non-HTTP string,
`fetchWithRetry()` joins it to `client.baseUrl`, not `client.fhirBaseUrl`
([`client.ts`](medplum/packages/core/src/client.ts), line 3,795). The plan's
own `.env` sets `MEDPLUM_BASE_URL=https://api.medplum.com/`, so these calls go
to paths such as:

```text
https://api.medplum.com/Appointment/$book
```

instead of:

```text
https://api.medplum.com/fhir/R4/Appointment/$book
```

The same behavior exists in the pinned `v5.0.12` source. Medplum's own client
example explicitly uses
`medplum.post(medplum.fhirUrl('Appointment', '$book'), parameters)`
([`client.ts`](medplum/packages/core/src/client.ts), line 1,320; also
[`examples/src/scheduling/book.ts`](medplum/packages/examples/src/scheduling/book.ts)).

The unit tests hide this because their mocks intercept the same incorrect
literal strings. Once deployed, new booking, cancellation, and rescheduling
will fail before response parsing matters.

**Required correction:** construct every FHIR operation URL with
`medplum.fhirUrl(...)` (or a verified `fhir/R4/...` URL), and add a contract
test that asserts the fully resolved request URL rather than only matching a
stub string.

### P0-03 — the "full 983-bundle slim run" uploads only 50 Bundles

> **Round 4 status: FIXED (commit `f77666d`).** `--limit`/`--all` were
> decoupled from `--slim`/`--full` — a new `--all` flag clears the limit, and
> `--slim`/`--full` only affect transform mode now. Task 36's documented
> command is now `npx tsx tools/seed/index.ts --slim --all`, which does
> select all 983 files, with an explicit inline note that `--slim` alone
> would still silently cap at 50. (The literal sentence "`--slim` alone
> selects 50 files" is still true in isolation — it's just no longer the
> command the plan instructs anyone to run.)

`parseCliArgs()` initializes `limit: 50` (line 1,954). `--full` clears that
limit, but `--slim` only changes `mode` and leaves the limit at 50 (lines
1,956–1,963).

Task 36 now runs:

```bash
npx tsx tools/seed/index.ts --slim
```

and claims that omitting `--limit` means all 983 files. It does not: this exact
command selects 50 files. There is currently no documented CLI form for
“all files in slim mode.” The expected `983 total per manifest` line can never
be reached by the prescribed command.

**Required correction:** separate selection from transform mode, for example
`--all --mode slim`, or make the production default unlimited and require an
explicit development limit. Reject mutually contradictory flags and test Task
36's exact argument vector.

### P0-04 — the seed CLI still crashes under the planned ESM configuration

> **Round 4 status: FIXED (commit `f77666d`).** `specialty-resolver.ts` now
> defines `const __dirname = dirname(fileURLToPath(import.meta.url));` before
> its import-time CSV read. A full-file grep for `__dirname` today shows
> every use site preceded by the same ESM-safe shim in its code block; none
> of the five originally-cited bare occurrences remain bare.

The fork's `package.json` sets `"type": "module"`. Task 9 correctly defines
`__dirname` in `index.ts`, but `index.ts` imports `pass1-scan.ts`, which imports
`specialty-resolver.ts`; that production module executes this at import time:

```ts
const DISEASE_NAMES = parseDiseaseDescriptions(
  join(__dirname, '../../Disease_Description.csv')
);
```

Bare `__dirname` is undefined in Node ESM. The CLI fails while loading modules,
before its newly-fixed `isMainModule`, credential validation, dry run, or
upload logic can execute.

The plan contains five remaining bare uses (lines 299, 428, 431, 523, and
1,727); line 523 is the direct runtime blocker, while the others make the test
files/config test inconsistent with the ESM setup.

**Required correction:** define paths from `import.meta.url` in every runtime
module and use an ESM-safe fixture-root helper in tests. Add an actual
`npx tsx tools/seed/index.ts --dry-run --limit 1` process-level smoke test.

### P0-05 — the direct Bot deployment command is not runnable in PowerShell

> **Round 4 status: FIXED (commit `f77666d`).** Task 26 no longer embeds
> source in a shell string. It's replaced by a checked-in
> `tools/deploy-bots-direct.ts` that imports `dotenv/config` itself, validates
> the three Medplum env vars are set, and uses plain unescaped `$bot-`/
> `$deploy` string literals since it's real TypeScript, not a PowerShell
> string. The run command (`npx tsx tools/deploy-bots-direct.ts`) is
> identical in Bash and PowerShell.

Task 26 wraps a long `tsx -e` program in a PowerShell double-quoted string and
tries to protect placeholder dollars with backslashes:

```text
'\$bot-' ...
'\$deploy'
```

Backslash does not escape `$` in PowerShell. A fresh shell expansion produced:

```text
replaceAll('\-name-reference') post('\')
```

so the placeholder replacement and deploy operation name are destroyed before
`tsx` sees the script. In addition, unlike the seed CLI, this inline script
does not import `dotenv/config`; the `.env` file created by the plan is not
automatically loaded, so the three Medplum environment values are undefined
unless the operator manually exports them first.

The Upload Data UI is documented as an alternative and may avoid these two
specific problems, but the required scripted/CI deployment path is broken on
the repository's actual Windows/PowerShell environment.

**Required correction:** create a checked-in `tools/deploy-bots.ts` (or repair
the existing deployment script), load and validate configuration explicitly,
avoid shell-embedded source code, and verify each deployed Bot's code hash plus
one invocation per Bot.

---

## P1 — high-risk correctness, safety, and completeness gaps

### P1-01 — booking still trusts a browser-authored clinical/scheduling object

> **Round 4 status: PARTIALLY FIXED (commit `3c9ed87`).** The core premise no
> longer holds — `agent-book-appointment.ts`'s `BookInput` is now plain
> identifiers only (`patientId, practitionerId, scheduleId, start, end,
> summaryCommunicationId`), explicitly "not trusted clinical content." The
> handler now re-reads and verifies the Patient/Practitioner/Schedule/
> Communication server-side, validates the summary Communication belongs to
> that Patient and has `preparation` status, validates the Practitioner's
> specialty and the Schedule's ownership/service, re-runs `$find` itself, and
> calls `validateProposal()`, which throws on an existing/duplicate Patient
> participant or a mismatched Slot/Schedule/Practitioner. `urgency` is now
> validated to be exactly `routine`/`urgent`. **What still survives:**
> complaint/reason length is only checked for presence, not bounded, and the
> post-`$book` Communication-link write is still a separate step whose
> failure is caught, logged, and swallowed with no `metadataPending` signal —
> narrower than originally described (metadata like description/reasonCode/
> priority is now baked into the booking call itself, only the Communication
> re-link is still a silent-failure risk).

The Patient participant fix is necessary but insufficient. Task 21 blindly
appends `Patient/${patientId}` to the browser-supplied proposal. It does not:

- reject an existing different/duplicate Patient participant;
- read and verify the Patient;
- prove the contained Slot and Schedule came from the selected Practitioner;
- prove the service matches the intended routine/urgent HealthcareService;
- verify `summaryCommunicationId` belongs to that Patient and intake request;
- bind the operation to the selected NPI or candidate;
- validate complaint/reason length or the `urgency` value at runtime.

Its own success fixture already starts with a Patient participant and then
appends another one with a different MockClient-generated Patient ID; the test
only asserts containment, so it accepts a two-patient Appointment.

After `$book`, Appointment metadata and the summary link are separate writes.
Failures are caught and logged, and `{ok: true}` is returned with no
`metadataPending` signal or recovery record. This avoids a false “booking
failed” message but silently violates FR-12 and can return a response missing
the fields the queue depends on.

### P1-02 — rescheduling can create double bookings and inconsistent summaries

> **Round 4 status: STILL OPEN.** Re-verified directly against the current
> `reschedule-appointment.ts`: the same 4-step sequence (book new → copy
> metadata → move summary → cancel old) runs with no try/catch or
> compensation logic across steps 2–4, and the summary search is still an
> unpaginated `searchResources()` filtered in memory. Tests still cover only
> full success and a `$book` slot-conflict rejection.

Task 25 performs four independent state changes:

1. book the new Appointment;
2. copy metadata to it;
3. move the summary Communication;
4. cancel the original Appointment.

Any failure after step 1 leaves a new booking committed. A failure before step
4 leaves both old and new appointments booked; a failure around step 3 can
move the summary while the old Appointment remains active. The handler throws
after the new booking exists, inviting retries and further duplicates. The
tests cover only complete success and a `$book` slot conflict, not failures in
steps 2–4.

The summary search is unpaginated and then filtered in memory, so it can also
miss the correct Communication for patients with many summaries.

### P1-03 — Schedule provisioning still reuses invalid Schedules and assigns wrong timezones

> **Round 4 status: STILL OPEN.** Re-verified: an existing Schedule is still
> returned as-is with no repair of services/alignment/timezone.
> `SlotPickerPage.tsx` still calls the ensure-doctor bot with only `{ npi }` —
> no candidate — so `timezoneForState(undefined)` still falls back to
> `America/New_York` for a previously-seeded Practitioner without a Schedule.

The per-service `SchedulingParameters` and explicit alignment intervals are
now correct improvements. Remaining problems:

- the fork's `App.tsx` auto-creates a bare Schedule for a logged-in
  Practitioner;
- `ensurePractitionerAndSchedule()` returns the first existing Schedule
  without checking/repairing its services, extensions, alignment, actor count,
  timezone, or availability;
- if a Practitioner already exists but has no Schedule, timezone comes only
  from `candidate?.address.state`; the slot page does not pass the chosen
  candidate, so a previous Synthea physician silently gets New York;
- all supplied patients are in Massachusetts, but the seeder also assigns the
  same default New York timezone to every imported Practitioner;
- one timezone per state is not reliable for multi-time-zone states.

The Round 2 response explicitly says the bare-Schedule repair was left open.

### P1-04 — blocking availability can miss overlaps and orphan busy Slots

> **Round 4 status: STILL OPEN.** Re-verified: `block-availability.ts`'s only
> change is an `actor=` filter added to the existing `date=lt.../date=ge...`
> range query. FHIR's `date` search parameter still indexes only
> `Appointment.start`, so an appointment starting before the block and ending
> inside it is still missed. Still batch-status-update instead of native
> `$cancel` (inconsistent with Task 24, which does use native `$cancel`), and
> the booked Slot is still left behind as orphaned/busy.

Task 2 only adds Practitioner actor scoping to the retained
`block-availability.ts`. The bot still:

- uses a start-date-range query rather than a verified general interval
  overlap check, so an Appointment beginning before the block and ending in it
  can be missed;
- updates Appointment status to cancelled in a batch instead of calling the
  native atomic `$cancel` operation;
- leaves the booked Appointment's Slot behind, allowing stale busy Slots to
  suppress future `$find` results;
- does not inspect per-entry batch failures.

This is inconsistent with Task 24's correct decision to use native `$cancel`
elsewhere.

### P1-05 — specialty inference is still deliberately incomplete

> **Round 4 status: STILL OPEN.** Re-verified: `ENCOUNTER_TYPE_SPECIALTY_MAP`
> still ships exactly 21 entries with an explicit "fill in the rest" note to
> the implementer. The tier-1 JSDoc still claims linked `Condition.code.text`
> is used, but `pass1-scan.ts` still never dereferences a Condition — a
> confirmed doc/code contradiction. File selection is still
> `readdirSync()`-based with no `.sort()`, feeding an unreproducible,
> iteration-order-dependent majority vote.

- The corpus has 49 distinct `Encounter.type[].text` values. Task 4 ships 21
  starter mappings and tells the implementer to fill the remaining 28 before
  proceeding. This is an explicit unresolved content task, not “complete,
  runnable TypeScript.”
- The plan says tier 1 includes linked `Condition.code.text`; `pass1-scan.ts`
  never dereferences linked Conditions.
- The seed and runtime label→NUCC maps are duplicated. No test compares them
  across the module boundary.
- Majority-vote ties depend on input iteration order; `readdirSync()` is not
  sorted, so partial-run results and tie winners are not reproducible.
- Synthea “NPI” values are deliberately short/fake (for example `290`), while
  the UI and model use the same field name for real 10-digit NPPES NPIs. The
  distinction is documented but not consistently communicated in the UI.

### P1-06 — NPPES candidates are not verified as the requested, active provider type

> **Round 4 status: STILL OPEN.** Re-verified against current `nppes.ts`:
> `mapResult()` still picks `taxonomies.find(t => t.primary) ?? taxonomies[0]`
> regardless of which taxonomy matched the search term, still has no
> post-filter by requested NUCC code, no NPI digit/length validation, and
> `nppesFetch` is still a bare `fetch()` with no timeout/retry/429 handling.

State normalization and fallback are fixed. The mapper still chooses the
result's **primary** taxonomy rather than the taxonomy that satisfied the
requested search, and there is no post-filter requiring the requested NUCC
code. It assumes non-empty taxonomy/basic/address arrays, does not validate
10-digit NPI input, has no timeout/retry/429 handling, and does not inspect
deactivation/reactivation fields.

The official NPPES API also warns that issuance of an NPI does not validate
licensure or credentialing. The product generates fictional availability for
real NPPES identities, yet the confirmation UI says “Appointment Confirmed”
and tells the user to give the NPI to the front desk without stating that no
real practice received a booking. The docs say scheduling is synthetic; the
runtime confirmation must say this just as plainly.

Source: [official NPPES API help](https://npiregistry.cms.hhs.gov/api-page).

### P1-07 — AI urgency and emergency behavior remain an unresolved clinical decision

> **Round 5 status (2026-08-06): RESOLVED BY PRODUCT DECISION — the first
> horn of this finding's own recommended fork.** The team decided: no
> urgency/triage classification at all. This is a POC where a patient just
> wants to see a doctor — not a clinical triage system, no labels. The
> `routine`/`urgent` field has been removed everywhere: `INTAKE_SYSTEM_PROMPT`
> no longer asks the model to classify it, `IntakeResult`/`BookingIntent`
> carry no `urgency` field, `Communication.priority`/`Appointment.priority`
> were dropped, and the second "Urgent Visit" HealthcareService (and its
> 15-minute duration / second `SchedulingParameters` extension) was removed
> — there is now exactly one visit type. The static "if this is a medical
> emergency, call 911" line on the complaint form is retained (it costs
> nothing and needs no classification to justify it). Verified across
> `docs/superpowers/plans/2026-08-04-medplum-native-implementation.md` and
> the Data Model/Design/LLD/HLD/Specs docs — no `urgency`/`priority`/
> `routine`/`urgent` references remain outside this historical record.
> The round-3 text below describes the state *before* this decision and is
> kept for context only.

The product says the AI performs no clinical judgment, but the intake model
classifies `routine` vs `urgent`, and that output changes appointment duration.
The test fixture treats exertional chest discomfort as routine. A static
“call 911” line does not detect red flags, fail closed, or prevent an unsafe
routine routing result.

The design needs an explicit decision: remove model-selected urgency and let
the user choose a scheduling type, or treat urgency as triage and add reviewed
rules, escalation behavior, validation, adversarial tests, and appropriate
governance.

### P1-08 — Gemini integration lacks runtime contracts, safety controls, and lifecycle handling

> **Round 4 status: STILL OPEN.** Re-verified: both callers are still plain
> `fetch()` with no `AbortController`/timeout/retry-backoff; the API-key
> secret is still cast with no existence/non-empty check; intake still does a
> bare `JSON.parse(...) as GeminiIntakeResult` with zero schema validation;
> chat still relies solely on a static phrase blacklist and never loads prior
> thread turns; `'gemini-2.5-flash-lite'` is still a hardcoded literal in
> three separate places with no central config or deployment gate.

Both Gemini callers lack explicit timeouts, cancellation, retry/backoff,
input/output limits, and secret validation. Intake performs `JSON.parse(...) as
GeminiIntakeResult` without schema validation; `reason`, `summary`, and
`urgency` can be absent or invalid. Chat relies on a short phrase blacklist,
does not load prior thread turns, provides no record citations, and does not
persist model/prompt versions, source resource versions, trace IDs, or the
subset of record data used.

The plan hard-codes `gemini-2.5-flash-lite`. It is still available on the scan
date, but Google's current deprecation table gives it a shutdown date of
**2026-10-16**, with migration recommended before then. Model selection cannot
remain duplicated string literals with no deployment gate.

Google's current terms/pricing also say unpaid-tier content may be used for
product improvement and human review, and explicitly say not to submit
sensitive, confidential, or personal information to unpaid services. This is
compatible only with the synthetic-demo boundary. The app needs a prominent
synthetic-only guard and must fail closed if repurposed for real PHI.

Sources: [Gemini deprecations](https://ai.google.dev/gemini-api/docs/deprecations),
[Gemini API terms](https://ai.google.dev/gemini-api/terms),
[Gemini pricing/data-use table](https://ai.google.dev/gemini-api/docs/pricing).

### P1-09 — "full patient record" and "every patient ever" remain false under hard caps

> **Round 4 status: STILL OPEN, one wording nuance.** Re-verified: the caps
> are all still in place (Conditions/MedicationRequests/Allergies/Encounters
> at 50, previous-physician search at 200, patient picker/history at 50,
> PractitionerRole and doctor-queue Appointment/Communication searches still
> fully unpaginated with no status filter). One nuance: the exact phrase
> "full patient record" does not appear verbatim anywhere in the docs — the
> real product claim is `Doctor_Appointment_Agent_Specs.md` FR-11, "every
> patient who has ever booked with them," which this finding's substance
> still accurately contradicts.

The plan still limits Conditions, MedicationRequests, Allergies, and Encounters
to 50; previous-physician search is limited to 200; patient picker/history are
limited to 50; Queue Appointment and Communication searches use server
defaults; PractitionerRole lookups are also unpaginated.

The unchanged corpus contains patients far over those limits (previous scan:
192 patients with more than 50 Encounters, maximum 1,625; 23 with more than 50
MedicationRequests, maximum 1,236). The Round 2 response explicitly accepts
these as POC trade-offs, but the product text still makes complete-record and
every-patient claims. Either paginate or narrow every claim and show the exact
subset used for AI grounding.

Queue semantics are also undefined for cancelled, rescheduled, no-show,
entered-in-error, future, and historical appointments.

### P1-10 — authorization remains a demo display filter, with additional ID-binding gaps

> **Round 4 status: STILL OPEN.** Re-verified: `agent-ensure-doctor.ts` still
> takes any NPI with zero relationship check; the chat relationship check is
> still a bare `searchOne('Appointment', {actor, patient})` with no `status`
> filter, so a cancelled Appointment still authorizes chat forever;
> `threadId` is still spliced into `partOf` with no verification it belongs
> to the same patient/practitioner pair; `PatientAgentChatPage.tsx` still
> takes `npi`/`patientId` straight from the raw URL.

Any broad project user can type any NPI or patient URL. The relationship check
accepts an Appointment of any status, so a cancelled booking can authorize chat
forever. Caller-supplied `threadId` is not verified to be a Communication for
the same patient and Practitioner. Booking and confirmation routes similarly
do not bind URL IDs to one another.

This can be acceptable only in an access-restricted environment that is
visibly labelled synthetic/demo. It is not a clinical authorization model.

### P1-11 — frontend state, recovery, and accessibility remain incomplete

> **Round 4 status: STILL OPEN.** Re-verified: `booking.context.ts` is still
> pure in-memory `useState`/Context with no persistence; `chosenCandidate` is
> still written once and never read again anywhere, and the ensure-doctor
> bot call still sends only `{ npi }`. `PatientPickerPage.tsx` and
> `BookingConfirmationPage.tsx` still `.catch(console.error)` on read
> failures, leaving the confirmation page spinning forever. Tasks 27–35 still
> contain zero `Test:`/`vitest`/`@testing-library` references, unlike every
> backend task.

- Booking intent/candidate/summary state lives only in React context; refresh,
  deep links, new tabs, and back/forward navigation lose the flow.
- `chosenCandidate` is written but never read or sent to the ensure-doctor Bot.
- Starting a new flow does not explicitly clear old booking state.
- Several loaders only `console.error`, leaving blank or perpetual-loading UI;
  confirmation can spin forever after a read failure.
- Chat turns and thread ID disappear on refresh despite persisted
  Communications.
- Clickable cards and copy text are not specified as keyboard-accessible
  controls.
- Complaint, question, and generated-output lengths are unbounded.
- There are no automated component/e2e tests for any new page.

### P1-12 — full mode is exposed but is not a valid or idempotent uploader

> **Round 4 status: FIXED (commit `3c9ed87`), same root cause as P0-01.**
> Task 6 no longer uses `identifier=...` conditional create as the identity
> mechanism for any resource type, full-mode included.
> `deterministicUpsert()` now does an unconditional `PUT
> ResourceType/{stableId}` for every retained/bootstrap resource regardless
> of type; `identifier` is attached for audit/search only. The specific
> failure mode described here (unsupported search params, non-idempotent
> conditional-create) no longer applies to the current mechanism.

Task 6 applies `withStableIdentifier()` to every resource type in full mode and
uses `identifier=...` conditional creates universally. Not every FHIR resource
allows an `identifier` field or an `identifier` search parameter. Resources
without IDs fall through without conditional-create. References outside the
seven slim types were not included in the corpus-backed field audit. A full
mode run can therefore emit invalid resources, unsupported search conditions,
unresolved references, and non-idempotent creates.

If full mode is not a product requirement, remove it. If it is, it needs a
resource-type-specific schema/search/reference strategy and a full-corpus live
test of that mode.

### P1-13 — Medplum version compatibility is still an explicit deployment gate

> **Round 4 status: FIXED.** The plan now pins `5.1.27` everywhere (tech
> stack line, Global Constraints, Task 1), and `medplum/package.json` /
> `medplum/packages/core/package.json` both report `"version": "5.1.27"` —
> the pinned version now matches the vendored local source exactly. The
> "target server version" gate is still explicitly acknowledged (not silently
> ignored) via Task 10/26 live preflights, which is the correct posture for
> what remains an inherently environment-dependent fact.

The fork pins Medplum packages at `5.0.12`; the local source used for most
scheduling validation is `5.1.27`; the target server version is unspecified.
The critical POST-ID behavior was rechecked and is the same in tag `v5.0.12`,
but the complete beta scheduling surface, operation output shortcuts,
extensions, client types, and server deployment still need verification
against the exact target version. Round 2 explicitly left this open.

### P1-14 — canonical documentation is still stale and now self-contradictory

> **Round 4 status: DOES NOT HOLD against the current file — all five
> sub-claims fail re-verification.** (a) Global Constraint line 20 already
> says `$find`/`$book` *responses* are bare Bundles and only the `$book`
> *request* is a Parameters resource — this already agrees with Tasks
> 21/25/31, no contradiction found. (b) The cited line 5,116 now contains
> unrelated content; Task 26's actual live-`$find` checklist item already
> asserts Task 19 sets `alignmentInterval`. (c) Task 9 and Task 36 agree with
> each other — both state the default is 50 and `--all` is required to
> select everything. (d) the Self-Review does claim every code block is
> complete/runnable, but in the same sentence explicitly names and reconciles
> the Task 4 specialty-table exception rather than contradicting it. (e) both
> `Issues_Audit_Response.md` and `Issues_Audit_Response_Round2.md` now open
> with an identical "archived audit record, superseded 2026-08-05" banner.
> This section appears to have been written against a pre-sync revision of
> the plan and should not be relied on; retained here only as historical
> record of a since-resolved state.

The seven banners are a useful precedence rule, but they do not reconcile the
documents. The latest implementation plan itself now contains contradictions:

- Global Constraint line 20 says `$find`/`$book` outputs are Parameters,
  while Tasks 21/25/31 correctly say they are bare Bundles.
- Task 26's live `$find` checklist (line 5,116) says Task 19 does not set
  `alignmentInterval`; Task 19 now does.
- Task 36 says no `--limit` means all files; Task 9 defaults it to 50.
- Self-Review says every code block is complete/runnable while Task 4 explicitly
  ships a 21-of-49 starter table.
- `Issues_Audit_Response.md` and `Issues_Audit_Response_Round2.md` both claim
  their respective P0 sets are fully fixed, without a superseded/current-status
  banner. Round 2's own “still open” section admits multiple P1/P2 items were
  deliberately not addressed.

An implementer still has to follow a chain of banners and correction reports
to discover which sentences are false. Reconcile the canonical docs or mark
the stale bodies/audit completion claims as historical.

---

## P2 — engineering, operability, and verification gaps

### P2-01 — tests still encode the implementation's assumptions

> **Round 4 status: PARTIALLY FIXED.** Two sub-claims are now stale because
> the bugs they tested for are gone: "resolved FHIR operation URLs (mocks
> accept the wrong strings)" is stale — tests now assert against
> `medplum.fhirUrl(...).toString()`, matching the P0-02 fix. "Server-assigned
> IDs for POST Bundle entries" is stale — there's no POST-id assumption left
> to test, per the P0-01 fix. "Task 36's exact CLI arguments selecting 983
> files" is now unit-tested (`parseCliArgs(['--slim','--all'])`). Every other
> item in the list below remains a genuine, confirmed gap — referential
> integrity after a live upload, ESM `main()` execution, duplicate-participant
> booking tampering, post-book metadata recovery, reschedule failures in
> steps 2–4, block interval/Slot release, batch entry-count mismatch (a real
> gap: `assertNoFailedEntries` only iterates `response.entry`, so *missing*
> entries vs. the request are never caught), the 49 specialty mappings,
> pagination, adversarial model responses, and live PowerShell Bot execution.

Missing or misleading coverage includes:

- server-assigned IDs for POST Bundle entries at pinned version `5.0.12`;
- referential integrity after real identity and clinical-wave uploads;
- resolved FHIR operation URLs (mocks currently accept the wrong strings);
- Task 36's exact CLI arguments selecting 983 files;
- process-level ESM startup;
- duplicate/different Patient participants and all booking ID tampering;
- post-book metadata recovery;
- reschedule failures after new booking;
- block interval overlap plus Slot release;
- batch response entry-count mismatch;
- full-mode resource validation;
- all 49 specialty mappings and Condition dereferencing;
- pagination beyond page one;
- malformed/adversarial/unsafe model responses and emergency inputs;
- PowerShell Bot deployment and per-Bot live execution.

### P2-02 — retry/error handling remains brittle

> **Round 4 status: STILL OPEN, confirmed exactly.** `assertNoFailedEntries`
> still throws a plain `Error` with no `.outcome`; `isTransient()` still
> treats anything without `.outcome` as retryable, so a deterministic
> per-entry validation failure is still retried up to `MAX_RETRIES = 3` times
> with no backoff/jitter/Retry-After. Slot-race classification is still one
> exact string match (`'Requested time slot is not available'`), duplicated
> in both booking and reschedule bots. Gemini/NPPES still have no timeout or
> cancellation policy.

- Batch validation errors are converted to plain `Error`; `isTransient()`
  treats any error without `.outcome` as retryable, so deterministic entry
  failures are retried three times.
- There is no delay, exponential backoff, jitter, or `Retry-After` handling.
- Only the first OperationOutcome issue code/message is inspected.
- Slot-race classification matches one exact English message.
- Gemini and NPPES have no timeout or common cancellation policy.
- Error messages do not consistently carry source file/resource/request IDs.

### P2-03 — CLI and manifest semantics are unsafe even after the 50-file blocker

> **Round 4 status: MOSTLY OPEN, one clause now stale.** Stale: "`--full`/
> `--slim` order changes both mode and limit" — the P0-03 fix deliberately
> decoupled `--limit`/`--all` from `--slim`/`--full`, so order no longer
> affects `limit` (mode is still order-dependent). Still open: missing/`NaN`/
> fractional/zero/negative `--limit` values are still accepted with no
> validation; unknown flags are still silently ignored; file order still has
> no explicit `.sort()`; the manifest is still keyed only by absolute path
> (no target/mode/digest); writes are still non-atomic; Task 36 still works
> around a poisoned manifest by manually `rmSync`-ing it rather than a
> target-aware recovery path.

- missing, `NaN`, fractional, zero, and negative `--limit` values are accepted;
- unknown flags are ignored;
- `--full`/`--slim` are not enforced as mutually exclusive, and their order
  changes both mode and limit;
- file order is not explicitly sorted;
- the manifest is keyed only by absolute path, not target base URL/project,
  mode, corpus digest, transform version, or options;
- manifest writes are not atomic; a truncated file makes the next run fail to
  parse;
- cleaning a poisoned target relies on manually deleting project data and the
  manifest rather than a safe, target-aware recovery workflow.

### P2-04 — deployment is not reproducible or clean

> **Round 4 status: STILL OPEN.** `tools/deploy-bots-direct.ts` (the P0-05
> replacement script) only checks env vars are *present*, never that the
> credential has the project-admin capability Task 26's own text says the
> Bot-creation endpoint needs. No Binary-orphan cleanup exists. No lockstep
> record of build/bundle hash/target version/deployed Bot versions is
> written anywhere. Model/Bot identifiers are still hardcoded literals with
> no automated startup health check.

- The direct script's credentials/permissions are not validated before work;
  Bot creation additionally needs project-admin capability not listed in the
  seed client's permission checklist.
- Every generated deployment creates fresh source/dist Binary resources and
  does not clean old orphaned Binaries.
- There is no lockstep record of frontend build, Bot bundle hashes, target
  project, target server version, secrets/config, and deployed Bot versions.
- The hard-coded model and Bot identifiers have no central deployment
  configuration or startup health check.

### P2-05 — the plan is not consistently executable from PowerShell

> **Round 4 status: STILL OPEN.** The specific P0-05 blocker is fixed, but
> the broader pattern isn't: `rmdir src/bots/example 2>/dev/null || true` and
> `UNZIPPED_TSV_PATH=/path/... npx tsx tools/seed/generate-zip3-centroids.ts`
> are both still Bash-only syntax with no PowerShell equivalent given. Task
> 27 still knowingly commits imports of not-yet-created pages and explicitly
> expects `tsc` to fail until Tasks 28–35 land, leaving an intermediate
> unbuildable commit by design.

In addition to P0-05, examples mix Bash and PowerShell semantics:

- `UNZIPPED_TSV_PATH=/path/... npx ...` is not PowerShell syntax;
- `2>/dev/null || true` assumes a Unix shell;
- several long double-quoted shell snippets contain `$` tokens;
- Task 27 knowingly commits imports of pages that do not exist yet and expects
  `tsc` to fail until later tasks, leaving intermediate commits unbuildable.

Choose and test one primary Windows path, and provide separately verified Bash
commands where needed.

### P2-06 — verification still overclaims product completion

> **Round 4 status: STILL OPEN, confirmed verbatim.** Task 37 Step 5 still
> states: "If every check above passes, the implementation matches every FR
> in `Doctor_Appointment_Agent_Specs.md`." The preceding steps still cover
> only one happy-path patient flow, one happy-path doctor flow plus a single
> refusal-prompt check, one race spot-check, and one cancel/reschedule/
> block-availability pass — no coverage of pagination, auth boundaries,
> AI-safety adversarial inputs, referential integrity, retry recovery, or
> deployment reproducibility.

Task 37 says the implementation matches every FR if a short manual walkthrough
passes. That walkthrough cannot prove pagination completeness, auth boundaries,
AI safety, data-use policy, model lifecycle, referential integrity, retry
recovery, all overlap cases, or deployment reproducibility. Exact acceptance
gates are needed for counts, duplicates, references, target versions, Bot code
hashes, and failure injection.

---

## Verified improvements in the latest correction pass

> **Round 4 status:** all six re-checked items below hold as real fixes, with
> one wording caveat. "Both HealthCareServices now carry the identifiers
> their conditional creates query" is true as a *fact* (both still carry
> `identifier`), but the *mechanism* it describes is now stale — the P0-01/
> P1-12 fix removed `ifNoneExist` conditional-create entirely in favor of
> unconditional `PUT`-by-known-id; the identifiers are now audit/search-only,
> not the identity mechanism. Separately, re-verification of "batch response
> entries checked for non-2xx" surfaced one caveat worth folding into P2-01:
> `assertNoFailedEntries` only iterates `response.entry`, so a response with
> *fewer* entries than the request silently misses the un-returned ones.

The following changes are real and should be retained:

- `$find` and `$book` are parsed as direct response Bundles in Tasks 21, 25,
  and 31.
- The real `$find` proposal is passed through and a Patient participant is
  added before booking.
- Generated PractitionerRoles are retained in the identity upload wave.
- Batch response entries are checked for non-2xx statuses.
- Full-mode “other” entries are retained by the splitter.
- Both HealthcareServices now carry the identifiers their conditional creates
  query.
- `pathToFileURL()` fixes Windows main-module detection; seed credentials are
  validated; `tools/` is added to the planned TypeScript include.
- Bot Binary matching is per Bot, and missing Bots use the admin project
  endpoint.
- NPPES full-state normalization and a broader fallback were added.
- Per-service alignment intervals were added.
- Reschedule now copies the listed issue metadata and re-links the summary on
  the complete-success path.
- Seven design documents have explicit superseding banners.
- Current committed changes pass `git diff --check`; the earlier EOF whitespace
  failure is fixed.

These improvements do not negate the blockers above.

## Re-scan evidence and limits

### Checks completed

- Read all project-owned Markdown documents and the changed commit range.
- Reviewed the current 6,579-line implementation plan and both audit-response
  documents.
- Inspected relevant source in both ignored reference checkouts.
- Verified the crucial POST-ID overwrite in both local Medplum `5.1.27` and
  git tag `v5.0.12`.
- Verified the relative-URL behavior in `MedplumClient` and the official local
  `$book` example's use of `fhirUrl()`.
- Parsed all 983 FHIR JSON Bundles successfully and scanned 432,827 entries /
  171,157 kept-resource internal references.
- Confirmed 41 CSV disease rows and 41 unique disease names.
- Confirmed root has no application `package.json` or `src/`.
- Confirmed all 14 current Markdown files have balanced fences (488 markers)
  and no broken relative Markdown links.
- Confirmed `git diff --check 7809524..HEAD` passes.
- Reproduced PowerShell's destructive interpolation of `\$bot` and `\$deploy`.
- Refreshed current official NPPES and Gemini model/data-use facts.

### Checks that could not be run

- Root `npm test`, `npm run build`, lint, or `tsc`: no root application exists.
- Live seed upload/repeat upload/reference audit: no implemented CLI or target
  credentials exist at root.
- Live Bot build/deploy/invocation and scheduling race/failure injection: no
  implemented Bots or authorized target were supplied.
- Live Gemini/NPPES application flows: the root application is absent, and no
  secret or production data should be inferred from ignored files.

The absence of runnable code is not evidence that plan defects are fixed. Code
findings above are against the exact code blocks the plan instructs an
implementer to create, the pinned reference source, and the supplied corpus.

## Round 4 Re-verification Summary (2026-08-06)

Every finding above was re-checked against commit `f77666d` by independently
reading the actual Medplum source and the current plan text (not by trusting
this document's own prose). Verdict tags:

| # | Finding | Round 4 status |
|---|---|---|
| P0-01 | seed ID assumption | **FIXED** (`3c9ed87`) |
| P0-02 | `$book`/`$cancel` wrong URL | **FIXED** (`3c9ed87`) |
| P0-03 | slim run caps at 50 | **FIXED** (`f77666d`) |
| P0-04 | ESM `__dirname` crash | **FIXED** (`f77666d`) |
| P0-05 | PowerShell Bot deploy broken | **FIXED** (`f77666d`) |
| P1-01 | booking trusts browser object | **PARTIALLY FIXED** — only post-book Communication-link swallow survives |
| P1-02 | reschedule double-booking risk | STILL OPEN |
| P1-03 | Schedule reuse / wrong timezone | STILL OPEN |
| P1-04 | block-availability overlap/orphan Slot | STILL OPEN |
| P1-05 | specialty inference incomplete | STILL OPEN |
| P1-06 | NPPES taxonomy/validation gaps | STILL OPEN |
| P1-07 | AI urgency/emergency safety | **RESOLVED** (2026-08-06, product decision: no urgency/triage classification) |
| P1-08 | Gemini runtime contracts | STILL OPEN |
| P1-09 | hard caps vs. "every patient" claims | STILL OPEN (wording nuance only) |
| P1-10 | authorization is a display filter | STILL OPEN |
| P1-11 | frontend state/recovery/tests | STILL OPEN |
| P1-12 | full-mode conditional-create | **FIXED** (`3c9ed87`, same fix as P0-01) |
| P1-13 | Medplum version mismatch | **FIXED** — plan now pins `5.1.27` |
| P1-14 | doc self-contradictions | **DOES NOT HOLD** — all 5 sub-claims fail re-check |
| P2-01 | tests encode wrong assumptions | PARTIALLY FIXED — 2 of ~13 sub-items stale |
| P2-02 | retry/error handling brittle | STILL OPEN |
| P2-03 | CLI/manifest unsafe | MOSTLY OPEN — 1 clause stale |
| P2-04 | deployment not reproducible | STILL OPEN |
| P2-05 | PowerShell inconsistency | STILL OPEN (beyond P0-05) |
| P2-06 | verification overclaims completion | STILL OPEN |

**Bottom line:** all 5 P0 blockers, and 4 of the 14 P1 findings (P1-07,
P1-12, P1-13, and effectively P1-14), no longer describe the current plan.
The original "NOT CLEARED" verdict is stale for the P0 tier specifically. It
remains accurate in spirit for the P1/P2 tier: 9 of 14 P1 findings and all 6
P2 findings are still live, confirmed defects as of this re-verification —
most seriously the reschedule double-booking risk (P1-02) and the
display-only authorization model (P1-10). This file should **not** be
deleted; it should stay open until the revised closure order below is
worked through.

**Round 5 addendum (2026-08-06):** P1-07 is now resolved by an explicit
product decision, not a code fix — the team chose to remove AI-driven
urgency/triage classification entirely rather than add safety rules around
it. See the P1-07 section above and the Data Model/Design/LLD/HLD/Specs docs
for the resulting removal of the `urgency`/`priority` field and the second
"Urgent Visit" HealthcareService throughout.

## Required closure order

*(Revised 2026-08-06 to reflect Round 4 status — struck items are fixed and
kept only for context; do not re-do them.)*

1. ~~Fix the seed identity/reference design...~~ — **done** (`3c9ed87`
   switched to deterministic unconditional PUT; also closes P1-12).
2. ~~Fix every FHIR operation URL...~~ — **done** (`3c9ed87`, all `$book`/
   `$cancel` calls now use `fhirUrl()`).
3. ~~Make an all-files slim run expressible, fix ESM startup...~~ — **done**
   (`f77666d`: `--slim --all`, `__dirname` shim, manifest scoping still
   partially open — see new item 8).
4. ~~Replace the shell-embedded Bot deployment...~~ — **done** (`f77666d`:
   `tools/deploy-bots-direct.ts`).
5. **Bind/validate booking inputs and design recoverable post-book
   metadata** — largely done for input validation (P1-01); the
   post-`$book` Communication-link failure still has no
   `metadataPending`/recovery signal. **Redesign reschedule and
   block-availability failure semantics** — still fully open (P1-02, P1-04).
6. **Repair existing Schedules and timezone sourcing** — still open (P1-03).
7. **Complete specialty mapping and NPPES result/provider-status
   validation** — still open (P1-05, P1-06).
8. **Harden CLI/manifest safety and retry/error handling** — still open
   (P2-02, P2-03: flag validation, manifest atomicity/scoping, retry
   backoff, entry-count-mismatch detection).
9. ~~Resolve urgency/emergency safety~~ — **done by product decision**
   (2026-08-06: no urgency/triage classification at all — P1-07). **Gemini
   schemas/timeouts/provenance/model migration, free-tier synthetic-only
   enforcement, pagination, and auth/thread boundaries** — still fully open
   (P1-08, P1-09, P1-10).
10. **Close frontend state/recovery/test gaps and deployment
    reproducibility** — still open (P1-11, P2-04, P2-05).
11. ~~Reconcile canonical documentation...~~ — **substantially done**; the
    specific contradictions P1-14 cited no longer exist. Turning Task 37's
    manual checklist into measurable acceptance gates (P2-06) is still open.
12. Only then implement the app and run unit, corpus, build, live Medplum,
    deployment, race, recovery, and end-to-end checks before deleting this
    report.
