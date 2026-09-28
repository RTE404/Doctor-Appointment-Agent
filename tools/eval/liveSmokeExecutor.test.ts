import { describe, expect, it, vi } from 'vitest';

import { loadScenarioCatalog } from './loadScenarios';
import {
  LIVE_SMOKE_SCENARIO_IDS,
  createLiveSmokeExecutor,
  type LiveSmokeDependencies,
  type LiveSmokeEnvironment,
  type LiveSmokeRunResult,
} from './liveSmokeExecutor';
import { createAgentTelemetry } from '../../src/bots/agent/lib/agentTelemetry';
import { confirmAndBookTopOption, createTrackingClient } from './liveSmokeExecutor';

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

const option = {
  id: 'o1', npi: '1234567890', practitionerId: 'pr-1', scheduleId: 'sc-1', doctorName: 'Dr. Synthetic',
  start: '2026-10-05T13:00:00.000Z', end: '2026-10-05T13:30:00.000Z', timeZone: 'America/New_York', previousDoctor: false,
};

describe('live smoke booking', () => {
  it('tags the $book appointment with the run tag, keeping existing tags, and counts the mutation', async () => {
    const post = vi.fn(async (_url: URL | string, _body: unknown) => ({}));
    const fake = { post, createResource: vi.fn(), fhirUrl: (...parts: string[]) => new URL(`https://x.test/fhir/R4/${parts.join('/')}`) };
    const counter = { count: 0 };
    const plan = { runTagCode: 'agent-eval-run', resources: [] };
    const client = createTrackingClient(fake as never, plan, counter);
    await client.post(fake.fhirUrl('Appointment', '$book'), {
      resourceType: 'Parameters',
      parameter: [{ name: 'appointment', resource: { resourceType: 'Appointment', meta: { tag: [{ system: 'demo', code: 'demo-generated' }] } } }],
    });
    const sent = post.mock.calls[0][1] as { parameter: Array<{ resource: { meta: { tag: Array<{ system: string; code: string }> } } }> };
    expect(sent.parameter[0].resource.meta.tag).toEqual(
      expect.arrayContaining([
        { system: 'demo', code: 'demo-generated' },
        { system: 'https://doctor-appointment-agent.example/fhir/eval-run', code: 'agent-eval-run' },
      ])
    );
    expect(counter.count).toBe(1);
  });

  it('tracks a booked appointment for cleanup after the confirmation step', async () => {
    const plan = { runTagCode: 'agent-eval-run', resources: [] as Array<{ resourceType: 'Appointment' | 'Communication' | 'Encounter'; id: string }> };
    const counter = { count: 0 };
    const book = vi.fn(async () => {
      counter.count += 1;
      return { ok: true as const, appointment: { resourceType: 'Appointment' as const, id: 'appt-1', status: 'booked' as const, participant: [] } };
    });
    const result = await confirmAndBookTopOption({} as never, { patientId: 'p', option, summaryCommunicationId: 'c' }, plan, counter, createAgentTelemetry(), book as never);
    expect(result).toEqual({ confirmationRequested: true, bookingCompleted: true, mutationsBeforeConfirmation: 0 });
    expect(plan.resources).toEqual([{ resourceType: 'Appointment', id: 'appt-1' }]);
  });

  it('handles slot_taken without tracking an appointment', async () => {
    const plan = { runTagCode: 'agent-eval-run', resources: [] };
    const book = vi.fn(async () => ({ ok: false as const, reason: 'slot_taken' as const }));
    const result = await confirmAndBookTopOption({} as never, { patientId: 'p', option, summaryCommunicationId: 'c' }, plan, { count: 0 }, createAgentTelemetry(), book as never);
    expect(result.bookingCompleted).toBe(false);
    expect(plan.resources).toEqual([]);
  });

  it('labels the first executed scenario cold and later ones warm, and passes booking counters through', async () => {
    const deps = dependencies({
      run: vi.fn(async (): Promise<LiveSmokeRunResult> => ({
        terminalKind: 'options', toolNames: [], loopSteps: 1, displayedOptions: [], availableOptionKeys: [],
        searchedProviderAliases: [], clarificationAsked: false, sessionResumed: true,
        confirmationRequested: true, bookingCompleted: true, bookingMutationCount: 1, bookingMutationCountBeforeConfirmation: 0,
      })),
    });
    const executor = createLiveSmokeExecutor(environment, deps);
    const [first] = [...LIVE_SMOKE_SCENARIO_IDS];
    const one = await executor.execute(scenario(first), 1);
    const two = await executor.execute(scenario(first), 2);
    expect(one.warmth).toBe('cold');
    expect(two.warmth).toBe('warm');
    expect(one).toMatchObject({ confirmationRequested: true, bookingCompleted: true, bookingMutationCount: 1, bookingMutationCountBeforeConfirmation: 0 });
  });
});
