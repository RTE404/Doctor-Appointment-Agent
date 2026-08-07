// tools/seed/specialty-resolver.test.ts
import { describe, expect, test } from 'vitest';
import { resolveSpecialty, ENCOUNTER_TYPE_SPECIALTY_MAP, SPECIALTY_NUCC_CODES, allPossibleSpecialtyLabels } from './specialty-resolver';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// ESM has no __dirname; this is the standard replacement (matches index.ts's Task 9 fix).
const __dirname = dirname(fileURLToPath(import.meta.url));

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

describe('ENCOUNTER_TYPE_SPECIALTY_MAP completeness', () => {
  test('covers every distinct Encounter.type[].text value in the real corpus', () => {
    const files = readdirSync(join(__dirname, '../../fhir')).filter((f) => f.endsWith('.json'));
    const seen = new Set<string>();
    for (const f of files) {
      const bundle = JSON.parse(readFileSync(join(__dirname, '../../fhir', f), 'utf-8'));
      for (const entry of bundle.entry ?? []) {
        const r = entry.resource;
        if (r?.resourceType === 'Encounter') {
          for (const t of r.type ?? []) {
            if (t.text) seen.add(t.text);
          }
        }
      }
    }
    expect(seen.size).toBe(49);
    const uncovered = [...seen].filter((text) => !ENCOUNTER_TYPE_SPECIALTY_MAP.has(text));
    expect(uncovered).toStrictEqual([]);
  }, 60_000);
});

describe('SPECIALTY_NUCC_CODES completeness', () => {
  test('has a real NUCC code for every specialty label the resolver can produce', () => {
    for (const label of allPossibleSpecialtyLabels()) {
      expect(SPECIALTY_NUCC_CODES[label], `missing NUCC code for "${label}"`).toBeDefined();
    }
  });
});
