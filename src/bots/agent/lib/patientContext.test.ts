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
// which matches this project's existing pattern in block-availability.test.ts.
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
});
