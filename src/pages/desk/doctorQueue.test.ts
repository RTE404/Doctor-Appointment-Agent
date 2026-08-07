// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Appointment, Communication, Patient } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { buildQueueEntries } from './doctorQueue';

describe('doctor queue resource join', () => {
  test('keeps separate appointments and joins each summary by Communication.about', () => {
    const appointments: Appointment[] = [
      {
        resourceType: 'Appointment',
        id: 'appt-1',
        status: 'booked',
        start: '2026-08-10T09:00:00Z',
        description: 'First issue',
        participant: [
          { actor: { reference: 'Patient/patient-1' }, status: 'accepted' },
          { actor: { reference: 'Practitioner/practitioner-1' }, status: 'accepted' },
        ],
      },
      {
        resourceType: 'Appointment',
        id: 'appt-2',
        status: 'booked',
        start: '2026-08-11T10:00:00Z',
        description: 'Second issue',
        participant: [
          { actor: { reference: 'Patient/patient-1' }, status: 'accepted' },
          { actor: { reference: 'Practitioner/practitioner-1' }, status: 'accepted' },
        ],
      },
    ];
    const summaries: Communication[] = [
      {
        resourceType: 'Communication',
        status: 'completed',
        about: [{ reference: 'Appointment/appt-1' }],
        payload: [{ contentString: 'Summary for first appointment' }],
      },
      {
        resourceType: 'Communication',
        status: 'completed',
        about: [{ reference: 'Appointment/appt-2' }],
        payload: [{ contentString: 'Summary for second appointment' }],
      },
    ];
    const patients: Patient[] = [
      {
        resourceType: 'Patient',
        id: 'patient-1',
        name: [{ given: ['Ada'], family: 'Lovelace' }],
      },
    ];

    expect(buildQueueEntries(appointments, summaries, patients)).toStrictEqual([
      {
        appointmentId: 'appt-1',
        patientId: 'patient-1',
        patientName: 'Ada Lovelace',
        appointmentDate: '2026-08-10T09:00:00Z',
        statedIssue: 'First issue',
        summary: 'Summary for first appointment',
      },
      {
        appointmentId: 'appt-2',
        patientId: 'patient-1',
        patientName: 'Ada Lovelace',
        appointmentDate: '2026-08-11T10:00:00Z',
        statedIssue: 'Second issue',
        summary: 'Summary for second appointment',
      },
    ]);
  });

  test('ignores appointments without a persisted id or patient participant', () => {
    const appointments: Appointment[] = [
      { resourceType: 'Appointment', status: 'booked', participant: [] },
      {
        resourceType: 'Appointment',
        id: 'without-patient',
        status: 'booked',
        participant: [{ actor: { reference: 'Practitioner/practitioner-1' }, status: 'accepted' }],
      },
    ];

    expect(buildQueueEntries(appointments, [], [])).toStrictEqual([]);
  });
});
