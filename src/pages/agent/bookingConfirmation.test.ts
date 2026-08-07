// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'vitest';
import { getPractitionerNpi, getPractitionerReference } from './bookingConfirmation';

describe('booking confirmation resource extraction', () => {
  test('finds the practitioner participant without depending on participant order', () => {
    expect(
      getPractitionerReference({
        resourceType: 'Appointment',
        status: 'booked',
        participant: [
          { actor: { reference: 'Patient/p1' }, status: 'accepted' },
          { actor: { reference: 'Practitioner/pr1' }, status: 'accepted' },
        ],
      })
    ).toBe('Practitioner/pr1');
  });

  test('returns only the US NPI identifier', () => {
    expect(
      getPractitionerNpi({
        resourceType: 'Practitioner',
        identifier: [
          { system: 'urn:other', value: 'wrong' },
          { system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' },
        ],
      })
    ).toBe('1234567890');
  });

  test('returns undefined when the required resource data is absent', () => {
    expect(getPractitionerReference({ resourceType: 'Appointment', status: 'booked', participant: [] })).toBeUndefined();
    expect(getPractitionerNpi({ resourceType: 'Practitioner' })).toBeUndefined();
  });
});
