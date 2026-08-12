// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { Appointment, Communication, Patient, Practitioner } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { buildQueueEntries, loadDoctorQueueEntries } from './doctorQueue';

type QueueFixture = Practitioner | Appointment | Communication | Patient;

function hasExactFilters(actual: Record<string, string>, expected: Record<string, string>): boolean {
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => Object.hasOwn(expected, key) && actual[key] === expected[key])
  );
}

function assertExpectedSearchFilters(
  resourceType: string,
  filters: Record<string, string>,
  expectedFilters: Record<string, string>[]
): void {
  if (!expectedFilters.some((expected) => hasExactFilters(filters, expected))) {
    throw new Error(`Unexpected search filters for ${resourceType}: ${JSON.stringify(filters)}`);
  }
}

function createQueueClient(resources: QueueFixture[]): MedplumClient {
  return {
    searchResources: async (resourceType: string, filters: Record<string, string>) => {
      if (resourceType === 'Practitioner') {
        const identifiers = resources
          .filter((resource): resource is Practitioner => resource.resourceType === 'Practitioner')
          .flatMap((practitioner) => practitioner.identifier?.map((identifier) => `${identifier.system}|${identifier.value}`) ?? []);
        assertExpectedSearchFilters(
          resourceType,
          filters,
          identifiers.map((identifier) => ({ identifier }))
        );
        return resources.filter((resource): resource is Practitioner => resource.resourceType === 'Practitioner')
          .filter((practitioner) => practitioner.identifier?.some((id) => `${id.system}|${id.value}` === filters.identifier));
      }
      if (resourceType === 'Appointment') {
        const practitionerReferences = resources
          .filter((resource): resource is Practitioner => resource.resourceType === 'Practitioner' && resource.id !== undefined)
          .map((practitioner) => `Practitioner/${practitioner.id}`);
        assertExpectedSearchFilters(
          resourceType,
          filters,
          practitionerReferences.map((actor) => ({ actor, _sort: '-date' }))
        );
        return resources.filter((resource): resource is Appointment => resource.resourceType === 'Appointment')
          .filter((appointment) => appointment.participant.some((part) => part.actor?.reference === filters.actor));
      }
      if (resourceType === 'Communication') {
        const practitionerReferences = resources
          .filter((resource): resource is Practitioner => resource.resourceType === 'Practitioner' && resource.id !== undefined)
          .map((practitioner) => `Practitioner/${practitioner.id}`);
        assertExpectedSearchFilters(
          resourceType,
          filters,
          practitionerReferences.map((recipient) => ({ recipient, category: 'ai-previsit-summary' }))
        );
        return resources.filter((resource): resource is Communication => resource.resourceType === 'Communication')
          .filter((communication) => communication.recipient?.some((recipient) => recipient.reference === filters.recipient))
          .filter((communication) => communication.category?.some((category) => category.coding?.some((coding) => coding.code === filters.category)));
      }
      throw new Error(`Unexpected search resource type: ${resourceType}`);
    },
    readResource: async (resourceType: string, id: string) => {
      if (resourceType !== 'Patient') throw new Error(`Unexpected read resource type: ${resourceType}`);
      const patient = resources.find((resource): resource is Patient => resource.resourceType === 'Patient' && resource.id === id);
      if (!patient) throw new Error(`Patient/${id} not found`);
      return patient;
    },
  } as unknown as MedplumClient;
}

describe('doctor queue resource join', () => {
  test('rejects unsupported search filters instead of silently ignoring them', async () => {
    const medplum = createQueueClient([
      {
        resourceType: 'Practitioner',
        id: 'practitioner-1',
        identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }],
      },
    ]);

    await expect(
      medplum.searchResources('Appointment', {
        actor: 'Practitioner/practitioner-1',
        _sort: '-date',
        status: 'booked',
      })
    ).rejects.toThrow(/Unexpected search filters/);
  });

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

  test('loads a synthetic-provider appointment and summary by its exact short identifier', async () => {
    const firstPractitioner: Practitioner = {
      resourceType: 'Practitioner',
      id: 'practitioner-1',
      identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '12345' }],
    };
    const relationshipPractitioner: Practitioner = {
      resourceType: 'Practitioner',
      id: 'practitioner-2',
      identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '12345' }],
    };
    const patient: Patient = {
      resourceType: 'Patient',
      id: 'patient-1',
      name: [{ given: ['Ada'], family: 'Lovelace' }],
    };
    const appointment: Appointment = {
      resourceType: 'Appointment',
      id: 'appointment-1',
      status: 'booked',
      start: '2026-08-11T13:00:00Z',
      description: 'Follow-up visit',
      participant: [
        { actor: { reference: 'Patient/patient-1' }, status: 'accepted' },
        { actor: { reference: 'Practitioner/practitioner-2' }, status: 'accepted' },
      ],
    };
    const summary: Communication = {
      resourceType: 'Communication',
      id: 'summary-1',
      status: 'completed',
      category: [{ coding: [{ code: 'ai-previsit-summary' }] }],
      recipient: [{ reference: 'Practitioner/practitioner-2' }],
      about: [{ reference: 'Appointment/appointment-1' }],
      payload: [{ contentString: 'Prepared summary' }],
    };
    const medplum = createQueueClient([
      firstPractitioner,
      relationshipPractitioner,
      patient,
      appointment,
      summary,
    ]);

    const entries = await loadDoctorQueueEntries(medplum, '12345');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      appointmentId: 'appointment-1',
      patientId: 'patient-1',
      summary: 'Prepared summary',
    });
  });

  test('deduplicates an appointment returned for multiple matching Practitioners', async () => {
    const firstPractitioner: Practitioner = {
      resourceType: 'Practitioner',
      id: 'practitioner-1',
      identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }],
    };
    const secondPractitioner: Practitioner = {
      resourceType: 'Practitioner',
      id: 'practitioner-2',
      identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }],
    };
    const patient: Patient = { resourceType: 'Patient', id: 'patient-1' };
    const appointment: Appointment = {
      resourceType: 'Appointment',
      id: 'appointment-1',
      status: 'booked',
      participant: [
        { actor: { reference: 'Patient/patient-1' }, status: 'accepted' },
        { actor: { reference: 'Practitioner/practitioner-1' }, status: 'accepted' },
        { actor: { reference: 'Practitioner/practitioner-2' }, status: 'accepted' },
      ],
    };
    const medplum = createQueueClient([firstPractitioner, secondPractitioner, patient, appointment]);

    const entries = await loadDoctorQueueEntries(medplum, '1234567890');

    expect(entries).toHaveLength(1);
    expect(entries[0].appointmentId).toBe('appointment-1');
  });
});
