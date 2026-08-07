// src/bots/core/reschedule-appointment.ts
import type { BotEvent, MedplumClient } from '@medplum/core';
import { OperationOutcomeError, resolveId } from '@medplum/core';
import type { Appointment, Bundle, Communication, Slot } from '@medplum/fhirtypes';

export type RescheduleInput = { appointmentId: string; newStart: string; newEnd: string };
export type RescheduleResult = { ok: true; appointment: Appointment } | { ok: false; reason: 'slot_taken' };

const SLOT_TAKEN_MESSAGE = 'Requested time slot is not available';

/** $book's real response is a bare Bundle — see agent-book-appointment.ts's identical fix. */
function extractBookedAppointment(bundle: Bundle): Appointment {
  const appointment = bundle.entry?.find((e) => e.resource?.resourceType === 'Appointment')?.resource as Appointment | undefined;
  if (!appointment) {
    throw new Error('$book response did not contain a booked Appointment');
  }
  return appointment;
}

export async function handler(medplum: MedplumClient, event: BotEvent<RescheduleInput>): Promise<RescheduleResult> {
  const { appointmentId, newStart, newEnd } = event.input;
  const original = await medplum.readResource('Appointment', appointmentId);
  const oldSlotId = resolveId(original.slot?.[0]);
  if (!oldSlotId) {
    throw new Error('Original appointment has no slot to reschedule from');
  }
  const oldSlot = await medplum.readResource('Slot', oldSlotId);
  const scheduleId = resolveId(oldSlot.schedule);
  if (!scheduleId) {
    throw new Error('Original slot has no schedule reference');
  }

  const proposedSlot: Slot = {
    resourceType: 'Slot',
    status: 'busy',
    start: newStart,
    end: newEnd,
    schedule: { reference: `Schedule/${scheduleId}` },
  };
  const proposedAppointment: Appointment = {
    resourceType: 'Appointment',
    status: 'proposed',
    start: newStart,
    end: newEnd,
    serviceType: original.serviceType,
    participant: original.participant, // already includes both Patient and Practitioner — this is a real already-booked Appointment, unlike agent-book-appointment's $find-sourced proposal
    contained: [proposedSlot],
    // Stated-issue metadata carried on the proposal itself, not written back
    // after $book — confirmed against Medplum server source
    // (validateProposedAppointment destructures only `contained` off the
    // submitted appointment and preserves everything else; book.ts's
    // customizer only sets `status`), so $book persists and echoes these
    // fields in one atomic write. Same principle as agent-book-appointment.ts.
    // (No priority field — no urgency/triage classification exists in this
    // product, decision recorded 2026-08-06.)
    description: original.description,
    comment: original.comment,
    reasonCode: original.reasonCode,
  };

  let bookedAppointment: Appointment;
  try {
    const response = (await medplum.post(medplum.fhirUrl('Appointment', '$book'), {
      resourceType: 'Parameters',
      parameter: [{ name: 'appointment', resource: proposedAppointment }],
    })) as Bundle;
    bookedAppointment = extractBookedAppointment(response);
  } catch (err) {
    if (err instanceof OperationOutcomeError && err.outcome.issue?.[0]?.details?.text === SLOT_TAKEN_MESSAGE) {
      return { ok: false, reason: 'slot_taken' };
    }
    throw err;
  }

  // Re-link the summary Communication to the NEW Appointment. Communication:about
  // is a real field but confirmed not searchable — found the same way the
  // doctor queue does (Data Model doc): search by subject/category (both
  // real search parameters), then filter in memory on `about`.
  const patientRef = original.participant?.find((p) => p.actor?.reference?.startsWith('Patient/'))?.actor?.reference;
  if (patientRef) {
    const candidateSummaries = await medplum.searchResources('Communication', {
      subject: patientRef,
      category: 'ai-previsit-summary',
    });
    const summary = candidateSummaries.find((c) => c.about?.[0]?.reference === `Appointment/${appointmentId}`);
    if (summary) {
      await medplum.updateResource<Communication>({ ...summary, about: [{ reference: `Appointment/${bookedAppointment.id}` }] });
    }
  }

  // Release the original via Medplum's native $cancel — confirmed atomic
  // (cancels + deletes its Slot in one transaction), same as Task 24.
  await medplum.post(medplum.fhirUrl('Appointment', appointmentId, '$cancel'), {});

  return { ok: true, appointment: bookedAppointment };
}
