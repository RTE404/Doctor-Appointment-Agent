# Doctor Appointment Agent — Low-Level Design

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
     returning `{specialty, reason, urgency, summary}`.
  4. `normalizeLlmSpecialty(result.specialty)` — if it returns
     `undefined`, return a clarification-needed response rather than
     guessing (FR-4's "never silently default" rule).
  5. Create a `Communication` (`status: 'preparation'`, `category:
     ai-previsit-summary`, `subject: Patient/{patientId}`, `sender:
     Device/ai-appointment-agent`, `payload: [{contentString:
     result.summary}]`, `meta.tag: [{code: 'ai-generated'}]`, **no
     `recipient` yet** — the doctor isn't chosen).
- **Output**: `{intent: {specialtyCode, specialtyLabel, reason, urgency},
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

### `ensurePractitionerAndSchedule(medplum, npi: string, candidate?: DoctorCandidate): Promise<{practitionerId, scheduleId, healthcareServiceIds: {routine: string, urgent: string}}>`
- **Purpose**: lazy provisioning. Deliberately a plain function, not a bot
  — but since step 1 can call NPPES (no CORS, must run bot-side), this
  function only ever runs *inside* a bot. Its sole caller is the
  `agent-ensure-doctor` bot below — **not** `agent-find-doctors` (which
  only ranks/returns candidates, it never provisions) and not the UI.
- **Logic**:
  1. `medplum.searchOne('Practitioner', 'identifier=http://hl7.org/fhir/sid/us-npi|' + npi)`.
     If found, reuse; else — fetch `candidate` via `getNppesDoctorByNpi`
     if not already supplied, and conditional-create `Practitioner` +
     `PractitionerRole` (specialty) in one transaction, `ifNoneExist`-keyed
     on the NPI identifier.
  2. `medplum.searchOne('Schedule', 'actor=Practitioner/' + practitionerId)`.
     If found, reuse; else generate a `WeeklyTemplate` deterministically
     from a hash of the NPI (working days, start/end hour, lunch gap —
     same logic as the retired Python `template.py`, just producing a
     `SchedulingParameters` extension instead of Postgres rows), resolve
     the doctor's timezone from a small state→IANA table, and
     conditional-create the `Schedule` with `serviceType: [Office Visit,
     Urgent Visit]` — **both** HealthcareServices (FHIR R4's
     `Schedule.serviceType` is `0..*`, confirmed — a Schedule isn't
     limited to one), so either can be requested via `$find`'s
     `service-type-reference` depending on the patient's `urgency`.
- **Output**: the practitioner/schedule ids plus **both** HealthcareService
  ids, keyed by which urgency they serve — the caller picks the right one.
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
- **Output**: `{practitionerId, scheduleId, healthcareServiceIds:
  {routine, urgent}}`. The UI then picks `healthcareServiceIds[urgency]`
  and calls `$find` directly against Medplum with `scheduleId` and that
  service id — no further bot round-trip to view slots.
- **Errors**: NPPES/Medplum failure propagates as a genuine bot failure —
  there's no partial-success case here.

---

## `src/bots/agent/agent-book-appointment.ts`

### `handler(medplum, event)`
- **Purpose**: FR-9/FR-10.
- **Input**: `{patientId, npi, scheduleId, healthcareServiceId, start,
  end, summaryCommunicationId}` — `healthcareServiceId` is whichever of
  `agent-ensure-doctor`'s two returned ids matches the intake's `urgency`
  (caller's responsibility to have picked the right one).
- **Logic**:
  1. Build a proposed `Appointment` (`status: 'proposed'`, `start`/`end`,
     `serviceType` with the `service-type-reference` extension pointing
     at the selected `HealthcareService`, `participant`: Patient +
     Practitioner). **No `contained` Slot** — `$hold` creates and owns a
     real, top-level `Slot` resource itself (confirmed: Medplum's
     `hold.ts` references the conflicting/created Slot as its own
     resource, e.g. `Schedule/{id}`-scoped `blockingSlots`, never as
     something embedded in the Appointment); once held, standard FHIR
     `Appointment.slot[]` references it. This is also why
     `agent-expire-holds` can search `Slot?status=busy-tentative`
     directly — it would find nothing if the Slot were `contained`.
  2. `try { await medplum.post('Appointment/$hold', proposedAppointment) }
     catch`. **`$hold` failure is a rejected Promise, not a resolved
     `{success: false}`** (confirmed: `medplum.executeBot()`/`$hold` both
     surface failure by rejecting with `OperationOutcomeError`, never by
     resolving to a failure value). In the `catch` block: inspect
     `err.outcome.issue[0].details.text`. If it is exactly `'Requested
     time slot is not available'` (Medplum's fixed string for every
     availability/conflict rejection — confirmed in `hold.ts`), return
     `{ok: false, reason: 'slot_taken'}`. **Any other rejection reason
     (bad service reference, wrong duration, outside availability window,
     etc.) is a genuine bug and must re-throw**, not be mislabeled as
     `slot_taken` — conflating them would hide real errors as if they were
     normal booking races.
  3. `POST Appointment/{id}/$confirm`.
  4. `PATCH` the confirmed Appointment: `description` = the LLM's short
     reason string (this is the "stated issue" shown on the doctor's
     queue card — see Data Model doc), `comment` = the patient's verbatim
     complaint text (longer, raw, not shown on the queue card),
     `reasonCode[0].text` = same value as `description` (structured-field
     copy, for any FHIR-standard tooling that reads `reasonCode` instead
     of `description`), `priority` = mapped from urgency.
  5. `PATCH` the summary `Communication` (`summaryCommunicationId`):
     `recipient = [Practitioner/{id}]`, `about = [Appointment/{id}]`,
     `status = 'completed'`, `sent = now`.
- **Output**: `{ok: true, appointment: ConfirmedAppointment}` or
  `{ok: false, reason: 'slot_taken'}`.
- **Errors**: any failure *after* a successful `$hold` (e.g. `$confirm`
  fails) is a genuine failure, not a `slot_taken` conflict — the hold
  already proved the slot was available a moment earlier — and propagates
  as a bot failure (thrown), matching the general bot-error contract in
  Design doc §12, rather than being silently swallowed.

---

## `src/bots/agent/agent-patient-chat.ts`

### `handler(medplum, event)`
- **Purpose**: FR-13/FR-14/FR-15 — the doctor-facing grounded Q&A agent.
- **Input**: `{patientId: string, question: string, threadId?: string}`.
- **Logic**:
  1. **Live, every call** (never cached): `loadPatientClinicalContext(medplum,
     patientId)` — the same shared read used by `agent-intake.ts`
     (`lib/patientContext.ts` above), so both bots ground themselves
     against identical data depth.
  2. Serialize into a compact, deterministic JSON context block.
  3. One Gemini call, single-turn (no multi-turn context retained by the
     model itself — see step 6 for how threading is achieved instead),
     `temperature: 0`, with the system prompt from `lib/prompts.ts`
     (Design doc §10: relay-only, fixed refusal for interpretation/advice
     requests, explicit "not recorded" for absent data).
  4. Output guard: scan the response for a small fixed list of
     interpretation-flavored phrases ("you should," "I recommend,"
     "likely has," etc.); if matched, substitute the fixed refusal string
     instead of returning the model's text (defense in depth, not a
     guarantee — Design doc §10).
  5. Persist the question as a `Communication` (`category: ai-chat`,
     `sender: Practitioner` — the asking doctor — or a generic "desk"
     actor if no real doctor identity is tracked, `subject: Patient`,
     `partOf: [Communication/{threadId}]` if continuing a thread).
  6. Persist the answer as a second `Communication` (`sender:
     Device/ai-appointment-agent`, same `partOf` thread) — **this
     persisted thread, not model memory, is what "threading" means here**;
     each individual Gemini call is still single-turn and stateless.
- **Output**: `{answer: string, threadId: string}`.
- **Errors**: Gemini/network failure propagates; a "no data found for this
  patient" condition (e.g. brand-new patient with no clinical history at
  all) is not an error — the agent answers from an empty context and
  correctly reports nothing is recorded.

---

## `src/bots/agent/agent-expire-holds.ts`

### `handler(medplum, event)`
- **Purpose**: cleans up stale holds — confirmed necessary since `$hold`
  has no built-in expiry (Design doc §6).
- **Trigger**: `Bot.cronString` (hourly), not `$execute` — confirmed real,
  implemented, tested (`packages/server/src/workers/cron.ts`).
- **Logic**: `Slot?status=busy-tentative&_lastUpdated=lt{now - 15min}` →
  for each, resolve the owning `Appointment` (via
  `Appointment?slot=Slot/{id}`) and cancel it the same way
  `src/bots/core/cancel-appointment.ts` does (status update + delete the
  held Slot — see that bot's fix below), so a cron-expired hold and a
  user-initiated cancel leave Medplum in the exact same state.
- **Output**: count of expired holds cleaned up (for logging only; no
  caller depends on the return value since this runs on a cron, not a
  user-facing flow).

---

## `src/bots/core/cancel-appointment.ts` *(modified — fixes an orphaned-Slot bug)*

### `handler(medplum, event)`
- **Purpose**: unchanged from the fork's original bot (cancel an
  Appointment) — audited and found to leave its held `Slot` behind as a
  permanent phantom `busy`/`busy-tentative` block, since `Slot` only ever
  exists while busy/held (Data Model doc) and nothing was deleting it on
  cancel.
- **Fix**: after setting `Appointment.status = 'cancelled'`, read
  `Appointment.slot[]` and `medplum.deleteResource('Slot', slotId)` for
  each referenced Slot — not a status flip to `'free'`, an actual delete,
  matching Slot's "only exists while non-free" convention, so `$find`
  correctly shows that time as available again with no lingering
  resource.
- **Used by**: the existing `AppointmentDetailPage` cancel action (fork's
  own UI, untouched) and `agent-expire-holds` (§ above, same cleanup
  path).

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
  3. `try { $hold }` on the new proposed Appointment — same string-match
     failure handling as `agent-book-appointment` (§ above): on the fixed
     `'Requested time slot is not available'` rejection, return `{ok:
     false, reason: 'slot_taken'}` without touching the original
     Appointment; any other rejection re-throws.
  4. On successful hold: `$confirm` the new Appointment, then run the same
     cancel-and-delete-Slot logic as `cancel-appointment.ts` on the
     *original* Appointment.
- **Output**: `{ok: true, appointment: ConfirmedAppointment}` or `{ok:
  false, reason: 'slot_taken'}` — the original booking is left completely
  untouched whenever the new time can't be held, so a failed reschedule
  never loses the patient's existing slot.
- **Errors**: same rule as `agent-book-appointment` — any failure after a
  successful hold on the new slot is a genuine bug, propagates as a bot
  failure.

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

### `transformBundle(bundle: Bundle, specialtiesByStableId: Map): Bundle`
- Per-bundle rewrite: (1) filters entries down to the 7 resource types the
  app reads; (2) rewrites `Practitioner`/`Organization` entries from bare
  `POST` to conditional `ifNoneExist` upserts keyed on Synthea's stable id
  (the duplicate-Practitioner fix); (3) injects the resolved specialty as
  both `PractitionerRole.specialty` (new resource, NUCC-coded) and
  `Practitioner.qualification[0].code.text` (display copy); (4) adds the
  mandatory timezone extension to each `Practitioner` so they're
  immediately schedulable without a separate provisioning step later.

## `tools/seed/upload.ts`

### `uploadBundle(medplum, bundle): Promise<void>`
- `medplum.executeBatch(bundle)` (bundles are already `type: 'transaction'`
  with `urn:uuid` fullUrls, so cross-resource references resolve
  server-side). Retries transient failures; does not retry validation
  errors (those need a code fix, not a retry).
