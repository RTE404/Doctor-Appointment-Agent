// src/bots/agent/agent-book-appointment.ts
import type { BotEvent, MedplumClient } from '@medplum/core';
import { OperationOutcomeError } from '@medplum/core';
import type { Appointment, Bundle, Communication, Schedule, Slot } from '@medplum/fhirtypes';

export type BookInput = {
  patientId: string;
  practitionerId: string;
  scheduleId: string;
  start: string;
  end: string;
  summaryCommunicationId: string;
};
export type BookResult = { ok: true; appointment: Appointment } | { ok: false; reason: 'slot_taken' };

const SLOT_TAKEN_MESSAGE = 'Requested time slot is not available';
// 'Office Visit' is the only visit type — no urgency/triage classification
// exists in this product (decision recorded 2026-08-06). Its id is NOT a
// literal: the bootstrap bundle seeds it via POST + ifNoneExist, so the id
// is server-assigned. Resolved dynamically in handler() below, the same
// way ensurePractitionerAndSchedule.ts resolves it.

function hasCategory(communication: Communication, code: string): boolean {
  return communication.category?.some((category) =>
    category.coding?.some((coding) => coding.system === 'http://example.com/agent-communication-category' && coding.code === code)
  ) === true;
}

function hasService(schedule: Schedule, serviceId: string): boolean {
  return schedule.serviceType?.some((serviceType) =>
    serviceType.extension?.some(
      (extension) =>
        extension.url === 'https://medplum.com/fhir/service-type-reference' &&
        extension.valueReference?.reference === `HealthcareService/${serviceId}`
    )
  ) === true;
}

function validateProposal(appointment: Appointment, practitionerId: string, scheduleId: string, start: string, end: string): Slot {
  if (appointment.start !== start || appointment.end !== end) {
    throw new Error('$find returned a proposal with unexpected times');
  }
  const patientParticipant = appointment.participant?.find((participant) => participant.actor?.reference?.startsWith('Patient/'));
  if (patientParticipant) {
    throw new Error('$find proposal unexpectedly contains a Patient participant');
  }
  const practitionerParticipants = appointment.participant?.filter(
    (participant) => participant.actor?.reference === `Practitioner/${practitionerId}`
  );
  if (practitionerParticipants?.length !== 1 || appointment.participant?.length !== 1) {
    throw new Error('$find proposal participants do not match the requested Practitioner');
  }
  const slot = appointment.contained?.find((resource) => resource.resourceType === 'Slot') as Slot | undefined;
  if (!slot || slot.schedule.reference !== `Schedule/${scheduleId}` || slot.start !== start || slot.end !== end) {
    throw new Error('$find proposal Slot does not match the selected Schedule and time');
  }
  return slot;
}

/**
 * Extracts the booked Appointment from $book's real response — a BARE
 * Bundle, never a Parameters envelope. Confirmed directly in
 * buildOutputParameters (packages/server/src/fhir/operations/utils/parameters.ts):
 * an operation with exactly one 'return' output parameter (both $find and
 * $book declare this) bypasses the Parameters wrapper and sends the
 * resource itself — here, the Bundle — as the HTTP response body.
 */
function extractBookedAppointment(bundle: Bundle): Appointment {
  const appointment = bundle.entry?.find((e) => e.resource?.resourceType === 'Appointment')?.resource as Appointment | undefined;
  if (!appointment) {
    throw new Error('$book response did not contain a booked Appointment — unexpected response shape');
  }
  return appointment;
}

export async function handler(medplum: MedplumClient, event: BotEvent<BookInput>): Promise<BookResult> {
  const { patientId, practitionerId, scheduleId, start, end, summaryCommunicationId } = event.input;

  // All authority comes from server-side FHIR resources. These reads also
  // prove that every submitted id resolves in the active project.
  await medplum.readResource('Patient', patientId);
  await medplum.readResource('Practitioner', practitionerId);
  const schedule = await medplum.readResource('Schedule', scheduleId);
  const summary = await medplum.readResource('Communication', summaryCommunicationId);

  // Checked before resolving the agent Device below so a mismatched
  // summary (wrong Patient/status/category/tag) fails fast without an
  // extra round trip, and to keep this file's error message uniform
  // regardless of which check actually failed.
  if (
    summary.status !== 'preparation' ||
    summary.subject?.reference !== `Patient/${patientId}` ||
    !hasCategory(summary, 'ai-previsit-summary') ||
    !summary.meta?.tag?.some((tag) => tag.code === 'ai-generated')
  ) {
    throw new Error('The intake Communication is not an authoritative preparation summary for this Patient');
  }
  // Device id is server-assigned (seeded via POST + ifNoneExist), never a
  // literal — resolved the same way agent-intake.ts resolves it when it
  // writes this same sender field.
  const agentDevice = await medplum.searchOne('Device', {
    identifier: 'http://example.com/agent-config|ai-appointment-agent',
  });
  if (!agentDevice?.id || summary.sender?.reference !== `Device/${agentDevice.id}`) {
    throw new Error('The intake Communication is not an authoritative preparation summary for this Patient');
  }
  const reason = summary.reasonCode?.[0]?.text;
  const complaintText = summary.note?.[0]?.text;
  const specialtyCode = summary.topic?.coding?.find((coding) => coding.system === 'http://nucc.org/provider-taxonomy')?.code;
  if (!reason || !complaintText || !specialtyCode) {
    throw new Error('The intake Communication is missing its booking reason, original complaint, or normalized specialty');
  }
  const practitionerRoles = await medplum.searchResources('PractitionerRole', {
    practitioner: `Practitioner/${practitionerId}`,
  });
  const specialtyMatches = practitionerRoles.some((role) =>
    role.specialty?.some((specialty) =>
      specialty.coding?.some(
        (coding) => coding.system === 'http://nucc.org/provider-taxonomy' && coding.code === specialtyCode
      )
    )
  );
  if (!specialtyMatches) {
    throw new Error('The requested Practitioner does not match the intake-selected specialty');
  }

  // Id is server-assigned (seeded via POST + ifNoneExist), never a
  // literal — resolved the same way ensurePractitionerAndSchedule.ts
  // resolves it when it writes this same service onto the Schedule.
  const officeVisit = await medplum.searchOne('HealthcareService', { name: 'Office Visit' });
  if (!officeVisit?.id) {
    throw new Error('The Office Visit HealthcareService is not configured');
  }
  const serviceId = officeVisit.id;
  if (schedule.actor?.some((actor) => actor.reference === `Practitioner/${practitionerId}`) !== true) {
    throw new Error('The Schedule does not belong to the requested Practitioner');
  }
  if (!hasService(schedule, serviceId)) {
    throw new Error('The Schedule does not offer the intake-selected service');
  }

  // The browser's earlier $find was display-only. Re-run it here so the
  // proposal and contained Slot cross the trust boundary from Medplum,
  // not from a mutable client payload.
  const findUrl = medplum.fhirUrl('Appointment', '$find');
  findUrl.searchParams.set('schedule', `Schedule/${scheduleId}`);
  findUrl.searchParams.set('service-type-reference', `HealthcareService/${serviceId}`);
  findUrl.searchParams.set('start', start);
  findUrl.searchParams.set('end', end);
  findUrl.searchParams.set('_count', '20');
  const findBundle = await medplum.get<Bundle<Appointment>>(findUrl);
  const proposedAppointment = (findBundle.entry ?? [])
    .map((entry) => entry.resource)
    .find((resource): resource is Appointment => resource?.resourceType === 'Appointment' && resource.start === start && resource.end === end);
  if (!proposedAppointment) {
    return { ok: false, reason: 'slot_taken' };
  }
  validateProposal(proposedAppointment, practitionerId, scheduleId, start, end);

  const appointmentToBook: Appointment = {
    ...proposedAppointment,
    participant: [...(proposedAppointment.participant ?? []), { actor: { reference: `Patient/${patientId}` }, status: 'accepted' }],
    description: reason,
    comment: complaintText,
    reasonCode: [{ text: reason }],
  };

  let bookedAppointment: Appointment;
  try {
    const response = (await medplum.post(medplum.fhirUrl('Appointment', '$book'), {
      resourceType: 'Parameters',
      parameter: [{ name: 'appointment', resource: appointmentToBook }],
    })) as Bundle;
    bookedAppointment = extractBookedAppointment(response);
  } catch (err) {
    if (err instanceof OperationOutcomeError) {
      const detailText = err.outcome.issue?.[0]?.details?.text;
      if (detailText === SLOT_TAKEN_MESSAGE) {
        return { ok: false, reason: 'slot_taken' };
      }
    }
    throw err;
  }

  // The Appointment is now genuinely booked, including the clinical
  // metadata placed on the proposal before the atomic $book call.
  // Everything below is only summary Communication linkage — a
  // failure here must NEVER be reported back to the caller as a booking
  // failure, since the booking already succeeded. Log and continue rather
  // than throw, so a flaky follow-up write can't make the UI tell the
  // patient their appointment didn't happen when it did.
  try {
    const practitionerRef = appointmentToBook.participant?.find((p) => p.actor?.reference?.startsWith('Practitioner/'))?.actor?.reference;

    // Read-and-spread — updateResource is a full replacement, not a patch.
    // A bare {id, recipient, about, status, sent} object here would
    // silently wipe category, subject, sender, payload (the summary text
    // itself), and meta.tag.
    await medplum.updateResource<Communication>({
      ...summary,
      recipient: practitionerRef ? [{ reference: practitionerRef }] : summary.recipient,
      about: [{ reference: `Appointment/${bookedAppointment.id}` }],
      status: 'completed',
      sent: new Date().toISOString(),
    });
  } catch (_err) {
    console.error('Booking succeeded but post-booking metadata update failed');
  }

  return { ok: true, appointment: bookedAppointment };
}
