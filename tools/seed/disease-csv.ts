import { readFileSync } from 'fs';

/**
 * Parses Disease_Description.csv, returning disease names in file order.
 * The sole reader of this file — tier-2's SPECIALTY_MAP (specialty-resolver.ts)
 * zips this list against a hand-authored specialty table.
 */
export function parseDiseaseDescriptions(csvPath: string): string[] {
  const raw = readFileSync(csvPath, 'utf-8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const [header, ...rows] = lines;
  const columns = header.split(',');
  const diseaseColumnIndex = columns.findIndex((c) => c.trim().toLowerCase() === 'disease');
  if (diseaseColumnIndex === -1) {
    throw new Error(`Expected a "Disease" column in ${csvPath}, got: ${header}`);
  }
  return rows.map((row) => row.split(',')[diseaseColumnIndex].trim());
}
