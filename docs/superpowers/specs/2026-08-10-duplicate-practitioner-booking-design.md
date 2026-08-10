# Duplicate Practitioner Booking Fix

## Problem

In the Vite development runtime, React Strict Mode can run the slot picker effect twice. Both executions call the doctor-provisioning action. Provisioning currently performs separate search and create operations, so concurrent requests can each create a Practitioner with the same NPI and then create separate related resources.

The booked Appointment remains valid and references one of those Practitioner resources. Doctor Desk currently resolves only one Practitioner for an NPI and searches Appointments for only that resource. If it resolves the duplicate without the Appointment, it incorrectly reports an empty queue. Patient chat has the same single-Practitioner assumption when it verifies the booking relationship.

## Goals

- Prevent concurrent provisioning from creating duplicate Practitioner, PractitionerRole, or Schedule resources.
- Make existing Appointments reachable when duplicate Practitioner resources already share an NPI.
- Preserve existing FHIR data without deleting, merging, or rewriting resources.
- Keep the NPI as a display and filtering mechanism rather than authentication.

## Non-goals

- Database cleanup or destructive deduplication.
- Changing the booking operation or Appointment structure.
- Removing React Strict Mode.
- Expanding Doctor Desk authorization behavior.

## Design

### Concurrency-safe provisioning

Doctor provisioning will use Medplum conditional create operations for resources that are logically unique:

- Practitioner: condition on the US NPI identifier.
- PractitionerRole: condition on the Practitioner reference and specialty.
- Schedule: condition on the Practitioner actor.

Conditional creation moves the uniqueness decision to the Medplum server, so concurrent callers receive the same existing-or-created resource. The existing sequential lookup remains useful to avoid unnecessary NPPES calls. When a Practitioner already exists but has no role, provisioning will resolve the doctor metadata and conditionally create the missing role.

### Duplicate-aware Doctor Desk queue

Doctor Desk will search for every Practitioner with the supplied NPI. It will load Appointments and pre-visit summaries for each matching Practitioner, combine the results, and deduplicate resources by FHIR ID before constructing queue entries. Patient reads will remain limited to patients referenced by the resulting Appointments.

This makes the currently booked Appointment visible without modifying either the Appointment or duplicate Practitioner records.

### Duplicate-aware patient chat

Patient chat will search every Practitioner with the NPI and select the Practitioner that has an Appointment relationship with the requested patient. The selected relationship-bearing Practitioner will be recorded as the sender of the doctor's question. If no matching Practitioner or relationship exists, the existing failure behavior remains.

## Error handling

- Missing NPPES data continues to fail provisioning when doctor metadata is required.
- Missing Practitioner and missing booking relationship errors remain explicit in the backend action.
- Duplicate queue results are collapsed by resource ID before rendering.
- No fallback will silently fabricate or rewrite identifiers.

## Testing

Tests will be written before implementation and must demonstrate:

1. Concurrent provisioning for one NPI returns one Practitioner and one Schedule.
2. Doctor Desk queue loading finds an Appointment attached to any Practitioner sharing the NPI and does not duplicate entries.
3. Patient chat accepts the Practitioner that actually owns the patient relationship even when another duplicate is returned first.
4. Existing sequential provisioning, queue construction, and chat safety tests remain green.

Full TypeScript, lint, Vitest, and production-build gates will run after focused tests pass.

