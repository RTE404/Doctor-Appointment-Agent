# Doctor Appointment Agent — Medplum-Native Rebuild

> ⚠️ **Frozen snapshot, 2026-08-03.** A four-agent audit (scheduling-demo
> bot code, Medplum core resource/operation contracts, the `fhir/` dataset,
> and cross-doc consistency) surfaced several corrections and design gaps
> after this plan was written — all fixed directly in
> `Doctor_Appointment_Agent_{Design,LLD,Data_Model,Specs,HLD,Backend}.md`,
> not here. Notably: `Slot` is confirmed a top-level searchable resource,
> never `contained` in an Appointment; `$hold` failures are caught and
> string-matched rather than assumed to always mean "slot taken"; a new
> `agent-ensure-doctor` bot now owns provisioning (resolves this plan's
> ambiguity about who calls `ensurePractitionerAndSchedule`); tier-2
> specialty matching is a first-class, completeness-checked table (tier 1
> alone only covers 52.27% of practitioners, not the near-universal case
> this plan assumed); `cancel-appointment.ts` and `RescheduleAppointment.tsx`
> had real bugs/gaps in code this plan marked "keep untouched," now fixed;
> `urgency` drives a real `HealthcareService` choice, not an open item.
> **Those five docs are authoritative wherever they differ from the text
> below.**

## Context

The project was originally built as a Python/FastAPI + Streamlit app calling
Medplum over REST (8 of 14 planned tasks completed: config, domain models,
exceptions, a hand-rolled Medplum client, the Synthea import/specialty-
enrichment script, patients service, intent service, NPPES directory
service — committed in the worktree at
`.claude/worktrees/doctor-appointment-agent-impl`).

New requirements changed the shape of the project entirely: this needs to be
built **natively on Medplum** — its React component library and pre-built
scheduling app as the frontend, Medplum Bots as the only backend logic,
Medplum itself as the sole datastore — rather than a separate Python service
calling Medplum from outside. Two user-facing surfaces are now required
instead of one:

- **Patient-facing**: unchanged flow from the original design (pick a demo
  patient → view history → describe complaint → LLM infers specialty →
  rank candidate doctors by specialty + distance → pick one → see slots →
  book), now running as Medplum Bots + a forked Medplum React app instead
  of Python/Streamlit.
- **Doctor-facing** (new): a doctor identified by NPI can see every patient
  who's ever booked with them, each with a short AI-generated summary and
  their stated issue, and can open a chat with a "patient agent" — an LLM
  grounded strictly in that patient's real FHIR data — to ask follow-up
  questions. This agent must never diagnose, interpret, or give medical
  advice in any form; it exists purely to demonstrate that doctors can
  query patient data conversationally, not to produce real clinical output.

This plan supersedes the Python implementation and the prior implementation
plan (`2026-07-30-doctor-appointment-agent-implementation.md`, now marked
superseded). Two independent Plan-agent passes (one optimizing for fastest
working path, one for Medplum-idiomatic correctness) were reconciled into
the single design below — including one critical, empirically-verified
finding: **the specialty-matching logic as originally designed is a
guaranteed no-op against the real dataset** (see §2). The full architecture
this plan produced is written up as the current design docs
(`Doctor_Appointment_Agent_Design.md`, `_HLD.md`, `_Specs.md`, `_Backend.md`,
`_Data_Model.md`, `_LLD.md`) — this plan file is the historical record of
how that design was reached and fact-checked; the docs are the maintained
source of truth going forward.

## Recommended Approach

### 0. Two spikes — resolved by direct source inspection

Both were originally flagged as unknowns to verify empirically before
building anything. The user provided a full local checkout of the Medplum
monorepo (commit `87cf429`, dated 2026-08-02), which settles both directly
from source rather than from docs or assumption:

1. **Can a Medplum Bot make an outbound `fetch()` call? — Confirmed yes.**
   `packages/server/src/bots/vmcontext.ts` injects `fetch` (via `node-fetch`)
   directly into the sandbox a bot's code runs in, with no domain
   allowlist or restriction in that file. More decisively, the actual
   production Lambda runtime bots execute in
   (`packages/bot-layer/package.json`) bundles `node-fetch`, `undici`,
   **and `twilio`** (a third-party SMS API client) as dependencies — Medplum
   ships an SMS-sending library inside the bot runtime, which only makes
   sense if bots can reach the outside internet. Treat this as settled.
2. **Is `Appointment/$find`/`$hold`/`$confirm` live? — Confirmed yes, and
   unconditionally routed.** `packages/server/src/fhir/operations/
   {find,hold,confirm,book,cancel}.ts` all exist with their own test files
   (implemented and tested, not stubs), and `packages/server/src/fhir/
   routes.ts` registers them as plain always-on routes (`GET /Appointment/
   $find`, `POST /Appointment/$book`, `POST /Appointment/$hold`, `POST
   /Appointment/:id/$confirm`) with no feature flag visible around them.
   Treat this as settled for a server running this or a comparably recent
   Medplum version.

**One remaining honest caveat, not a gate**: this confirms the *source
code*, dated 2026-08-02. Whichever actual Medplum server gets deployed to
should be given one quick live check (a single `$find` call against a
test Schedule) before relying on it — just to confirm the deployed version
matches, not to re-litigate whether the feature exists at all. The
materialized-slot fallback (§1) is kept documented as cheap insurance for
that edge case, not because the primary path is still in doubt.

### 1. Fork strategy

Fork `github.com/medplum/medplum-scheduling-demo`. It already has a
provider-side Schedule/Appointment UI and a patient chart with a booking
action — most of the value here is not rebuilding that.

**This section is verified against the actual cloned repo** (at
`medplum-scheduling-demo/` in the project root), not just web research —
every file named below was confirmed to exist with that exact name and
role.

- **Keep untouched**: `vite.config.ts`, `esbuild-script.mjs`, `src/main.tsx`,
  `src/config.ts`, `src/Schedule.context.ts`, `SignInPage`, `LandingPage`,
  `SearchPage`, `ResourcePage`, `UploadDataPage`, `PatientPage`,
  `PatientSchedulePage`, `AppointmentDetailPage`, `AppointmentsPage`, all of
  `src/components/**`, `src/bots/core/{block-availability,
  cancel-appointment}.ts`. `src/scripts/deploy-bots.ts` — confirmed:
  extend its `Bots: BotDescription[]` array with the new agent bots, don't
  rewrite its pattern — it already emits `Bot` resources keyed by
  `identifier: [{system: 'http://example.com', value: botName}]` via a
  conditional `PUT`, which is how the frontend calls bots by name
  (`medplum.executeBot({system, value}, ...)`), not a hardcoded UUID.
- **Delete**: `src/bots/example/*` (Synthea replaces the built-in demo
  data), `src/bots/core/set-availability.ts` + its UI action — `$find` is
  confirmed available (§0), so the materialized-free-slot model this bot
  implements is superseded. Keep its code around only as a reference if
  the live-server check in §0 ever surfaces a version mismatch.
- **Modify**: `src/App.tsx` — confirmed it's a standard `react-router`
  `<Routes>` tree inside `@medplum/react`'s `<AppShell>`, with a `menus`
  prop driving the left nav; add the two new route trees below as
  additional `<Route>` entries plus two new `menus` groups ("Patient
  Agent", "Doctor Desk"), following the existing pattern exactly.
  `src/pages/SchedulePage.tsx` — **confirmed** (not just inferred) it
  fetches via `medplum.searchResources('Slot', ...)`, not `$find`. Since
  `$find` computes free time rather than materializing it, this calendar
  view needs relabeling to "booked & blocked time" or re-sourcing from
  `$find`.
- **New routes** (route-per-step, matching the pattern every existing page
  in this fork already follows):
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
  Booking-flow state (extracted intent, chosen candidate) that needs to
  survive across these routes goes in a small React context, mirroring
  the fork's existing `Schedule.context.ts` pattern — not URL params for
  everything.

### 2. Fix the specialty-resolution bug before porting it

The original design's matcher exact-matches normalized `Encounter.type[]
.text` against the 41 names in `Disease_Description.csv`. Verified against
all 983 real bundles: there are exactly 49 distinct `type.text` values
corpus-wide, and the intersection with the 41 disease names is **empty**.
Ported as-is, every practitioner resolves to "General Practice" and the
"has this patient seen a specialist before" branch can never fire.

**Fix — a tiered matcher**, verified against the real corpus to produce an
actual specialty spread (not just theoretical):
1. **Tier 1**: keyword-match `Encounter.reasonCode[].coding[].display` and
   linked `Condition.code.text` against the 41 disease names (normalized
   substring match, e.g. "Asthma" ⊂ "Childhood asthma"). 11,048 of the
   corpus's encounters carry `reasonCode`; 7,304 Conditions link back to
   encounters.
2. **Tier 2**: fall back to a small hand-map over the 49 known
   `type.text` strings (encounter *kind*, not diagnosis — much weaker
   signal, use only when tier 1 has nothing).
3. **Tier 3**: "General Practice" fallback.

Majority vote per practitioner across all their encounters, same as
originally designed — just fix what's being matched. Watch out for
near-universal Synthea conditions (hyperlipidemia, prediabetes, obesity)
inflating a couple of specialties — down-weight or exclude them from tier 1
if the resulting distribution looks skewed. Build a `--dry-run` mode into
the seeding tool (§6) that prints the specialty histogram so this can be
tuned without touching the server.

### 3. Bot decomposition (`src/bots/agent/`)

A bot is justified only by (a) a secret the browser can't hold, (b) an
endpoint the browser can't reach (NPPES has no CORS headers — confirmed by
direct request — so it must go through a bot), or (c) a write needing to be
one atomic operation. Patient history loading, previous-practitioner
*display*, and the doctor's patient-queue view are all plain authenticated
FHIR searches the frontend makes directly — no bot needed for any of them.

| Bot | Trigger | Does |
|---|---|---|
| `agent-intake` | `$execute`, once per complaint submission | Reads patient's Condition/MedicationRequest/AllergyIntolerance/Encounter. One Gemini call (`gemini-2.5-flash-lite`, temp 0, JSON mode) returns `{specialty, reason, urgency, summary}` in one shot. Persists the summary immediately as a `Communication` (status `preparation`, no recipient yet). Normalizes the LLM's specialty string against a fixed NUCC-code table; if it can't confidently map, returns a clarification request rather than guessing. |
| `agent-find-doctors` | `$execute` | Previous-physician path: `Encounter→Practitioner` for this patient, filtered by an **exact** `PractitionerRole.specialty` match against the LLM-inferred specialty. Ranking rule: a previous physician is only ever surfaced when that exact match succeeds — if it does, always shown first, ahead of every NPPES candidate, regardless of distance; no match → no previous-physician result at all, purely NPPES candidates. New-doctor path: NPPES search, ranked by distance (§5) among themselves. Returns top ~10 with a `source: previous|nppes` badge. Writes nothing until booked. |
| *(shared lib, not a bot)* `ensurePractitionerAndSchedule` | called by `agent-find-doctors`/booking flow | Conditional-create of `Practitioner` (NPI-keyed) + `PractitionerRole` (specialty, queryable) + `Schedule` with NPI-seeded deterministic weekly availability + mandatory timezone extension. No independent trigger — doesn't earn a separate bot/deployment artifact. |
| `agent-book-appointment` | `$execute` | Proposed Appointment → `$hold` → `$confirm` (deliberately not the simpler `$book`, which skips the re-validation `$hold` provides). On success: writes Appointment fields, updates the summary Communication (`recipient`, `about`, `status: completed`). On hold failure: returns `{ok: false, reason: 'slot_taken'}` from its normal return value, no throw. |
| `agent-patient-chat` | `$execute`, once per chat message | Re-reads that patient's data **live, every call**. One Gemini call, single-turn, no tools. Persists each Q&A as threaded `Communication` resources. |
| `agent-expire-holds` | cron (hourly) | `$hold` has no built-in expiry (confirmed by reading `hold.ts`) — finds stale `busy-tentative` Slots and cancels the owning Appointment. `Bot.cronString`/`cronTiming` confirmed real/implemented. |

### 4. Data model decisions

- **Summary + chat → `Communication` resources.** `recipient`, `subject`,
  `sent`, `category` are confirmed-real search parameters; `about` is a
  real field but confirmed **not** a search parameter. One `Device`
  resource as `Communication.sender`, tagged `ai-generated`.
- **Adopt `PractitionerRole` for specialty** (reversing the original
  design's POC shortcut) — semantically correct, and a single indexed
  search instead of pulling every practitioner and filtering in code.
  Dual-write `Practitioner.qualification[0].code` as a display copy.
- **NUCC provider taxonomy codes** as the single specialty vocabulary.
- **One `HealthcareService`** ("Office Visit", 30 min) required by
  `$find`/`$hold`.
- **"Every patient who's ever booked with NPI X"** avoids depending on
  `Communication:about` (confirmed absent) or unverified reference-chaining
  modifiers — three separate confirmed-real queries, joined in memory.
- **`SchedulingParameters` extension** — confirmed exact URL
  `https://medplum.com/fhir/StructureDefinition/SchedulingParameters`;
  `availableTime`'s `daysOfWeek` repeats once per day, not an array.

### 5. Distance ranking

Synthea already writes real lat/long onto every patient's address — no zip
lookup needed patient-side. Only NPPES doctors need a zip3 centroid table
(~900 rows). Haversine formula, called server-side from
`agent-find-doctors`.

### 6. Seeding tool (`tools/seed/`, standalone TypeScript/Node CLI, not a bot)

Ports the retired Python import/specialty scripts. Fixes the
duplicate-Practitioner bug (Synthea reuses the same practitioner across
bundles as bare `POST`s — switch to conditional-create keyed on Synthea's
stable id). Filters to the 7 resource types the app reads (~90% volume
reduction). `--limit`/`--slim`/`--full`/`--dry-run` flags. Stream-parses
files.

### 7. Doctor chat agent — safety boundary

Structural (patientId is a parameter, not model-chosen; no tools, no
writes) → system prompt (relay-only, fixed refusal for
interpretation/advice requests) → output keyword guard (weak, defense in
depth) → UI banner → full audit trail via persisted Communication threads.

### 8. What gets deleted from the Python implementation

Entire FastAPI app, Streamlit UI, Docker Compose, hand-rolled Medplum
client, pydantic-settings config, Pydantic DTOs, domain exceptions, the
patients/scheduling/booking service modules, the pytest suite. Ported, not
deleted: the 41-row Disease→Specialty table, NPPES mapping logic (upgraded
to NUCC codes), the intent system prompt.

### 9. Build order

1. Live check against the target Medplum server (§0's remaining caveat).
2. Fork, install, confirm the stock demo runs.
3. Fix/verify the specialty matcher, `--dry-run` only.
4. Config bundle + `tools/seed/` with `--limit 50`.
5. Patient-facing history/picker pages (no bots yet).
6. `agent-intake` + complaint form + candidate list.
7. Distance ranking wired into `agent-find-doctors`.
8. Lazy provisioning + slot picker + `agent-book-appointment`.
9. Doctor desk pages.
10. `agent-patient-chat` + chat UI.
11. `agent-expire-holds` cron.
12. Full seed run (`--slim`, all 983 bundles).

## Verification

See `Doctor_Appointment_Agent_Specs.md`'s acceptance criteria for the full
list — both end-to-end flows (patient booking, doctor desk + chat),
seeding correctness (no duplicate Practitioners), and the chat agent's
refusal behavior under an adversarial diagnostic-framed question.

## Critical Files

- `medplum-scheduling-demo/` at project root — the fork target
- `medplum/` at project root (Medplum monorepo, commit `87cf429`) — source
  of every fact-check in this plan
- `fhir/*.json` (983 files) and `Disease_Description.csv` at project root
- The retired Python implementation (`.claude/worktrees/
  doctor-appointment-agent-impl/`) — reference only, for the logic being
  ported (specialty table, NPPES mapping, intent prompt), not for reuse
  as-is
- `docs/Doctor_Appointment_Agent_Design.md`, `_HLD.md`, `_Specs.md`,
  `_Backend.md`, `_Data_Model.md`, `_LLD.md` — the maintained,
  fully-written-up design this plan produced
