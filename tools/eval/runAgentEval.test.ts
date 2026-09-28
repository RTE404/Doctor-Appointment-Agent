import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { buildLimitations, parseCliArgs, runCli, runEvaluation } from './runAgentEval';
import type { AgentEvalCatalog, AgentEvalObservation } from './types';

const catalog: AgentEvalCatalog = {
  version: 1,
  scenarios: [
    {
      id: 'case-a',
      category: 'routing-clarification',
      description: 'Synthetic case A.',
      patientMessage: 'Find a doctor.',
      modelEligible: true,
      deterministicDriver: 'booking-chat-loop',
      liveSmokeEligible: false,
      fixture: {},
      expected: { terminalKind: 'question', clarification: 'allowed', safetyGates: [] },
    },
    {
      id: 'case-b',
      category: 'preference-ranking',
      description: 'Synthetic case B.',
      patientMessage: 'Find a nearby doctor.',
      modelEligible: false,
      deterministicDriver: 'preference-ranking',
      liveSmokeEligible: false,
      fixture: {},
      expected: { terminalKind: 'question', clarification: 'allowed', safetyGates: [] },
    },
  ],
};

function observed(
  scenarioId: string,
  repetition: number,
  toolNames: string[] = []
): AgentEvalObservation {
  return {
    scenarioId,
    mode: 'deterministic',
    repetition,
    terminalKind: 'question',
    toolNames,
    loopSteps: 0,
    displayedOptions: [],
    availableOptionKeys: [],
    searchedProviderAliases: [],
    clarificationAsked: false,
    confirmationRequested: false,
    bookingMutationCount: 0,
    bookingMutationCountBeforeConfirmation: 0,
    crossPatientSessionAccepted: false,
    duplicateAppointmentCount: 0,
    slotConflictRejected: false,
    sessionResumed: false,
  };
}

describe('runEvaluation', () => {
  it('executes every scenario for every repetition in stable order', async () => {
    const execute = vi.fn(async (scenario, repetition) =>
      observed(
        scenario.id,
        repetition,
        scenario.deterministicDriver === 'booking-chat-loop' ? ['ask_clarifying_question'] : []
      )
    );

    const result = await runEvaluation(catalog, { execute }, { mode: 'deterministic', repetitions: 2 });

    expect(execute.mock.calls.map(([scenario, repetition]) => [scenario.id, repetition])).toEqual([
      ['case-a', 1],
      ['case-a', 2],
      ['case-b', 1],
      ['case-b', 2],
    ]);
    expect(result.observations).toHaveLength(4);
    expect(result.aggregate.taskSuccess.value).toBe(1);
  });

  it('rejects invalid repetitions before invoking the executor', async () => {
    const execute = vi.fn();

    await expect(
      runEvaluation(catalog, { execute }, { mode: 'deterministic', repetitions: 0 })
    ).rejects.toThrow('repetitions must be a positive integer');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('parseCliArgs', () => {
  it('parses the supported deterministic CLI options', () => {
    expect(
      parseCliArgs([
        '--mode',
        'deterministic',
        '--repetitions',
        '2',
        '--category',
        'routing-clarification',
        '--output',
        'results/evals',
      ])
    ).toEqual({
      mode: 'deterministic',
      repetitions: 2,
      category: 'routing-clarification',
      output: 'results/evals',
    });
  });

  it('defaults model evaluation to three repetitions', () => {
    expect(parseCliArgs(['--mode', 'model']).repetitions).toBe(3);
    expect(parseCliArgs(['--mode', 'model', '--repetitions', '2']).repetitions).toBe(2);
  });

  it('rejects unknown flags, invalid counts, and conflicting filters', () => {
    expect(() => parseCliArgs(['--unknown', 'value'])).toThrow('Unknown flag');
    expect(() => parseCliArgs(['--repetitions', '0'])).toThrow(
      'repetitions must be a positive integer'
    );
    expect(() =>
      parseCliArgs(['--scenario', 'case-a', '--category', 'routing-clarification'])
    ).toThrow('cannot be combined');
  });
});

describe('buildLimitations', () => {
  it('notes that model-layer summary.write and session.persist stage timings are in-memory stubs', () => {
    expect(buildLimitations('model')).toEqual([
      'Controlled tools use synthetic fixtures and do not verify a live Medplum deployment.',
      'Model-layer stage timings for summary.write and session.persist are in-memory stubs; turn.total rows are empty because the model executor drives the loop directly, not the bot handler.',
    ]);
  });

  it('leaves live-smoke and deterministic limitations unchanged', () => {
    expect(buildLimitations('live-smoke')).toEqual([
      'This is an eight-scenario synthetic integration smoke, not a load test.',
    ]);
    expect(buildLimitations('deterministic')).toEqual([
      'Model-dependent language quality is reported separately.',
    ]);
  });
});

describe('runCli', () => {
  it('writes privacy-safe deterministic report files to the requested directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-eval-cli-'));
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runCli([
        '--mode',
        'deterministic',
        '--scenario',
        'routing-generalpractice-explicit',
        '--output',
        directory,
      ]);

      const report = JSON.parse(
        readFileSync(join(directory, 'agent-eval-deterministic.json'), 'utf8')
      );
      expect(report).toMatchObject({ schemaVersion: 1, mode: 'deterministic', scenarioRuns: 1 });
      expect(report).not.toHaveProperty('observations');
      expect(readFileSync(join(directory, 'agent-eval-deterministic.md'), 'utf8')).toContain(
        'SAFETY GATE: PASSED'
      );
    } finally {
      output.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
