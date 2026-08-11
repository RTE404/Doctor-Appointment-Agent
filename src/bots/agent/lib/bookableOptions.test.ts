import { describe, expect, test } from 'vitest';
import { rankBookableOptions } from './bookableOptions';
import type { BookableOption } from './bookableOptions';

function option(
  id: string,
  start: string,
  previousDoctor: boolean,
  distanceMiles?: number,
  npi: string = `npi-${id}`
): BookableOption {
  return {
    id,
    npi,
    practitionerId: `practitioner-${id}`,
    scheduleId: `schedule-${id}`,
    doctorName: `Dr. ${id}`,
    start,
    end: new Date(Date.parse(start) + 30 * 60 * 1000).toISOString(),
    timeZone: 'America/New_York',
    previousDoctor,
    distanceMiles,
  };
}

describe('rankBookableOptions', () => {
  test('uses time, previous doctor, distance, and earliest start in that order', () => {
    const options = [
      option('afternoon-previous-near', '2026-08-12T18:00:00Z', true, 1),
      option('morning-new-near', '2026-08-12T13:00:00Z', false, 1),
      option('morning-previous-far', '2026-08-12T14:00:00Z', true, 20),
      option('morning-previous-near', '2026-08-12T15:00:00Z', true, 2),
    ];

    expect(
      rankBookableOptions(options, {
        timeOfDay: 'morning',
        preferPreviousDoctor: true,
        preferNearby: true,
      }).map((item) => item.id)
    ).toEqual(['morning-previous-near', 'morning-previous-far', 'morning-new-near']);
  });

  test('ignores distance when proximity was not requested', () => {
    const fartherEarlier = option('farther-earlier', '2026-08-12T13:00:00Z', false, 20);
    const nearerLater = option('nearer-later', '2026-08-12T14:00:00Z', false, 1);

    expect(
      rankBookableOptions([nearerLater, fartherEarlier], {
        preferPreviousDoctor: false,
        preferNearby: false,
      }).map((item) => item.id)
    ).toEqual(['farther-earlier', 'nearer-later']);
  });

  test('sorts unknown distance after known distance when proximity was requested', () => {
    const unknown = option('unknown', '2026-08-12T13:00:00Z', false);
    const known = option('known', '2026-08-12T14:00:00Z', false, 8);

    expect(
      rankBookableOptions([unknown, known], {
        preferPreviousDoctor: false,
        preferNearby: true,
      }).map((item) => item.id)
    ).toEqual(['known', 'unknown']);
  });

  test('returns at most three options by default without mutating input', () => {
    const input = [
      option('four', '2026-08-12T16:00:00Z', false),
      option('one', '2026-08-12T13:00:00Z', false),
      option('three', '2026-08-12T15:00:00Z', false),
      option('two', '2026-08-12T14:00:00Z', false),
    ];

    expect(
      rankBookableOptions(input, { preferPreviousDoctor: false, preferNearby: false }).map((item) => item.id)
    ).toEqual(['one', 'two', 'three']);
    expect(input.map((item) => item.id)).toEqual(['four', 'one', 'three', 'two']);
  });

  test('returns only the best-ranked slot for each distinct provider', () => {
    const input = [
      option('doctor-one-0900', '2026-08-12T13:00:00Z', true, 1, 'npi-doctor-one'),
      option('doctor-one-0930', '2026-08-12T13:30:00Z', true, 1, 'npi-doctor-one'),
      option('doctor-one-1000', '2026-08-12T14:00:00Z', true, 1, 'npi-doctor-one'),
      option('doctor-two-1030', '2026-08-12T14:30:00Z', false, 2, 'npi-doctor-two'),
      option('doctor-three-1100', '2026-08-12T15:00:00Z', false, 3, 'npi-doctor-three'),
    ];

    expect(
      rankBookableOptions(input, {
        timeOfDay: 'morning',
        preferPreviousDoctor: true,
        preferNearby: true,
      }).map((item) => item.id)
    ).toEqual(['doctor-one-0900', 'doctor-two-1030', 'doctor-three-1100']);
  });
});
