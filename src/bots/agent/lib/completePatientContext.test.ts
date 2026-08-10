import type { MedplumClient } from '@medplum/core';
import type { Bundle, Patient } from '@medplum/fhirtypes';
import { describe, expect, test, vi } from 'vitest';
import { loadCompletePatientContext } from './completePatientContext';

const ORIGIN = 'https://api.example.test';
const EVERYTHING_URL = `${ORIGIN}/fhir/R4/Patient/patient-1/$everything`;

function makeClient(pages: Record<string, Bundle>, fallbackPatient?: Patient): MedplumClient {
  return {
    fhirUrl: (...path: string[]) => new URL(`/fhir/R4/${path.join('/')}`, ORIGIN),
    get: vi.fn(async (url: URL | string) => {
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
    expect(client.get).toHaveBeenNthCalledWith(1, EVERYTHING_URL, { cache: 'no-cache' });
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

  test('reads and inserts the focal Patient when the operation omits it, and excludes another Patient', async () => {
    const focalPatient: Patient = { resourceType: 'Patient', id: 'patient-1', name: [{ given: ['Asha'], family: 'Rao' }] };
    const client = makeClient({ [EVERYTHING_URL]: { resourceType: 'Bundle', type: 'searchset', entry: [
      { resource: { resourceType: 'Patient', id: 'patient-2' } }, { resource: { resourceType: 'AllergyIntolerance', id: 'allergy-1', patient: { reference: 'Patient/patient-1' }, code: { text: 'Peanuts' } } },
    ] } }, focalPatient);
    const context = await loadCompletePatientContext(client, 'patient-1');
    expect(context.patient).toStrictEqual(focalPatient);
    expect(context.resources.filter((resource) => resource.resourceType === 'Patient')).toStrictEqual([focalPatient]);
  });

  test('fails closed when a next link repeats a page', async () => {
    const client = makeClient({ [EVERYTHING_URL]: { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: { resourceType: 'Patient', id: 'patient-1' } }], link: [{ relation: 'next', url: EVERYTHING_URL }] } });
    await expect(loadCompletePatientContext(client, 'patient-1')).rejects.toThrow(/pagination cycle/i);
  });

  test('rejects a cross-origin next link before sending authenticated traffic', async () => {
    const client = makeClient({ [EVERYTHING_URL]: { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: { resourceType: 'Patient', id: 'patient-1' } }], link: [{ relation: 'next', url: 'https://attacker.example/fhir/R4/Patient/patient-1/$everything' }] } });
    await expect(loadCompletePatientContext(client, 'patient-1')).rejects.toThrow(/cross-origin/i);
  });
});
