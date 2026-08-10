// src/bots/agent/lib/ensurePractitionerAndSchedule.test.ts
import { beforeAll, describe, expect, test } from 'vitest';
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type { Bundle, SearchParameter } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { ensurePractitionerAndSchedule, __setNppesLookupForTests } from './ensurePractitionerAndSchedule';

// A bare MockClient only indexes ~24 hand-picked search parameters — none
// for HealthcareService.name, Practitioner.identifier, or Schedule.actor,
// which this module depends on. See patientContext.test.ts for the same
// fix and its rationale.
beforeAll(() => {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-medplum.json') as Bundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
  }
});

describe('ensurePractitionerAndSchedule', () => {
  test('creates Practitioner, PractitionerRole, and a single-service Schedule for a new NPI', async () => {
    const medplum = new MockClient();
    await medplum.createResource({ resourceType: 'HealthcareService', id: 'office-visit', name: 'Office Visit' });

    const result = await ensurePractitionerAndSchedule(medplum, '1234567890', {
      npi: '1234567890', firstName: 'Jane', lastName: 'Doe', nuccCode: '207RC0000X', nuccDisplay: 'Cardiovascular Disease',
      address: { state: 'MA', postalCode: '02108' },
    });

    expect(result.healthcareServiceId).toBe('office-visit');

    const schedule = await medplum.readResource('Schedule', result.scheduleId);
    expect(schedule.actor?.[0].reference).toBe(`Practitioner/${result.practitionerId}`);
    expect(schedule.serviceType).toHaveLength(1);
    for (const concept of schedule.serviceType ?? []) {
      const ref = concept.extension?.find((e: any) => e.url === 'https://medplum.com/fhir/service-type-reference');
      expect(ref?.valueReference?.reference).toMatch(/^HealthcareService\//);
    }

    // One SchedulingParameters extension, with its own `service`
    // sub-extension. A service-less extension is silently ignored by
    // Medplum's actual matching logic — this is what makes it apply at all.
    const schedulingParamsExtensions = (schedule.extension ?? []).filter(
      (e: any) => e.url === 'https://medplum.com/fhir/StructureDefinition/SchedulingParameters'
    );
    expect(schedulingParamsExtensions).toHaveLength(1);

    const officeVisitParams = schedulingParamsExtensions.find((e: any) =>
      e.extension?.some((sub: any) => sub.url === 'service' && sub.valueReference?.reference === 'HealthcareService/office-visit')
    );
    expect(officeVisitParams).toBeDefined();
    expect(officeVisitParams?.extension?.find((e: any) => e.url === 'duration')?.valueDuration?.value).toBe(30);
    expect(officeVisitParams?.extension?.find((e: any) => e.url === 'alignmentInterval')?.valueDuration?.value).toBe(30);
    expect(officeVisitParams?.extension?.find((e: any) => e.url === 'timezone')?.valueCode).toBe('America/New_York');

    const practitioner = await medplum.readResource('Practitioner', result.practitionerId);
    expect(practitioner.identifier?.[0]).toStrictEqual({ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' });

    const role = await medplum.searchOne('PractitionerRole', { practitioner: `Practitioner/${result.practitionerId}` });
    expect(role?.specialty?.[0].coding?.[0].code).toBe('207RC0000X');
  });

  test('is idempotent — a second call for the same NPI reuses the same resources', async () => {
    const medplum = new MockClient();
    await medplum.createResource({ resourceType: 'HealthcareService', id: 'office-visit', name: 'Office Visit' });
    const candidate = { npi: '1234567890', firstName: 'Jane', lastName: 'Doe', nuccCode: '207RC0000X', nuccDisplay: 'Cardiovascular Disease', address: { state: 'MA' } };

    const first = await ensurePractitionerAndSchedule(medplum, '1234567890', candidate);
    const second = await ensurePractitionerAndSchedule(medplum, '1234567890', candidate);

    expect(second.practitionerId).toBe(first.practitionerId);
    expect(second.scheduleId).toBe(first.scheduleId);
  });

  test('is idempotent when two requests provision the same NPI concurrently', async () => {
    const medplum = new MockClient();
    await medplum.createResource({ resourceType: 'HealthcareService', id: 'office-visit', name: 'Office Visit' });
    const candidate = {
      npi: '1234567890',
      firstName: 'Jane',
      lastName: 'Doe',
      nuccCode: '207RC0000X',
      nuccDisplay: 'Cardiovascular Disease',
      address: { state: 'MA' },
    };

    const [first, second] = await Promise.all([
      ensurePractitionerAndSchedule(medplum, candidate.npi, candidate),
      ensurePractitionerAndSchedule(medplum, candidate.npi, candidate),
    ]);

    const practitioners = await medplum.searchResources('Practitioner', {
      identifier: 'http://hl7.org/fhir/sid/us-npi|1234567890',
    });
    const schedules = await medplum.searchResources('Schedule', {
      actor: `Practitioner/${first.practitionerId}`,
    });

    expect(second.practitionerId).toBe(first.practitionerId);
    expect(second.scheduleId).toBe(first.scheduleId);
    expect(practitioners).toHaveLength(1);
    expect(schedules).toHaveLength(1);
  });

  test('looks up NPPES when no candidate is supplied', async () => {
    const medplum = new MockClient();
    await medplum.createResource({ resourceType: 'HealthcareService', id: 'office-visit', name: 'Office Visit' });
    __setNppesLookupForTests(async () => ({
      npi: '1234567890', firstName: 'Jane', lastName: 'Doe', nuccCode: '207RC0000X', nuccDisplay: 'Cardiovascular Disease', address: { state: 'MA' },
    }));

    const result = await ensurePractitionerAndSchedule(medplum, '1234567890');

    const practitioner = await medplum.readResource('Practitioner', result.practitionerId);
    expect(practitioner.name?.[0].family).toBe('Doe');
  });
});
