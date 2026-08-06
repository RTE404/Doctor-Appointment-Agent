// tools/seed/pass2-transform.test.ts
import { describe, expect, test } from 'vitest';
import type { Bundle } from '@medplum/fhirtypes';
import { transformBundle } from './pass2-transform';

const SYNTHEA_ID = 'https://synthea.mitre.org/identifier';

describe('transformBundle', () => {
  test("filters to the 7 app-read resource types in 'slim' mode", () => {
    // Fixture resources are deliberately minimal (only the fields this suite exercises) —
    // cast rather than fully satisfy @medplum/fhirtypes' per-resourceType interfaces.
    const bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        { resource: { resourceType: 'Patient', id: 'p1' } },
        { resource: { resourceType: 'Observation', id: 'o1' } },
        { resource: { resourceType: 'Claim', id: 'c1' } },
      ],
    } as unknown as Bundle;

    const result = transformBundle(bundle, new Map(), 'slim');

    const types = result.entry?.map((e) => e.resource?.resourceType);
    expect(types).toStrictEqual(['Patient']);
  });

  test("keeps every resource type in 'full' mode", () => {
    const bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        { resource: { resourceType: 'Patient', id: 'p1' } },
        { resource: { resourceType: 'Observation', id: 'o1' } },
      ],
    } as unknown as Bundle;

    const result = transformBundle(bundle, new Map(), 'full');

    const types = result.entry?.map((e) => e.resource?.resourceType);
    expect(types).toContain('Observation');
  });

  test('attaches a stable-id identifier and conditionally-creates every kept resource, dropping the source id', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        { resource: { resourceType: 'Patient', id: 'patient-1' }, request: { method: 'POST', url: 'Patient' } },
        {
          resource: { resourceType: 'Condition', id: 'cond-1', subject: { reference: 'urn:uuid:patient-1' } },
          request: { method: 'POST', url: 'Condition' },
        },
      ],
    };

    const result = transformBundle(bundle, new Map(), 'slim');

    const patientEntry = result.entry?.find((e) => e.resource?.resourceType === 'Patient');
    expect((patientEntry?.resource as any).identifier).toContainEqual({ system: SYNTHEA_ID, value: 'patient-1' });
    // No id is sent: a non-super-admin POST create has its id silently
    // replaced by the server, so shipping the old Synthea id here would be
    // misleading about what actually lands.
    expect((patientEntry?.resource as any).id).toBeUndefined();
    expect(patientEntry?.request).toStrictEqual({
      method: 'POST',
      url: 'Patient',
      ifNoneExist: `identifier=${SYNTHEA_ID}|patient-1`,
    });

    const conditionEntry = result.entry?.find((e) => e.resource?.resourceType === 'Condition');
    expect((conditionEntry?.resource as any).identifier).toContainEqual({ system: SYNTHEA_ID, value: 'cond-1' });
    expect(conditionEntry?.request).toStrictEqual({
      method: 'POST',
      url: 'Condition',
      ifNoneExist: `identifier=${SYNTHEA_ID}|cond-1`,
    });
    // The referenced Patient's real id isn't known at transform time (it's
    // server-assigned on conditional-create), so the reference is left as a
    // conditional reference — Medplum resolves it by search when this
    // Condition is written, which requires the Patient to already exist.
    expect((conditionEntry?.resource as any).subject.reference).toBe(`Patient?identifier=${SYNTHEA_ID}|patient-1`);
  });

  test('resolves clinical-to-clinical references (Condition.encounter, MedicationRequest.encounter/requester/reasonReference) — the real corpus has 26,268 of these', () => {
    const bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        { resource: { resourceType: 'Patient', id: 'patient-1' }, request: { method: 'POST', url: 'Patient' } },
        { resource: { resourceType: 'Practitioner', id: 'pract-1' }, request: { method: 'POST', url: 'Practitioner' } },
        {
          resource: { resourceType: 'Encounter', id: 'enc-1', subject: { reference: 'urn:uuid:patient-1' } },
          request: { method: 'POST', url: 'Encounter' },
        },
        {
          resource: {
            resourceType: 'Condition',
            id: 'cond-1',
            subject: { reference: 'urn:uuid:patient-1' },
            encounter: { reference: 'urn:uuid:enc-1' },
          },
          request: { method: 'POST', url: 'Condition' },
        },
        {
          resource: {
            resourceType: 'MedicationRequest',
            id: 'med-1',
            subject: { reference: 'urn:uuid:patient-1' },
            encounter: { reference: 'urn:uuid:enc-1' },
            requester: { reference: 'urn:uuid:pract-1' },
            reasonReference: [{ reference: 'urn:uuid:cond-1' }],
          },
          request: { method: 'POST', url: 'MedicationRequest' },
        },
      ],
    } as unknown as Bundle;

    const result = transformBundle(bundle, new Map(), 'slim');

    const condition = result.entry?.find((e) => e.resource?.resourceType === 'Condition')?.resource as any;
    expect(condition.encounter.reference).toBe(`Encounter?identifier=${SYNTHEA_ID}|enc-1`);

    const medReq = result.entry?.find((e) => e.resource?.resourceType === 'MedicationRequest')?.resource as any;
    expect(medReq.encounter.reference).toBe(`Encounter?identifier=${SYNTHEA_ID}|enc-1`);
    expect(medReq.requester.reference).toBe(`Practitioner?identifier=${SYNTHEA_ID}|pract-1`);
    expect(medReq.reasonReference[0].reference).toBe(`Condition?identifier=${SYNTHEA_ID}|cond-1`);
  });

  test('conditionally-creates Practitioner while retaining its source identifier', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [{ resource: { resourceType: 'Practitioner', id: 'stable-id-1' }, request: { method: 'POST', url: 'Practitioner' } }],
    };

    const result = transformBundle(bundle, new Map([['stable-id-1', 'Cardiology']]), 'slim');

    const practitionerEntry = result.entry?.find((e) => e.resource?.resourceType === 'Practitioner');
    expect(practitionerEntry?.request).toStrictEqual({
      method: 'POST',
      url: 'Practitioner',
      ifNoneExist: `identifier=${SYNTHEA_ID}|stable-id-1`,
    });
    expect((practitionerEntry?.resource as any).id).toBeUndefined();
    expect((practitionerEntry?.resource as any).identifier).toContainEqual({ system: SYNTHEA_ID, value: 'stable-id-1' });
  });

  test('injects the resolved specialty as a real NUCC code (not the label) on PractitionerRole, plus qualification display copy and timezone', () => {
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [{ resource: { resourceType: 'Practitioner', id: 'stable-id-1' }, request: { method: 'POST', url: 'Practitioner' } }],
    };

    const result = transformBundle(bundle, new Map([['stable-id-1', 'Cardiology']]), 'slim');

    const practitioner = result.entry?.find((e) => e.resource?.resourceType === 'Practitioner')?.resource as any;
    expect(practitioner.qualification[0].code.text).toBe('Cardiology');
    expect(practitioner.extension).toContainEqual({
      url: 'http://hl7.org/fhir/StructureDefinition/timezone',
      valueCode: expect.any(String),
    });

    const role = result.entry?.find((e) => e.resource?.resourceType === 'PractitionerRole')?.resource as any;
    expect(role.specialty[0].coding[0].code).toBe('207RC0000X'); // real NUCC code for Cardiology, not the label
    expect(role.specialty[0].coding[0].display).toBe('Cardiology');
    expect(role.practitioner.reference).toBe(`Practitioner?identifier=${SYNTHEA_ID}|stable-id-1`);
    expect(role.id).toBeUndefined();
    expect(role.identifier).toContainEqual({ system: SYNTHEA_ID, value: 'stable-id-1-role' });
    const roleEntry = result.entry?.find((e) => e.resource?.resourceType === 'PractitionerRole');
    expect(roleEntry?.request).toStrictEqual({
      method: 'POST',
      url: 'PractitionerRole',
      ifNoneExist: `identifier=${SYNTHEA_ID}|stable-id-1-role`,
    });
  });
});
