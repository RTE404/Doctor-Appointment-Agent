# Doctor Appointment Agent — Backend Structure

Supersedes the Python/FastAPI-era Backend doc. There is no longer a
separate backend service — this document covers the two things that
replace it: the Medplum Bots (`src/bots/agent/`, inside the forked
frontend repo) and the standalone TypeScript seeding tool (`tools/seed/`).
Concrete layout to scaffold against; nothing here exists yet.

## Repository Layout

The application is a fork of `medplum-scheduling-demo`
(confirmed structure by direct inspection of the cloned repo — see
`Doctor_Appointment_Agent_Design.md` §4 for the full keep/delete/modify
breakdown). New additions:

```
src/
  App.tsx                          # MODIFIED — two new route trees + menu groups
  pages/
    SchedulePage.tsx                 # MODIFIED — relabeled/re-sourced for $find
    agent/
      PatientPickerPage.tsx
      PatientHistoryPage.tsx          # history + complaint form
      DoctorResultsPage.tsx           # ranked candidates
      SlotPickerPage.tsx
      BookingConfirmationPage.tsx     # NPI shown large, copyable
    desk/
      DoctorLookupPage.tsx            # NPI input
      DoctorQueuePage.tsx             # patient list
      PatientAgentChatPage.tsx
  components/
    agent/
      ComplaintForm.tsx
      IntentCard.tsx
      DoctorCard.tsx
      SlotGrid.tsx
    desk/
      QueueTable.tsx
      PatientBriefCard.tsx
      AgentChat.tsx
  booking.context.ts                # flow state across /agent/* routes, mirrors Schedule.context.ts
  config/
    specialties.ts                   # SPECIALTY_TO_TAXONOMY-equivalent, real NUCC codes; shared by bots + UI
  data/
    zip3-centroids.ts                 # ~900-row 3-digit-zip centroid table
  bots/
    core/
      block-availability.ts           # UNCHANGED
      cancel-appointment.ts           # MODIFIED — now deletes the released Slot (was orphaning it)
      reschedule-appointment.ts       # NEW — RescheduleAppointment.tsx previously had no bot backing
    agent/
      agent-intake.ts
      agent-find-doctors.ts
      agent-ensure-doctor.ts          # NEW — thin wrapper bot around ensurePractitionerAndSchedule
      agent-book-appointment.ts
      agent-patient-chat.ts
      agent-expire-holds.ts
      lib/
        ensurePractitionerAndSchedule.ts   # shared lib, not a bot — called only by agent-ensure-doctor
        patientContext.ts                   # loadPatientClinicalContext(), shared by agent-intake + agent-patient-chat
        geo.ts                              # haversineMiles()
        ranking.ts                           # rankCandidates()
        nppes.ts                             # NPPES client + response mapping
        prompts.ts                            # system prompts for both LLM calls
      *.test.ts                       # colocated, per the fork's existing convention
  scripts/
    deploy-bots.ts                   # MODIFIED — extend the Bots[] array with agent bots

tools/
  seed/                              # standalone TypeScript/Node CLI, NOT a bot
    index.ts                          # CLI entry: --limit, --slim/--full, --dry-run
    disease-csv.ts                     # parses Disease_Description.csv
    specialty-resolver.ts               # ported 41-row table + tiered matcher
    pass1-scan.ts                        # streams all bundles → practitioner→reason-text map
    pass2-transform.ts                    # per-bundle rewrite (conditional-create, filter, timezone)
    upload.ts                              # transaction POST with concurrency + retry

data/
  core/
    agent-config.json                # HealthcareService(s), Device, CodeSystem/ValueSet — uploadable via UploadDataPage
```

`fhir/*.json` (983 Synthea bundles) and `Disease_Description.csv` stay at
the project root, unchanged — they're `tools/seed/`'s input, read directly
from disk (not bundled into the app).

## Configuration

**Frontend (Vite `.env`)**: just enough to point at the Medplum project —
base URL, client id. No secrets here.

**Bots (Medplum Project Secrets, not env files)**: `GEMINI_API_KEY` —
accessed inside a bot via `event.secrets['GEMINI_API_KEY'].valueString`,
never exposed to the browser or committed anywhere. This is a genuine
security improvement over the Python design, where the equivalent key
lived in a `.env` file read by the FastAPI process.

**Seeding tool (`.env` at project root, gitignored)**: `MEDPLUM_BASE_URL`,
`MEDPLUM_CLIENT_ID`, `MEDPLUM_CLIENT_SECRET` — used only by
`tools/seed/index.ts`'s `startClientLogin` call, never shipped anywhere
else.

## Core Dependencies

- `@medplum/react`, `@medplum/core`, `@medplum/fhirtypes` — already in the
  forked repo; no Medplum-specific SDK needs adding
- `react-router` — already in the fork, used for the new `/agent/*` and
  `/desk/*` routes the same way as every existing page
- Bots run in Medplum's own sandboxed runtime (Node-based; global `fetch`
  confirmed available — see Design doc §3) — no HTTP client dependency
  needs adding for NPPES/Gemini calls
- `tools/seed/` is a separate `tsx`/Node CLI with its own narrower
  dependency set: `@medplum/core` (for `MedplumClient`/`startClientLogin`),
  `csv-parse` (or similar) for `Disease_Description.csv`, no framework
  dependencies — it never runs inside a bot or the browser

## Shared Building Blocks

- **`src/config/specialties.ts`**: the single specialty vocabulary (real
  NUCC taxonomy codes, not free-text labels) — used by `agent-intake`
  (LLM output → code), `agent-find-doctors` (code → NPPES query), and any
  UI component displaying a specialty. One table, one source of truth
  across bots and frontend.
- **`src/bots/agent/lib/ensurePractitionerAndSchedule.ts`**: the lazy
  Practitioner/PractitionerRole/Schedule provisioning logic — deliberately
  not its own bot (no independent trigger), but always runs bot-side
  since it may call NPPES (no CORS from the browser). Its only caller is
  `agent-ensure-doctor.ts` (see Design doc §6) — not `agent-find-doctors`,
  and never the UI directly.
- **`src/bots/agent/lib/patientContext.ts`**: `loadPatientClinicalContext()`
  — the single standardized Patient/Condition/MedicationRequest/
  AllergyIntolerance/Encounter read, shared by `agent-intake.ts` and
  `agent-patient-chat.ts` so both bots ground themselves against the same
  data depth instead of two independently-tuned queries.
- **`tools/seed/specialty-resolver.ts`**: the corrected tiered specialty
  matcher (Design doc §9) — this is genuinely separate code from
  `src/config/specialties.ts` even though both deal with "specialty": the
  resolver figures out a *previous-physician's* specialty from their
  encounter history at seed time; the config table maps a *specialty
  code* to an NPPES taxonomy string at query time. Different inputs,
  different jobs, don't conflate them into one file.

## Module Dependency Direction

```
pages/agent/*, pages/desk/*  →  bots/agent/*, bots/core/*  (via medplum.executeBot)
pages/agent/*, pages/desk/*  →  Medplum directly (via useMedplum(), for anything not requiring a bot)
bots/agent/agent-ensure-doctor.ts  →  bots/agent/lib/ensurePractitionerAndSchedule.ts
bots/agent/agent-intake.ts, agent-patient-chat.ts  →  bots/agent/lib/patientContext.ts
bots/agent/*  →  bots/agent/lib/{geo,ranking,nppes,prompts}.ts
bots/agent/*, src/pages/**  →  src/config/specialties.ts
bots/core/reschedule-appointment.ts  →  (reuses cancel-appointment.ts's Slot-delete logic inline, no shared lib)
tools/seed/*  →  (nothing in src/ — fully standalone, shares no runtime code with the bots or frontend)
```

No bot imports another bot directly — each is invoked independently via
`$execute`; shared logic lives in `lib/`, not by one bot calling another's
handler. This mirrors the "usable/testable independently" property from
the original Python design's module boundaries, just re-expressed for
bots.
