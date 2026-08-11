// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'vitest';
import {
  formatAppointmentDateTime,
  getAppointmentSlotReference,
  getPractitionerNpi,
  getPractitionerReference,
  getPractitionerSpecialty,
  getScheduleTimeZone,
} from './bookingConfirmation';

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

  test('resolves the booked slot and schedule timezone', () => {
    expect(
      getAppointmentSlotReference({
        resourceType: 'Appointment',
        status: 'booked',
        participant: [],
        slot: [{ reference: 'Slot/slot-1' }],
      })
    ).toBe('Slot/slot-1');

    expect(
      getScheduleTimeZone({
        resourceType: 'Schedule',
        actor: [{ reference: 'Practitioner/pr1' }],
        extension: [
          {
            url: 'https://medplum.com/fhir/StructureDefinition/SchedulingParameters',
            extension: [{ url: 'timezone', valueCode: 'America/New_York' }],
          },
        ],
      })
    ).toBe('America/New_York');
  });

  test('formats the booked time in the provider schedule timezone', () => {
    expect(
      formatAppointmentDateTime(
        '2026-08-11T13:00:00.000Z',
        '2026-08-11T13:30:00.000Z',
        'America/New_York'
      )
    ).toEqual({
      date: 'Tuesday, August 11, 2026',
      time: '9:00 AM–9:30 AM',
    });
  });

  test('extracts the practitioner specialty label', () => {
    expect(
      getPractitionerSpecialty([
        {
          resourceType: 'PractitionerRole',
          specialty: [{ coding: [{ system: 'http://nucc.org/provider-taxonomy', code: '208D00000X', display: 'General Practice' }] }],
        },
      ])
    ).toBe('General Practice');
  });
});
