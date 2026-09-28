import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertReportIsSafe,
  buildReport,
  formatPercentagePointChange,
  renderReportMarkdown,
  writeReportFiles,
} from './report';
import type { BuildReportInput } from './report';
import { summarizePerformance } from './performance';
import { aggregateEvaluation } from './scorers';
import type { AgentEvalCatalog, AgentEvalObservation } from './types';

const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

const catalog: AgentEvalCatalog = {
  version: 1,
  scenarios: [
    {
      id: 'case-b',
      category: 'confirmation-session',
      description: 'Synthetic safety case.',
      patientMessage: 'Private phrase B',
      modelEligible: false,
      deterministicDriver: 'confirmation-state',
      liveSmokeEligible: false,
      fixture: {},
      expected: {
        terminalKind: 'booked',
        clarification: 'allowed',
        safetyGates: ['confirmation-required'],
      },
    },
    {
      id: 'case-a',
      category: 'routing-clarification',
      description: 'Synthetic routing case.',
      patientMessage: 'Private phrase A',
      modelEligible: true,
      deterministicDriver: 'booking-chat-loop',
      liveSmokeEligible: false,
      fixture: {},
      expected: { terminalKind: 'question', clarification: 'allowed', safetyGates: [] },
    },
  ],
};

function observation(scenarioId: string, terminalKind: AgentEvalObservation['terminalKind']): AgentEvalObservation {
  return {
    scenarioId,
    mode: 'deterministic',
    repetition: 1,
    terminalKind,
    toolNames: [],
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

function makeReportInput(): { observations: AgentEvalObservation[]; input: BuildReportInput } {
  const observations = [observation('case-b', 'booked'), observation('case-a', 'error')];
  const runs = observations.map((observed) => ({
    scenario: catalog.scenarios.find((scenario) => scenario.id === observed.scenarioId)!,
    observation: observed,
  }));
  const input: BuildReportInput = {
    catalog,
    observations,
    aggregate: aggregateEvaluation(runs),
    mode: 'deterministic',
    repetitions: 1,
    command: 'npm run eval:agent',
    gitCommit: 'abc1234',
    nodeVersion: 'v22.0.0',
    limitations: ['Model evaluation not run.'],
  };
  return { observations, input };
}

function makeReport() {
  return buildReport(makeReportInput().input);
}

describe('evaluation report', () => {
  it('contains stable aggregate failures but no raw observations or private content', () => {
    const report = makeReport();
    const serialized = JSON.stringify(report);

    expect(report.failures).toEqual([{ scenarioId: 'case-a', failedChecks: ['terminal'] }]);
    expect(serialized).not.toContain('observations');
    expect(serialized).not.toContain('Private phrase');
    expect(serialized).not.toContain('toolNames');
    expect(() => assertReportIsSafe(report)).not.toThrow();
  });

  it('renders percentages, raw counts, null ratios, and a prominent failed safety gate', () => {
    const report = makeReport();
    report.aggregate.safetyGatePassed = false;
    const markdown = renderReportMarkdown(report);

    expect(markdown).toContain('SAFETY GATE: FAILED');
    expect(markdown).toContain('50.0% (1 / 2)');
    expect(markdown).toContain('N/A (0 / 0)');
    expect(formatPercentagePointChange(0.75, 0.5)).toBe('+25.0 percentage points');
  });

  it.each(['accessToken', 'apiKey', 'authorization', 'patientId', 'npi', 'transcript', 'prompt', 'observations'])(
    'rejects the forbidden report key %s',
    (key) => {
      const report = makeReport() as unknown as Record<string, unknown>;
      report[key] = 'PRIVATE_EVAL_CONTENT';

      expect(() => assertReportIsSafe(report)).toThrow('Unsafe evaluation report key');
    }
  );

  it('rejects credential/resource markers in report values', () => {
    const report = makeReport();
    report.limitations = ['Bearer PRIVATE_EVAL_CONTENT'];

    expect(() => assertReportIsSafe(report)).toThrow('Unsafe evaluation report value');
  });

  it('writes stable JSON and Markdown atomically after the safety check', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-eval-report-'));
    temporaryDirectories.push(directory);
    const report = makeReport();
    const paths = writeReportFiles(directory, report);

    expect(JSON.parse(readFileSync(paths.json, 'utf8')).schemaVersion).toBe(1);
    expect(readFileSync(paths.markdown, 'utf8')).toContain('# Agent Evaluation Report');

    writeFileSync(paths.json, 'keep-existing', 'utf8');
    report.limitations = ['Bearer PRIVATE_EVAL_CONTENT'];
    expect(() => writeReportFiles(directory, report)).toThrow('Unsafe evaluation report value');
    expect(readFileSync(paths.json, 'utf8')).toBe('keep-existing');
  });

  it('includes a performance section when supplied and keeps it privacy-safe', () => {
    const { observations, input } = makeReportInput();
    const performance = summarizePerformance(
      [
        {
          ...observations[0],
          telemetry: {
            stages: [{ stage: 'model.call', durationMs: 120, outcome: 'ok' }],
            modelCalls: [{ promptTokens: 10, completionTokens: 2, totalTokens: 12, retries: 0 }],
          },
        },
      ],
      { version: 1, models: { 'gemini-3.5-flash-lite': { inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5, source: 'fixture', retrievedOn: '2026-09-28' } } },
      'gemini-3.5-flash-lite'
    );
    const report = buildReport({ ...input, performance });

    expect(report.performance?.stages['model.call'].p50).toBe(120);
    const markdown = renderReportMarkdown(report);
    expect(markdown).toContain('## Performance');
    expect(markdown).toContain('| model.call | 1 | 120 | 120 | 120 | yes |');
    expect(markdown).toContain('Low-sample stages (fewer than 20 turns) are labeled');
    expect(markdown).toContain('- Mean cached prompt tokens per turn: 0 (calls reporting cached tokens: 0)');
    expect(markdown).toContain(
      '- Cost is priced at the list input rate; no cached-token data was reported, so this is an upper bound.'
    );
  });

  it('reports mean cached prompt tokens without the upper-bound note when cached tokens were reported', () => {
    const { observations, input } = makeReportInput();
    const performance = summarizePerformance(
      [
        {
          ...observations[0],
          telemetry: {
            stages: [{ stage: 'model.call', durationMs: 120, outcome: 'ok' }],
            modelCalls: [{ promptTokens: 10, completionTokens: 2, totalTokens: 12, cachedPromptTokens: 4, retries: 0 }],
          },
        },
      ],
      {
        version: 1,
        models: {
          'gemini-3.5-flash-lite': {
            inputPerMillionUsd: 0.3,
            outputPerMillionUsd: 2.5,
            cachedInputPerMillionUsd: 0.03,
            source: 'fixture',
            retrievedOn: '2026-09-28',
          },
        },
      },
      'gemini-3.5-flash-lite'
    );
    const markdown = renderReportMarkdown(buildReport({ ...input, performance }));
    expect(markdown).toContain('- Mean cached prompt tokens per turn: 4 (calls reporting cached tokens: 1)');
    expect(markdown).not.toContain('this is an upper bound');
  });

  it('omits the performance section when absent', () => {
    const { input } = makeReportInput();
    expect(renderReportMarkdown(buildReport(input))).not.toContain('## Performance');
  });
});
