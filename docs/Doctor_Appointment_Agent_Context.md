# Doctor Appointment Agent POC — Context & Design Decisions

> **Synchronized 2026-08-05:** This document matches the authoritative
> implementation plan at
> `docs/superpowers/plans/2026-08-04-medplum-native-implementation.md`.

## Goal

Build an AI-powered **Doctor Appointment Agent** with two connected
surfaces:

- **Patient-facing**: retrieval of patient history from Medplum (FHIR),
  AI understanding of a brief appointment request, reuse of previous care
  history when appropriate, discovery of new doctors through NPPES, and
  appointment booking using a synthetic-but-realistic scheduling model.
- **Doctor-facing**: once a patient books, the specific doctor (looked up
  by NPI) can see every patient who has ever booked with them, each with a
  short AI-generated pre-visit summary and their stated issue, and can
  chat with an AI agent grounded strictly in that patient's real record to
  ask follow-up questions before the visit.

The POC is **not** a diagnosis or medical reasoning system, on either
surface. The doctor-facing agent specifically is a data-relay/summarization
tool — it answers from the patient's actual record and refuses to offer
clinical interpretation, even if asked directly.

The project is built **natively on Medplum**: Medplum's React component
library and a forked pre-built scheduling app for the frontend, Medplum
Bots for all backend logic, and Medplum itself as the sole datastore — not
a separate backend service calling Medplum from outside. See
`Doctor_Appointment_Agent_Design.md` for why and how (the project started
as a Python/FastAPI service calling Medplum over REST; that approach was
superseded once "build natively on Medplum" became an explicit
requirement).

------------------------------------------------------------------------

# Scope

Included:
- Demo patients (synthetic, Synthea-generated — see Data Sources)
- Patient history
- Brief natural-language appointment request
- Specialty identification
- Previous physician lookup
- New doctor discovery
- Appointment booking
- Provider-side appointment cancellation and rescheduling through
  Medplum's native scheduling operations
- Doctor lookup by NPI
- Per-doctor patient queue (everyone who's ever booked with them)
- AI-generated pre-visit patient summary
- Doctor-facing chat agent grounded in the patient's real record

Excluded: Diagnosis, adaptive questionnaires, clinical decision support,
medication recommendations, clinical judgment or advice of any kind from
either AI surface, patient-agent cancellation/rescheduling flows, waitlists, reminders, recurring
appointments, real authentication/login for doctors (NPI entry is a
display filter, not an access-control mechanism — see Design doc §"Doctor
identifier & access model").

------------------------------------------------------------------------

# Data Sources

## Medplum

The sole datastore for the entire application — patient/clinical data,
doctor records, scheduling, and the AI-generated summaries/chat transcripts
all live here. Resources used include Patient, Condition,
MedicationRequest, AllergyIntolerance, Encounter, Practitioner,
PractitionerRole, Organization, Schedule, Slot, Appointment, Communication,
Device, and HealthcareService (see `Doctor_Appointment_Agent_Data_Model.md`
for the full field-level breakdown).

Patient/clinical data is seeded from a Synthea-generated FHIR bundle
dataset (983 patient bundles, `fhir/` at the project root) via a one-time
TypeScript seeding tool — the app never generates patient data itself, only
reads it. Encounters reference practitioners and organizations, which is
how previous-physician history is reconstructed. Every seeded resource is
written at a deterministic id with `PUT ResourceType/{id}`; Medplum POST
creation is not used because it replaces caller-supplied ids and would
break cross-resource references.

## NPPES

Used only for discovering **new** doctors (i.e. ones the patient hasn't
seen before). Provides: NPI, name, specialty (NUCC taxonomy), address,
contact details. Does NOT provide: working hours, appointment slots,
calendars, or availability — scheduling for any doctor (previously-seen or
newly discovered) is synthetic, generated the first time that doctor is
looked up.

## Scheduling

Owned entirely by Medplum's native scheduling operations (`Schedule`,
`Slot`, `Appointment`, and the `$find`/`$book`/`$cancel` operations) —
there is no separate application-owned scheduling service or database.
Schedules are linked to doctors via NPI (stored as a `Practitioner`
identifier). The browser uses `$find` only to display candidate times; the
booking Bot repeats `$find` server-side and books that fresh proposal, so a
browser-supplied Appointment is never trusted. See
`Doctor_Appointment_Agent_Design.md` for the lazy provisioning and
NPI-seeded availability mechanism.

------------------------------------------------------------------------

# User Workflow

**Patient-facing:**
1. Select demo patient.
2. Load patient history from Medplum.
3. User enters a 1-2 sentence appointment request.
4. AI determines the appointment type/specialty (and, in the same call,
   drafts the pre-visit summary used later on the doctor's side).
5. AI checks previous encounter history for an exact specialty match.
6. If a matching previous physician exists: offer booking with that
   physician (always shown first when it exists), or allow searching for a
   new physician.
7. If searching for a new physician (or no previous match exists): query
   NPPES, rank candidates by specialty and distance.
8. User selects a doctor.
9. Scheduling retrieves or lazily creates the doctor's schedule.
10. Display available slots.
11. User books a slot.
12. Appointment confirmation — the doctor's NPI is shown prominently, since
    that's how the demo user carries the handoff to the doctor-facing side.

**Doctor-facing (new):**
13. Doctor enters their NPI to filter the view (a display filter, not a
    login).
14. Doctor sees every patient who has ever booked with them — name,
    AI-generated summary, stated issue, appointment date.
15. Doctor opens a chat with the patient-agent, grounded live in that
    patient's real Medplum record, to ask follow-up questions. The agent
    never diagnoses or offers clinical judgment; every question and answer
    is persisted for audit purposes.

For the concrete architecture behind both flows (bot decomposition, data
model, safety-boundary design), see `Doctor_Appointment_Agent_Design.md`,
`Doctor_Appointment_Agent_HLD.md`, and `Doctor_Appointment_Agent_Data_Model.md`.

------------------------------------------------------------------------

# Big Design Question: Real Appointment Slots

## Objective

Can the application display real appointment availability for real
doctors?

This research predates the Medplum-native rebuild but its conclusion is
unaffected by the stack change — it's about what data exists in the world,
not which language the app is written in. See
`Real_Appointment_Data_Research.md` for the fuller follow-up pass (Zocdoc,
ModMed, SuperSaaS, TIMIFY, Cronofy, SMART Scheduling Links, etc.), which
reached the same conclusion by a different route.

## Research Summary

### Practo

Pros: Real appointment slots internally.

Cons: No public API. Commercial partner access only. Terms prohibit using
Practo data to build competing databases.

Result: **Not suitable.**

------------------------------------------------------------------------

### NPPES

Pros: Real doctor directory.

Cons: No scheduling information.

Result: **Cannot provide appointment availability.**

------------------------------------------------------------------------

### FHIR Scheduling APIs

FHIR defines: Schedule, Slot, Appointment.

However these are standards implemented by individual healthcare providers
(Epic, Cerner, Athena, etc.). There is no nationwide endpoint that maps
arbitrary NPIs to live availability. (Medplum's own implementation of these
same operations is what the current design uses — but only for the
synthetic schedules this app itself creates, not as a way to reach into
some other provider's real system.)

Result: **Not usable as a universal scheduling source.**

------------------------------------------------------------------------

### Commercial Scheduling Platforms

Examples: NexHealth, Athena, DrChrono, Eka Care.

These expose real appointment slots only for practices integrated with
their platform and generally require provider authorization.

Result: **Not compatible with arbitrary NPPES doctors.**

------------------------------------------------------------------------

### Web Scraping

Possible but rejected because of: legal concerns, Terms of Service,
fragility, anti-bot protections.

Result: **Rejected.**

------------------------------------------------------------------------

**Conclusion, carried forward unchanged into the Medplum-native design**:
scheduling stays synthetic. See `Doctor_Appointment_Agent_Design.md` for
how that's implemented on Medplum (NPI-seeded `SchedulingParameters`, lazy
`Practitioner`/`Schedule` provisioning, `$find` for live availability).
