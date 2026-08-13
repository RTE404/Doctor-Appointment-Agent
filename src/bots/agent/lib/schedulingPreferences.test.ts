import { describe, expect, test } from 'vitest';
import { timeOfDayAt } from './schedulingPreferences';

describe('timeOfDayAt', () => {
  test('uses the doctor schedule timezone', () => {
    expect(timeOfDayAt('2026-08-12T13:00:00Z', 'America/New_York')).toBe('morning');
    expect(timeOfDayAt('2026-08-12T18:00:00Z', 'America/New_York')).toBe('afternoon');
    expect(timeOfDayAt('2026-08-12T22:00:00Z', 'America/New_York')).toBe('evening');
  });
});
