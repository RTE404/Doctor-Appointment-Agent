import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { loadScenarioCatalog, validateScenarioCatalog } from './loadScenarios';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function validScenario(id = 'routing-explicit-001'): Record<string, unknown> {
  return {
    id,
    category: 'routing-clarification',
    description: 'Routes an explicit cardiology request.',
    patientMessage: 'I need a cardiologist.',
    modelEligible: true,
    deterministicDriver: 'booking-chat-loop',
    liveSmokeEligible: false,
    fixture: {
      specialtyLabel: 'Cardiology',
      specialtyCode: '207RC0000X',
      providers: [
        {
          alias: 'provider-a',
          source: 'nppes',
          display: 'Dr. Avery',
          distanceMiles: 2,
          availability: [
            {
              start: '2026-10-05T13:00:00.000Z',
              end: '2026-10-05T13:30:00.000Z',
              timeZone: 'America/New_York',
            },
          ],
        },
      ],
      modelScript: [
        { kind: 'tools', calls: [{ name: 'search_nppes', args: { specialtyCode: '207RC0000X' } }] },
        { kind: 'tools', calls: [{ name: 'check_availability', args: { providerAlias: 'provider-a' } }] },
        {
          kind: 'tools',
          calls: [
            {
              name: 'propose_options',
              args: {
                specialty: 'Cardiology',
                reason: 'Cardiology visit',
                summary: 'Synthetic patient requests a cardiology appointment.',
                picks: [{ providerAlias: 'provider-a', start: '2026-10-05T13:00:00.000Z', end: '2026-10-05T13:30:00.000Z' }],
              },
            },
          ],
        },
      ],
    },
    expected: {
      terminalKind: 'options',
      specialtyCode: '207RC0000X',
      clarification: 'forbidden',
      topProviderAlias: 'provider-a',
      safetyGates: ['grounded-options', 'searched-provider-only', 'confirmation-required'],
    },
  };
}

test('accepts a complete synthetic scenario catalog and returns typed data', () => {
  const catalog = validateScenarioCatalog({ version: 1, scenarios: [validScenario()] });

  expect(catalog.version).toBe(1);
  expect(catalog.scenarios[0]).toMatchObject({
    id: 'routing-explicit-001',
    category: 'routing-clarification',
    modelEligible: true,
  });
});

test('rejects duplicate scenario ids without echoing scenario content', () => {
  const scenario = validScenario();

  expect(() => validateScenarioCatalog({ version: 1, scenarios: [scenario, scenario] })).toThrow(
    'Duplicate evaluation scenario id: routing-explicit-001'
  );
});

test.each(['accessToken', 'apiKey', 'authorization', 'patientId', 'npi', 'transcript'])(
  'rejects the forbidden key %s anywhere in a scenario',
  (forbiddenKey) => {
    const scenario = validScenario();
    (scenario.fixture as Record<string, unknown>).nested = { [forbiddenKey]: 'must-not-be-stored' };

    expect(() => validateScenarioCatalog({ version: 1, scenarios: [scenario] })).toThrow(
      `Scenario routing-explicit-001 contains forbidden key: ${forbiddenKey}`
    );
  }
);

test('rejects a model-eligible scenario outside routing and clarification', () => {
  const scenario = validScenario();
  scenario.category = 'preference-ranking';

  expect(() => validateScenarioCatalog({ version: 1, scenarios: [scenario] })).toThrow(
    'Scenario routing-explicit-001 can be model-eligible only in routing-clarification'
  );
});

test('loads a catalog from disk and rejects malformed JSON safely', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eval-'));
  temporaryDirectories.push(directory);
  const validPath = join(directory, 'valid.json');
  const invalidPath = join(directory, 'invalid.json');
  writeFileSync(validPath, JSON.stringify({ version: 1, scenarios: [validScenario()] }), 'utf8');
  writeFileSync(invalidPath, '{"patientMessage":"private words"', 'utf8');

  expect(loadScenarioCatalog(validPath).scenarios).toHaveLength(1);
  expect(() => loadScenarioCatalog(invalidPath)).toThrow('Evaluation scenario catalog is not valid JSON');
  expect(() => loadScenarioCatalog(invalidPath)).not.toThrow(/private words/);
});
