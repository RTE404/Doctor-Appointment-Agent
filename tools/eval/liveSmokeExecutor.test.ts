import { describe, expect, it, vi } from 'vitest';

import { loadScenarioCatalog } from './loadScenarios';
import {
  LIVE_SMOKE_SCENARIO_IDS,
  createLiveSmokeExecutor,
  type LiveSmokeDependencies,
  type LiveSmokeEnvironment,
  type LiveSmokeRunResult,
} from './liveSmokeExecutor';

const catalog = loadScenarioCatalog('data/evals/booking-scenarios.json');

const environment: Required<LiveSmokeEnvironment> = {
  MEDPLUM_BASE_URL: 'https://example.test',
  MEDPLUM_PROJECT_ID: 'synthetic-project',
  DEMO_MEDPLUM_CLIENT_ID: 'browser-client',
  DEMO_MEDPLUM_CLIENT_SECRET: 'browser-secret',
  DEMO_WORKER_CLIENT_ID: 'worker-client',
  DEMO_WORKER_CLIENT_SECRET: 'worker-secret',
  GEMINI_API_KEY: 'model-key',
};

function scenario(id: string) {
  const found = catalog.scenarios.find((item) => item.id === id);
  if (!found) throw new Error(`Missing scenario ${id}`);
  return structuredClone(found);
}

function dependencies(overrides: Partial<LiveSmokeDependencies> = {}): LiveSmokeDependencies {
  return {
    buildCleanupPlan: vi.fn(() => ({ runTagCode: 'eval-run-test', resources: [] })),
    initialize: vi.fn(async () => ({ kind: 'test-session' })),
    run: vi.fn(async (_session, _scenario, plan): Promise<LiveSmokeRunResult> => {
      plan.resources.push({ resourceType: 'Communication', id: 'external-id-must-not-leak' });
      return {
        terminalKind: 'options',
        specialtyCode: '208D00000X',
        toolNames: ['search_nppes', 'check_availability', 'propose_options'],
        loopSteps: 3,
        displayedOptions: [
          {
            providerAlias: 'provider-live-1',
            start: '2026-10-05T13:00:00.000Z',
            end: '2026-10-05T13:30:00.000Z',
            previousDoctor: false,
          },
        ],
        availableOptionKeys: [
          'provider-live-1|2026-10-05T13:00:00.000Z|2026-10-05T13:30:00.000Z',
        ],
        searchedProviderAliases: ['provider-live-1'],
        clarificationAsked: false,
        sessionResumed: true,
      };
    }),
    cleanup: vi.fn(async (_session, plan) => {
      plan.resources.splice(0);
    }),
    ...overrides,
  };
}

describe('createLiveSmokeExecutor', () => {
  it('requires the complete synthetic configuration before any dependency call', () => {
    const deps = dependencies();

    expect(() =>
      createLiveSmokeExecutor({ ...environment, DEMO_WORKER_CLIENT_SECRET: undefined }, deps)
    ).toThrow('missing required local configuration');
    expect(deps.buildCleanupPlan).not.toHaveBeenCalled();
    expect(deps.initialize).not.toHaveBeenCalled();
  });

  it('builds the cleanup plan before any network initialization', () => {
    const deps = dependencies({
      buildCleanupPlan: vi.fn(() => {
        throw new Error('cleanup plan unavailable');
      }),
    });

    expect(() => createLiveSmokeExecutor(environment, deps)).toThrow('cleanup plan unavailable');
    expect(deps.initialize).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
  });

  it('restricts execution to the exact eight reviewed catalog scenarios', async () => {
    const liveScenarios = catalog.scenarios.filter((item) => item.liveSmokeEligible);
    expect(LIVE_SMOKE_SCENARIO_IDS.size).toBe(8);
    expect(liveScenarios.map((item) => item.id).sort()).toEqual([...LIVE_SMOKE_SCENARIO_IDS].sort());

    const deps = dependencies();
    const executor = createLiveSmokeExecutor(environment, deps);
    await expect(executor.execute(scenario('preference-morning-citycenter'), 1)).rejects.toThrow(
      'not approved for live smoke'
    );
    expect(deps.initialize).not.toHaveBeenCalled();
  });

  it('rejects a mutated copy of an allowlisted scenario before network access', async () => {
    const input = scenario('routing-generalpractice-explicit');
    input.patientMessage = 'Unreviewed external-data request';
    const deps = dependencies();
    const executor = createLiveSmokeExecutor(environment, deps);

    await expect(executor.execute(input, 1)).rejects.toThrow('does not match the reviewed synthetic catalog');
    expect(deps.initialize).not.toHaveBeenCalled();
  });

  it('cleans tracked resources and never includes external identifiers in the observation', async () => {
    const deps = dependencies();
    const executor = createLiveSmokeExecutor(environment, deps);

    const result = await executor.execute(scenario('routing-generalpractice-explicit'), 1);

    expect(deps.initialize).toHaveBeenCalledTimes(1);
    expect(deps.cleanup).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ mode: 'live-smoke', repetition: 1, terminalKind: 'options' });
    expect(JSON.stringify(result)).not.toContain('external-id-must-not-leak');
  });

  it('still cleans tracked resources when scenario execution fails', async () => {
    const deps = dependencies({
      run: vi.fn(async (_session, _scenario, plan) => {
        plan.resources.push({ resourceType: 'Communication', id: 'partial-resource' });
        throw new Error('sanitized live failure');
      }),
    });
    const executor = createLiveSmokeExecutor(environment, deps);

    await expect(executor.execute(scenario('routing-generalpractice-explicit'), 1)).rejects.toThrow(
      'sanitized live failure'
    );
    expect(deps.cleanup).toHaveBeenCalledTimes(1);
  });
});
