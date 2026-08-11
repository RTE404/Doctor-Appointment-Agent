// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { collectEncounterTypeTexts, validateEncounterTypeCoverage } from './specialty-corpus';

const temporaryDirectories: string[] = [];
function writeBundle(contents: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'specialty-corpus-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'bundle.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}
afterEach(() => temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe('specialty corpus audit', () => {
  test('collects distinct Encounter type text values', () => {
    const path = writeBundle({ entry: [
      { resource: { resourceType: 'Encounter', type: [{ text: 'Office Visit' }] } },
      { resource: { resourceType: 'Encounter', type: [{ text: 'Office Visit' }, { text: 'Emergency Encounter' }] } },
      { resource: { resourceType: 'Patient' } },
    ] });
    expect([...collectEncounterTypeTexts([path])].sort()).toStrictEqual(['Emergency Encounter', 'Office Visit']);
  });

  test('accepts the expected count when every type is mapped', () => {
    expect(() => validateEncounterTypeCoverage(
      new Set(['Office Visit', 'Emergency Encounter']),
      new Map([['Office Visit', 'General Practice'], ['Emergency Encounter', 'General Practice']]),
      2
    )).not.toThrow();
  });

  test('reports unexpected counts and uncovered types', () => {
    expect(() => validateEncounterTypeCoverage(
      new Set(['Office Visit', 'Unmapped Encounter']),
      new Map([['Office Visit', 'General Practice']]),
      49
    )).toThrow(/expected 49.*found 2.*Unmapped Encounter/i);
  });

  test('fails on malformed corpus JSON', () => {
    const directory = mkdtempSync(join(tmpdir(), 'specialty-corpus-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'broken.json');
    writeFileSync(path, '{');
    expect(() => collectEncounterTypeTexts([path])).toThrow();
  });
});
