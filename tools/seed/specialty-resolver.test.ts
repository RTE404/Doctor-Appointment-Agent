// tools/seed/specialty-resolver.test.ts
import { describe, expect, test } from 'vitest';
import { resolveSpecialty, SPECIALTY_NUCC_CODES, allPossibleSpecialtyLabels } from './specialty-resolver';

describe('resolveSpecialty', () => {
  test('tier 1: substring-matches reasonText against a known disease name', () => {
    // 'Bronchial Asthma' is a real row in Disease_Description.csv (-> Pulmonology);
    // the reason text is a realistic superstring containing it verbatim.
    expect(resolveSpecialty(['Patient reports symptoms of Bronchial Asthma'], [])).toBe('Pulmonology');
  });

  test('tier 2: falls back to encounter type when no reason text matches', () => {
    expect(resolveSpecialty([], ['Well child visit'])).toBe('Pediatrics');
  });

  test('tier 3: falls back to General Practice when nothing matches', () => {
    expect(resolveSpecialty(['unrelated free text'], ['totally unknown kind'])).toBe('General Practice');
  });

  test('tier 1 takes priority over tier 2 when both could match', () => {
    expect(resolveSpecialty(['Patient reports symptoms of Bronchial Asthma'], ['Well child visit'])).toBe('Pulmonology');
  });
});

describe('SPECIALTY_NUCC_CODES completeness', () => {
  test('has a real NUCC code for every specialty label the resolver can produce', () => {
    for (const label of allPossibleSpecialtyLabels()) {
      expect(SPECIALTY_NUCC_CODES[label], `missing NUCC code for "${label}"`).toBeDefined();
    }
  });
});
