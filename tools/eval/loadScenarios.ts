import { readFileSync } from 'node:fs';
import type {
  AgentEvalCatalog,
  AgentEvalScenario,
  ClarificationPolicy,
  DeterministicDriver,
  EvalCategory,
  EvalModelTurnFixture,
  EvalProviderFixture,
  EvalSafetyGate,
  EvalTerminalKind,
  EvalToolCallFixture,
} from './types.js';

const CATEGORIES = new Set<EvalCategory>([
  'routing-clarification',
  'preference-ranking',
  'grounding-tampering',
  'availability-dependency',
  'confirmation-session',
]);

const DRIVERS = new Set<DeterministicDriver>([
  'booking-chat-loop',
  'preference-ranking',
  'proposal-grounding',
  'confirmation-state',
  'session-boundary',
]);

const TERMINAL_KINDS = new Set<EvalTerminalKind>(['question', 'options', 'booked', 'slot-taken', 'error']);
const CLARIFICATION_POLICIES = new Set<ClarificationPolicy>(['required', 'forbidden', 'allowed']);
const SAFETY_GATES = new Set<EvalSafetyGate>([
  'grounded-options',
  'searched-provider-only',
  'confirmation-required',
  'patient-bound-session',
  'no-duplicate-booking',
  'slot-conflict-safe',
]);
const FORBIDDEN_KEYS = new Set(['accessToken', 'apiKey', 'authorization', 'patientId', 'npi', 'transcript']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${context} requires a non-empty ${key}`);
  }
  return value;
}

function assertNoForbiddenKeys(value: unknown, scenarioId: string): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoForbiddenKeys(entry, scenarioId);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(`Scenario ${scenarioId} contains forbidden key: ${key}`);
    }
    assertNoForbiddenKeys(child, scenarioId);
  }
}

function validateProvider(value: unknown, scenarioId: string): EvalProviderFixture {
  if (!isRecord(value)) throw new Error(`Scenario ${scenarioId} has an invalid provider fixture`);
  const alias = requiredString(value, 'alias', `Scenario ${scenarioId} provider`);
  if (!/^provider-[a-z0-9-]+$/.test(alias)) {
    throw new Error(`Scenario ${scenarioId} has an invalid synthetic provider alias`);
  }
  if (value.source !== 'previous' && value.source !== 'nppes') {
    throw new Error(`Scenario ${scenarioId} has an invalid provider source`);
  }
  const display = requiredString(value, 'display', `Scenario ${scenarioId} provider`);
  if (value.distanceMiles !== undefined && (typeof value.distanceMiles !== 'number' || value.distanceMiles < 0)) {
    throw new Error(`Scenario ${scenarioId} has an invalid provider distance`);
  }
  if (!Array.isArray(value.availability)) {
    throw new Error(`Scenario ${scenarioId} provider requires availability`);
  }
  const availability = value.availability.map((entry) => {
    if (!isRecord(entry)) throw new Error(`Scenario ${scenarioId} has an invalid availability fixture`);
    const start = requiredString(entry, 'start', `Scenario ${scenarioId} availability`);
    const end = requiredString(entry, 'end', `Scenario ${scenarioId} availability`);
    const timeZone = requiredString(entry, 'timeZone', `Scenario ${scenarioId} availability`);
    if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start)) {
      throw new Error(`Scenario ${scenarioId} has an invalid availability interval`);
    }
    return { start, end, timeZone };
  });
  return { alias, source: value.source, display, distanceMiles: value.distanceMiles as number | undefined, availability };
}

function validateModelTurn(value: unknown, scenarioId: string): EvalModelTurnFixture {
  if (!isRecord(value)) throw new Error(`Scenario ${scenarioId} has an invalid model turn`);
  if (value.kind === 'text') {
    return { kind: 'text', content: requiredString(value, 'content', `Scenario ${scenarioId} model turn`) };
  }
  if (value.kind !== 'tools' || !Array.isArray(value.calls) || value.calls.length === 0) {
    throw new Error(`Scenario ${scenarioId} has an invalid model tool turn`);
  }
  return {
    kind: 'tools',
    calls: value.calls.map((call) => {
      if (!isRecord(call) || !isRecord(call.args)) {
        throw new Error(`Scenario ${scenarioId} has an invalid model tool call`);
      }
      const name = requiredString(call, 'name', `Scenario ${scenarioId} model tool call`);
      if (!['search_previous_physician', 'search_nppes', 'check_availability', 'ask_clarifying_question', 'propose_options'].includes(name)) {
        throw new Error(`Scenario ${scenarioId} has an unknown model tool`);
      }
      return { name: name as EvalToolCallFixture['name'], args: call.args };
    }),
  };
}

function validateScenario(value: unknown, index: number): AgentEvalScenario {
  if (!isRecord(value)) throw new Error(`Evaluation scenario at index ${index} must be an object`);
  const id = requiredString(value, 'id', `Evaluation scenario at index ${index}`);
  assertNoForbiddenKeys(value, id);
  if (!CATEGORIES.has(value.category as EvalCategory)) throw new Error(`Scenario ${id} has an invalid category`);
  if (!DRIVERS.has(value.deterministicDriver as DeterministicDriver)) {
    throw new Error(`Scenario ${id} has an invalid deterministic driver`);
  }
  const description = requiredString(value, 'description', `Scenario ${id}`);
  const patientMessage = requiredString(value, 'patientMessage', `Scenario ${id}`);
  if (typeof value.modelEligible !== 'boolean' || typeof value.liveSmokeEligible !== 'boolean') {
    throw new Error(`Scenario ${id} requires boolean eligibility flags`);
  }
  if (value.modelEligible && value.category !== 'routing-clarification') {
    throw new Error(`Scenario ${id} can be model-eligible only in routing-clarification`);
  }
  if (!isRecord(value.fixture)) throw new Error(`Scenario ${id} requires a fixture object`);
  if (!isRecord(value.expected)) throw new Error(`Scenario ${id} requires an expected object`);
  if (!TERMINAL_KINDS.has(value.expected.terminalKind as EvalTerminalKind)) {
    throw new Error(`Scenario ${id} has an invalid terminal kind`);
  }
  if (!CLARIFICATION_POLICIES.has(value.expected.clarification as ClarificationPolicy)) {
    throw new Error(`Scenario ${id} has an invalid clarification policy`);
  }
  if (!Array.isArray(value.expected.safetyGates)) {
    throw new Error(`Scenario ${id} requires safety gates`);
  }
  const safetyGates = value.expected.safetyGates.map((gate) => {
    if (!SAFETY_GATES.has(gate as EvalSafetyGate)) throw new Error(`Scenario ${id} has an invalid safety gate`);
    return gate as EvalSafetyGate;
  });

  const fixture = {
    ...value.fixture,
    providers: value.fixture.providers === undefined
      ? undefined
      : Array.isArray(value.fixture.providers)
        ? value.fixture.providers.map((provider) => validateProvider(provider, id))
        : (() => { throw new Error(`Scenario ${id} has invalid providers`); })(),
    modelScript: value.fixture.modelScript === undefined
      ? undefined
      : Array.isArray(value.fixture.modelScript)
        ? value.fixture.modelScript.map((turn) => validateModelTurn(turn, id))
        : (() => { throw new Error(`Scenario ${id} has an invalid model script`); })(),
  };

  return {
    id,
    category: value.category as EvalCategory,
    description,
    patientMessage,
    modelEligible: value.modelEligible,
    deterministicDriver: value.deterministicDriver as DeterministicDriver,
    liveSmokeEligible: value.liveSmokeEligible,
    fixture,
    expected: {
      terminalKind: value.expected.terminalKind as EvalTerminalKind,
      specialtyCode: value.expected.specialtyCode as string | undefined,
      clarification: value.expected.clarification as ClarificationPolicy,
      topProviderAlias: value.expected.topProviderAlias as string | undefined,
      safetyGates,
    },
  } as AgentEvalScenario;
}

export function validateScenarioCatalog(value: unknown): AgentEvalCatalog {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.scenarios)) {
    throw new Error('Evaluation scenario catalog must use schema version 1');
  }
  const scenarios = value.scenarios.map((scenario, index) => validateScenario(scenario, index));
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    if (seen.has(scenario.id)) throw new Error(`Duplicate evaluation scenario id: ${scenario.id}`);
    seen.add(scenario.id);
  }
  return { version: 1, scenarios };
}

export function loadScenarioCatalog(path: string): AgentEvalCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error('Evaluation scenario catalog is not valid JSON');
  }
  return validateScenarioCatalog(parsed);
}
