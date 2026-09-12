import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scoreScenario } from './scorers.js';
import type {
  AgentEvalCatalog,
  AgentEvalObservation,
  EvalAggregate,
  RatioMetric,
} from './types.js';

export interface AgentEvalReport {
  schemaVersion: 1;
  catalogVersion: 1;
  mode: AgentEvalObservation['mode'];
  model?: string;
  repetitions: number;
  scenarioRuns: number;
  aggregate: EvalAggregate;
  failures: Array<{ scenarioId: string; failedChecks: string[] }>;
  command: string;
  gitCommit: string;
  nodeVersion: string;
  limitations: string[];
}

export interface BuildReportInput {
  catalog: AgentEvalCatalog;
  observations: AgentEvalObservation[];
  aggregate: EvalAggregate;
  mode: AgentEvalObservation['mode'];
  model?: string;
  repetitions: number;
  command: string;
  gitCommit: string;
  nodeVersion: string;
  limitations: string[];
}

const FORBIDDEN_KEYS = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'patientid',
  'npi',
  'transcript',
  'prompt',
  'messages',
  'observations',
  'raw',
]);

function collectUnsafeValue(value: string): boolean {
  return (
    /\bBearer\s+\S+/i.test(value) ||
    /\b(?:Patient|Practitioner|Schedule|Communication)\/[A-Za-z0-9.-]+/.test(value)
  );
}

export function assertReportIsSafe(value: unknown): void {
  function visit(current: unknown): void {
    if (typeof current === 'string') {
      if (collectUnsafeValue(current)) throw new Error('Unsafe evaluation report value');
      return;
    }
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (typeof current !== 'object' || current === null) return;
    for (const [key, child] of Object.entries(current)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        throw new Error(`Unsafe evaluation report key: ${key}`);
      }
      visit(child);
    }
  }
  visit(value);
}

export function buildReport(input: BuildReportInput): AgentEvalReport {
  const scenarioById = new Map(input.catalog.scenarios.map((scenario) => [scenario.id, scenario]));
  const failuresById = new Map<string, Set<string>>();
  for (const observation of input.observations) {
    const scenario = scenarioById.get(observation.scenarioId);
    if (!scenario) throw new Error(`Observation references unknown scenario: ${observation.scenarioId}`);
    const score = scoreScenario(scenario, observation);
    const failedChecks = Object.entries(score.checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    if (failedChecks.length > 0) {
      const existing = failuresById.get(scenario.id) ?? new Set<string>();
      failedChecks.forEach((check) => existing.add(check));
      failuresById.set(scenario.id, existing);
    }
  }
  const failures = [...failuresById]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([scenarioId, checks]) => ({ scenarioId, failedChecks: [...checks].sort() }));
  const report: AgentEvalReport = {
    schemaVersion: 1,
    catalogVersion: input.catalog.version,
    mode: input.mode,
    ...(input.model ? { model: input.model } : {}),
    repetitions: input.repetitions,
    scenarioRuns: input.observations.length,
    aggregate: input.aggregate,
    failures,
    command: input.command,
    gitCommit: input.gitCommit,
    nodeVersion: input.nodeVersion,
    limitations: [...input.limitations],
  };
  assertReportIsSafe(report);
  return report;
}

function formatRatio(metric: RatioMetric): string {
  if (metric.value === null) return `N/A (${metric.numerator} / ${metric.denominator})`;
  return `${(metric.value * 100).toFixed(1)}% (${metric.numerator} / ${metric.denominator})`;
}

export function formatPercentagePointChange(current: number, previous: number): string {
  const difference = (current - previous) * 100;
  const prefix = difference > 0 ? '+' : '';
  return `${prefix}${difference.toFixed(1)} percentage points`;
}

const METRICS: Array<[keyof EvalAggregate, string]> = [
  ['taskSuccess', 'Task success'],
  ['routingAccuracy', 'Routing accuracy'],
  ['clarificationCompliance', 'Clarification compliance'],
  ['toolSequenceCompliance', 'Tool-sequence compliance'],
  ['groundedOptionPrecision', 'Grounded-option precision'],
  ['distinctProviderCompliance', 'Distinct-provider compliance'],
  ['preferenceAdherence', 'Preference adherence'],
  ['confirmationViolationRate', 'Confirmation violation rate'],
  ['unauthorizedBookingRate', 'Unauthorized booking rate'],
  ['slotConflictCorrectness', 'Slot-conflict correctness'],
  ['sessionResumptionSuccess', 'Session resumption success'],
  ['stepCapRate', 'Step-cap rate'],
];

export function renderReportMarkdown(report: AgentEvalReport): string {
  assertReportIsSafe(report);
  const lines = [
    '# Agent Evaluation Report',
    '',
    report.aggregate.safetyGatePassed ? '**SAFETY GATE: PASSED**' : '**SAFETY GATE: FAILED**',
    '',
    `- Mode: ${report.mode}`,
    ...(report.model ? [`- Model: ${report.model}`] : []),
    `- Scenario runs: ${report.scenarioRuns}`,
    `- Repetitions: ${report.repetitions}`,
    `- Catalog version: ${report.catalogVersion}`,
    `- Git commit: ${report.gitCommit}`,
    `- Node: ${report.nodeVersion}`,
    `- Command: \`${report.command}\``,
    '',
    '## Metrics',
    '',
    '| Metric | Result |',
    '| --- | ---: |',
    ...METRICS.map(([key, label]) => `| ${label} | ${formatRatio(report.aggregate[key] as RatioMetric)} |`),
    '',
    '## Failed scenarios',
    '',
    ...(report.failures.length === 0
      ? ['None.']
      : report.failures.map((failure) => `- ${failure.scenarioId}: ${failure.failedChecks.join(', ')}`)),
    '',
    '## Limitations',
    '',
    ...(report.limitations.length === 0 ? ['None recorded.'] : report.limitations.map((item) => `- ${item}`)),
    '',
  ];
  return lines.join('\n');
}

function replaceAtomically(path: string, content: string): void {
  const temporaryPath = `${path}.tmp`;
  try {
    writeFileSync(temporaryPath, content, 'utf8');
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function writeReportFiles(
  outputDirectory: string,
  report: AgentEvalReport
): { json: string; markdown: string } {
  assertReportIsSafe(report);
  const baseName = `agent-eval-${report.mode}`;
  const paths = {
    json: join(outputDirectory, `${baseName}.json`),
    markdown: join(outputDirectory, `${baseName}.md`),
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  const markdown = renderReportMarkdown(report);
  mkdirSync(outputDirectory, { recursive: true });
  replaceAtomically(paths.json, json);
  replaceAtomically(paths.markdown, markdown);
  return paths;
}
