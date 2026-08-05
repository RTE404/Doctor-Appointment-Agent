# Doctor Appointment Agent — Application Design

> ⚠️ **Superseded on specific points by the implementation plan
> (2026-08-05 correction pass).** This doc and the LLD/Specs/HLD/Data
> Model/Backend/Context docs are still the source of truth for
> architecture and rationale — but `docs/superpowers/plans/2026-08-04-medplum-native-implementation.md`
> is authoritative wherever the two disagree on these specific points,
> confirmed against real Medplum source after this doc was written:
> booking uses a single **`$book`** call (not `$hold`→`$confirm`) applied
> to the exact proposed Appointment `$find` returns, with the missing
> Patient participant added before booking; there is **no `agent-expire-holds`
> bot** (no hold state exists to expire); cancellation uses Medplum's
> **native `$cancel`** operation directly (no hand-rolled
> `cancel-appointment.ts` bot); `Schedule` needs **two** `SchedulingParameters`
> extensions (one per HealthcareService, each with a `service` sub-extension
> and an explicit `alignmentInterval`), not one. See
> `docs/Issues_Audit_Response.md` for the full verification trail. This
> doc will be reconciled in a future pass; until then, treat the plan as
> authoritative on these points and this doc as authoritative on
> everything else.

Supersedes the original Python/FastAPI + Streamlit design. New
requirements made this a Medplum-native, two-sided application; the
Python implementation (8 of 14 tasks completed, in
`.claude/worktrees/doctor-appointment-agent-impl`) is retired in favor of
the design below. Everything here was validated against two local
checkouts provided during design: the Medplum monorepo itself
(`medplum/`, commit `87cf429`) and the fork target
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
support, medication recommendations, cancellations, waitlists, reminders,
recurring appointments, real authentication for doctors (see §"Doctor
identifier & access model"), and — critically — no clinical
judgment/advice from either AI surface, even when directly asked.

## 2. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Fork of `medplum-scheduling-demo` (React + Vite + `@medplum/react`) | Already implements a provider-side Schedule/Appointment UI and a patient chart with booking — confirmed by direct inspection of the cloned repo, not just its README |
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
2. **`Appointment/$find`/`$hold`/`$confirm` are real, implemented, and
   unconditionally routed** — confirmed in `packages/server/src/fhir/
   operations/{find,hold,confirm}.ts` (each with its own test file) and
   `packages/server/src/fhir/routes.ts` (plain always-on routes, no
   feature flag). One honest caveat: this confirms the *source*, dated
   2026-08-02 — whichever Medplum server actually gets deployed to should
   get one live `$find` check before relying on it, to confirm the
   deployed version matches. `medplum-scheduling-demo` itself does **not**
   use these operations (see §4) — it predates them.

## 4. Fork strategy

Fork `github.com/medplum/medplum-scheduling-demo`. Verified directly
against the cloned repo — every file below was confirmed to exist with
that exact name and role, not inferred from the README.

- **Keep untouched**: `vite.config.ts`, `esbuild-script.mjs`,
  `src/main.tsx`, `src/config.ts`, `src/Schedule.context.ts`,
  `SignInPage`, `LandingPage`, `SearchPage`, `ResourcePage`,
  `UploadDataPage`, `PatientPage`, `PatientSchedulePage`,
  `AppointmentDetailPage`, `AppointmentsPage`, all of `src/components/**`,
  `src/bots/core/block-availability.ts`.
  `src/scripts/deploy-bots.ts` — extend its `Bots: BotDescription[]` array
  with the new bots (§6), don't rewrite its pattern: it already emits
  `Bot` resources keyed by `identifier: [{system: 'http://example.com',
  value: botName}]` via a conditional `PUT`, which is how the frontend
  calls bots by name (`medplum.executeBot({system, value}, ...)`), not a
  hardcoded UUID.
- **Modify (bug fixes in "keep untouched" territory, found during audit)**:
  `src/bots/core/cancel-appointment.ts` — confirmed to orphan its held
  `Slot` (never deletes it on cancel, leaving a permanent phantom block);
  fixed to delete the Slot(s) referenced by `Appointment.slot[]` once the
  Appointment is cancelled (LLD). `RescheduleAppointment.tsx` — confirmed
  to have **no bot backing at all**; its UI action previously called
  nothing. Given a new `src/bots/core/reschedule-appointment.ts` (LLD) —
  hold the new time, confirm, then cancel+delete-Slot the original,
  leaving the original booking untouched if the new time can't be held.
- **Delete**: `src/bots/example/*` (Synthea data replaces the built-in
  demo data), `src/bots/core/set-availability.ts` + its UI action — this
  bot materializes `status: free` Slot resources, a model superseded now
  that `$find` computes free time live. Keep its code as a reference only
  if the live-server check in §3 ever surfaces a version mismatch on the
  deployed target.
- **Modify**: `src/App.tsx` — confirmed to be a standard `react-router`
  `<Routes>` tree inside `@medplum/react`'s `<AppShell>` with a `menus`
  prop driving the left nav; add two new route trees (§5) as additional
  `<Route>` entries plus two new `menus` groups ("Patient Agent", "Doctor
  Desk"), following the existing pattern exactly.
  `src/pages/SchedulePage.tsx` — confirmed it fetches via
  `medplum.searchResources('Slot', ...)`, not `$find`. Since `$find`
  computes free time rather than materializing it, this calendar view
  needs relabeling to "booked & blocked time" or re-sourcing from `$find`.

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
| `agent-intake` | `$execute`, once per complaint submission | Reads the patient's Condition/MedicationRequest/AllergyIntolerance/Encounter. One Gemini call (temp 0, JSON mode) returns `{specialty, reason, urgency, summary}` in one shot — one LLM call produces both the intent and the pre-visit summary. Persists the summary immediately as a `Communication` (status `preparation`, no recipient yet). Normalizes the LLM's specialty string against a fixed NUCC-code table; if it can't confidently map, returns a clarification request rather than guessing. |
| `agent-find-doctors` | `$execute` | Previous-physician path: `Encounter→Practitioner` for this patient, filtered by an **exact** `PractitionerRole.specialty` match (confirmed real search parameter) against the LLM-inferred specialty. **Ranking rule**: a previous physician is only ever surfaced when that exact match succeeds — if it does, shown first, ahead of every NPPES candidate, regardless of distance (**tie-break**: most-recent `Encounter` wins if multiple previous practitioners match). No exact match → no previous-physician result at all (not a fuzzy/partial inclusion), list is purely NPPES candidates. New-doctor path: NPPES search via the ported specialty→taxonomy table, ranked by distance (§8) among themselves. Returns top ~10 with a `source: previous\|nppes` badge. Writes nothing — candidates aren't persisted until one is booked, and it never provisions a Practitioner/Schedule itself (that's `agent-ensure-doctor`, below). |
| `agent-ensure-doctor` | `$execute`, once per slot-picker page load | Thin wrapper around `ensurePractitionerAndSchedule` (below) — exists as its own bot because provisioning may need an NPPES lookup (no CORS, must run bot-side). Returns `{practitionerId, scheduleId, healthcareServiceIds: {routine, urgent}}`; the UI then calls `$find` directly with the id matching the patient's `urgency`. This is the only caller of `ensurePractitionerAndSchedule` — not `agent-find-doctors`, and never the UI directly. |
| *(shared lib, not a bot)* `ensurePractitionerAndSchedule` | called only by `agent-ensure-doctor` | Conditional-create (`ifNoneExist`) of `Practitioner` (keyed on NPI identifier) + `PractitionerRole` (specialty, queryable) + `Schedule` with NPI-seeded deterministic weekly availability (working days/hours/lunch gap derived from a hash of the NPI) + mandatory timezone extension (see §7's gotcha) + `serviceType` listing **both** HealthcareServices. No independent trigger — doesn't earn a separate bot/deployment artifact beyond the wrapper above. |
| `agent-book-appointment` | `$execute` | Builds a proposed Appointment (no `contained` Slot — `$hold` creates/owns a real top-level Slot itself, referenced afterward via standard `Appointment.slot[]`) → `$hold` → `$confirm` — deliberately not the simpler one-shot `$book` operation (confirmed by reading `book.ts`: it creates an Appointment as `booked` directly with no re-check that the slot is still free, which would reopen the double-booking race `$hold`'s atomic check exists to close). On success: writes `Appointment.description` (the "stated issue" shown to the doctor) / `.comment` / `.reasonCode` from the complaint/reason, updates the summary `Communication` with `recipient=[Practitioner]`, `about=[Appointment]`, `status=completed`. On hold failure: `$hold` **rejects** (Medplum bots never resolve to `{success: false}` — see §12); the bot catches that rejection and inspects the OperationOutcome's fixed `'Requested time slot is not available'` text specifically before returning `{ok: false, reason: 'slot_taken'}` — any other rejection re-throws as a genuine bot failure rather than being mislabeled as a booking race. |
| `agent-patient-chat` | `$execute`, once per chat message | Re-reads that patient's Patient/Condition/MedicationRequest/AllergyIntolerance/Encounter **live, every call**, via the same shared `loadPatientClinicalContext` read `agent-intake` uses — never a cached blob, never a differently-tuned query. One Gemini call, single-turn, no tools. Persists each question and answer as threaded `Communication` resources (audit trail — see Data Model doc). |
| `agent-expire-holds` | cron (hourly) | **Confirmed necessary**: `hold.ts` has no expiry/TTL logic anywhere, so a held slot stays `busy-tentative` forever unless something explicitly releases it. Finds stale `busy-tentative` Slots older than ~15 min and cancels the owning Appointment using the same delete-the-Slot logic as the fixed `cancel-appointment.ts` (§4). `Bot.cronString`/`cronTiming` are real, implemented, tested fields — a genuine supported trigger, not a workaround; `cronString` must be exactly 5 numeric fields (no seconds, no month/day aliases — confirmed via Medplum's pinned `cron-validator` version) or the job silently fails to schedule with no error surfaced. |
| `cancel-appointment` *(core, modified)* / `reschedule-appointment` *(core, new)* | direct UI action (not `$execute` from the agent flow) | See §4's fork-strategy fix and the LLD — both now delete the Slot they release, keeping `$find`'s live view accurate. |

## 7. Scheduling mechanics

`ensurePractitionerAndSchedule` builds a `Schedule` with the
`SchedulingParameters` extension (confirmed exact URL:
`https://medplum.com/fhir/StructureDefinition/SchedulingParameters`).
**Gotcha worth building correctly the first time**: `availableTime`'s
`daysOfWeek` sub-extension repeats once per day — a doctor working
Mon/Wed/Fri needs three separate `{url: 'daysOfWeek', valueCode: ...}`
entries inside one `availableTime` block, not one entry holding an array.
Getting this wrong silently produces a doctor with zero bookable time
rather than an obvious error.

`$find` additionally requires (confirmed directly in `find.ts`'s operation
definition): exactly one `service-type-reference` (which must be present in
the target `Schedule.serviceType` array — a Schedule here always lists
both Office Visit and Urgent Visit, so either can be requested depending
on `urgency`), one-or-more `schedule` references, a `start`/`end` range
capped at 31 days, and — per `getSchedulingParametersGroup` — every
`Schedule` must have exactly one `actor` and a resolvable timezone (from
the actor's extension or the Schedule/HealthcareService's own
`SchedulingParameters`) or the operation throws `No timezone specified`.
Confirmed separately: `Practitioner` needs nothing beyond that resolvable
timezone for `$find` to accept it (no `active` check, no other field
gating); an absent `Schedule.planningHorizon` is not an error and doesn't
default to anything — it's silently unbounded, capped only by the
request's own 31-day window.

Schedules start fully open — no fake pre-booked history, consistent with
the original design's decision (see Data Model doc for the full
resource-by-resource shape).

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
- **Duplicate-Practitioner fix**: Synthea repeats the same Practitioner
  (same stable id, same fake NPI) across many bundles as a bare `POST`, so
  importing as-is creates a fresh copy per occurrence, breaking "NPI is
  the unique doctor key." Fixed via conditional-create (`ifNoneExist`)
  keyed on Synthea's own stable id. The tool asserts NPI uniqueness across
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
- **Bootstrap pass**: conditional-create the `HealthcareService`,
  `Device`, and the small `ai-previsit-summary`/`ai-chat` CodeSystem/
  ValueSet, in one transaction bundle (uploadable via the fork's existing
  `UploadDataPage`).
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

NPI is the doctor identifier, reused across both doctor pools (Synthea
"previous physician" fake NPIs and NPPES real NPIs — confirmed they can
never collide, since real NPIs are always 10 digits and Synthea's are
short, e.g. `"290"`). It's always visible on the patient-facing
confirmation page. Entering it on `/desk` is a **display filter, not a
login or access-control mechanism** — this is an explicit, deliberate
scope decision for the POC, not an oversight. No real per-doctor
authentication is implemented.

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
- Slot taken between listing and booking → `$hold` rejects with a fixed
  `'Requested time slot is not available'` OperationOutcome message (no
  distinct status code exists for this vs. other validation failures —
  confirmed directly in `hold.ts`); `agent-book-appointment` matches on
  that exact text before returning `{ok: false, reason: 'slot_taken'}` —
  any other rejection reason re-throws, so a real bug is never mislabeled
  as a booking race. UI re-fetches slots on `slot_taken`.
- LLM fails to confidently extract a specialty → ask the user to clarify
  rather than guessing (unchanged from the original design's philosophy).

## 13. Testing

Following the fork's existing pattern (`vitest`, bot logic factored into
testable pure functions/libs): unit tests for the Haversine function, the
tiered specialty resolver (table-driven, using the real 41-disease list),
and the ranking comparator — all pure and independently testable without a
live Medplum connection. Beyond that, a manual end-to-end walkthrough for
both flows (see Specs doc's acceptance criteria) rather than a full
automated integration suite — consistent with this being a POC, not a
maintained product.

## 14. Deployment

Vite dev server (or a static build) for the frontend; bots deployed via
the fork's existing `deploy-bots.ts` script to the target Medplum project;
Medplum itself runs as an external dependency (managed cloud project or
self-hosted), same as NPPES and Gemini. No Docker Compose, no separate
database to stand up.

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

- Live-check `$find` against the actually-deployed Medplum server before
  relying on it in production use (§3's one remaining caveat).
- Optional demonstration `AccessPolicy` (scoped to one hand-created
  practitioner membership) as a "here's how real per-doctor enforcement
  would work" artifact — deliberately not the main `/desk` access model,
  which stays an intentionally unauthenticated display filter.
- Whether Medplum's own "Spaces" AI feature already overlaps with the
  doctor-chat-agent idea is genuinely unresolved (a competitor-research
  pass could not confirm either way) — worth a direct check once real
  Medplum access is available.

(The second `HealthcareService` for `urgency: urgent` is no longer an open
item — both Office Visit and Urgent Visit are settled, load-bearing parts
of the Schedule/booking design; see §6, §7, and the Data Model doc.)
