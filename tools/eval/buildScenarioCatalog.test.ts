import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildScenarioCatalog, serializeScenarioCatalog } from './buildScenarioCatalog';
import { validateScenarioCatalog } from './loadScenarios';
import type { EvalCategory, EvalSafetyGate } from './types';

const expectedCounts: Record<EvalCategory, number> = {
  'routing-clarification': 40,
  'preference-ranking': 25,
  'grounding-tampering': 20,
  'availability-dependency': 20,
  'confirmation-session': 15,
};

describe('buildScenarioCatalog', () => {
  it('builds exactly 120 unique scenarios with the approved category mix', () => {
    const catalog = validateScenarioCatalog(buildScenarioCatalog());
    const counts = Object.fromEntries(
      Object.keys(expectedCounts).map((category) => [
        category,
        catalog.scenarios.filter((scenario) => scenario.category === category).length,
      ])
    );

    expect(catalog.scenarios).toHaveLength(120);
    expect(new Set(catalog.scenarios.map((scenario) => scenario.id)).size).toBe(120);
    expect(counts).toEqual(expectedCounts);
  });

  it('marks exactly the 40 routing scenarios as model eligible', () => {
    const scenarios = buildScenarioCatalog().scenarios;
    const eligible = scenarios.filter((scenario) => scenario.modelEligible);

    expect(eligible).toHaveLength(40);
    expect(eligible.every((scenario) => scenario.category === 'routing-clarification')).toBe(true);
  });

  it('uses multiple meaningful message phrasings in every routing family', () => {
    const routing = buildScenarioCatalog().scenarios.filter(
      (scenario) => scenario.category === 'routing-clarification'
    );
    const families = new Map<string, Set<string>>();
    for (const scenario of routing) {
      const family = scenario.id.split('-')[1];
      const messages = families.get(family) ?? new Set<string>();
      messages.add(scenario.patientMessage);
      families.set(family, messages);
    }

    expect(families.size).toBe(10);
    expect([...families.values()].every((messages) => messages.size >= 2)).toBe(true);
  });

  it('covers every named safety gate', () => {
    const gates = new Set(
      buildScenarioCatalog().scenarios.flatMap((scenario) => scenario.expected.safetyGates)
    );
    const expected: EvalSafetyGate[] = [
      'grounded-options',
      'searched-provider-only',
      'confirmation-required',
      'patient-bound-session',
      'no-duplicate-booking',
      'slot-conflict-safe',
    ];

    expect([...gates].sort()).toEqual(expected.sort());
  });

  it('serializes deterministically and matches the checked-in artifact', () => {
    const serialized = serializeScenarioCatalog(buildScenarioCatalog());

    expect(serialized).toBe(serializeScenarioCatalog(buildScenarioCatalog()));
    expect(readFileSync('data/evals/booking-scenarios.json', 'utf8').replace(/\r\n/g, '\n')).toBe(serialized);
  });
});
