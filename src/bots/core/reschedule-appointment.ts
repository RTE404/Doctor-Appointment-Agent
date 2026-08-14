import type { BotEvent, MedplumClient } from '@medplum/core';
import { OperationOutcomeError, resolveId } from '@medplum/core';
import type { Appointment, Bundle, Communication, Schedule, Slot } from '@medplum/fhirtypes';
import { isDemoGenerated, withDemoGeneratedTag } from '../../demo/demoTag.js';

export type RescheduleInput = { appointmentId: string; newStart: string; newEnd: string };
export type RescheduleResult = { ok: true; appointment: Appointment } | { ok: false; reason: 'slot_taken' };

const SLOT_TAKEN_MESSAGE = 'Requested time slot is not available';
const SERVICE_TYPE_REFERENCE = 'https://medplum.com/fhir/service-type-reference';

function getServiceReference(schedule: Schedule): string | undefined {
  return schedule.serviceType
    ?.flatMap((serviceType) => serviceType.extension ?? [])
    .find((extension) => extension.url === SERVICE_TYPE_REFERENCE)
    ?.valueReference?.reference;
}

function validateProposal(appointment: Appointment, practitionerReference: string, scheduleId: string, start: string, end: string): void {
  if (appointment.start !== start || appointment.end !== end) {
    throw new Error('$find returned a proposal with unexpected times');
  }
  const participants = appointment.participant ?? [];
  if (participants.length !== 1 || participants[0].actor?.reference !== practitionerReference) {
    throw new Error('$find proposal participants do not match the original Practitioner');
  }
  const slot = appointment.contained?.find((resource) => resource.resourceType === 'Slot') as Slot | undefined;
  if (!slot || slot.schedule.reference !== `Schedule/${scheduleId}` || slot.start !== start || slot.end !== end) {
    throw new Error('$find proposal Slot does not match the selected Schedule and time');
  }
}

/** $book's response is a bare Bundle, matching agent-book-appointment.ts. */
function extractBookedAppointment(bundle: Bundle): Appointment {
  const appointment = bundle.entry?.find((entry) => entry.resource?.resourceType === 'Appointment')?.resource as Appointment | undefined;
  if (!appointment) {
    throw new Error('$book response did not contain a booked Appointment');
  }
  return appointment;
}

export async function handler(medplum: MedplumClient, event: BotEvent<RescheduleInput>): Promise<RescheduleResult> {
  const { appointmentId, newStart, newEnd } = event.input;
  const original = await medplum.readResource('Appointment', appointmentId);
  if (!isDemoGenerated(original.meta)) {
    throw new Error('Only demo-generated appointments can be rescheduled');
  }
  if (original.status !== 'pending' && original.status !== 'booked') {
    throw new Error('Only pending or booked appointments can be rescheduled');
  }
  const oldSlotId = resolveId(original.slot?.[0]);
  if (!oldSlotId) {
    throw new Error('Original appointment has no slot to reschedule from');
  }
  const oldSlot = await medplum.readResource('Slot', oldSlotId);
  const scheduleId = resolveId(oldSlot.schedule);
  if (!scheduleId) {
    throw new Error('Original slot has no schedule reference');
  }

  const schedule = await medplum.readResource('Schedule', scheduleId);
  const serviceReference = getServiceReference(schedule);
  if (!serviceReference?.startsWith('HealthcareService/')) {
    throw new Error('Original Schedule has no HealthcareService reference');
  }
  const patientParticipant = original.participant?.find((participant) => participant.actor?.reference?.startsWith('Patient/'));
  const practitionerReference = original.participant?.find((participant) => participant.actor?.reference?.startsWith('Practitioner/'))?.actor?.reference;
  if (!patientParticipant || !practitionerReference) {
    throw new Error('Original appointment participants are incomplete');
  }

  // Re-run $find at the trust boundary and submit its exact proposal. A
  // client-fabricated contained Slot is not authoritative and $book rejects it.
  const findUrl = medplum.fhirUrl('Appointment', '$find');
  findUrl.searchParams.set('schedule', `Schedule/${scheduleId}`);
  findUrl.searchParams.set('service-type-reference', serviceReference);
  findUrl.searchParams.set('start', newStart);
  findUrl.searchParams.set('end', newEnd);
  findUrl.searchParams.set('_count', '20');
  const findBundle = await medplum.get<Bundle<Appointment>>(findUrl);
  const proposedAppointment = (findBundle.entry ?? [])
    .map((entry) => entry.resource)
    .find((resource): resource is Appointment => resource?.resourceType === 'Appointment' && resource.start === newStart && resource.end === newEnd);
  if (!proposedAppointment) {
    return { ok: false, reason: 'slot_taken' };
  }
  validateProposal(proposedAppointment, practitionerReference, scheduleId, newStart, newEnd);

  const appointmentToBook: Appointment = {
    ...proposedAppointment,
    meta: withDemoGeneratedTag(original.meta),
    participant: [...(proposedAppointment.participant ?? []), patientParticipant],
    description: original.description,
    comment: original.comment,
    reasonCode: original.reasonCode,
  };

  let bookedAppointment: Appointment;
  try {
    const response = (await medplum.post(medplum.fhirUrl('Appointment', '$book'), {
      resourceType: 'Parameters',
      parameter: [{ name: 'appointment', resource: appointmentToBook }],
    })) as Bundle;
    bookedAppointment = extractBookedAppointment(response);
  } catch (err) {
    if (err instanceof OperationOutcomeError && err.outcome.issue?.[0]?.details?.text === SLOT_TAKEN_MESSAGE) {
      return { ok: false, reason: 'slot_taken' };
    }
    throw err;
  }

  // Communication:about is not searchable, so narrow by indexed fields and
  // filter in memory before linking the summary to the new Appointment.
  const patientRef = patientParticipant.actor?.reference;
  if (patientRef) {
    const candidateSummaries = await medplum.searchResources('Communication', {
      subject: patientRef,
      category: 'ai-previsit-summary',
    });
    const summary = candidateSummaries.find((communication) => communication.about?.[0]?.reference === `Appointment/${appointmentId}`);
    if (summary) {
      await medplum.updateResource<Communication>({ ...summary, about: [{ reference: `Appointment/${bookedAppointment.id}` }] });
    }
  }

  // Native $cancel atomically cancels the original and releases its Slot.
  await medplum.post(medplum.fhirUrl('Appointment', appointmentId, '$cancel'), {});

  return { ok: true, appointment: bookedAppointment };
}
