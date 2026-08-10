// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { Appointment, Communication, Patient, Resource } from '@medplum/fhirtypes';

export interface QueueEntry {
  appointmentId: string;
  patientId: string;
  patientName: string;
  appointmentDate: string;
  statedIssue: string;
  summary?: string;
}

function getPatientName(patient: Patient | undefined): string {
  const name = patient?.name?.[0];
  const display = `${name?.given?.join(' ') ?? ''} ${name?.family ?? ''}`.trim();
  return display || 'Unknown Patient';
}

function uniqueById<T extends Resource>(resources: T[]): T[] {
  const resourcesById = new Map<string, T>();
  for (const resource of resources) {
    if (resource.id && !resourcesById.has(resource.id)) {
      resourcesById.set(resource.id, resource);
    }
  }
  return [...resourcesById.values()];
}

export async function loadDoctorQueueEntries(medplum: MedplumClient, npi: string): Promise<QueueEntry[]> {
  const practitioners = await medplum.searchResources('Practitioner', {
    identifier: `http://hl7.org/fhir/sid/us-npi|${npi}`,
  });
  const practitionerReferences = practitioners.flatMap((practitioner) =>
    practitioner.id ? [`Practitioner/${practitioner.id}`] : []
  );
  if (practitionerReferences.length === 0) {
    return [];
  }

  const resourceSets = await Promise.all(
    practitionerReferences.map(async (practitionerReference) => {
      const [appointments, summaries] = await Promise.all([
        medplum.searchResources('Appointment', { actor: practitionerReference, _sort: '-date' }),
        medplum.searchResources('Communication', {
          recipient: practitionerReference,
          category: 'ai-previsit-summary',
        }),
      ]);
      return { appointments, summaries };
    })
  );
  const appointments = uniqueById(resourceSets.flatMap((resourceSet) => resourceSet.appointments)).sort((left, right) =>
    (right.start ?? '').localeCompare(left.start ?? '')
  );
  const summaries = uniqueById(resourceSets.flatMap((resourceSet) => resourceSet.summaries));
  const patientIds = [
    ...new Set(
      appointments.flatMap((appointment) =>
        appointment.participant
          .map((participant) => participant.actor?.reference)
          .filter((reference): reference is string => reference?.startsWith('Patient/') === true)
          .map((reference) => reference.split('/')[1])
      )
    ),
  ];
  const patients = await Promise.all(patientIds.map((patientId) => medplum.readResource('Patient', patientId)));
  return buildQueueEntries(appointments, summaries, patients);
}

export function buildQueueEntries(
  appointments: Appointment[],
  summaries: Communication[],
  patients: Patient[]
): QueueEntry[] {
  const summaryByAppointmentId = new Map<string, string>();
  for (const summary of summaries) {
    const appointmentReference = summary.about?.find((about) => about.reference?.startsWith('Appointment/'))?.reference;
    const appointmentId = appointmentReference?.split('/')[1];
    const content = summary.payload?.find((payload) => payload.contentString)?.contentString;
    if (appointmentId && content) {
      summaryByAppointmentId.set(appointmentId, content);
    }
  }

  const patientById = new Map(patients.flatMap((patient) => (patient.id ? [[patient.id, patient] as const] : [])));

  return appointments.flatMap((appointment) => {
    const patientReference = appointment.participant.find((participant) =>
      participant.actor?.reference?.startsWith('Patient/')
    )?.actor?.reference;
    const patientId = patientReference?.split('/')[1];
    if (!appointment.id || !patientId) {
      return [];
    }

    return [
      {
        appointmentId: appointment.id,
        patientId,
        patientName: getPatientName(patientById.get(patientId)),
        appointmentDate: appointment.start ?? '',
        statedIssue: appointment.description ?? 'No stated issue',
        summary: summaryByAppointmentId.get(appointment.id),
      },
    ];
  });
}
