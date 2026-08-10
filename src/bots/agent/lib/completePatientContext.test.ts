import type { MedplumClient } from '@medplum/core';
import type { Bundle, Patient } from '@medplum/fhirtypes';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadCompletePatientContext } from './completePatientContext';

const ORIGIN = 'https://api.example.test';
const EVERYTHING_URL = `${ORIGIN}/fhir/R4/Patient/patient-1/$everything`;

function makeClient(
  pages: Record<string, Bundle>,
  fallbackPatient?: Patient,
  onGet?: (options?: RequestInit) => void
): MedplumClient {
  return {
    fhirUrl: (...path: string[]) => new URL(`/fhir/R4/${path.join('/')}`, ORIGIN),
    get: vi.fn(async (url: URL | string, options?: RequestInit) => {
      onGet?.(options);
      const page = pages[url.toString()];
      if (!page) throw new Error(`Unexpected page URL: ${url.toString()}`);
      return page;
    }),
    readResource: vi.fn(async () => {
      if (!fallbackPatient) throw new Error('Unexpected Patient fallback read');
      return fallbackPatient;
    }),
  } as unknown as MedplumClient;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadCompletePatientContext', () => {
  test('loads every page, includes new resource types, and deduplicates by FHIR identity', async () => {
    const firstPage: Bundle = {
      resourceType: 'Bundle', type: 'searchset',
      entry: [
        { fullUrl: `${ORIGIN}/fhir/R4/Patient/patient-1`, resource: { resourceType: 'Patient', id: 'patient-1' } },
        { fullUrl: `${ORIGIN}/fhir/R4/Condition/condition-1`, resource: { resourceType: 'Condition', id: 'condition-1', subject: { reference: 'Patient/patient-1' } } },
      ],
      link: [{ relation: 'next', url: '?_cursor=page-2' }],
    };
    const secondPage: Bundle = {
      resourceType: 'Bundle', type: 'searchset',
      entry: [
        { fullUrl: `${ORIGIN}/fhir/R4/Condition/condition-1`, resource: { resourceType: 'Condition', id: 'condition-1', subject: { reference: 'Patient/patient-1' } } },
        { fullUrl: `${ORIGIN}/fhir/R4/MedicationRequest/medication-1`, resource: { resourceType: 'MedicationRequest', id: 'medication-1', status: 'active', intent: 'order', subject: { reference: 'Patient/patient-1' } } },
        { fullUrl: `${ORIGIN}/fhir/R4/Observation/observation-1`, resource: { resourceType: 'Observation', id: 'observation-1', status: 'final', code: { text: 'Body height' }, subject: { reference: 'Patient/patient-1' }, valueQuantity: { value: 170, unit: 'cm' } } },
      ],
    };
    const client = makeClient({ [EVERYTHING_URL]: firstPage, [`${EVERYTHING_URL}?_cursor=page-2`]: secondPage });
    const context = await loadCompletePatientContext(client, 'patient-1');
    expect(client.get).toHaveBeenNthCalledWith(
      1,
      EVERYTHING_URL,
      expect.objectContaining({ cache: 'no-cache', signal: expect.any(AbortSignal) })
    );
    expect(client.get).toHaveBeenNthCalledWith(
      2,
      `${EVERYTHING_URL}?_cursor=page-2`,
      expect.objectContaining({ cache: 'no-cache', signal: expect.any(AbortSignal) })
    );
    expect(context.patient.id).toBe('patient-1');
    expect(context.resources.map((resource) => `${resource.resourceType}/${resource.id}`)).toStrictEqual([
      'Condition/condition-1', 'MedicationRequest/medication-1', 'Observation/observation-1', 'Patient/patient-1',
    ]);
  });

  test('retains an idless resource and collapses an identical repeated entry deterministically', async () => {
    const idlessObservation = { resourceType: 'Observation' as const, status: 'final' as const, code: { text: 'Patient-reported note' }, subject: { reference: 'Patient/patient-1' }, valueString: 'No mobility concerns' };
    const client = makeClient({ [EVERYTHING_URL]: { resourceType: 'Bundle', type: 'searchset', entry: [
      { resource: { resourceType: 'Patient', id: 'patient-1' } }, { resource: idlessObservation }, { resource: { ...idlessObservation } },
    ] } });
    const context = await loadCompletePatientContext(client, 'patient-1');
    expect(context.resources.filter((resource) => !resource.id)).toStrictEqual([idlessObservation]);
  });

  test('collapses identical idless resources even when their fullUrl values differ', async () => {
    const idlessObservation = {
      resourceType: 'Observation' as const,
      status: 'final' as const,
      code: { text: 'Patient-reported note' },
      subject: { reference: 'Patient/patient-1' },
      valueString: 'No mobility concerns',
    };
    const client = makeClient({
      [EVERYTHING_URL]: {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: [
          { resource: { resourceType: 'Patient', id: 'patient-1' } },
          { fullUrl: 'urn:uuid:first', resource: idlessObservation },
          { fullUrl: 'urn:uuid:second', resource: { ...idlessObservation } },
        ],
      },
    });

    const context = await loadCompletePatientContext(client, 'patient-1');

    expect(context.resources.filter((resource) => !resource.id)).toStrictEqual([idlessObservation]);
  });

  test('retains different idless resources even when their fullUrl value is reused', async () => {
    const client = makeClient({
      [EVERYTHING_URL]: {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: [
          { resource: { resourceType: 'Patient', id: 'patient-1' } },
          {
            fullUrl: 'urn:uuid:reused',
            resource: { resourceType: 'Observation', status: 'final', code: { text: 'Note' }, valueString: 'Alpha' },
          },
          {
            fullUrl: 'urn:uuid:reused',
            resource: { resourceType: 'Observation', status: 'final', code: { text: 'Note' }, valueString: 'Beta' },
          },
        ],
      },
    });

    const context = await loadCompletePatientContext(client, 'patient-1');

    expect(
      context.resources
        .filter((resource) => resource.resourceType === 'Observation')
        .map((resource) => resource.valueString)
    ).toStrictEqual(['Alpha', 'Beta']);
  });

  test('reads and inserts the focal Patient when the operation omits it, and excludes another Patient', async () => {
    const focalPatient: Patient = { resourceType: 'Patient', id: 'patient-1', name: [{ given: ['Asha'], family: 'Rao' }] };
    const client = makeClient({ [EVERYTHING_URL]: { resourceType: 'Bundle', type: 'searchset', entry: [
      { resource: { resourceType: 'Patient', id: 'patient-2' } }, { resource: { resourceType: 'AllergyIntolerance', id: 'allergy-1', patient: { reference: 'Patient/patient-1' }, code: { text: 'Peanuts' } } },
    ] } }, focalPatient);
    const context = await loadCompletePatientContext(client, 'patient-1');
    expect(context.patient).toStrictEqual(focalPatient);
    expect(context.resources.filter((resource) => resource.resourceType === 'Patient')).toStrictEqual([focalPatient]);
    expect(client.readResource).toHaveBeenCalledWith(
      'Patient',
      'patient-1',
      expect.objectContaining({ cache: 'no-cache', signal: expect.any(AbortSignal) })
    );
  });

  test('rejects a fallback Patient whose identity does not match the selected patient', async () => {
    const client = makeClient(
      {
        [EVERYTHING_URL]: {
          resourceType: 'Bundle',
          type: 'searchset',
          entry: [
            {
              resource: {
                resourceType: 'Condition',
                id: 'condition-1',
                subject: { reference: 'Patient/patient-1' },
              },
            },
          ],
        },
      },
      { resourceType: 'Patient', id: 'patient-2' }
    );

    await expect(loadCompletePatientContext(client, 'patient-1')).rejects.toThrow(/focal Patient identity/i);
  });

  test('fails closed when a next link repeats a page', async () => {
    const client = makeClient({ [EVERYTHING_URL]: { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: { resourceType: 'Patient', id: 'patient-1' } }], link: [{ relation: 'next', url: EVERYTHING_URL }] } });
    await expect(loadCompletePatientContext(client, 'patient-1')).rejects.toThrow(/pagination cycle/i);
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  test('rejects a cross-origin next link before sending authenticated traffic', async () => {
    const client = makeClient({ [EVERYTHING_URL]: { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: { resourceType: 'Patient', id: 'patient-1' } }], link: [{ relation: 'next', url: 'https://attacker.example/fhir/R4/Patient/patient-1/$everything' }] } });
    await expect(loadCompletePatientContext(client, 'patient-1')).rejects.toThrow(/cross-origin/i);
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['missing', { relation: 'next' }],
    ['blank', { relation: 'next', url: '   ' }],
  ])('rejects a %s next-link URL', async (_label, nextLink) => {
    const bundle = {
      resourceType: 'Bundle',
      type: 'searchset',
      entry: [{ resource: { resourceType: 'Patient', id: 'patient-1' } }],
      link: [nextLink],
    } as Bundle;
    const client = makeClient({ [EVERYTHING_URL]: bundle });

    await expect(loadCompletePatientContext(client, 'patient-1')).rejects.toThrow(/next link.*URL/i);
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  test('rejects multiple next links as ambiguous before fetching either one', async () => {
    const client = makeClient({
      [EVERYTHING_URL]: {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: [{ resource: { resourceType: 'Patient', id: 'patient-1' } }],
        link: [
          { relation: 'next', url: '?_cursor=page-2-a' },
          { relation: 'next', url: '?_cursor=page-2-b' },
        ],
      },
    });

    await expect(loadCompletePatientContext(client, 'patient-1')).rejects.toThrow(/multiple next links/i);
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['another patient', `${ORIGIN}/fhir/R4/Patient/patient-2/$everything?_cursor=2`],
    ['another path', `${ORIGIN}/fhir/R4/Observation?_cursor=2`],
  ])('rejects a same-origin next link targeting %s', async (_label, nextUrl) => {
    const client = makeClient({
      [EVERYTHING_URL]: {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: [{ resource: { resourceType: 'Patient', id: 'patient-1' } }],
        link: [{ relation: 'next', url: nextUrl }],
      },
      [nextUrl]: { resourceType: 'Bundle', type: 'searchset' },
    });

    await expect(loadCompletePatientContext(client, 'patient-1')).rejects.toThrow(/selected endpoint/i);
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  test.each(['?_cursor=page-2#results', '#same-page'])('rejects a fragment-bearing next link (%s)', async (nextUrl) => {
    const resolvedNextUrl = new URL(nextUrl, EVERYTHING_URL).toString();
    const client = makeClient({
      [EVERYTHING_URL]: {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: [{ resource: { resourceType: 'Patient', id: 'patient-1' } }],
        link: [{ relation: 'next', url: nextUrl }],
      },
      [resolvedNextUrl]: { resourceType: 'Bundle', type: 'searchset' },
    });

    await expect(loadCompletePatientContext(client, 'patient-1')).rejects.toThrow(/fragment/i);
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  test('rejects an unsupported pagination protocol', async () => {
    const client = makeClient({
      [EVERYTHING_URL]: {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: [{ resource: { resourceType: 'Patient', id: 'patient-1' } }],
        link: [{ relation: 'next', url: 'ftp://api.example.test/fhir/R4/Patient/patient-1/$everything?_cursor=2' }],
      },
    });

    await expect(loadCompletePatientContext(client, 'patient-1')).rejects.toThrow(/protocol/i);
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  test('rejects unique-cursor pagination that exceeds the page budget before fetching another page', async () => {
    const secondUrl = `${EVERYTHING_URL}?_cursor=page-2`;
    const thirdUrl = `${EVERYTHING_URL}?_cursor=page-3`;
    const client = makeClient({
      [EVERYTHING_URL]: {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: [{ resource: { resourceType: 'Patient', id: 'patient-1' } }],
        link: [{ relation: 'next', url: '?_cursor=page-2' }],
      },
      [secondUrl]: {
        resourceType: 'Bundle',
        type: 'searchset',
        link: [{ relation: 'next', url: '?_cursor=page-3' }],
      },
      [thirdUrl]: { resourceType: 'Bundle', type: 'searchset' },
    });

    await expect(loadCompletePatientContext(client, 'patient-1', { maxPages: 2 })).rejects.toThrow(/page limit/i);
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  test('rejects a new deduplicated resource that exceeds the retained-resource budget', async () => {
    const client = makeClient({
      [EVERYTHING_URL]: {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: [
          { resource: { resourceType: 'Patient', id: 'patient-1' } },
          { resource: { resourceType: 'Condition', id: 'condition-1', subject: { reference: 'Patient/patient-1' } } },
        ],
      },
    });

    await expect(loadCompletePatientContext(client, 'patient-1', { maxResources: 1 })).rejects.toThrow(
      /resource count limit/i
    );
  });

  test('rejects compact serialized FHIR resources that exceed the byte budget without exposing content', async () => {
    const client = makeClient({
      [EVERYTHING_URL]: {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: [{ resource: { resourceType: 'Patient', id: 'patient-1', name: [{ text: 'Sensitive Patient' }] } }],
      },
    });
    let thrown: unknown;

    try {
      await loadCompletePatientContext(client, 'patient-1', { maxSerializedResourceBytes: 1 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Complete patient context exceeded the serialized resource byte limit');
    expect((thrown as Error).message).not.toContain('Sensitive Patient');
  });

  test('rejects when an awaited page consumes the remaining loader deadline', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let requestSignal: AbortSignal | undefined;
    const client = makeClient(
      {
        [EVERYTHING_URL]: {
          resourceType: 'Bundle',
          type: 'searchset',
          entry: [{ resource: { resourceType: 'Patient', id: 'patient-1' } }],
        },
      },
      undefined,
      (options) => {
        requestSignal = options?.signal ?? undefined;
        now = 1_006;
      }
    );

    await expect(loadCompletePatientContext(client, 'patient-1', { deadlineMs: 5 })).rejects.toThrow(/deadline/i);
    expect(requestSignal).toBeInstanceOf(AbortSignal);
  });
});
