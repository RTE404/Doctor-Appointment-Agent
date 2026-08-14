// src/bots/agent/lib/patientContext.test.ts
import { beforeAll, describe, expect, test } from 'vitest';
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type { Bundle, SearchParameter } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { loadPatientClinicalContext } from './patientContext';

// A bare MockClient only indexes ~24 hand-picked search parameters (see
// @medplum/mock's mocks/searchparameters.json) — none for Condition,
// MedicationRequest, AllergyIntolerance, or Encounter. Every searchResources
// call on those types silently returns zero results without this setup,
// which matches this project's existing pattern in agent-booking-chat.test.ts.
beforeAll(() => {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-medplum.json') as Bundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
  }
});

describe('loadPatientClinicalContext', () => {
  test('loads patient plus their conditions, medications, allergies, and encounters', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient', name: [{ given: ['Test'], family: 'Patient' }] });
    await medplum.createResource({
      resourceType: 'Condition',
      subject: { reference: `Patient/${patient.id}` },
      code: { text: 'Childhood asthma' },
    });
    await medplum.createResource({
      resourceType: 'MedicationRequest',
      status: 'active',
      intent: 'order',
      subject: { reference: `Patient/${patient.id}` },
      medicationCodeableConcept: { text: 'Albuterol' },
    });
    await medplum.createResource({
      resourceType: 'AllergyIntolerance',
      patient: { reference: `Patient/${patient.id}` },
      code: { text: 'Peanuts' },
    });
    await medplum.createResource({
      resourceType: 'Encounter',
      status: 'finished',
      class: { code: 'AMB' },
      subject: { reference: `Patient/${patient.id}` },
    });

    const context = await loadPatientClinicalContext(medplum, patient.id as string);

    expect(context.patient.id).toBe(patient.id);
    expect(context.conditions).toHaveLength(1);
    expect(context.medications).toHaveLength(1);
    expect(context.allergies).toHaveLength(1);
    expect(context.encounters).toHaveLength(1);
  });

  test('resolves each encounter to its practitioner name, specialty, and organization name', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient', name: [{ given: ['Test'], family: 'Patient' }] });
    const practitioner = await medplum.createResource({
      resourceType: 'Practitioner',
      name: [{ given: ['Jane'], family: 'Doe' }],
    });
    await medplum.createResource({
      resourceType: 'PractitionerRole',
      practitioner: { reference: `Practitioner/${practitioner.id}` },
      specialty: [{ coding: [{ system: 'http://nucc.org/provider-taxonomy', code: '207RC0000X', display: 'Cardiology' }] }],
    });
    const organization = await medplum.createResource({ resourceType: 'Organization', name: 'Central Clinic' });
    await medplum.createResource({
      resourceType: 'Encounter',
      status: 'finished',
      class: { code: 'AMB' },
      subject: { reference: `Patient/${patient.id}` },
      participant: [{ individual: { reference: `Practitioner/${practitioner.id}` } }],
      serviceProvider: { reference: `Organization/${organization.id}` },
      period: { start: '2026-01-01T10:00:00.000Z' },
    });

    const context = await loadPatientClinicalContext(medplum, patient.id as string);

    expect(context.encounterSummaries).toHaveLength(1);
    expect(context.encounterSummaries[0]).toMatchObject({
      date: '2026-01-01',
      practitionerName: 'Dr. Jane Doe',
      specialty: 'Cardiology',
      organizationName: 'Central Clinic',
    });
  });

  test('falls back to "Unknown" fields for an encounter missing practitioner or organization data', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient', name: [{ given: ['Test'], family: 'Patient' }] });
    await medplum.createResource({
      resourceType: 'Encounter',
      status: 'finished',
      class: { code: 'AMB' },
      subject: { reference: `Patient/${patient.id}` },
    });

    const context = await loadPatientClinicalContext(medplum, patient.id as string);

    expect(context.encounterSummaries).toHaveLength(1);
    expect(context.encounterSummaries[0]).toMatchObject({
      date: 'Unknown date',
      practitionerName: 'Unknown',
      specialty: 'Unknown specialty',
      organizationName: 'Unknown organization',
    });
  });
});
