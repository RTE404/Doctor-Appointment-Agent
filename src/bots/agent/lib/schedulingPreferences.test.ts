import { describe, expect, test } from 'vitest';
import { normalizeSchedulingPreferences, timeOfDayAt } from './schedulingPreferences';

describe('normalizeSchedulingPreferences', () => {
  test('accepts only the three approved preference fields', () => {
    expect(
      normalizeSchedulingPreferences({
        timeOfDay: 'morning',
        preferPreviousDoctor: true,
        preferNearby: true,
        unsupported: 'ignored',
      })
    ).toEqual({ timeOfDay: 'morning', preferPreviousDoctor: true, preferNearby: true });
  });

  test('fails closed to unset and false for malformed model output', () => {
    expect(normalizeSchedulingPreferences({ timeOfDay: 'night', preferPreviousDoctor: 'yes' })).toEqual({
      timeOfDay: undefined,
      preferPreviousDoctor: false,
      preferNearby: false,
    });
  });
});

describe('timeOfDayAt', () => {
  test('uses the doctor schedule timezone', () => {
    expect(timeOfDayAt('2026-08-12T13:00:00Z', 'America/New_York')).toBe('morning');
    expect(timeOfDayAt('2026-08-12T18:00:00Z', 'America/New_York')).toBe('afternoon');
    expect(timeOfDayAt('2026-08-12T22:00:00Z', 'America/New_York')).toBe('evening');
  });
});
