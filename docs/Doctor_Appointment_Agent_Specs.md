# Doctor Appointment Agent — Functional Specification

Formalizes the workflow from `Doctor_Appointment_Agent_Context.md` and the HLD
into testable functional requirements, each traceable to an API endpoint and
backend module/function. This is what the manual walkthrough in the Design
doc (§8) checks against.

## Actors

- **Patient/User** — the only actor for this POC. Selects a demo patient,
  makes a request, picks a doctor and slot, confirms a booking.

## Functional Requirements

| ID | Requirement | Acceptance Criteria |
|---|---|---|
| FR-1 | User can select a demo patient from a list | `GET /patients` returns available demo patients (id + display name) |
| FR-2 | System shows the selected patient's history | `GET /patients/{id}/history` returns conditions, medications, allergies, and past encounters (with practitioner + specialty + organization); `404` for an unknown id |
| FR-3 | User can submit a 1–2 sentence natural-language appointment request | UI free-text field; submission calls `POST /requests` |
| FR-4 | System determines the requested specialty from the NL request via LLM | `POST /requests` returns `{specialty, reason}`; for low-confidence extraction, the system asks the user to clarify rather than guessing (never silently defaults to a specialty) |
| FR-5 | System checks history for a previous practitioner of the matching specialty | `GET /doctors` returns the previous practitioner, flagged as such, when one exists in Encounter history with matching specialty |
| FR-6 | System searches NPPES when no previous match exists | `GET /doctors` falls through to an NPPES-backed search, filtered by specialty + patient location |
| FR-7 | User can always choose to search for a new doctor, even if a previous match exists | `GET /doctors` response includes both the previous-physician option (if any) and a path to trigger a fresh NPPES search |
| FR-8 | System shows available slots for a selected doctor | `GET /doctors/{npi}/slots` returns open slots; lazily creates the doctor's Medplum `Practitioner`/`Schedule` on first request for that NPI |
| FR-9 | User can book a slot and receive confirmation | `POST /appointments` returns a confirmation (doctor, patient, time) for a valid, still-open slot |
| FR-10 | System prevents double-booking | Booking an already-held/booked slot returns `409` and creates no duplicate `Appointment` |

## Non-Functional Requirements

Deliberately minimal for a POC — see HLD §9 for the full list of what's
explicitly **not** designed (scalability, multi-tenancy, performance targets,
custom security/observability layers). The one NFR that matters here:
booking must be atomic — two concurrent attempts on the same slot must not
both succeed (covered by FR-10, backed by Medplum's `$hold`/`$confirm`).

## Data Requirements

See `Doctor_Appointment_Agent_Data_Model.md` for the full entity/attribute
list. Summary: patient-side data (Patient, Condition, MedicationRequest,
AllergyIntolerance, Encounter) is read-only from Medplum; doctor/scheduling
data (Practitioner, Schedule, Slot, Appointment) is created lazily and
written to Medplum by this app.

## Assumptions

Unchanged from HLD §8: single local user at a time, English-only requests,
US doctors only (NPPES), no auth/session layer beyond what's needed to demo
the flow.

## Traceability: Requirement → Endpoint → Module/Function

| FR | Endpoint | Module.Function (see LLD doc) |
|---|---|---|
| FR-1 | `GET /patients` | `patients.list_demo_patients` |
| FR-2 | `GET /patients/{id}/history` | `patients.get_patient_history` |
| FR-3, FR-4 | `POST /requests` | `intent.extract_intent` |
| FR-5, FR-7 | `GET /doctors` | `patients.find_previous_practitioner_by_specialty`, `directory.search_doctors` |
| FR-6 | `GET /doctors` | `directory.search_doctors` |
| FR-8 | `GET /doctors/{npi}/slots` | `scheduling.ensure_practitioner`, `scheduling.ensure_schedule`, `scheduling.get_available_slots` |
| FR-9, FR-10 | `POST /appointments` | `booking.book_appointment` (→ `scheduling.hold_slot`, `scheduling.confirm_appointment`) |
