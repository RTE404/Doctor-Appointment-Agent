# Doctor Appointment Agent — Low-Level Design

> **Synchronized with the approved implementation plan (2026-08-04).** All
> `@medplum/*` packages are exactly `5.1.27`; scheduling calls use
> `medplum.fhirUrl(...)` and the verified bare-Bundle response contracts;
> seeded identity uses deterministic PUT; booking trusts only resources and
> a fresh `$find` result read by the Bot.

Supersedes the Python-era LLD. Function-by-function design for every bot
and shared library module in `Doctor_Appointment_Agent_Backend.md`. Each
entry: signature, purpose, inputs/outputs, step-by-step logic, and errors.
Bot handlers follow Medplum's standard shape: `export async function
handler(medplum: MedplumClient, event: BotEvent): Promise<any>`, receiving
input via `event.input` and secrets via `event.secrets`.

---

## `src/bots/agent/lib/geo.ts`

### `haversineMiles(a: {lat: number, lng: number}, b: {lat: number, lng: number}): number`
- **Purpose**: distance ranking input (Design doc §8).
- **Logic**: standard Haversine formula, `R = 3958.8` miles. Pure
  function, no I/O.
- **Output**: distance in miles.

### `patientCoords(patient: Patient): {lat: number, lng: number} | undefined`
- **Purpose**: extract a patient's coordinates without a zip lookup.
- **Logic**: read `patient.address[0].extension` where `url ===
  'http://hl7.org/fhir/StructureDefinition/geolocation'`; pull the nested
  `latitude`/`longitude` `valueDecimal` extensions. Confirmed present on
  every Synthea-seeded patient. Returns `undefined` if absent (real-world
  patient with no geolocation extension) — caller falls back to a zip3
  centroid lookup in that case.

### `zip3Centroid(postalCode: string): {lat: number, lng: number} | undefined`
- **Purpose**: doctor-side coordinates (NPPES gives zip, not lat/long).
- **Logic**: `postalCode.slice(0, 3)` → lookup in `src/data/
  zip3-centroids.ts`. Returns `undefined` for an unrecognized prefix.

---

## `src/bots/agent/lib/ranking.ts`

### `rankCandidates(patientCoords, candidates: DoctorCandidate[]): RankedCandidate[]`
- **Purpose**: order NPPES candidates for `agent-find-doctors`.
- **Logic**:
  1. For each candidate, resolve coordinates via `zip3Centroid` on their
     NPPES address postal code.
  2. Compute `distanceMiles = haversineMiles(patientCoords, candidateCoords)`
     (skip/deprioritize candidates with no resolvable coordinates).
  3. Sort ascending by `distanceMiles`.
- **Output**: same candidates, each annotated with `distanceMiles`, in
  ranked order. Does **not** handle the previous-physician-first rule —
  that's a separate, simpler rule applied directly in `agent-find-doctors`
  (a previous-physician match, when present, is always prepended ahead of
  this ranked NPPES list — see that bot's logic below), not blended into
  this scoring function.

---

## `src/bots/agent/lib/nppes.ts`

### `searchNppesDoctors(taxonomyDescription: string, city: string, state: string, limit = 20): Promise<DoctorCandidate[]>`
- **Purpose**: ported from the retired Python `directory/service.py`,
  near-verbatim.
- **Logic**: `fetch` to NPPES's public endpoint with `taxonomy_description`,
  `city`, `state`, `limit`, `version: '2.1'`; filter to active (non-
  deactivated) records; map each result to `DoctorCandidate{npi,
  firstName, lastName, nuccCode, nuccDisplay, address, phone}`.
- **Errors**: network/5xx failures propagate to the caller (bot-level
  failure), not swallowed.

### `getNppesDoctorByNpi(npi: string): Promise<DoctorCandidate | undefined>`
- Same mapping, single-result lookup by NPI. Returns `undefined` (not an
  error) if NPPES has no record for that NPI.

---

## `src/bots/agent/lib/patientContext.ts`

### `loadPatientClinicalContext(medplum, patientId: string): Promise<PatientClinicalContext>`
- **Purpose**: the one standardized "read everything relevant about this
  patient" query, shared by `agent-intake.ts` and `agent-patient-chat.ts`
  so both bots ground themselves against the same depth of data — no more
  silently-different `_count`/`_sort` values between the two.
- **Logic**: parallel reads —
  `Patient/{patientId}`,
  `Condition?subject=Patient/{patientId}&_count=50&_sort=-recorded-date`,
  `MedicationRequest?subject=Patient/{patientId}&_count=50&_sort=-authoredon`,
  `AllergyIntolerance?patient=Patient/{patientId}&_count=50`,
  `Encounter?subject=Patient/{patientId}&_include=Encounter:practitioner&_count=50&_sort=-date`.
- **Output**: `{patient, conditions, medications, allergies, encounters}` —
  plain arrays, no serialization; callers build their own grounding block
  or JSON context from this shape.
- **Callers**: `agent-intake.ts` (one-shot grounding for the LLM call),
  `agent-patient-chat.ts` (called fresh on every chat message — never
  cached, per FR-13).

---

## `src/config/specialties.ts`

### `SPECIALTY_TABLE: SpecialtyDef[]`
- **Purpose**: the single specialty vocabulary shared by bots and UI.
- **Shape**: `{label: string, nuccCode: string, nuccDisplay: string,
  nppesTaxonomyDescription: string}[]` — real NUCC codes, not free-text
  labels (Data Model doc).

### `normalizeLlmSpecialty(freeText: string): SpecialtyDef | undefined`
- **Purpose**: called by `agent-intake` to map the LLM's free-text
  specialty guess onto a real, controlled vocabulary entry before it's
  used for anything else.
- **Logic**: case-insensitive match against `label`, then against a fixed
  synonym map (one entry per `SPECIALTY_TABLE` row, e.g. `"heart
  doctor"|"cardiologist"|"heart" → Cardiology`, `"skin doctor"|
  "dermatologist" → Dermatology`, `"bone doctor"|"orthopedist"|
  "orthopedics" → Orthopedics`, `"kids doctor"|"pediatrician" →
  Pediatrics`, `"eye doctor"|"eye specialist" → Ophthalmology`, `"gp"|
  "family doctor"|"general doctor" → General Practice` — expanded as real
  LLM output is observed in testing); returns `undefined` on no match in
  either.

**Naming note**: `nuccCode`/`nuccDisplay` (here and in `nppes.ts`'s
`DoctorCandidate`) name the raw taxonomy fields as data flows out of the
table/NPPES. `specialtyCode` (used in bot I/O below, e.g. `agent-intake`'s
output and `agent-find-doctors`'s input) is the exact same NUCC code
value, just named for what it represents at that boundary — a request/
response field, not a table lookup. Same string, different name depending
on which side of the boundary you're reading.

---

## `src/bots/agent/agent-intake.ts`

### `handler(medplum, event)`
- **Purpose**: FR-3/FR-4/FR-12 — one LLM call producing both the booking
  intent and the pre-visit summary.
- **Input**: `{patientId: string, complaintText: string}`.
- **Logic**:
  1. `loadPatientClinicalContext(medplum, patientId)` (shared with
     `agent-patient-chat.ts` — see `lib/patientContext.ts` above; both
     bots need the same "full picture" of a patient, at the same read
     depth, not two independently-tuned queries).
  2. Build a compact grounding block from the above.
  3. One call to Gemini's OpenAI-compatible endpoint (`event.secrets
     ['GEMINI_API_KEY']`, model `gemini-2.5-flash-lite`, `temperature: 0`,
     JSON response mode), with the grounding block and the complaint text,
     returning `{specialty, reason, summary}`. No urgency/triage
     classification is requested or produced (decision recorded
     2026-08-06) — this is a POC where a patient wants to see a doctor,
     not a clinical triage system.
  4. `normalizeLlmSpecialty(result.specialty)` — if it returns
     `undefined`, return a clarification-needed response rather than
     guessing (FR-4's "never silently default" rule).
  5. Create the authoritative summary `Communication`: `status:
     'preparation'`, `category: ai-previsit-summary`, `subject:
     Patient/{patientId}`, `sender: Device/ai-appointment-agent`,
     `payload.contentString = result.summary`, `topic` = the normalized NUCC
     specialty, `reasonCode` = the concise reason, `note` = the original
     complaint, and `meta.tag: ai-generated`. It has no
     recipient yet because the doctor is not chosen.
- **Output**: `{intent: {specialtyCode, specialtyLabel, reason},
  summaryCommunicationId: string}`, or `{needsClarification: true}`.
- **Errors**: Gemini/network failure propagates as a bot failure (no
  silent fallback).

---

## `src/bots/agent/agent-find-doctors.ts`

### `handler(medplum, event)`
- **Purpose**: FR-5/FR-6/FR-7.
- **Input**: `{patientId: string, specialtyCode: string}`.
- **Logic**:
  1. `Encounter?subject=Patient/{patientId}&_include=Encounter:practitioner&_count=200`
     → distinct `Practitioner` references from the included resources.
  2. `PractitionerRole?practitioner={ids}&specialty=http://nucc.org/provider-taxonomy|{specialtyCode}`
     — **one** query answering "did this patient see this exact
     specialty before" (confirmed real, indexed search parameter — Data
     Model doc).
  3. **If step 2 returns a match(es)**: resolve to a `PreviousPhysician`
     result (name, last-seen date, organization). This is the *only*
     condition under which a previous physician is ever surfaced — no
     partial/fuzzy inclusion. **Tie-break**: if more than one previous
     practitioner has an exact specialty match, take the one whose most
     recent `Encounter.period.start` is latest.
  4. Always also run the NPPES path: `searchNppesDoctors(taxonomy, city,
     state)` using the patient's address for location.
  5. `rankCandidates(patientCoords(patient), nppesResults)`.
  6. Assemble the response: previous-physician result (if any) always
     first, followed by the top ~10 ranked NPPES candidates, each tagged
     `source: 'previous' | 'nppes'`.
- **Output**: `{candidates: RankedCandidate[]}` — writes nothing;
  candidates aren't persisted until one is booked.
- **Errors**: NPPES failure propagates; a previous-physician-path miss is
  not an error (falls through silently to NPPES-only results, per FR-6).

---

## `src/bots/agent/lib/ensurePractitionerAndSchedule.ts`

### `ensurePractitionerAndSchedule(medplum, npi: string, candidate?: DoctorCandidate): Promise<{practitionerId, scheduleId, healthcareServiceId: string}>`
- **Purpose**: lazy provisioning. Deliberately a plain function, not a bot
  — but since step 1 can call NPPES (no CORS, must run bot-side), this
  function only ever runs *inside* a bot. Its sole caller is the
  `agent-ensure-doctor` bot below — **not** `agent-find-doctors` (which
  only ranks/returns candidates, it never provisions) and not the UI.
- **Logic**:
  1. `medplum.searchOne('Practitioner', 'identifier=http://hl7.org/fhir/sid/us-npi|' + npi)`.
     If found, reuse; otherwise fetch `candidate` via
     `getNppesDoctorByNpi` if it was not supplied and create the
     `Practitioner`. Search for and reuse its matching `PractitionerRole`, or
     create the missing NUCC-coded role.
  2. `medplum.searchOne('Schedule', 'actor=Practitioner/' + practitionerId)`.
     If found, reuse; else generate a `WeeklyTemplate` deterministically
     from a hash of the NPI (working days, start/end hour, lunch gap —
     same logic as the retired Python `template.py`, just producing a
     `SchedulingParameters` extension instead of Postgres rows), resolve
     the doctor's timezone from a small state→IANA table, and create the
     `Schedule` with `serviceType` holding a **single**
     entry, for the one HealthcareService ("Office Visit") — there is no
     urgency/triage classification in this product (decision recorded
     2026-08-06), so no second entry is needed. Confirmed both the array
     cardinality (`0..*`) and the exact matching mechanic directly in
     Medplum's `servicetype.ts`: the entry is a
     `CodeableConcept` carrying the `service-type-reference` extension
     (`{url: 'https://medplum.com/fhir/service-type-reference',
     valueReference: {reference: 'HealthcareService/{id}'}}`). Add exactly
     one Schedule-level `SchedulingParameters` group. It carries `service`,
     `duration`, a matching `alignmentInterval`, `timezone`, and the
     deterministic availability blocks; a group without `service` would not
     match the service.
- **Output**: the practitioner/schedule ids plus the single HealthcareService
  id.
- **Idempotency**: the identifier/actor searches in steps 1–2 are what
  make repeated calls for the same NPI safe; a concurrent first-time race
  for the same NPI is an accepted, low-probability edge case for a
  single-demo-at-a-time POC.

---

## `src/bots/agent/agent-ensure-doctor.ts`

### `handler(medplum, event)`
- **Purpose**: FR-8 — the thin bot wrapper the slot-picker route
  (`/agent/:patientId/doctors/:npi/slots`) calls before it can call `$find`
  directly. Exists because provisioning may need an NPPES lookup, which
  needs a bot (no CORS — Design doc §6).
- **Input**: `{npi: string, candidate?: DoctorCandidate}` — `candidate` is
  passed when the UI already has it from `agent-find-doctors`'s NPPES
  results, sparing a redundant NPPES call for the common case; omitted for
  a previous-physician pick (already in Medplum, no NPPES data needed).
- **Logic**: `ensurePractitionerAndSchedule(medplum, npi, candidate)`,
  nothing else.
- **Output**: `{practitionerId, scheduleId, healthcareServiceId}`. The UI
  then calls `$find` directly against Medplum with `scheduleId` and that
  service id — no urgency-based selection, no further bot round-trip to
  view slots.
- **Errors**: NPPES/Medplum failure propagates as a genuine bot failure —
  there's no partial-success case here.

---

## `src/bots/agent/agent-book-appointment.ts`

### `handler(medplum, event)`
- **Purpose**: FR-9/FR-10.
- **Input**: `{patientId, practitionerId, scheduleId, start, end,
  summaryCommunicationId}`. The browser sends no HealthcareService id,
  specialty, proposed Appointment, or clinical display metadata.
- **Logic**:
  1. Read `Patient/{patientId}`, `Practitioner/{practitionerId}`,
     `Schedule/{scheduleId}`, the Practitioner's NUCC-coded
     `PractitionerRole`, and `Communication/{summaryCommunicationId}`.
  2. Validate that the Schedule actor is that Practitioner; the summary's
     subject is that Patient; and the summary has the expected category,
     Device sender, `ai-generated` tag, and `preparation` status.
  3. Derive specialty, reason, complaint, and the single HealthcareService
     entirely from the authoritative role and Communication. Reject
     mismatches instead of accepting browser claims.
  4. Call type-level `$find` with the authoritative service, Schedule, and a
     narrow range covering `start`/`end`. Parse its **bare Bundle** and find
     an exact proposed Appointment whose `contained` Slot has the requested
     Schedule, start, and end. If none exists, return `slot_taken`.
  5. Take that exact fresh proposal, add the Patient participant, and add
     `description`, `comment`, and `reasonCode` derived from the
     Communication. Do not hand-reconstruct its service or contained Slot.
  6. Send a `Parameters` request whose `appointment` parameter contains that
     proposal to `medplum.fhirUrl('Appointment', '$book')`. Parse the bare
     Bundle response for the booked Appointment and persisted top-level
     Slot. `$book` performs the availability check inside a serializable
     transaction.
  7. Read-and-spread update the summary `Communication`:
     `recipient = [Practitioner/{id}]`, `about = [Appointment/{id}]`,
     `status = 'completed'`, `sent = now`. If this post-book linkage fails,
     log it and still return the booked Appointment; the Bot must not tell
     the patient that a booking failed after it actually committed.
- **Output**: `{ok: true, appointment: BookedAppointment}` or
  `{ok: false, reason: 'slot_taken'}`.
- **Errors**: absence of an exact fresh proposal and the verified Medplum
  availability-conflict OperationOutcome map to `slot_taken`. Invalid
  resource relationships, malformed summary state, and every unrelated
  operation failure are genuine thrown Bot failures.

---

## `src/bots/agent/agent-patient-chat.ts`

### `handler(medplum, event)`
- **Purpose**: FR-13/FR-14/FR-15 — the doctor-facing grounded Q&A agent.
- **Input**: `{npi: string, patientId: string, question: string,
  threadId?: string}`.
- **Logic**:
  1. Resolve the Practitioner by NPI and verify a real Appointment relates
     that Practitioner to `Patient/{patientId}`. Reject mismatched pairs.
  2. **Live, every call** (never cached): `loadPatientClinicalContext(medplum,
     patientId)` — the same shared read used by `agent-intake.ts`
     (`lib/patientContext.ts` above), so both bots ground themselves
     against identical data depth.
  3. Serialize into a compact, deterministic JSON context block.
  4. One Gemini call, single-turn (no multi-turn context retained by the
     model itself — see step 7 for how threading is achieved instead),
     `temperature: 0`, with the system prompt from `lib/prompts.ts`
     (Design doc §10: relay-only, fixed refusal for interpretation/advice
     requests, explicit "not recorded" for absent data).
  5. Output guard: scan the response for a small fixed list of
     interpretation-flavored phrases ("you should," "I recommend,"
     "likely has," etc.); if matched, substitute the fixed refusal string
     instead of returning the model's text (defense in depth, not a
     guarantee — Design doc §10).
  6. Persist the question as a `Communication` (`category: ai-chat`,
     `sender: Practitioner/{resolvedId}` for the verified asking doctor,
     `subject: Patient`,
     `partOf: [Communication/{threadId}]` if continuing a thread).
  7. Persist the answer as a second `Communication` (`sender:
     Device/ai-appointment-agent`, same `partOf` thread) — **this
     persisted thread, not model memory, is what "threading" means here**;
     each individual Gemini call is still single-turn and stateless.
- **Output**: `{answer: string, threadId: string}`.
- **Errors**: Gemini/network failure propagates; a "no data found for this
  patient" condition (e.g. brand-new patient with no clinical history at
  all) is not an error — the agent answers from an empty context and
  correctly reports nothing is recorded.

---

## Removed: `src/bots/agent/agent-expire-holds.ts`

This Bot does not exist. Booking uses one immediate `$book` operation, so no
intermediate hold state exists and no cron cleanup is required.

---

## Removed: `src/bots/core/cancel-appointment.ts`

The provider cancellation action posts directly to
`medplum.fhirUrl('Appointment', appointmentId, '$cancel')`. Medplum performs
the status update and deletes referenced Slots atomically in a serializable
transaction, so a custom Bot would duplicate safer native behavior.

---

## `src/bots/core/reschedule-appointment.ts` *(new — `RescheduleAppointment.tsx` previously had no bot backing at all)*

### `handler(medplum, event)`
- **Purpose**: give the fork's existing `RescheduleAppointment.tsx` UI
  action (present in the component tree, calling nothing until now) a
  real backing bot.
- **Input**: `{appointmentId: string, newStart: string, newEnd: string}`.
- **Logic**:
  1. Read the existing `Appointment/{appointmentId}` (for its `Schedule`/
     `serviceType`/`participant` references).
  2. Build a new proposed `Appointment` at `newStart`/`newEnd` on the same
     `Schedule`/`serviceType`/`participant`s.
     Include a contained proposed Slot because this retained questionnaire
     chooses a date/time directly instead of consuming a `$find` proposal.
  3. Send that proposal in a `Parameters` request to type-level `$book` via
     `medplum.fhirUrl(...)`, parse the bare Bundle, and return `slot_taken`
     only for the verified availability-conflict outcome. Until this
     succeeds, the original Appointment remains untouched.
  4. Preserve the original Appointment's clinical display metadata on the
     replacement and re-link its summary Communication to the replacement.
  5. Cancel the original through native instance-level `$cancel`.
- **Output**: `{ok: true, appointment: BookedAppointment}` or `{ok: false,
  reason: 'slot_taken'}`.
- **Known POC edge**: `$book`, Communication re-linking, and `$cancel` are
  separate operations. A failure after replacement booking can require
  reconciliation and may briefly or permanently leave both appointments.
  The Bot must surface that failure rather than label it `slot_taken`.

---

## `tools/seed/disease-csv.ts`

### `parseDiseaseDescriptions(csvPath: string): string[]`
- **Purpose**: the sole reader of `Disease_Description.csv`.
- **Logic**: parses the 41-row CSV, returns disease names in file order.
  Called once by `specialty-resolver.ts` to build `SPECIALTY_MAP` (zipped
  against the hand-authored specialty list below) — nothing else reads
  this file directly.

---

## `tools/seed/specialty-resolver.ts`

### `SPECIALTY_MAP: Map<string, string>` (disease name → specialty)
- Built by zipping `Disease_Description.csv`'s 41 disease names (in file
  order) against a hand-authored, ported specialty list — same 41-row
  table as the retired Python `specialty_mapping.py`, unchanged content.
  A row-count assertion at load time guards against the CSV and the
  hardcoded list silently drifting apart.

### `resolveSpecialty(reasonTexts: string[], typeTexts: string[]): string`
- **Purpose**: the corrected tiered matcher (Design doc §9).
- **Logic**:
  1. Tier 1: normalize and substring-match each of `reasonTexts` (from
     `Encounter.reasonCode[].coding[].display` and linked
     `Condition.code.text`) against `SPECIALTY_MAP`'s keys.
  2. If tier 1 yields nothing: tier 2, same match against `typeTexts`
     (from `Encounter.type[].text`) against a hand-map that **must cover
     all 49 known corpus `type.text` values** — confirmed via a
     full-corpus audit that tier 1 alone only resolves 52.27% of
     practitioners (473 of 905), so tier 2 is doing nearly half the real
     work here, not acting as a rare fallback. `--dry-run` asserts
     completeness: any `type.text` encountered that isn't a key in the
     hand-map is logged explicitly (not silently dropped to tier 3), so
     gaps in the table surface immediately instead of quietly inflating
     the "General Practice" bucket.
  3. If still nothing (tier 2 hand-map has no entry, logged per above):
     `'General Practice'`.
- **Output**: a single specialty string per encounter; the caller
  (`pass1-scan.ts`) does the majority vote across a practitioner's
  encounters.
- **Known limitation, stated plainly**: substring matching has an obvious
  failure mode (e.g. a screening/well-visit encounter whose reason text
  happens to contain a disease-adjacent word) — the `--dry-run` histogram
  is the intended way to spot-check this before a full run, not a
  guarantee of clinical accuracy.

## `tools/seed/pass1-scan.ts`

### `scanPractitionerSpecialties(filePaths: string[]): Map<npi, string>`
- Streams every bundle (never holds 1.1GB in memory), collects each
  practitioner's encounter reason/type texts keyed by their **Synthea
  stable id** (not their fake NPI — the id used for dedup, per the
  duplicate-Practitioner fix), calls `resolveSpecialty` per encounter, and
  majority-votes per practitioner.
- Asserts NPI uniqueness across the corpus while it's already iterating;
  fails loudly (naming the colliding NPIs) rather than silently
  proceeding if violated.

## `tools/seed/pass2-transform.ts`

### `transformBundle(bundle: Bundle, specialtiesByStableId: Map, mode: 'slim' | 'full'): Bundle`
- Per-bundle rewrite: (1) filters entries to the slim set or retains the
  full-mode resource set; (2) assigns every retained resource a
  deterministic FHIR id, rewrites every reference to that id, and emits an
  unconditional `PUT ResourceType/{id}` request (never POST); (3) injects
  the resolved specialty as
  both `PractitionerRole.specialty` (new resource, NUCC-coded) and
  `Practitioner.qualification[0].code.text` (display copy); (4) adds the
  mandatory timezone extension to each `Practitioner` so they're
  immediately schedulable without a separate provisioning step later.

## `tools/seed/upload.ts`

### `uploadBundle(medplum, bundle): Promise<Bundle>`
- Executes the transaction/batch and returns the response Bundle. Retries
  transient failures, rejects validation failures, and inspects every batch
  entry status so a partially failed HTTP-200 batch is never reported as a
  successful upload.

## `tools/seed/chunk-bundle.ts`

### `splitForUpload(bundle): {identityBundle, clinicalChunks}` / `uploadPatientBundle(...)`
- All references are already deterministic before chunking. Identity
  resources upload first in a transaction; clinical resources upload in
  size-bounded batch chunks below Medplum's default 1 MB request limit.
  Bootstrap resources use the same unconditional PUT rule, including the
  fixed `Device/ai-appointment-agent` id.
