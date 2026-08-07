// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Appointment, Communication, Patient } from '@medplum/fhirtypes';

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
