import type { BotEvent, MedplumClient } from '@medplum/core';
import { isDemoGenerated } from '../../demo/demoTag.js';

export type CancelAppointmentInput = { appointmentId: string };
export type CancelAppointmentResult = { ok: true };

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<CancelAppointmentInput>
): Promise<CancelAppointmentResult> {
  const appointment = await medplum.readResource('Appointment', event.input.appointmentId);
  if (!isDemoGenerated(appointment.meta)) {
    throw new Error('Only demo-generated appointments can be cancelled');
  }
  if (appointment.status !== 'pending' && appointment.status !== 'booked') {
    throw new Error('Only pending or booked appointments can be cancelled');
  }

  await medplum.post(medplum.fhirUrl('Appointment', event.input.appointmentId, '$cancel'), {});
  return { ok: true };
}
