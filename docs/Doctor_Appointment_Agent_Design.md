# Doctor Appointment Agent — Application Design

> **Synchronized 2026-08-05:** This design matches the authoritative
> implementation plan at
> `docs/superpowers/plans/2026-08-04-medplum-native-implementation.md`.

Supersedes the original Python/FastAPI + Streamlit design. New
requirements made this a Medplum-native, two-sided application; the
Python implementation (8 of 14 tasks completed, in
`.claude/worktrees/doctor-appointment-agent-impl`) is retired in favor of
the design below. Everything here was validated against two local
checkouts provided during design: the Medplum monorepo itself
(`medplum/`, package line `5.1.27`) and the fork target
(`medplum-scheduling-demo/`) — claims are marked **confirmed** where they
were checked directly against that source, not just documentation.

## 1. Goals & Non-Goals

**Goal:** demonstrate an AI agent that takes a patient's brief
natural-language appointment request, uses their real FHIR history plus
NPPES doctor discovery, books them into a synthetic-but-realistic
appointment slot — and, on the other side, lets the booked doctor see an
AI-generated pre-visit summary and chat with an agent grounded in that
patient's real record.

**Non-goals:** diagnosis, adaptive questionnaires, clinical decision
support, medication recommendations, patient-agent cancellation or
rescheduling flows, waitlists, reminders,
recurring appointments, real authentication for doctors (see §"Doctor
identifier & access model"), and — critically — no clinical
judgment/advice from either AI surface, even when directly asked.

## 2. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Fork of `medplum-scheduling-demo` (React + Vite + `@medplum/react`) with every `@medplum/*` package pinned exactly to `5.1.27` | Already implements a provider-side Schedule/Appointment UI and a patient chart with booking; a single exact Medplum package family avoids client/operation contract drift |
| Backend logic | Medplum Bots (TypeScript, sandboxed serverless functions) | The project's "build natively on Medplum" requirement rules out a separate backend service; Bots are Medplum's only backend-logic mechanism |
| Datastore | Medplum only | Patient/clinical data, doctor records, scheduling, and the AI-generated summaries/chat all live here — no separate database |
| Doctor discovery | NPPES API | Unchanged from the original design — directory-only, no availability |
| AI | Google Gemini free tier (`gemini-2.5-flash-lite`), via its OpenAI-compatible endpoint | Same choice as the Python phase — genuinely free (no credit card), and the OpenAI-shaped client works from a Bot the same way it worked from Python |

No Python remains in the live application. The seeding tool (§9) is a
standalone TypeScript/Node CLI, ported from the original Python script.

## 3. Two foundational facts, confirmed by reading Medplum's source directly

These were originally open risks; both are now settled by direct
inspection of the Medplum monorepo, not assumption:

1. **Bots can make outbound `fetch()` calls.** `packages/server/src/bots/
   vmcontext.ts` injects `fetch` (via `node-fetch`) into the sandbox a
   bot's code runs in, with no domain restriction visible. More decisively,
   the actual production Lambda runtime (`packages/bot-layer/package.json`)
   bundles `node-fetch`, `undici`, **and `twilio`** — Medplum ships an SMS
   client inside the bot runtime, which only makes sense if bots can reach
   the outside internet. This is what makes calling Gemini and NPPES from
   a Bot viable at all.
2. **`Appointment/$find`, `$book`, and instance-level `$cancel` are real,
   implemented operations.** `$book` takes a `Parameters` request whose
   `appointment` parameter contains the proposed Appointment; `$find` and
   `$book` return bare `Bundle` resources, not `Parameters` envelopes.
   `$book` runs the same availability validation as `$hold` inside a
   serializable transaction, so this immediate-confirmation flow needs no
   hold/confirm phase or expiry job. Every operation URL is built with
   `medplum.fhirUrl(...)`. The target server still must pass the live
   contract preflight before release; source/package compatibility is not
   inferred from a hosted server's version label alone.

## 4. Fork strategy

Fork `github.com/medplum/medplum-scheduling-demo`. Verified directly
against the cloned repo — every file below was confirmed to exist with
that exact name and role, not inferred from the README.

- **Copy the scaffold without nesting Git state**: copy the fork into the
  repository root while excluding `.git`, build artifacts, dependencies,
  and the fork's `.gitignore`. Merge ignore rules into the root file and
  track the generated `package-lock.json`.
- **Delete the superseded free-slot path**: remove
  `set-availability.ts`, `book-appointment.ts`, their tests, and
  `CreateAppointment.tsx`. Strip only the free-slot branch from
  `CreateUpdateSlot.tsx`; keep the busy-unavailable blocking path.
- **Keep and fix provider operations**: scope
  `block-availability.ts` to the blocking Schedule's actor. Delete the
  custom `cancel-appointment.ts` bot and call Medplum's atomic native
  `$cancel` from `AppointmentActions.tsx`. Add
  `reschedule-appointment.ts`, which books the replacement through
  `$book`, preserves Appointment metadata, re-links the summary, and then
  cancels the original through native `$cancel`.
- **Modify the shell**: make `/agent` the signed-in home, add the
  `/agent/*` and `/desk/*` routes and menus, and retire the practitioner-owned
  `My Schedule` and `My Appointments` navigation. Keep the old list/calendar
  routes as redirects so bookmarks do not strand users.
- **Deploy the final seven Bots correctly**: update `deploy-bots.ts` and
  `UploadDataPage.tsx` for `block-availability`,
  `reschedule-appointment`, and the five agent Bots. Resolve each Bot's
  placeholders, match its own compiled Binary, create missing Bots through
  the project admin endpoint, and invoke that Bot's `$deploy` operation.

## 5. Routes

```
/agent                                   patient picker
/agent/:patientId                        history + complaint form
/agent/:patientId/doctors                ranked candidate list
/agent/:patientId/doctors/:npi/slots     slot picker
/agent/:patientId/confirmed/:apptId      confirmation (NPI shown large, copyable)

/desk                                    NPI input
/desk/:npi                               patient queue
/desk/:npi/patients/:patientId           patient-agent chat
```

One route per step, matching the convention every existing page in the
fork already follows (each of `PatientPage`, `SchedulePage`,
`AppointmentDetailPage`, etc. is its own route/page, not a single
step-state component). Booking-flow state that needs to survive across
routes (extracted intent, chosen candidate) goes in a small React context,
mirroring the fork's existing `Schedule.context.ts` pattern.

## 6. Bot decomposition (`src/bots/agent/`)

A bot is justified only by (a) a secret the browser can't hold, (b) an
endpoint the browser can't reach (NPPES has no CORS headers — confirmed by
direct request — so it must go through a bot), or (c) a write needing to
be one atomic operation. Patient history loading, previous-practitioner
*display*, and the doctor's patient-queue view are all plain authenticated
FHIR searches the frontend makes directly — no bot needed for any of
them.

| Bot | Trigger | Does |
|---|---|---|
| `agent-intake` | `$execute`, once per complaint submission | Reads the patient's Condition/MedicationRequest/AllergyIntolerance/Encounter. One Gemini call (temp 0, JSON mode) returns `{specialty, reason, summary}` in one shot — no urgency/triage classification (decision recorded 2026-08-06: this is a POC where a patient just wants to see a doctor, not a clinical triage system). Persists the result immediately as an authoritative `Communication`: `topic` is the normalized NUCC specialty, `reasonCode` is the concise reason, `note` preserves the original complaint. The resource remains `preparation` with no recipient until booking. If the specialty cannot be mapped confidently, the bot asks for clarification instead of guessing. |
| `agent-find-doctors` | `$execute` | Previous-physician path: `Encounter→Practitioner` for this patient, filtered by an **exact** `PractitionerRole.specialty` match (confirmed real search parameter) against the LLM-inferred specialty. **Ranking rule**: a previous physician is only ever surfaced when that exact match succeeds — if it does, shown first, ahead of every NPPES candidate, regardless of distance (**tie-break**: most-recent `Encounter` wins if multiple previous practitioners match). No exact match → no previous-physician result at all (not a fuzzy/partial inclusion), list is purely NPPES candidates. New-doctor path: NPPES search via the ported specialty→taxonomy table, ranked by distance (§8) among themselves. Returns top ~10 with a `source: previous\|nppes` badge. Writes nothing — candidates aren't persisted until one is booked, and it never provisions a Practitioner/Schedule itself (that's `agent-ensure-doctor`, below). |
| `agent-ensure-doctor` | `$execute`, once per slot-picker page load | Thin wrapper around `ensurePractitionerAndSchedule` (below) — exists as its own bot because provisioning may need an NPPES lookup (no CORS, must run bot-side). Returns `{practitionerId, scheduleId, healthcareServiceId}`; the UI then calls `$find` directly with that id — there is only one visit type, so no urgency-based selection is needed. This is the only caller of `ensurePractitionerAndSchedule` — not `agent-find-doctors`, and never the UI directly. |
| *(shared lib, not a bot)* `ensurePractitionerAndSchedule` | called only by `agent-ensure-doctor` | Searches by NPI and reuses existing resources; otherwise creates the `Practitioner`, matching `PractitionerRole`, and `Schedule`. The Schedule uses an NPI-seeded deterministic weekly template and carries a single `SchedulingParameters` extension for the one Office Visit service. The search-before-create approach is idempotent in ordinary use; a concurrent first request for the same previously unseen NPI can still race and is an accepted POC limitation. No independent trigger — it does not get a separate Bot artifact. |
| `agent-book-appointment` | `$execute` | Accepts only `{patientId, practitionerId, scheduleId, start, end, summaryCommunicationId}`. Re-reads and validates the Patient, Practitioner, Schedule, PractitionerRole, and intake Communication; derives specialty, reason, and complaint from those server-side resources; re-runs `$find`; and chooses the exact fresh proposal whose contained Slot matches the requested time. It adds the Patient participant and clinical display metadata before sending that exact proposal to `$book`. On success it read-and-spread links the summary Communication. A booking conflict becomes `{ok: false, reason: 'slot_taken'}`; unrelated pre-book failures re-throw, while a post-book Communication-link failure is logged so a committed booking is not reported as failed. |
| `agent-patient-chat` | `$execute`, once per chat message | Accepts the doctor's NPI, resolves the real Practitioner, and verifies a booking relationship to the Patient before answering. Re-reads the Patient/Condition/MedicationRequest/AllergyIntolerance/Encounter **live, every call**, via the same shared `loadPatientClinicalContext` used by `agent-intake`. One Gemini call, single-turn, no tools. Persists the verified Practitioner-authored question and Device-authored answer as threaded `Communication` resources. |
| Native `$cancel` / `reschedule-appointment` *(core, new)* | appointment-detail action available to the demo operator (not exposed in the patient agent flow) | Cancellation calls Medplum's atomic instance-level `$cancel` directly. Rescheduling books the replacement through `$book`, preserves metadata and the summary link, then cancels the original through native `$cancel`. There is no custom cancellation or hold-expiry Bot. |

## 7. Scheduling mechanics

`ensurePractitionerAndSchedule` builds a `Schedule` with exactly one
`SchedulingParameters` extension, for the single Office Visit service
(confirmed exact URL:
`https://medplum.com/fhir/StructureDefinition/SchedulingParameters`).
The extension has a `service` reference to the HealthcareService plus its
own `duration`, matching `alignmentInterval`, `timezone`, and `availability`.
The service reference is required: a Schedule-level group without one does
not match the requested service. An explicit alignment interval avoids the
otherwise-default hourly grid and produces 30-minute starts.
**Gotcha worth building correctly the first time**: `availableTime`'s
`daysOfWeek` sub-extension repeats once per day — a doctor working
Mon/Wed/Fri needs three separate `{url: 'daysOfWeek', valueCode: ...}`
entries inside one `availableTime` block, not one entry holding an array.
Getting this wrong silently produces a doctor with zero bookable time
rather than an obvious error.

`$find` additionally requires (confirmed directly in `find.ts`'s operation
definition): exactly one `service-type-reference` (which must be present in
the target `Schedule.serviceType` array — a Schedule here always lists
the single Office Visit service), one-or-more `schedule` references, a
`start`/`end` range capped at 31 days, and — per
`getSchedulingParametersGroup` — every
`Schedule` must have exactly one `actor` and a resolvable timezone (from
the actor's extension or the Schedule/HealthcareService's own
`SchedulingParameters`) or the operation throws `No timezone specified`.
Confirmed separately: `Practitioner` needs nothing beyond that resolvable
timezone for `$find` to accept it (no `active` check, no other field
gating); an absent `Schedule.planningHorizon` is not an error and doesn't
default to anything — it's silently unbounded, capped only by the
request's own 31-day window.

The browser calls `$find` only to display proposed times. At booking it sends
only ids and the selected start/end. The booking Bot repeats `$find` against
the authoritative service and Schedule, selects the exact fresh proposal,
and sends that proposal in a `Parameters` request to `$book`. Both operations
return bare `Bundle` resources. Every operation URL is built with
`medplum.fhirUrl(...)`.

Schedules start fully open — no fake pre-booked history, consistent with the
original design's decision (see Data Model doc for the full resource shape).

## 8. Distance ranking

Synthea already writes a real `http://hl7.org/fhir/StructureDefinition/
geolocation` extension (lat/long) onto every patient's address — no zip
lookup needed on the patient side. Only NPPES-returned doctors need one
(NPPES gives address/zip only). A compact 3-digit-zip (ZCTA3) centroid
table (~900 rows, ~20KB) is used rather than full 5-digit (~41k rows,
>1MB) — ±10–20 mile accuracy is fine for a ranking signal, not
turn-by-turn, and keeps bot bundle size small. Plain Haversine formula,
pure/unit-testable function, called from `agent-find-doctors` (ranking has
to happen server-side anyway since NPPES itself must be called from a
bot).

## 9. Seeding tool (`tools/seed/`, standalone TypeScript/Node CLI, not a bot)

Ports `scripts/import_synthea_data.py` + `scripts/specialty_mapping.py`
from the retired Python implementation. Not a bot: needs filesystem access
to the 1.1GB dataset and a long runtime, neither of which bots support.
Authenticates via `@medplum/core`'s `startClientLogin` (client-credentials
flow).

- **Specialty-resolution fix (the single most important correctness issue
  found during redesign)**: the original matcher exact-matched normalized
  `Encounter.type[].text` against the 41 names in `Disease_Description.csv`.
  Verified against all 983 real bundles: there are exactly 49 distinct
  `type.text` values corpus-wide, and the intersection with the 41 disease
  names is **empty**. Ported as-is, every practitioner would resolve to
  "General Practice" and the previous-physician-reuse feature could never
  fire for any specialist. Fixed with a tiered matcher: **tier 1** —
  substring-match `Encounter.reasonCode[].coding[].display` and linked
  `Condition.code.text` against the 41 disease names (11,048 encounters
  carry `reasonCode`; 7,304 Conditions link back to encounters); **tier
  2** — fall back to a hand-map covering **all 49** known `type.text`
  strings (weaker signal, encounter *kind* not diagnosis); **tier 3** —
  "General Practice" fallback. Majority vote per practitioner across their
  encounters, same as originally designed — just fixed what's being
  matched. **Confirmed via full-corpus audit that tier 1 alone only
  resolves 52.27% of practitioners (473/905)** — tier 2's hand-map is
  built and reviewed as a first-class table covering the real spread of
  corpus values, not a rare fallback, and `--dry-run` logs any `type.text`
  value it doesn't recognize rather than silently letting it fall to
  "General Practice." The histogram this produces is also the tuning tool
  for near-universal Synthea conditions (hyperlipidemia/prediabetes/
  obesity) that could otherwise skew the distribution.
- **Identity and duplicate-Practitioner fix**: Synthea repeats the same
  Practitioner (same stable id, same fake NPI) across many bundles. Medplum
  replaces caller-supplied ids on `POST`, so every retained seed resource is
  normalized to a deterministic FHIR id and written with unconditional
  `PUT ResourceType/{id}`. References are rewritten to those ids before
  upload. Retries are idempotent and a repeated Practitioner upserts instead
  of multiplying. The tool asserts NPI uniqueness across
  practitioners and fails loudly (reporting exactly which NPIs collided)
  if that assumption is ever violated — not yet verified at full-corpus
  scale. If it fails: a handful of collisions gets a disambiguating suffix
  appended to the (already-fake) NPI for internal bookkeeping; widespread
  collisions would mean switching the dedup key to Synthea's own id
  entirely and demoting NPI to a display-only field. Decide reactively,
  not preemptively.
- **Filter dataset**: keep only the 7 resource types the app reads
  (Patient, Practitioner, Organization, Encounter, Condition,
  MedicationRequest, AllergyIntolerance) — cuts out Observation/Claim/
  ExplanationOfBenefit/Procedure/DiagnosticReport/ImagingStudy, roughly
  90% of the 1.1GB/432K-resource corpus.
- **Bootstrap pass**: deterministic unconditional PUTs create/update the
  fixed-id HealthcareServices, `Device/ai-appointment-agent`, and the small
  `ai-previsit-summary`/`ai-chat` CodeSystem/ValueSet set. Their fixed
  references are therefore resolvable exactly.
- **Upload safety**: transformed patient bundles are split into a small
  identity transaction plus clinical batch chunks below the server's 1 MB
  request limit. Each batch entry status is checked; retryable failures are
  retried without hiding per-entry FHIR failures.
- CLI flags: `--limit N` (small default for dev iteration), `--slim`/
  `--full`, `--dry-run` (prints the specialty histogram without writing
  anything). Stream-parses files — never holds 1.1GB in memory.

## 10. Doctor chat agent — safety boundary

Enforced structurally first, prompt second, output-guard third (weak,
labeled as such, not oversold):
1. **Structural**: `patientId` is a bot parameter the model never chooses;
   the bot fetches only that patient's data; no tools, no writes, single
   completion turn. The model cannot reach outside one patient's
   compartment regardless of what it's asked.
2. **System prompt**: relay/summarize only what's in the provided record;
   never diagnose, interpret, suggest treatment/medication/tests, or give
   prognosis/advice, even hypothetically; fixed refusal string if asked
   for any of that; explicit "not recorded" if the answer isn't in the
   data. `temperature: 0`.
3. **Output guard** (defense in depth, not a guarantee): a small keyword
   screen on the response ("you should", "I recommend", "likely has",
   etc.) that swaps in the refusal if matched.
4. **UI**: persistent banner above the chat stating this is record-lookup
   only. A few canned example questions to drive the demo.
5. **Audit**: every question and answer persisted as threaded
   `Communication` resources — any boundary violation is inspectable after
   the fact.

## 11. Doctor identifier & access model

A signed-in Medplum account grants its user **demo operator** access. It
does not identify the user as a doctor or a `Practitioner` resource. The app does not create a
`Schedule` for that profile and does not expose practitioner-owned `My
Schedule` or `My Appointments` views. Their legacy routes redirect signed-in
operators to `/agent` and signed-out visitors to `/`.

NPI is the doctor identifier, reused across both doctor pools (Synthea
"previous physician" fake NPIs and NPPES real NPIs — confirmed they can
never collide, since real NPIs are always 10 digits and Synthea's are
short, e.g. `"290"`). It's always visible on the patient-facing
confirmation page. Entering it on `/desk` is a **display filter, not a
login, identity assertion, or access-control mechanism** — this is an
explicit, deliberate scope decision for the POC, not an oversight. No real
per-doctor authentication is implemented.

## 12. Error handling

- **Bot invocation errors, generally (confirmed via direct source read)**:
  `medplum.executeBot()` never resolves to a `{success: false, ...}`
  value — any bot failure (thrown error, non-2xx response) makes the
  returned Promise **reject** with `OperationOutcomeError`. Every
  bot-calling UI component wraps `executeBot()` in try/catch and reads
  `err.outcome.issue[0].details.text` for a human-readable message, rather
  than expecting a resolved failure object. `agent-book-appointment`'s
  `{ok: false, reason: 'slot_taken'}` (below) is a deliberate, singled-out
  exception to this pattern for exactly one expected, non-erroneous case —
  every other bot failure is a genuine thrown error, left to propagate.
- NPPES/Gemini unreachable from a bot → surfaced as a clear error, no
  silent fallback.
- No exact specialty match on the previous-physician path → falls through
  to NPPES search transparently (§6); zero NPPES results → UI shows "no
  doctors found," not an error.
- Slot taken between display and booking → the Bot's fresh `$find` either
  lacks an exact proposal or `$book` rejects during its serializable
  availability check. The Bot returns `{ok: false, reason: 'slot_taken'}`
  only for those expected conflict cases; unrelated failures re-throw. The
  UI re-fetches slots on `slot_taken`.
- LLM fails to confidently extract a specialty → ask the user to clarify
  rather than guessing (unchanged from the original design's philosophy).

## 13. Testing

Following the fork's existing `vitest` pattern, pure helper tests cover
distance, specialty resolution, ranking, seed transformation/chunking, and
prompt/output guards. Handler tests cover authoritative booking re-reads,
summary validation, fresh `$find` selection, `$book` parsing, native cancel,
relationship checks, and failure classification. Before seeding and release,
live target preflights verify deterministic PUT identity, the exact
`$find`/`$book`/`$cancel` contracts, and the service-specific scheduling grid.
The final acceptance pass walks both user flows end to end.

## 14. Deployment

Vite dev server (or a static build) for the frontend. All `@medplum/*`
packages are pinned together at exactly `5.1.27`. The corrected deployment
path registers seven Bots (`block-availability`, `reschedule-appointment`,
and the five `agent-*` Bots), resolves each Bot's placeholders against its
own created-or-found Bot resource and Binary, uploads the compiled code, and
calls `$deploy` for each one. Merely creating Bot resources is not a
deployment. Medplum, NPPES, and Gemini remain external dependencies; there
is no Docker Compose or separate application database.

## 15. What's dropped from the Python implementation

Entire FastAPI app (`app/api/`, `app/main.py`, routers), Streamlit UI,
Docker Compose, `app/core/medplum_client.py` (replaced by `@medplum/core`'s
already-authenticated-inside-a-bot client), `app/config.py`/pydantic-settings
(replaced by Bot secrets + Vite env), all `app/models/*.py` Pydantic DTOs
(replaced by `@medplum/fhirtypes` + a handful of bot-payload interfaces),
`app/core/exceptions.py`, `app/patients/service.py` (collapses into direct
browser searches + `@medplum/react`'s `PatientSummary` component), the
`app/scheduling/`/`app/booking/` concepts (replaced by Medplum's native
scheduling operations), the full pytest suite/`conftest.py`/
`requirements.txt`.

**Ported, not deleted**: the 41-row Disease→Specialty table (now the seed
of a corrected tiered matcher), the NPPES response-mapping logic and
specialty→taxonomy table (upgraded to real NUCC codes), the intent system
prompt (extended with the `summary` field).

## 16. Open items / Future work

- Run the documented target preflights before release: version/identity
  before seeding, then live `$find`, `$book`, `$cancel`, per-service
  `SchedulingParameters`, and all seven deployed Bot executions.
- Optional demonstration `AccessPolicy` (scoped to one hand-created
  practitioner membership) as a "here's how real per-doctor enforcement
  would work" artifact — deliberately not the main `/desk` access model,
  which stays an intentionally unauthenticated display filter.
- Whether Medplum's own "Spaces" AI feature already overlaps with the
  doctor-chat-agent idea is genuinely unresolved (a competitor-research
  pass could not confirm either way) — worth a direct check once real
  Medplum access is available.

(There is only one `HealthcareService`, "Office Visit." Per the product
decision recorded 2026-08-06, this app performs no urgency/triage
classification — it's a POC where a patient just wants to see a doctor, not
a clinical triage system. The previously-planned second "Urgent Visit"
HealthcareService and all routine/urgent branching have been removed from
the design; see §6, §7, and the Data Model doc.)
