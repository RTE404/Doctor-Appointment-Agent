import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

import { GEMINI_BOOKING_MODEL } from '../../src/bots/agent/agent-booking-chat.js';
import { executeDeterministicScenario } from './deterministicExecutor.js';
import { createLiveSmokeExecutor } from './liveSmokeExecutor.js';
import { loadScenarioCatalog } from './loadScenarios.js';
import { createModelExecutor } from './modelExecutor.js';
import { summarizePerformance } from './performance.js';
import { loadPricing } from './pricing.js';
import { buildReport, writeReportFiles } from './report.js';
import { aggregateEvaluation } from './scorers.js';
import type {
  AgentEvalCatalog,
  AgentEvalObservation,
  AgentEvalScenario,
  EvalAggregate,
  EvalCategory,
} from './types.js';

export interface AgentEvalExecutor {
  execute(scenario: AgentEvalScenario, repetition: number): Promise<AgentEvalObservation>;
}

export interface RunEvaluationResult {
  observations: AgentEvalObservation[];
  aggregate: EvalAggregate;
}

export interface EvalCliOptions {
  mode: AgentEvalObservation['mode'];
  repetitions: number;
  scenario?: string;
  category?: EvalCategory;
  output: string;
}

const MODES = new Set<AgentEvalObservation['mode']>(['deterministic', 'model', 'live-smoke']);
const CATEGORIES = new Set<EvalCategory>([
  'routing-clarification',
  'preference-ranking',
  'grounding-tampering',
  'availability-dependency',
  'confirmation-session',
]);

export function parseCliArgs(args: string[]): EvalCliOptions {
  const options: EvalCliOptions = {
    mode: 'deterministic',
    repetitions: 1,
    output: 'results/evals',
  };
  let repetitionsProvided = false;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('Flag ' + (flag ?? '(missing)') + ' requires a value');
    }
    switch (flag) {
      case '--mode':
        if (!MODES.has(value as AgentEvalObservation['mode'])) throw new Error('Unknown mode: ' + value);
        options.mode = value as AgentEvalObservation['mode'];
        break;
      case '--repetitions': {
        const repetitions = Number(value);
        if (!Number.isInteger(repetitions) || repetitions < 1) {
          throw new Error('repetitions must be a positive integer');
        }
        options.repetitions = repetitions;
        repetitionsProvided = true;
        break;
      }
      case '--scenario':
        options.scenario = value;
        break;
      case '--category':
        if (!CATEGORIES.has(value as EvalCategory)) throw new Error('Unknown category: ' + value);
        options.category = value as EvalCategory;
        break;
      case '--output':
        options.output = value;
        break;
      default:
        throw new Error('Unknown flag: ' + flag);
    }
  }
  if (options.scenario && options.category) {
    throw new Error('--scenario and --category cannot be combined');
  }
  if (options.mode === 'model' && !repetitionsProvided) {
    options.repetitions = 3;
  }
  return options;
}

export async function runEvaluation(
  catalog: AgentEvalCatalog,
  executor: AgentEvalExecutor,
  options: { mode: AgentEvalObservation['mode']; repetitions: number }
): Promise<RunEvaluationResult> {
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
    throw new Error('repetitions must be a positive integer');
  }

  const observations: AgentEvalObservation[] = [];
  for (const scenario of catalog.scenarios) {
    for (let repetition = 1; repetition <= options.repetitions; repetition++) {
      const observation = await executor.execute(scenario, repetition);
      observations.push({ ...observation, mode: options.mode, repetition });
    }
  }
  return {
    observations,
    aggregate: aggregateEvaluation(
      observations.map((observation) => ({
        scenario: catalog.scenarios.find((scenario) => scenario.id === observation.scenarioId) as AgentEvalScenario,
        observation,
      }))
    ),
  };
}

function selectScenarios(catalog: AgentEvalCatalog, options: EvalCliOptions): AgentEvalCatalog {
  const scenarios = catalog.scenarios.filter(
    (scenario) =>
      (!options.scenario || scenario.id === options.scenario) &&
      (!options.category || scenario.category === options.category)
  );
  if (scenarios.length === 0) {
    throw new Error('No scenarios matched the requested filter');
  }
  return { ...catalog, scenarios };
}

export async function runCli(args: string[]): Promise<void> {
  const options = parseCliArgs(args);
  let catalog = selectScenarios(loadScenarioCatalog('data/evals/booking-scenarios.json'), options);
  let executor: AgentEvalExecutor;
  if (options.mode === 'deterministic') {
    executor = { execute: (scenario) => executeDeterministicScenario(scenario) };
  } else if (options.mode === 'model') {
    config({ path: '.env.local', quiet: true });
    const apiKey = process.env.GEMINI_API_KEY?.trim() ?? '';
    if (apiKey === '') {
      throw new Error('GEMINI_API_KEY is not configured for model evaluation');
    }
    catalog = { ...catalog, scenarios: catalog.scenarios.filter((scenario) => scenario.modelEligible) };
    if (catalog.scenarios.length === 0) {
      throw new Error('No model-eligible scenarios matched the requested filter');
    }
    console.log('Gemini configuration: present');
    executor = createModelExecutor({ apiKey, concurrency: 1 });
  } else {
    config({ path: '.env.local', quiet: true });
    catalog = {
      ...catalog,
      scenarios: catalog.scenarios.filter((scenario) => scenario.liveSmokeEligible),
    };
    if (catalog.scenarios.length === 0) {
      throw new Error('No live-smoke scenarios matched the requested filter');
    }
    executor = createLiveSmokeExecutor({
      MEDPLUM_BASE_URL: process.env.MEDPLUM_BASE_URL,
      MEDPLUM_PROJECT_ID: process.env.MEDPLUM_PROJECT_ID,
      DEMO_MEDPLUM_CLIENT_ID: process.env.DEMO_MEDPLUM_CLIENT_ID,
      DEMO_MEDPLUM_CLIENT_SECRET: process.env.DEMO_MEDPLUM_CLIENT_SECRET,
      DEMO_WORKER_CLIENT_ID: process.env.DEMO_WORKER_CLIENT_ID,
      DEMO_WORKER_CLIENT_SECRET: process.env.DEMO_WORKER_CLIENT_SECRET,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    });
  }
  const result = await runEvaluation(catalog, executor, options);
  const model = GEMINI_BOOKING_MODEL;
  const performance =
    options.mode === 'deterministic' ? undefined : summarizePerformance(result.observations, loadPricing(), model);
  const report = buildReport({
    catalog,
    observations: result.observations,
    aggregate: result.aggregate,
    mode: options.mode,
    ...(options.mode !== 'deterministic' ? { model } : {}),
    repetitions: options.repetitions,
    command: 'npx tsx tools/eval/runAgentEval.ts ' + args.join(' '),
    gitCommit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
    nodeVersion: process.version,
    limitations:
      options.mode === 'model'
        ? ['Controlled tools use synthetic fixtures and do not verify a live Medplum deployment.']
        : options.mode === 'live-smoke'
          ? ['This is an eight-scenario synthetic integration smoke, not a load test.']
          : ['Model-dependent language quality is reported separately.'],
    ...(performance ? { performance } : {}),
  });
  const reportFiles = writeReportFiles(options.output, report);
  console.log(
    JSON.stringify(
      {
        mode: options.mode,
        reportFiles,
        aggregate: result.aggregate,
      },
      null,
      2
    )
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Evaluation failed');
    process.exitCode = 1;
  });
}
