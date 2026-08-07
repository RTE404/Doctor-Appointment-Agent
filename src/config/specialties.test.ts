// src/config/specialties.test.ts
import { describe, expect, test } from 'vitest';
import { SPECIALTY_TABLE, normalizeLlmSpecialty } from './specialties';

describe('SPECIALTY_TABLE', () => {
  test('every entry has a label, nuccCode, nuccDisplay, and nppesTaxonomyDescription', () => {
    for (const entry of SPECIALTY_TABLE) {
      expect(entry.label).toBeTruthy();
      expect(entry.nuccCode).toBeTruthy();
      expect(entry.nuccDisplay).toBeTruthy();
      expect(entry.nppesTaxonomyDescription).toBeTruthy();
    }
  });

  test('no duplicate labels', () => {
    const labels = SPECIALTY_TABLE.map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('normalizeLlmSpecialty', () => {
  test('matches an exact label case-insensitively', () => {
    expect(normalizeLlmSpecialty('cardiology')?.label).toBe('Cardiology');
  });

  test('matches a known synonym', () => {
    expect(normalizeLlmSpecialty('heart doctor')?.label).toBe('Cardiology');
    expect(normalizeLlmSpecialty('skin doctor')?.label).toBe('Dermatology');
    expect(normalizeLlmSpecialty('gp')?.label).toBe('General Practice');
  });

  test('returns undefined for no match, never guesses', () => {
    expect(normalizeLlmSpecialty('quantum flux specialist')).toBeUndefined();
  });
});
