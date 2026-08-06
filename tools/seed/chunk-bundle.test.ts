// tools/seed/chunk-bundle.test.ts
import { describe, expect, test } from 'vitest';
import type { Bundle } from '@medplum/fhirtypes';
import { splitForUpload, uploadPatientBundle } from './chunk-bundle';

// References are already resolved to plain, real form by this point
// (Task 6's transformBundle) — chunk-bundle.ts never sees a urn:uuid.
// Fixture resources are deliberately minimal (only the fields this suite exercises) —
// cast rather than fully satisfy @medplum/fhirtypes' per-resourceType interfaces.
const TRANSFORMED_BUNDLE = {
  resourceType: 'Bundle',
  type: 'transaction',
  entry: [
    { resource: { resourceType: 'Patient', id: 'patient-1' }, request: { method: 'PUT', url: 'Patient/patient-1' } },
    { resource: { resourceType: 'Organization', id: 'org-1' }, request: { method: 'PUT', url: 'Organization/org-1' } },
    { resource: { resourceType: 'Practitioner', id: 'pract-1' }, request: { method: 'PUT', url: 'Practitioner/pract-1' } },
    {
      resource: { resourceType: 'PractitionerRole', id: 'role-1', practitioner: { reference: 'Practitioner/pract-1' } },
      request: { method: 'PUT', url: 'PractitionerRole/role-1' },
    },
    {
      resource: { resourceType: 'Encounter', id: 'enc-1', subject: { reference: 'Patient/patient-1' }, serviceProvider: { reference: 'Organization/org-1' } },
      request: { method: 'PUT', url: 'Encounter/enc-1' },
    },
    {
      resource: { resourceType: 'Condition', id: 'cond-1', subject: { reference: 'Patient/patient-1' } },
      request: { method: 'PUT', url: 'Condition/cond-1' },
    },
  ],
} as unknown as Bundle;

describe('splitForUpload', () => {
  test('separates identity resources (including PractitionerRole) from clinical resources', () => {
    const { identityBundle, clinicalChunks } = splitForUpload(TRANSFORMED_BUNDLE);

    expect(identityBundle.type).toBe('transaction');
    // PractitionerRole must be in the identity wave — an earlier version of
    // this split silently dropped it (matched neither IDENTITY_TYPES nor
    // CLINICAL_TYPES), and a full-corpus scan found 2,484 Practitioner
    // occurrences whose corresponding generated roles would all be lost.
    expect(identityBundle.entry?.map((e) => e.resource?.resourceType)).toStrictEqual(['Patient', 'Organization', 'Practitioner', 'PractitionerRole']);
    expect(clinicalChunks).toHaveLength(1);
    expect(clinicalChunks[0].type).toBe('batch');
    expect(clinicalChunks[0].entry?.map((e) => e.resource?.resourceType)).toStrictEqual(['Encounter', 'Condition']);
  });

  test('splits clinical resources into multiple chunks once past the per-chunk cap', () => {
    const manyEntries = Array.from({ length: 650 }, (_, i) => ({
      resource: { resourceType: 'Condition' as const, id: `cond-${i}`, subject: { reference: 'Patient/patient-1' } },
      request: { method: 'PUT' as const, url: `Condition/cond-${i}` },
    }));
    const bigBundle = { resourceType: 'Bundle', type: 'transaction', entry: [TRANSFORMED_BUNDLE.entry![0], ...manyEntries] } as unknown as Bundle;

    const { clinicalChunks } = splitForUpload(bigBundle);

    expect(clinicalChunks.length).toBeGreaterThan(1);
    expect(clinicalChunks.every((c) => (c.entry?.length ?? 0) <= 300)).toBe(true);
  });

  test("'full' mode's extra resource types (outside the 7-type/PractitionerRole allowlists) land in a third chunk group, not dropped", () => {
    const bundleWithExtra = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [...TRANSFORMED_BUNDLE.entry!, { resource: { resourceType: 'Observation', id: 'obs-1' }, request: { method: 'PUT', url: 'Observation/obs-1' } }],
    } as unknown as Bundle;

    const { otherChunks } = splitForUpload(bundleWithExtra);

    expect(otherChunks.length).toBeGreaterThan(0);
    expect(otherChunks[0].entry?.map((e) => e.resource?.resourceType)).toContain('Observation');
  });
});

describe('uploadPatientBundle', () => {
  test('uploads the identity bundle first, then each clinical chunk — no rewriting step, references are already resolved', async () => {
    const calls: Bundle[] = [];
    const medplum = {
      executeBatch: async (b: Bundle) => {
        calls.push(b);
        return b.type === 'transaction'
          ? ({ resourceType: 'Bundle', type: 'transaction-response', entry: (b.entry ?? []).map(() => ({ response: { status: '201' } })) } as Bundle)
          : ({ resourceType: 'Bundle', type: 'batch-response', entry: (b.entry ?? []).map(() => ({ response: { status: '201' } })) } as Bundle);
      },
    } as any;

    await uploadPatientBundle(medplum, TRANSFORMED_BUNDLE);

    expect(calls).toHaveLength(2); // one identity transaction, one clinical chunk
    expect(calls[0].type).toBe('transaction');
    expect(calls[0].entry?.map((e) => e.resource?.resourceType)).toContain('PractitionerRole');
    expect(calls[1].type).toBe('batch');
    const encounter = calls[1].entry?.find((e) => e.resource?.resourceType === 'Encounter')?.resource as any;
    expect(encounter.subject.reference).toBe('Patient/patient-1'); // already resolved, untouched
  });
});
