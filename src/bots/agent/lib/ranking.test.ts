// src/bots/agent/lib/ranking.test.ts
import { describe, expect, test } from 'vitest';
import { rankCandidates } from './ranking';
import type { DoctorCandidate } from './ranking';

function candidate(npi: string, postalCode: string): DoctorCandidate {
  return {
    npi,
    firstName: 'Test',
    lastName: npi,
    nuccCode: '207RC0000X',
    nuccDisplay: 'Cardiovascular Disease Physician',
    address: { postalCode },
  };
}

describe('rankCandidates', () => {
  test('sorts ascending by distance from the patient', () => {
    const patientCoords = { lat: 40.7128, lng: -74.006 }; // NYC
    const candidates = [candidate('far', '90001'), candidate('near', '10002')]; // LA, NYC-adjacent

    const result = rankCandidates(patientCoords, candidates);

    expect(result.map((c) => c.npi)).toStrictEqual(['near', 'far']);
    expect(result[0].distanceMiles).toBeLessThan(result[1].distanceMiles as number);
  });

  test('candidates with unresolvable coordinates sort last, not dropped', () => {
    const patientCoords = { lat: 40.7128, lng: -74.006 };
    const candidates = [candidate('unresolvable', '00000'), candidate('resolvable', '10002')];

    const result = rankCandidates(patientCoords, candidates);

    expect(result).toHaveLength(2);
    expect(result[result.length - 1].npi).toBe('unresolvable');
    expect(result[result.length - 1].distanceMiles).toBeUndefined();
  });

  test('undefined patientCoords leaves every candidate with undefined distance, order preserved', () => {
    const candidates = [candidate('a', '10002'), candidate('b', '90001')];

    const result = rankCandidates(undefined, candidates);

    expect(result.every((c) => c.distanceMiles === undefined)).toBe(true);
    expect(result.map((c) => c.npi)).toStrictEqual(['a', 'b']);
  });
});
