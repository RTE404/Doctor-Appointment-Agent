import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Appointment, Bundle } from '@medplum/fhirtypes';
import { describe, expect, test, vi } from 'vitest';
import {
  __setFindBookableOptionsDependenciesForTests,
  handler,
} from './agent-find-bookable-options';
import type { FindBookableOptionsInput } from './agent-find-bookable-options';
import type { FoundCandidate } from './agent-find-doctors';
import type { IntakeResult } from './agent-intake';

const NOW = new Date('2026-08-11T12:00:00.000Z');

function event(): BotEvent<FindBookableOptionsInput> {
  return {
    bot: { reference: 'Bot/concierge' },
    input: { patientId: 'patient-1', complaintText: 'Find a nearby doctor in the morning' },
    contentType: 'application/json',
    secrets: { GEMINI_API_KEY: { name: 'GEMINI_API_KEY', valueString: 'test-key' } },
  };
}

function candidate(index: number, source: 'previous' | 'nppes' = 'nppes'): FoundCandidate {
  return {
    npi: `100000000${index}`,
    firstName: `First${index}`,
    lastName: `Last${index}`,
    nuccCode: '208D00000X',
    nuccDisplay: 'General Practice Physician',
    address: { state: 'MA' },
    source,
    distanceMiles: index,
  };
}

function medplumWithAvailability(
  getImpl: (url: URL) => Promise<Bundle<Appointment>>,
  scheduleTimeZone: string = 'America/New_York'
): MedplumClient {
  return {
    fhirUrl: (...segments: string[]) => new URL(`https://example.test/fhir/R4/${segments.join('/')}`),
    get: getImpl,
    readResource: async (resourceType: string, id: string) => ({
      resourceType,
      id,
      extension: [
        {
          url: 'https://medplum.com/fhir/StructureDefinition/SchedulingParameters',
          extension: [
            { url: 'service', valueReference: { reference: 'HealthcareService/service-1' } },
            { url: 'timezone', valueCode: scheduleTimeZone },
          ],
        },
      ],
    }),
  } as unknown as MedplumClient;
}

function successfulIntake(): Exclude<IntakeResult, { needsClarification: true }> {
  return {
    intent: { specialtyCode: '208D00000X', specialtyLabel: 'General Practice', reason: 'General visit' },
    summaryCommunicationId: 'summary-1',
    preferences: { timeOfDay: 'morning' as const, preferPreviousDoctor: true, preferNearby: true },
  };
}

describe('agent-find-bookable-options handler', () => {
  test('returns one clarification without searching doctors or availability', async () => {
    const findDoctors = vi.fn();
    const get = vi.fn();
    __setFindBookableOptionsDependenciesForTests({
      intake: async () => ({ needsClarification: true }),
      findDoctors,
      ensureDoctor: vi.fn(),
      now: () => NOW,
    });

    const result = await handler(medplumWithAvailability(get), event());

    expect(result).toStrictEqual({ needsClarification: true });
    expect(findDoctors).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  test('queries at most five doctors for exactly seven days and returns only three grounded options', async () => {
    const candidates = Array.from({ length: 6 }, (_, index) => candidate(index + 1, index === 0 ? 'previous' : 'nppes'));
    const ensureDoctor = vi.fn(async (_medplum: MedplumClient, npi: string) => ({
      practitionerId: `practitioner-${npi}`,
      scheduleId: `schedule-${npi}`,
      healthcareServiceId: 'service-1',
    }));
    const queriedUrls: URL[] = [];
    const medplum = medplumWithAvailability(async (url) => {
      queriedUrls.push(new URL(url));
      const schedule = url.searchParams.get('schedule') as string;
      const npi = schedule.replace('Schedule/schedule-', '');
      const index = Number(npi.slice(-1));
      const start = new Date(Date.parse('2026-08-12T13:00:00.000Z') + index * 30 * 60 * 1000).toISOString();
      return {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: [{ resource: { resourceType: 'Appointment', status: 'proposed', start, end: new Date(Date.parse(start) + 30 * 60 * 1000).toISOString(), participant: [] } }],
      };
    });
    __setFindBookableOptionsDependenciesForTests({
      intake: async () => successfulIntake(),
      findDoctors: async () => ({ candidates }),
      ensureDoctor,
      now: () => NOW,
    });

    const result = await handler(medplum, event());

    expect(ensureDoctor).toHaveBeenCalledTimes(5);
    expect(queriedUrls).toHaveLength(5);
    for (const url of queriedUrls) {
      expect(url.searchParams.get('start')).toBe('2026-08-11T12:00:00.000Z');
      expect(url.searchParams.get('end')).toBe('2026-08-18T12:00:00.000Z');
      expect(url.searchParams.get('_count')).toBe('100');
    }
    expect(result).not.toHaveProperty('intent');
    expect(result).toMatchObject({ summaryCommunicationId: 'summary-1', preferences: successfulIntake().preferences });
    if ('needsClarification' in result) throw new Error('expected options');
    expect(result.options).toHaveLength(3);
    expect(result.options[0]).toMatchObject({ previousDoctor: true, doctorName: 'Dr. First1 Last1' });
  });

  test('keeps successful availability when another candidate fails', async () => {
    const candidates = [candidate(1), candidate(2)];
    __setFindBookableOptionsDependenciesForTests({
      intake: async () => successfulIntake(),
      findDoctors: async () => ({ candidates }),
      ensureDoctor: async (_medplum, npi) => {
        if (npi.endsWith('1')) throw new Error('candidate failed');
        return { practitionerId: 'practitioner-2', scheduleId: 'schedule-2', healthcareServiceId: 'service-1' };
      },
      now: () => NOW,
    });
    const medplum = medplumWithAvailability(async () => ({
      resourceType: 'Bundle',
      type: 'searchset',
      entry: [
        {
          resource: {
            resourceType: 'Appointment',
            status: 'proposed',
            start: '2026-08-12T13:00:00.000Z',
            end: '2026-08-12T13:30:00.000Z',
            participant: [],
          },
        },
      ],
    }));

    const result = await handler(medplum, event());

    if ('needsClarification' in result) throw new Error('expected options');
    expect(result.options).toHaveLength(1);
    expect(result.options[0].practitionerId).toBe('practitioner-2');
  });

  test('merges a duplicate previous doctor and uses the ensured schedule timezone', async () => {
    const previous = { ...candidate(1, 'previous'), address: {}, distanceMiles: undefined };
    const duplicate = { ...candidate(1), address: { state: 'CA' }, distanceMiles: 1 };
    const ensureDoctor = vi.fn(async (_medplum: MedplumClient, npi: string) => ({
      practitionerId: `practitioner-${npi}`,
      scheduleId: `schedule-${npi}`,
      healthcareServiceId: 'service-1',
    }));
    __setFindBookableOptionsDependenciesForTests({
      intake: async () => successfulIntake(),
      findDoctors: async () => ({ candidates: [previous, duplicate] }),
      ensureDoctor,
      now: () => NOW,
    });
    const proposal: Appointment = {
      resourceType: 'Appointment',
      status: 'proposed',
      start: '2026-08-12T16:00:00.000Z',
      end: '2026-08-12T16:30:00.000Z',
      participant: [],
    };
    const medplum = medplumWithAvailability(
      async () => ({
        resourceType: 'Bundle',
        type: 'searchset',
        entry: [{ resource: proposal }, { resource: proposal }],
      }),
      'America/Los_Angeles'
    );

    const result = await handler(medplum, event());

    if ('needsClarification' in result) throw new Error('expected options');
    expect(ensureDoctor).toHaveBeenCalledTimes(1);
    expect(result.options).toHaveLength(1);
    expect(result.options[0]).toMatchObject({
      previousDoctor: true,
      distanceMiles: 1,
      timeZone: 'America/Los_Angeles',
    });
  });

  test('fails when every bounded doctor availability lookup fails', async () => {
    __setFindBookableOptionsDependenciesForTests({
      intake: async () => successfulIntake(),
      findDoctors: async () => ({ candidates: [candidate(1), candidate(2)] }),
      ensureDoctor: async () => {
        throw new Error('candidate failed');
      },
      now: () => NOW,
    });

    await expect(handler(medplumWithAvailability(vi.fn()), event())).rejects.toThrow(
      'Unable to retrieve appointment availability'
    );
  });
});
