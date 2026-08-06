import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'vitest';
import { scanPractitionerSpecialties } from './pass1-scan';

function writeBundle(dir: string, name: string, entries: unknown[]): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, JSON.stringify({ resourceType: 'Bundle', type: 'transaction', entry: entries }));
  return filePath;
}

describe('scanPractitionerSpecialties', () => {
  test('resolves a practitioner to a specialty via majority vote across encounters', () => {
    // Reference shape matches the REAL corpus, verified directly against
    // fhir/*.json: Encounter.participant[0].individual.reference is a bare
    // urn:uuid:{uuid} — the exact same uuid as the Practitioner resource's
    // own `id` (Synthea sets Practitioner.id to the uuid portion of its own
    // fullUrl) — never a `Practitioner?identifier=...` conditional reference.
    const dir = mkdtempSync(join(tmpdir(), 'pass1-'));
    const file = writeBundle(dir, 'bundle1.json', [
      {
        resource: {
          resourceType: 'Practitioner',
          id: '0000016d-3a85-4cca-0000-000000000122',
        },
      },
      {
        resource: {
          resourceType: 'Encounter',
          id: 'enc-1',
          participant: [{ individual: { reference: 'urn:uuid:0000016d-3a85-4cca-0000-000000000122' } }],
          reasonCode: [{ coding: [{ display: 'Patient reports symptoms of Bronchial Asthma' }] }],
        },
      },
      {
        resource: {
          resourceType: 'Encounter',
          id: 'enc-2',
          participant: [{ individual: { reference: 'urn:uuid:0000016d-3a85-4cca-0000-000000000122' } }],
          reasonCode: [{ coding: [{ display: 'Patient reports symptoms of Bronchial Asthma' }] }],
        },
      },
    ]);

    const result = scanPractitionerSpecialties([file]);

    expect(result.get('0000016d-3a85-4cca-0000-000000000122')).toBe('Pulmonology');
  });

  test('asserts NPI uniqueness and throws naming the collision', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pass1-'));
    const file = writeBundle(dir, 'bundle2.json', [
      {
        resource: {
          resourceType: 'Practitioner',
          id: 'stable-id-a',
          identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '999' }],
        },
      },
      {
        resource: {
          resourceType: 'Practitioner',
          id: 'stable-id-b',
          identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '999' }],
        },
      },
    ]);

    expect(() => scanPractitionerSpecialties([file])).toThrow(/999/);
  });
});
