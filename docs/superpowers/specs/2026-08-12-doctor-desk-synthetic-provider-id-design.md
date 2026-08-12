# Doctor Desk Synthetic Provider Identifier Compatibility

**Status:** Approved design
**Date:** 2026-08-12

## Purpose

Make the existing Doctor Desk demo journey work for appointments booked with either a real NPPES provider or a seeded Synthea provider.

After booking a synthetic provider, the confirmation page already displays and copies the short numeric value stored in the provider's US NPI identifier. The Doctor Desk currently rejects that value because its shared validator requires exactly ten digits. The change will allow the copied value to pass through the existing patient-queue, pre-visit-summary, and patient-agent-chat pipeline.

## Required Demo Journey

1. The user books an appointment with a synthetic provider.
2. The confirmation page displays the provider's existing short identifier and allows it to be copied.
3. The user pastes that identifier into Doctor Desk.
4. Doctor Desk resolves the same FHIR `Practitioner` by the exact US NPI identifier value.
5. The queue displays the patient, appointment details, and associated pre-visit summary.
6. The user opens the patient and chats with the agent.
7. The backend verifies the provider-patient appointment relationship before loading patient context and answering.

The same journey must continue to work for genuine ten-digit NPPES NPIs.

## Design Decision

Use one shared normalization and validation rule throughout the Doctor Desk routes:

- Trim surrounding whitespace.
- Remove spaces and hyphens, preserving the current normalization behavior.
- Accept a normalized value containing one through ten digits.
- Reject empty values, letters, punctuation other than removable hyphens, and values longer than ten digits.
- Preserve the normalized identifier exactly. Do not pad, rewrite, or replace short synthetic values.

This intentionally validates the identifier shapes used by the POC. It does not add NPI checksum validation or claim that a short synthetic value is a genuine NPPES-issued NPI.

## Components and Data Flow

### Booking confirmation

No booking or confirmation data-flow change is required. The confirmation page continues reading the booked `Practitioner` and copying the value stored under `http://hl7.org/fhir/sid/us-npi`.

### Doctor Desk lookup

The lookup page uses the widened shared validation rule, navigates with the normalized value, and replaces wording that requires a ten-digit NPI with wording that accepts the provider identifier shown on the booking confirmation.

### Patient queue

The queue route uses the same shared rule. It continues searching `Practitioner.identifier` using the exact normalized value, then loads that practitioner's appointments and `ai-previsit-summary` communications. Existing empty and error states remain unchanged.

### Patient-agent chat

The chat route uses the same shared rule. It passes the exact normalized identifier to the existing `agent-patient-chat` action. The server continues resolving the practitioner and requiring an actual appointment relationship with the selected patient before loading patient context.

## Error Handling

- Invalid identifiers are rejected before navigation or chat execution.
- A syntactically valid identifier with no matching practitioner produces the existing empty queue behavior.
- A matching practitioner without a booking relationship cannot use the patient chat pipeline.
- Existing backend, Medplum, and Gemini failures continue through their current error displays.

## Testing

Tests will verify:

- A short synthetic numeric identifier is normalized and accepted.
- A genuine ten-digit NPI remains accepted.
- Existing space and hyphen normalization remains supported.
- Empty, alphabetic, unsupported-punctuation, and over-ten-digit values are rejected.
- The Doctor Desk queue can resolve a synthetic provider and show its booked patient and summary.
- The patient-agent chat path accepts the same short identifier while retaining the appointment-relationship check.

## Alternatives Considered

### Accept any non-empty text

This is more permissive but allows malformed identifiers into routes and FHIR searches. It provides no demo benefit over the bounded numeric rule.

### Convert synthetic identifiers into ten-digit values

This would change seeded identities, risk breaking existing FHIR references and appointments, and require a data migration. It is unnecessary for the requested demo.

## Scope Boundaries

This change does not:

- Create a provider directory or synthetic-provider list.
- Modify seeded Practitioner resources or migrate identifiers.
- Generate, pad, or imitate real NPIs.
- Change appointment booking, summary generation, FHIR storage, or Gemini behavior.
- Treat entry of an NPI or synthetic identifier as authentication or authorization.

## Acceptance Criteria

- A synthetic provider's short identifier can be copied from booking confirmation and pasted into Doctor Desk.
- Doctor Desk displays the corresponding booked patient and pre-visit summary.
- Opening that patient allows agent chat through the existing relationship-checked pipeline.
- The same workflow still succeeds for ten-digit NPPES NPIs.
- Invalid identifier input remains blocked with accurate guidance.
