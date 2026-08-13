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
  collectSearchedCandidates,
  searchNppesTool,
  searchPreviousPhysicianTool,
} from './bookingChatTools';
import type { FoundCandidate } from '../agent-find-doctors';
import { __setNppesSearcherForTests } from '../agent-find-doctors';
import type { BookingChatMessage } from './bookingSession';

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

  test('check_availability does not accept previousDoctor/distanceMiles as model-supplied arguments', () => {
    // Both are derived server-side from the candidate the NPI actually came
    // from, never from an unverifiable model claim — a model that could set
    // `previousDoctor: true` could put a false "Previously visited" badge in
    // front of the patient.
    const checkAvailability = BOOKING_CHAT_TOOL_SCHEMAS.find((t) => t.function.name === 'check_availability');
    const properties = (checkAvailability?.function.parameters as { properties: Record<string, unknown> }).properties;

    expect(Object.keys(properties)).toStrictEqual(['npi', 'startOffsetDays', 'windowDays']);
  });
});

describe('collectSearchedCandidates', () => {
  function toolResultMessage(tool: string, result: unknown): BookingChatMessage {
    return { role: 'tool', tool_call_id: 'call-1', content: JSON.stringify({ tool, result }) };
  }

  function candidate(npi: string, overrides: Partial<FoundCandidate> = {}): FoundCandidate {
    return {
      source: 'nppes',
      npi,
      firstName: 'First',
      lastName: 'Last',
      nuccCode: '208D00000X',
      nuccDisplay: 'General Practice Physician',
      address: {},
      ...overrides,
    } as FoundCandidate;
  }

  test('indexes candidates from both search tools by NPI and ignores every other tool result', () => {
    const transcript: BookingChatMessage[] = [
      toolResultMessage('search_nppes', [candidate('1'), candidate('2')]),
      toolResultMessage('search_previous_physician', candidate('3', { source: 'previous' })),
      toolResultMessage('check_availability', [{ npi: '4' }]),
      { role: 'tool', tool_call_id: 'call-x', content: 'not json' },
      toolResultMessage('search_nppes', { error: 'boom' }),
    ];

    const index = collectSearchedCandidates(transcript);

    expect([...index.keys()].sort()).toStrictEqual(['1', '2', '3']);
    expect(index.get('3')?.source).toBe('previous');
  });

  test('a null search_previous_physician result contributes nothing', () => {
    const index = collectSearchedCandidates([toolResultMessage('search_previous_physician', null)]);

    expect(index.size).toBe(0);
  });

  test('a previous-physician match is never downgraded by a later nppes hit on the same NPI', () => {
    const transcript: BookingChatMessage[] = [
      toolResultMessage('search_previous_physician', candidate('1', { source: 'previous' })),
      toolResultMessage('search_nppes', [candidate('1')]),
    ];

    expect(collectSearchedCandidates(transcript).get('1')?.source).toBe('previous');
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

  test('raises an explicit error for an unrecognized specialty code instead of returning an empty list', async () => {
    // An empty array is indistinguishable from "no doctors found nearby", so
    // the model would keep burning loop steps with no corrective signal.
    const medplum = new MockClient();
    const patient: Patient = { resourceType: 'Patient', address: [{ city: 'Boston', state: 'Massachusetts' }] };

    await expect(searchNppesTool(medplum, patient, 'not-a-code')).rejects.toThrow(
      /"not-a-code" is not a supported NUCC specialty code/
    );
  });
});

describe('checkAvailabilityTool', () => {
  function fakeMedplum(overrides: { existingRole?: boolean; createSpy?: ReturnType<typeof vi.fn> } = {}): MedplumClient {
    const createResourceIfNoneExist =
      overrides.createSpy ?? vi.fn(async (resource: unknown) => ({ ...(resource as object), id: 'created-1' }));
    return {
      searchOne: vi.fn(async (resourceType: string) => {
        if (resourceType === 'HealthcareService') return { resourceType, id: 'service-1' };
        if (resourceType === 'Practitioner') return { resourceType, id: 'practitioner-1' };
        if (resourceType === 'PractitionerRole') return overrides.existingRole === false ? undefined : { resourceType, id: 'role-1' };
        if (resourceType === 'Schedule') return { resourceType, id: 'schedule-1' };
        return undefined;
      }),
      createResourceIfNoneExist,
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
  }

  const nppesCandidate = {
    source: 'nppes',
    npi: '1000000001',
    firstName: 'Jane',
    lastName: 'Doe',
    nuccCode: '207RC0000X',
    nuccDisplay: 'Cardiovascular Disease Physician',
    address: { state: 'MA' },
    distanceMiles: 3.5,
  } as FoundCandidate;

  test('returns grounded BookableOptions using the schedule timezone and derives the doctor name from the ensured Practitioner', async () => {
    __setBookingChatToolsNowForTests(() => new Date('2026-08-13T12:00:00.000Z'));

    const result = await checkAvailabilityTool(fakeMedplum(), { npi: '1000000001' }, nppesCandidate);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      npi: '1000000001',
      doctorName: 'Dr. Jane Doe',
      timeZone: 'America/New_York',
    });
  });

  test('derives previousDoctor and distanceMiles from the resolved candidate, not from tool arguments', async () => {
    __setBookingChatToolsNowForTests(() => new Date('2026-08-13T12:00:00.000Z'));
    const previousCandidate = {
      source: 'previous',
      npi: '1000000001',
      firstName: 'Jane',
      lastName: 'Doe',
      nuccCode: '207RC0000X',
      nuccDisplay: 'Cardiovascular Disease Physician',
      address: {},
      distanceMiles: undefined,
    } as FoundCandidate;

    const fromNppes = await checkAvailabilityTool(fakeMedplum(), { npi: '1000000001' }, nppesCandidate);
    const fromPrevious = await checkAvailabilityTool(fakeMedplum(), { npi: '1000000001' }, previousCandidate);

    expect(fromNppes[0]).toMatchObject({ previousDoctor: false, distanceMiles: 3.5 });
    expect(fromPrevious[0]).toMatchObject({ previousDoctor: true });
    expect(fromPrevious[0].distanceMiles).toBeUndefined();
  });

  test('seeds a newly provisioned PractitionerRole with the specialty the candidate was actually found under', async () => {
    // Regression guard for the specialty-mismatch bug fixed in 2778736: an
    // NPPES provider can match a search on a NON-primary taxonomy. Without
    // the candidate, ensurePractitionerAndSchedule re-looks-up the NPI and
    // takes the provider's PRIMARY taxonomy, so the PractitionerRole gets a
    // specialty that agent-book-appointment then rejects — booking fails
    // permanently for that provider.
    __setBookingChatToolsNowForTests(() => new Date('2026-08-13T12:00:00.000Z'));
    const createSpy = vi.fn(async (resource: unknown) => ({ ...(resource as object), id: 'created-1' }));

    await checkAvailabilityTool(fakeMedplum({ existingRole: false, createSpy }), { npi: '1000000001' }, nppesCandidate);

    const roleCall = createSpy.mock.calls.find(
      ([resource]) => (resource as { resourceType?: string }).resourceType === 'PractitionerRole'
    );
    expect(roleCall).toBeDefined();
    expect((roleCall?.[0] as { specialty: { coding: { code: string }[] }[] }).specialty[0].coding[0].code).toBe(
      '207RC0000X'
    );
  });
});
