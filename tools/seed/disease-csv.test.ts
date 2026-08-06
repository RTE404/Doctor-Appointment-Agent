import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, test } from 'vitest';
import { parseDiseaseDescriptions } from './disease-csv';

// ESM has no __dirname; this is the standard replacement (matches index.ts's Task 9 fix).
const __dirname = dirname(fileURLToPath(import.meta.url));

describe('parseDiseaseDescriptions', () => {
  test('returns disease names in file order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'disease-csv-'));
    const csvPath = join(dir, 'diseases.csv');
    writeFileSync(csvPath, 'Disease,Description\nAsthma,Some description\nDiabetes,Another description\n');

    const result = parseDiseaseDescriptions(csvPath);

    expect(result).toStrictEqual(['Asthma', 'Diabetes']);
  });

  test('reads the real Disease_Description.csv and returns exactly 41 names', () => {
    const result = parseDiseaseDescriptions(join(__dirname, '../../Disease_Description.csv'));

    expect(result).toHaveLength(41);
    expect(new Set(result).size).toBe(41); // no duplicates
  });
});
