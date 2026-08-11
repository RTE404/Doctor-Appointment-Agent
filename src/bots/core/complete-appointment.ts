import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Bundle, Coding, Encounter } from '@medplum/fhirtypes';
import { isDemoGenerated, withDemoGeneratedTag } from '../../demo/demoTag.js';

export type CompleteAppointmentInput = {
  appointmentId: string;
  encounterType: Coding;
};

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<CompleteAppointmentInput>
): Promise<Encounter> {
  const appointment = await medplum.readResource('Appointment', event.input.appointmentId);
  if (!isDemoGenerated(appointment.meta)) {
    throw new Error('Only demo-generated appointments can be completed');
  }
  if (!appointment.id || !appointment.start || !appointment.end) {
    throw new Error('The appointment is missing its id or scheduled times');
  }
  if (appointment.status === 'fulfilled') {
    const existing = await medplum.readResource('Encounter', appointment.id);
    if (
      isDemoGenerated(existing.meta) &&
      existing.appointment?.some((reference) => reference.reference === `Appointment/${appointment.id}`)
    ) {
      return existing;
    }
    throw new Error('The completed appointment does not have its matching demo encounter');
  }
  if (appointment.status !== 'booked') {
    throw new Error('Only booked appointments can be completed');
  }

  const patientParticipants = appointment.participant?.filter((participant) =>
    participant.actor?.reference?.startsWith('Patient/')
  );
  const practitionerParticipants = appointment.participant?.filter((participant) =>
    participant.actor?.reference?.startsWith('Practitioner/')
  );
  if (patientParticipants?.length !== 1 || !practitionerParticipants?.length) {
    throw new Error('The appointment participants are invalid');
  }

  const patientReference = { reference: patientParticipants[0].actor?.reference as string };
  const start = Date.parse(appointment.start);
  const end = Date.parse(appointment.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error('The appointment times are invalid');
  }
  if (!event.input.encounterType?.code) {
    throw new Error('An encounter type code is required');
  }

  const encounter: Encounter = {
    resourceType: 'Encounter',
    id: appointment.id,
    meta: withDemoGeneratedTag(),
    status: 'finished',
    subject: patientReference,
    appointment: [{ reference: `Appointment/${appointment.id}` }],
    class: {
      system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
      code: 'VR',
      display: 'virtual',
    },
    type: [{ coding: [{ ...event.input.encounterType }] }],
    serviceType: appointment.serviceType?.[0],
    period: { start: appointment.start, end: appointment.end },
    length: { value: Math.floor((end - start) / 60_000), unit: 'minutes' },
    participant: practitionerParticipants.map((participant) => ({
      individual: { reference: participant.actor?.reference as string },
      type: [
        {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType',
              code: 'ATND',
            },
          ],
        },
      ],
    })),
  };

  const transaction: Bundle = {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: [
      {
        resource: { ...appointment, status: 'fulfilled' },
        request: { method: 'PUT', url: `Appointment/${appointment.id}` },
      },
      {
        resource: encounter,
        request: { method: 'PUT', url: `Encounter/${appointment.id}` },
      },
    ],
  };

  await medplum.executeBatch(transaction);
  return medplum.readResource('Encounter', appointment.id);
}
