// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type { Appointment, Bundle, Communication, Patient, SearchParameter } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { beforeAll, describe, expect, test } from 'vitest';
import { buildQueueEntries, loadDoctorQueueEntries } from './doctorQueue';

beforeAll(() => {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-medplum.json') as Bundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
  }
});

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

  test('loads an appointment attached to any Practitioner sharing the NPI', async () => {
    const medplum = new MockClient();
    await medplum.createResource({
      resourceType: 'Practitioner',
      identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }],
    });
    const relationshipPractitioner = await medplum.createResource({
      resourceType: 'Practitioner',
      identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }],
    });
    const patient = await medplum.createResource({
      resourceType: 'Patient',
      name: [{ given: ['Ada'], family: 'Lovelace' }],
    });
    const appointment = await medplum.createResource({
      resourceType: 'Appointment',
      status: 'booked',
      start: '2026-08-11T13:00:00Z',
      description: 'Follow-up visit',
      participant: [
        { actor: { reference: `Patient/${patient.id}` }, status: 'accepted' },
        { actor: { reference: `Practitioner/${relationshipPractitioner.id}` }, status: 'accepted' },
      ],
    });
    await medplum.createResource({
      resourceType: 'Communication',
      status: 'completed',
      category: [{ coding: [{ code: 'ai-previsit-summary' }] }],
      recipient: [{ reference: `Practitioner/${relationshipPractitioner.id}` }],
      about: [{ reference: `Appointment/${appointment.id}` }],
      payload: [{ contentString: 'Prepared summary' }],
    });

    const entries = await loadDoctorQueueEntries(medplum, '1234567890');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      appointmentId: appointment.id,
      patientId: patient.id,
      summary: 'Prepared summary',
    });
  });

  test('deduplicates an appointment returned for multiple matching Practitioners', async () => {
    const medplum = new MockClient();
    const firstPractitioner = await medplum.createResource({
      resourceType: 'Practitioner',
      identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }],
    });
    const secondPractitioner = await medplum.createResource({
      resourceType: 'Practitioner',
      identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }],
    });
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    const appointment = await medplum.createResource({
      resourceType: 'Appointment',
      status: 'booked',
      participant: [
        { actor: { reference: `Patient/${patient.id}` }, status: 'accepted' },
        { actor: { reference: `Practitioner/${firstPractitioner.id}` }, status: 'accepted' },
        { actor: { reference: `Practitioner/${secondPractitioner.id}` }, status: 'accepted' },
      ],
    });

    const entries = await loadDoctorQueueEntries(medplum, '1234567890');

    expect(entries).toHaveLength(1);
    expect(entries[0].appointmentId).toBe(appointment.id);
  });
});
