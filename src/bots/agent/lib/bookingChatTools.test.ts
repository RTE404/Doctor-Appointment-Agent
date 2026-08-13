import { beforeAll, describe, expect, test, vi } from 'vitest';
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import type { MedplumClient } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type { Appointment, Bundle, Patient, Schedule, SearchParameter } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import {
  BOOKING_CHAT_TOOL_SCHEMAS,
  __setBookingChatToolsNowForTests,
  checkAvailabilityTool,
  searchNppesTool,
  searchPreviousPhysicianTool,
} from './bookingChatTools';
import { __setNppesSearcherForTests } from '../agent-find-doctors';

beforeAll(() => {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-medplum.json') as Bundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
  }
});

describe('BOOKING_CHAT_TOOL_SCHEMAS', () => {
  test('declares all five tools with function-calling shape', () => {
    const names = BOOKING_CHAT_TOOL_SCHEMAS.map((t) => t.function.name);
    expect(names).toStrictEqual([
      'search_previous_physician',
      'search_nppes',
      'check_availability',
      'ask_clarifying_question',
      'propose_options',
    ]);
    for (const tool of BOOKING_CHAT_TOOL_SCHEMAS) {
      expect(tool.type).toBe('function');
      expect(tool.function.parameters).toHaveProperty('type', 'object');
    }
  });
});

describe('searchPreviousPhysicianTool', () => {
  test('returns null when there is no matching previous physician', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient' });

    const result = await searchPreviousPhysicianTool(medplum, patient.id as string, '208D00000X');

    expect(result).toBeNull();
  });
});

describe('searchNppesTool', () => {
  test('returns up to 15 ranked NPPES candidates', async () => {
    __setNppesSearcherForTests(async () =>
      Array.from({ length: 20 }, (_, i) => ({
        npi: `100000000${i}`,
        firstName: `First${i}`,
        lastName: `Last${i}`,
        nuccCode: '208D00000X',
        nuccDisplay: 'General Practice Physician',
        address: {},
      }))
    );
    const medplum = new MockClient();
    const patient: Patient = { resourceType: 'Patient', address: [{ city: 'Boston', state: 'Massachusetts' }] };

    const result = await searchNppesTool(medplum, patient, '208D00000X');

    expect(result).toHaveLength(15);
    expect(result.every((c) => c.source === 'nppes')).toBe(true);
  });
});

describe('checkAvailabilityTool', () => {
  test('returns grounded BookableOptions using the schedule timezone and derives the doctor name from the ensured Practitioner', async () => {
    __setBookingChatToolsNowForTests(() => new Date('2026-08-13T12:00:00.000Z'));
    const medplum = {
      searchOne: vi.fn(async (resourceType: string) => {
        if (resourceType === 'HealthcareService') return { resourceType, id: 'service-1' };
        if (resourceType === 'Practitioner') return { resourceType, id: 'practitioner-1' };
        if (resourceType === 'PractitionerRole') return { resourceType, id: 'role-1' };
        if (resourceType === 'Schedule') return { resourceType, id: 'schedule-1' };
        return undefined;
      }),
      createResourceIfNoneExist: vi.fn(async (resource: unknown) => ({ ...(resource as object), id: 'schedule-1' })),
      readResource: vi.fn(async (resourceType: string, id: string) => {
        if (resourceType === 'Practitioner') {
          return { resourceType, id, name: [{ given: ['Jane'], family: 'Doe' }] };
        }
        if (resourceType === 'Schedule') {
          const schedule: Schedule = {
            resourceType: 'Schedule',
            id,
            actor: [{ reference: 'Practitioner/practitioner-1' }],
            extension: [
              {
                url: 'https://medplum.com/fhir/StructureDefinition/SchedulingParameters',
                extension: [
                  { url: 'service', valueReference: { reference: 'HealthcareService/service-1' } },
                  { url: 'timezone', valueCode: 'America/New_York' },
                ],
              },
            ],
          };
          return schedule;
        }
        throw new Error(`unexpected read ${resourceType}`);
      }),
      fhirUrl: (...segments: string[]) => new URL(`https://example.test/fhir/R4/${segments.join('/')}`),
      get: vi.fn(async (url: URL) => {
        const start = url.searchParams.get('start');
        const appointment: Appointment = {
          resourceType: 'Appointment',
          status: 'proposed',
          start: start as string,
          end: new Date(Date.parse(start as string) + 30 * 60 * 1000).toISOString(),
          participant: [],
        };
        return { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: appointment }] };
      }),
    } as unknown as MedplumClient;

    const result = await checkAvailabilityTool(medplum, { npi: '1000000001', previousDoctor: true, distanceMiles: 3.5 });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      npi: '1000000001',
      doctorName: 'Dr. Jane Doe',
      timeZone: 'America/New_York',
      previousDoctor: true,
      distanceMiles: 3.5,
    });
  });
});
