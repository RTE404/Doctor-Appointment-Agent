// src/bots/agent/agent-ensure-doctor.test.ts
import { beforeAll, describe, expect, test } from 'vitest';
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type { Bundle, SearchParameter } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { handler } from './agent-ensure-doctor';

// ensurePractitionerAndSchedule searches HealthcareService.name,
// Practitioner.identifier, and Schedule.actor — none indexed by a bare
// MockClient. See patientContext.test.ts for the same fix and its rationale.
beforeAll(() => {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-medplum.json') as Bundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
  }
});

describe('agent-ensure-doctor handler', () => {
  test('delegates straight to ensurePractitionerAndSchedule and returns its result', async () => {
    const medplum = new MockClient();
    await medplum.createResource({ resourceType: 'HealthcareService', id: 'office-visit', name: 'Office Visit' });

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: {
        npi: '1234567890',
        candidate: { npi: '1234567890', firstName: 'Jane', lastName: 'Doe', nuccCode: '207RC0000X', nuccDisplay: 'Cardiovascular Disease', address: { state: 'MA' } },
      },
      contentType: 'application/json',
      secrets: {},
    });

    expect(result.healthcareServiceId).toBe('office-visit');
    expect(result.practitionerId).toBeDefined();
    expect(result.scheduleId).toBeDefined();
  });
});
