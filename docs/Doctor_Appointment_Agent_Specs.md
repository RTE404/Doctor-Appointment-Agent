# Doctor Appointment Agent — Functional Specification

> ⚠️ **Superseded on specific points** — see `Doctor_Appointment_Agent_Design.md`'s
> banner for the full list (booking uses `$book` not `$hold`/`$confirm`,
> no `agent-expire-holds`, native `$cancel`, per-service `SchedulingParameters`).
> Specifically here: **FR-10**'s "via `$hold`'s atomic check" and the
> traceability table's `$hold → $confirm` references are stale — read
> "`$book`'s atomic check" instead. The implementation plan
> (`docs/superpowers/plans/2026-08-04-medplum-native-implementation.md`)
> is authoritative on these points.

Formalizes the workflow from `Doctor_Appointment_Agent_Context.md` and the
HLD into testable functional requirements, now covering both the
patient-facing and doctor-facing surfaces. Supersedes the Python-era Specs
doc — FR-1 through FR-10 carry the same intent as before but are now
traced to bots/routes instead of Python modules; FR-11 through FR-15 are
new, covering the doctor-facing flow.

## Actors

- **Patient/User** — selects a demo patient, makes a request, picks a
  doctor and slot, confirms a booking.
- **Doctor** — enters their NPI, views their patient queue, chats with the
  patient-agent for a specific patient.

## Functional Requirements

| ID | Requirement | Acceptance Criteria |
|---|---|---|
| FR-1 | User can select a demo patient from a list | `/agent` lists available demo patients (direct FHIR search, no bot) |
| FR-2 | System shows the selected patient's history | `/agent/:patientId` shows conditions, medications, allergies, and past encounters (with practitioner + specialty + organization), fetched directly from Medplum |
| FR-3 | User can submit a 1–2 sentence natural-language appointment request | Free-text field on `/agent/:patientId`; submission calls `agent-intake` |
| FR-4 | System determines the requested specialty from the NL request via LLM | `agent-intake` returns `{specialty, reason, urgency, summary}` in one call; if the LLM's free-text specialty can't be normalized to a known NUCC entry (`normalizeLlmSpecialty` finds no match), the system asks the user to clarify rather than guessing — this is a binary normalize/no-match outcome, not a confidence score |
| FR-5 | System checks history for a previous practitioner of the *exact* matching specialty | `agent-find-doctors` surfaces the previous practitioner, flagged and ranked first, only when `PractitionerRole.specialty` exactly matches the inferred specialty; if more than one previous practitioner matches, the one with the most recent `Encounter` wins the tie |
| FR-6 | System searches NPPES when no exact previous match exists | `agent-find-doctors` falls through to an NPPES-backed search, filtered by specialty + patient location, ranked by distance |
| FR-7 | User can always choose to search for a new doctor, even if a previous match exists | `agent-find-doctors`'s response includes both the previous-physician result (if any) and the NPPES candidate list together |
| FR-8 | System shows available slots for a selected doctor | `agent-ensure-doctor` lazily provisions the doctor's `Practitioner`/`PractitionerRole`/`Schedule` (via `ensurePractitionerAndSchedule`) on first request for that NPI and returns the ids; the UI then calls `$find` directly against that `Schedule` |
| FR-9 | User can book a slot and receive confirmation | `agent-book-appointment` returns a confirmation (doctor, patient, time) for a valid, still-open slot; confirmation page shows the doctor's NPI prominently |
| FR-10 | System prevents double-booking | Booking an already-held/booked slot returns `{ok: false, reason: 'slot_taken'}` via `$hold`'s atomic check; no duplicate `Appointment` is created |
| FR-11 | Doctor can look up their patient queue by NPI | `/desk/:npi` shows every patient who has ever booked with that NPI, newest first — a display filter, not a login (see HLD §9) |
| FR-12 | Each queued patient shows an AI-generated pre-visit summary and their stated issue | The summary is generated once, at complaint-submission time, by `agent-intake`, and persisted immediately as a `Communication` (`status: preparation`, no recipient yet); `agent-book-appointment` only updates that same Communication's `recipient`/`about`/`status` once the doctor is chosen — it never regenerates the summary. The "stated issue" is `Appointment.description`, written by `agent-book-appointment` from the same intake output. Neither is regenerated on page load. |
| FR-13 | Doctor can chat with an AI agent grounded in a specific patient's real record | `agent-patient-chat` re-reads that patient's live Medplum data on every message and answers only from it |
| FR-14 | The chat agent must never diagnose, interpret, or give clinical/medical advice, even if directly asked | Verified by asking a diagnostic-framed question ("what do you think this means") and confirming the fixed refusal response, not an opinion |
| FR-15 | Every chat question and answer is auditable after the fact | Persisted as threaded `Communication` resources (`category: ai-chat`), retrievable via a search on that patient/practitioner |

## Non-Functional Requirements

Deliberately minimal for a POC — see HLD §10 for the full list of what's
explicitly **not** designed (scalability, multi-tenancy, performance
targets, custom security/observability layers). Two NFRs that matter here:
booking must be atomic (FR-10, backed by Medplum's `$hold`/`$confirm`), and
the doctor-chat agent's non-diagnostic boundary must hold under adversarial
questioning (FR-14) — this is treated as a correctness requirement, not
just a nice-to-have.

## Data Requirements

See `Doctor_Appointment_Agent_Data_Model.md` for the full entity/attribute
list. Summary: patient-side clinical data is read-only from Medplum
(seeded once from Synthea); doctor/scheduling/AI-artifact data
(`Practitioner`, `PractitionerRole`, `Schedule`, `Appointment`,
`Communication`, `Device`) is created lazily and written to Medplum by the
app itself.

## Assumptions

Unchanged from HLD §9: single user per role at a time, English-only
input, US doctors only (NPPES), NPI entry is a display filter not
authentication.

## Traceability: Requirement → Bot/Route → Data

| FR | Route | Bot / mechanism |
|---|---|---|
| FR-1 | `/agent` | Direct FHIR search |
| FR-2 | `/agent/:patientId` | Direct FHIR search (`_include`d Encounter→Practitioner/Organization) |
| FR-3, FR-4 | `/agent/:patientId` | `agent-intake` |
| FR-5, FR-7 | `/agent/:patientId/doctors` | `agent-find-doctors` |
| FR-6 | `/agent/:patientId/doctors` | `agent-find-doctors` → NPPES |
| FR-8 | `/agent/:patientId/doctors/:npi/slots` | `agent-ensure-doctor` (wraps `ensurePractitionerAndSchedule`) + direct `$find` |
| FR-9, FR-10 | `/agent/:patientId/confirmed/:apptId` | `agent-book-appointment` (`$hold` → `$confirm`) |
| FR-11 | `/desk/:npi` | Direct FHIR search (`Practitioner`, `Appointment`, `Communication`) |
| FR-12 | `/desk/:npi` | `agent-intake` (summary generated at complaint-submission time; updated, not regenerated, by `agent-book-appointment` at booking time) |
| FR-13, FR-14, FR-15 | `/desk/:npi/patients/:patientId` | `agent-patient-chat` |
