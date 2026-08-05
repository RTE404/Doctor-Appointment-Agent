# Medplum-Native Rebuild — Archived Design Snapshot

> **Status: superseded and non-executable.** This 2026-08-03 design snapshot
> established the Medplum-native direction, but its original task details
> contained scheduling, identity, and deployment assumptions that were later
> disproved. Do not implement from this file. The only executable plan is
> `docs/superpowers/plans/2026-08-04-medplum-native-implementation.md`.

## What this snapshot established

- Fork the TypeScript/React Medplum scheduling demo instead of rebuilding the
  Python/FastAPI/Streamlit stack.
- Use Medplum as both FHIR store and Bot runtime; NPPES and Gemini are the only
  external runtime dependencies.
- Keep synthetic appointment availability. No universal live availability API
  exists for arbitrary real doctors.
- Use Synthea for demo patients and historical clinical context, and NPPES for
  real provider-directory discovery.
- Represent specialties only with NUCC provider taxonomy codes.
- Persist AI summaries and chat turns as auditable FHIR `Communication`
  resources authored by `Device/ai-appointment-agent` where appropriate.
- Treat `/desk` NPI entry as a demo display filter, not authentication.

Those architectural choices remain valid. Every implementation detail below
comes from the later, source-verified plan.

## Final scheduling contract

- All `@medplum/*` packages are pinned to exactly `5.1.27`.
- Every scheduling URL is built with `medplum.fhirUrl(...)`.
- The browser may call `Appointment/$find` to render choices, but its response
  is display state only.
- The booking browser payload is limited to:

  ```ts
  {
    patientId,
    practitionerId,
    scheduleId,
    start,
    end,
    summaryCommunicationId,
  }
  ```

- `agent-book-appointment` re-reads the Patient, Practitioner, Schedule,
  PractitionerRole, and intake Communication. It validates their
  relationships, derives the service and clinical metadata, repeats `$find`,
  and selects the exact fresh proposal with its contained Slot.
- `$find` and `$book` return bare `Bundle` resources. The `$book` request is a
  `Parameters` resource whose `appointment` parameter contains the proposal.
- The Bot adds the Patient participant and server-derived Appointment metadata
  before `$book`. It then read-and-spread updates the summary Communication.
- `$book` performs conflict validation in a serializable transaction. There is
  no `$hold`/`$confirm` phase and no hold-expiry Bot.
- Provider cancellation calls native instance-level `$cancel`; there is no
  custom cancellation Bot. Provider rescheduling books the replacement and
  then calls native `$cancel` on the original, with its documented non-atomic
  POC edge.

## Final scheduling-resource shape

- Each `Schedule.serviceType` lists both fixed HealthcareServices: Office Visit
  (30 minutes) and Urgent Visit (15 minutes).
- Each Schedule carries two separate `SchedulingParameters` extensions, one
  per service. Each contains `service`, `duration`, matching
  `alignmentInterval`, `timezone`, and `availability`.
- `$find` proposals carry contained Slots. Successful `$book` persists a
  top-level Slot referenced by the booked Appointment. Native `$cancel`
  deletes that Slot.
- Lazy NPPES provisioning searches before creating Practitioner,
  PractitionerRole, and Schedule resources. A concurrent first request for a
  previously unseen NPI remains an accepted POC race.

## Final intake and chat authority

- `agent-intake` stores urgency in `Communication.priority`, the concise reason
  in `reasonCode`, the original complaint in `note`, and the normalized NUCC
  specialty in `topic`. It also preserves the expected category, Device
  sender, `ai-generated` tag, Patient subject, and `preparation` status.
- Booking derives its HealthcareService and clinical display fields from that
  Communication and the PractitionerRole, not from browser-supplied values.
- `agent-patient-chat` accepts `{npi, patientId, question, threadId?}`, resolves
  the real Practitioner, verifies a booking relationship, reloads current
  clinical context, and records the question with that Practitioner as sender.

## Final seed and deployment contract

- Medplum changes caller-supplied ids on POST. Every retained seed and
  bootstrap resource therefore receives a deterministic FHIR id and is written
  by unconditional `PUT ResourceType/{id}`. All references are rewritten before
  upload; retries are idempotent.
- The uploader separates the identity transaction from size-bounded clinical
  batches below the server's 1 MB request limit and checks every batch entry
  response.
- The ESM seed CLI resolves its own path with `import.meta.url` utilities and
  supports explicit slim/full modes, dry-run validation, and resumable upload.
- The final deployment roster is exactly seven Bots:
  `block-availability`, `reschedule-appointment`, `agent-intake`,
  `agent-find-doctors`, `agent-ensure-doctor`, `agent-book-appointment`, and
  `agent-patient-chat`.
- Direct deployment creates or finds each Bot through the admin project route,
  resolves that Bot's own Binary placeholders, uploads its compiled code, and
  calls `$deploy`.

## Required gates

Before implementation/release, follow the later plan's automated tests and
live checks, especially:

1. deterministic PUT identity and reference resolution on a disposable seed;
2. target behavior for bare-Bundle `$find`/`$book` and atomic `$cancel`;
3. both service-specific scheduling grids and alignment intervals;
4. all seven Bots deployed with their correct compiled Binary; and
5. both end-to-end demo flows, including a double-booking race check.
