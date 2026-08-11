import { readFileSync } from 'node:fs';

interface BundleLike {
  entry?: Array<{ resource?: { resourceType?: string; type?: Array<{ text?: string }> } }>;
}

export function collectEncounterTypeTexts(bundlePaths: string[]): Set<string> {
  const encounterTypes = new Set<string>();
  for (const path of bundlePaths) {
    const bundle = JSON.parse(readFileSync(path, 'utf8')) as BundleLike;
    for (const entry of bundle.entry ?? []) {
      if (entry.resource?.resourceType !== 'Encounter') continue;
      for (const type of entry.resource.type ?? []) if (type.text) encounterTypes.add(type.text);
    }
  }
  return encounterTypes;
}

export function validateEncounterTypeCoverage(
  encounterTypes: ReadonlySet<string>,
  mapping: ReadonlyMap<string, string>,
  expectedCount: number
): void {
  const uncovered = [...encounterTypes].filter((text) => !mapping.has(text)).sort();
  if (encounterTypes.size !== expectedCount || uncovered.length > 0) {
    throw new Error(`Expected ${expectedCount} distinct encounter types but found ${encounterTypes.size}; uncovered: ${uncovered.length ? uncovered.join(', ') : 'none'}`);
  }
}
