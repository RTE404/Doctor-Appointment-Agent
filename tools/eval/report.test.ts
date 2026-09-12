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

function makeReport() {
  const observations = [observation('case-b', 'booked'), observation('case-a', 'error')];
  const runs = observations.map((observed) => ({
    scenario: catalog.scenarios.find((scenario) => scenario.id === observed.scenarioId)!,
    observation: observed,
  }));
  return buildReport({
    catalog,
    observations,
    aggregate: aggregateEvaluation(runs),
    mode: 'deterministic',
    repetitions: 1,
    command: 'npm run eval:agent',
    gitCommit: 'abc1234',
    nodeVersion: 'v22.0.0',
    limitations: ['Model evaluation not run.'],
  });
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
});
