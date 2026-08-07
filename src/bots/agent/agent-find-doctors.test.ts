// src/bots/agent/agent-find-doctors.test.ts
import { beforeAll, describe, expect, test } from 'vitest';
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type { Bundle, SearchParameter } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { handler, __setNppesSearcherForTests } from './agent-find-doctors';

// A bare MockClient only indexes ~24 hand-picked search parameters — none
// for Encounter.subject or PractitionerRole.practitioner/specialty, which
// findPreviousPhysician depends on. See patientContext.test.ts for the same
// fix and its rationale.
beforeAll(() => {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-medplum.json') as Bundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
  }
});

describe('agent-find-doctors handler', () => {
  test('surfaces the previous physician first on an exact specialty match, tie-broken by most recent encounter', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({
      resourceType: 'Patient',
      address: [{ extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/geolocation', extension: [{ url: 'latitude', valueDecimal: 42.36 }, { url: 'longitude', valueDecimal: -71.06 }] }] }],
    });
    const olderDoc = await medplum.createResource({ resourceType: 'Practitioner', identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1000000001' }], name: [{ given: ['Older'], family: 'Doc' }] });
    const newerDoc = await medplum.createResource({ resourceType: 'Practitioner', identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1000000002' }], name: [{ given: ['Newer'], family: 'Doc' }] });
    await medplum.createResource({ resourceType: 'PractitionerRole', practitioner: { reference: `Practitioner/${olderDoc.id}` }, specialty: [{ coding: [{ system: 'http://nucc.org/provider-taxonomy', code: '207RC0000X' }] }] });
    await medplum.createResource({ resourceType: 'PractitionerRole', practitioner: { reference: `Practitioner/${newerDoc.id}` }, specialty: [{ coding: [{ system: 'http://nucc.org/provider-taxonomy', code: '207RC0000X' }] }] });
    await medplum.createResource({ resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, subject: { reference: `Patient/${patient.id}` }, participant: [{ individual: { reference: `Practitioner/${olderDoc.id}` } }], period: { start: '2024-01-01T00:00:00Z' } });
    await medplum.createResource({ resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, subject: { reference: `Patient/${patient.id}` }, participant: [{ individual: { reference: `Practitioner/${newerDoc.id}` } }], period: { start: '2025-06-01T00:00:00Z' } });
    __setNppesSearcherForTests(async () => []);

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { patientId: patient.id as string, specialtyCode: '207RC0000X' },
      contentType: 'application/json',
      secrets: {},
    });

    expect(result.candidates[0]).toMatchObject({ source: 'previous', npi: '1000000002' });
  });

  test('falls through to NPPES-only results when no previous match exists', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    __setNppesSearcherForTests(async () => [
      { npi: '9999999999', firstName: 'New', lastName: 'Doc', nuccCode: '207RC0000X', nuccDisplay: 'Cardiovascular Disease', address: { postalCode: '02108' } },
    ]);

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { patientId: patient.id as string, specialtyCode: '207RC0000X' },
      contentType: 'application/json',
      secrets: {},
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ source: 'nppes', npi: '9999999999' });
  });
});
