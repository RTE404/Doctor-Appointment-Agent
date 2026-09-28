import { MedplumClient, OperationOutcomeError } from '@medplum/core';
import type { BotEvent } from '@medplum/core';
import type { Communication, Patient, Resource } from '@medplum/fhirtypes';
import { randomUUID } from 'node:crypto';

import { handler as bookingChatHandler } from '../../src/bots/agent/agent-booking-chat.js';
import type { BookingChatInput } from '../../src/bots/agent/agent-booking-chat.js';
import { handler as bookAppointmentHandler } from '../../src/bots/agent/agent-book-appointment.js';
import { createAgentTelemetry } from '../../src/bots/agent/lib/agentTelemetry.js';
import type { AgentTelemetry, TelemetrySnapshot } from '../../src/bots/agent/lib/agentTelemetry.js';
import type { BookingChatTraceEvent } from '../../src/bots/agent/lib/bookingChatLoop.js';
import type { BookableOption } from '../../src/bots/agent/lib/bookableOptions.js';
import { isDemoGenerated, withDemoGeneratedTag } from '../../src/demo/demoTag.js';
import { loginClientApplication } from '../../api/server/medplumClientApplication.js';
import { buildScenarioCatalog } from './buildScenarioCatalog.js';
import type { AgentEvalExecutor } from './runAgentEval.js';
import type { AgentEvalObservation, AgentEvalScenario, EvalObservedOption } from './types.js';

const SYNTHEA_IDENTIFIER_SYSTEM = 'https://synthea.mitre.org/identifier';
const EVAL_RUN_TAG_SYSTEM = 'https://doctor-appointment-agent.example/fhir/eval-run';
type ActivityResourceType = 'Appointment' | 'Communication' | 'Encounter';

export interface LiveSmokeEnvironment {
  MEDPLUM_BASE_URL?: string;
  MEDPLUM_PROJECT_ID?: string;
  DEMO_MEDPLUM_CLIENT_ID?: string;
  DEMO_MEDPLUM_CLIENT_SECRET?: string;
  DEMO_WORKER_CLIENT_ID?: string;
  DEMO_WORKER_CLIENT_SECRET?: string;
  GEMINI_API_KEY?: string;
}

type CompleteLiveSmokeEnvironment = { [Key in keyof LiveSmokeEnvironment]-?: string };

export interface LiveSmokeResourceReference {
  resourceType: ActivityResourceType;
  id: string;
}

export interface LiveSmokeCleanupPlan {
  runTagCode: string;
  resources: LiveSmokeResourceReference[];
}

export interface LiveSmokeRunResult {
  terminalKind: AgentEvalObservation['terminalKind'];
  specialtyCode?: string;
  toolNames: string[];
  loopSteps: number;
  displayedOptions: EvalObservedOption[];
  availableOptionKeys: string[];
  searchedProviderAliases: string[];
  clarificationAsked: boolean;
  sessionResumed: boolean;
  sanitizedErrorCategory?: string;
  telemetry?: TelemetrySnapshot;
  bookingCompleted?: boolean;
  confirmationRequested?: boolean;
  bookingMutationCount?: number;
  bookingMutationCountBeforeConfirmation?: number;
}

export interface LiveSmokeDependencies {
  buildCleanupPlan(): LiveSmokeCleanupPlan;
  initialize(environment: CompleteLiveSmokeEnvironment): Promise<unknown>;
  run(
    session: unknown,
    scenario: AgentEvalScenario,
    plan: LiveSmokeCleanupPlan,
    environment: CompleteLiveSmokeEnvironment
  ): Promise<LiveSmokeRunResult>;
  cleanup(session: unknown, plan: LiveSmokeCleanupPlan): Promise<void>;
}

const APPROVED_SCENARIOS = buildScenarioCatalog().scenarios.filter(
  (scenario) => scenario.liveSmokeEligible
);
const APPROVED_BY_ID = new Map(APPROVED_SCENARIOS.map((scenario) => [scenario.id, scenario]));
export const LIVE_SMOKE_SCENARIO_IDS = new Set(APPROVED_BY_ID.keys());

function requireCompleteEnvironment(environment: LiveSmokeEnvironment): CompleteLiveSmokeEnvironment {
  const keys: Array<keyof LiveSmokeEnvironment> = [
    'MEDPLUM_BASE_URL',
    'MEDPLUM_PROJECT_ID',
    'DEMO_MEDPLUM_CLIENT_ID',
    'DEMO_MEDPLUM_CLIENT_SECRET',
    'DEMO_WORKER_CLIENT_ID',
    'DEMO_WORKER_CLIENT_SECRET',
    'GEMINI_API_KEY',
  ];
  if (keys.some((key) => !environment[key]?.trim())) {
    throw new Error('live smoke not run: missing required local configuration');
  }
  return environment as CompleteLiveSmokeEnvironment;
}

function assertApprovedScenario(scenario: AgentEvalScenario): void {
  const approved = APPROVED_BY_ID.get(scenario.id);
  if (!approved || !scenario.liveSmokeEligible) {
    throw new Error(`Scenario ${scenario.id} is not approved for live smoke`);
  }
  if (JSON.stringify(scenario) !== JSON.stringify(approved)) {
    throw new Error(`Scenario ${scenario.id} does not match the reviewed synthetic catalog`);
  }
}

interface ProductionSession {
  worker: MedplumClient;
  syntheticPatientId: string;
}

function asProductionSession(session: unknown): ProductionSession {
  if (typeof session !== 'object' || session === null || !('worker' in session) || !('syntheticPatientId' in session)) {
    throw new Error('Live smoke session is invalid');
  }
  return session as ProductionSession;
}

async function initializeProduction(environment: CompleteLiveSmokeEnvironment): Promise<ProductionSession> {
  const browser = await loginClientApplication(
    {
      MEDPLUM_BASE_URL: environment.MEDPLUM_BASE_URL,
      MEDPLUM_PROJECT_ID: environment.MEDPLUM_PROJECT_ID,
      DEMO_MEDPLUM_CLIENT_ID: environment.DEMO_MEDPLUM_CLIENT_ID,
      DEMO_MEDPLUM_CLIENT_SECRET: environment.DEMO_MEDPLUM_CLIENT_SECRET,
    },
    undefined,
    { requireReadOnlyAccessPolicy: true }
  );
  const browserClient = browser.client as MedplumClient;
  const patients = await browserClient.searchResources('Patient', {
    identifier: `${SYNTHEA_IDENTIFIER_SYSTEM}|`,
    _count: '1',
  });
  const patient = patients[0] as Patient | undefined;
  if (
    !patient?.id ||
    !patient.identifier?.some((identifier) => identifier.system === SYNTHEA_IDENTIFIER_SYSTEM)
  ) {
    throw new Error('Synthetic demo patient is unavailable');
  }
  const worker = await loginClientApplication({
    MEDPLUM_BASE_URL: environment.MEDPLUM_BASE_URL,
    MEDPLUM_PROJECT_ID: environment.MEDPLUM_PROJECT_ID,
    DEMO_MEDPLUM_CLIENT_ID: environment.DEMO_WORKER_CLIENT_ID,
    DEMO_MEDPLUM_CLIENT_SECRET: environment.DEMO_WORKER_CLIENT_SECRET,
  });
  return { worker: worker.client as MedplumClient, syntheticPatientId: patient.id };
}

function addRunTags(resource: Resource, runTagCode: string): Resource {
  const meta = withDemoGeneratedTag(resource.meta);
  const alreadyTagged = meta.tag?.some(
    (tag) => tag.system === EVAL_RUN_TAG_SYSTEM && tag.code === runTagCode
  );
  return {
    ...resource,
    meta: {
      ...meta,
      tag: alreadyTagged
        ? meta.tag
        : [...(meta.tag ?? []), { system: EVAL_RUN_TAG_SYSTEM, code: runTagCode }],
    },
  } as Resource;
}

export interface BookingMutationCounter {
  count: number;
}

function isBookUrl(url: unknown): boolean {
  return String(url).endsWith('/Appointment/$book');
}

export function createTrackingClient(
  client: MedplumClient,
  plan: LiveSmokeCleanupPlan,
  counter: BookingMutationCounter
): MedplumClient {
  const activityTypes = new Set<ActivityResourceType>(['Appointment', 'Communication', 'Encounter']);
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'createResource') {
        return async (resource: Resource): Promise<Resource> => {
          const created = await target.createResource(addRunTags(resource, plan.runTagCode));
          if (created.id && activityTypes.has(created.resourceType as ActivityResourceType)) {
            plan.resources.push({
              resourceType: created.resourceType as ActivityResourceType,
              id: created.id,
            });
          }
          return created;
        };
      }
      if (property === 'post') {
        return async (url: URL | string, body: unknown, ...rest: unknown[]): Promise<unknown> => {
          if (!isBookUrl(url)) {
            return (target.post as (...args: unknown[]) => Promise<unknown>).call(target, url, body, ...rest);
          }
          const parameters = body as { parameter?: Array<{ name: string; resource?: Resource }> };
          const tagged = {
            ...parameters,
            parameter: (parameters.parameter ?? []).map((parameter) =>
              parameter.resource ? { ...parameter, resource: addRunTags(parameter.resource, plan.runTagCode) } : parameter
            ),
          };
          counter.count += 1;
          return (target.post as (...args: unknown[]) => Promise<unknown>).call(target, url, tagged, ...rest);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as MedplumClient;
}

// Note: addRunTags applies withDemoGeneratedTag too; the booking handler
// already set the demo tag, so this is idempotent.

export async function confirmAndBookTopOption(
  client: MedplumClient,
  input: { patientId: string; option: BookableOption; summaryCommunicationId: string },
  plan: LiveSmokeCleanupPlan,
  counter: BookingMutationCounter,
  telemetry: AgentTelemetry,
  book: typeof bookAppointmentHandler = bookAppointmentHandler
): Promise<{ confirmationRequested: true; bookingCompleted: boolean; mutationsBeforeConfirmation: number }> {
  // Explicit confirmation step: nothing may have been booked before this point.
  const mutationsBeforeConfirmation = counter.count;
  const result = await book(
    client,
    {
      bot: { identifier: { system: 'http://example.com', value: 'agent-book-appointment' } },
      contentType: 'application/json',
      input: {
        patientId: input.patientId,
        practitionerId: input.option.practitionerId,
        scheduleId: input.option.scheduleId,
        start: input.option.start,
        end: input.option.end,
        summaryCommunicationId: input.summaryCommunicationId,
      },
      secrets: {},
    },
    telemetry
  );
  if (result.ok && result.appointment.id) {
    plan.resources.push({ resourceType: 'Appointment', id: result.appointment.id });
  }
  return { confirmationRequested: true, bookingCompleted: result.ok, mutationsBeforeConfirmation };
}

function sanitizeLiveOptions(options: BookableOption[]): {
  displayedOptions: EvalObservedOption[];
  keys: string[];
  aliases: string[];
} {
  const aliasByProvider = new Map<string, string>();
  const displayedOptions = options.map((option) => {
    const providerKey = option.practitionerId;
    let alias = aliasByProvider.get(providerKey);
    if (!alias) {
      alias = `provider-live-${aliasByProvider.size + 1}`;
      aliasByProvider.set(providerKey, alias);
    }
    return {
      providerAlias: alias,
      start: option.start,
      end: option.end,
      previousDoctor: option.previousDoctor,
      distanceMiles: option.distanceMiles,
    };
  });
  return {
    displayedOptions,
    keys: displayedOptions.map((option) => `${option.providerAlias}|${option.start}|${option.end}`),
    aliases: [...new Set(displayedOptions.map((option) => option.providerAlias))],
  };
}

async function runProduction(
  sessionValue: unknown,
  scenario: AgentEvalScenario,
  plan: LiveSmokeCleanupPlan,
  environment: CompleteLiveSmokeEnvironment
): Promise<LiveSmokeRunResult> {
  const session = asProductionSession(sessionValue);
  const telemetry = createAgentTelemetry();
  const counter: BookingMutationCounter = { count: 0 };
  const client = createTrackingClient(session.worker, plan, counter);
  const trace: BookingChatTraceEvent[] = [];
  const event: BotEvent<BookingChatInput> = {
    bot: { identifier: { system: 'http://example.com', value: 'agent-booking-chat' } },
    contentType: 'application/json',
    input: { patientId: session.syntheticPatientId, message: scenario.patientMessage },
    secrets: {
      GEMINI_API_KEY: { name: 'GEMINI_API_KEY', valueString: environment.GEMINI_API_KEY },
    },
  };
  const result = await bookingChatHandler(client, event, (traceEvent) => trace.push(traceEvent), telemetry);
  const modelResponses = trace.filter((traceEvent) => traceEvent.type === 'model-response');
  const toolNames = modelResponses.flatMap((traceEvent) => traceEvent.toolNames);
  const options = result.kind === 'options' ? result.options : [];
  const sanitized = sanitizeLiveOptions(options);
  let specialtyCode: string | undefined;
  if (result.kind === 'options') {
    const summary = await client.readResource('Communication', result.summaryCommunicationId) as Communication;
    specialtyCode = summary.topic?.coding?.find(
      (coding) => coding.system === 'http://nucc.org/provider-taxonomy'
    )?.code;
  }
  let booking: Awaited<ReturnType<typeof confirmAndBookTopOption>> | undefined;
  if (result.kind === 'options' && result.options.length > 0) {
    booking = await confirmAndBookTopOption(
      client,
      { patientId: session.syntheticPatientId, option: result.options[0], summaryCommunicationId: result.summaryCommunicationId },
      plan,
      counter,
      telemetry
    );
  }
  return {
    terminalKind: result.kind === 'options' ? 'options' : result.kind === 'error' ? 'error' : 'question',
    specialtyCode,
    toolNames,
    loopSteps: modelResponses.length,
    displayedOptions: sanitized.displayedOptions,
    availableOptionKeys: sanitized.keys,
    // The production provenance gate permits availability checks only after a
    // provider search. Final displayed options therefore form a conservative
    // subset of searched providers without retaining external identifiers.
    searchedProviderAliases: sanitized.aliases,
    clarificationAsked: toolNames.includes('ask_clarifying_question'),
    sessionResumed: result.kind === 'question' || result.kind === 'options',
    telemetry: telemetry.snapshot(),
    confirmationRequested: booking?.confirmationRequested ?? false,
    bookingCompleted: booking?.bookingCompleted ?? false,
    bookingMutationCount: counter.count,
    bookingMutationCountBeforeConfirmation: booking?.mutationsBeforeConfirmation ?? counter.count,
  };
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof OperationOutcomeError &&
    error.outcome.issue?.some((issue) => issue.code === 'not-found') === true
  );
}

async function cleanupProduction(sessionValue: unknown, plan: LiveSmokeCleanupPlan): Promise<void> {
  const { worker } = asProductionSession(sessionValue);
  const unique = [...new Map(plan.resources.map((reference) => [
    `${reference.resourceType}/${reference.id}`,
    reference,
  ])).values()].reverse();
  for (const reference of unique) {
    let resource: Resource;
    try {
      resource = await worker.readResource(reference.resourceType, reference.id);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    if (
      !isDemoGenerated(resource.meta) ||
      !resource.meta?.tag?.some(
        (tag) => tag.system === EVAL_RUN_TAG_SYSTEM && tag.code === plan.runTagCode
      )
    ) {
      throw new Error('Live smoke cleanup refused an untagged resource');
    }
    if (
      reference.resourceType === 'Appointment' &&
      'status' in resource &&
      (resource.status === 'pending' || resource.status === 'booked')
    ) {
      try {
        await worker.post(worker.fhirUrl('Appointment', reference.id, '$cancel'), {});
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    try {
      await worker.deleteResource(reference.resourceType, reference.id);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  plan.resources.splice(0);
}

const productionDependencies: LiveSmokeDependencies = {
  buildCleanupPlan: () => ({ runTagCode: `agent-eval-${randomUUID()}`, resources: [] }),
  initialize: initializeProduction,
  run: runProduction,
  cleanup: cleanupProduction,
};

export function createLiveSmokeExecutor(
  environment: LiveSmokeEnvironment,
  dependencies: LiveSmokeDependencies = productionDependencies
): AgentEvalExecutor {
  const completeEnvironment = requireCompleteEnvironment(environment);
  const cleanupPlan = dependencies.buildCleanupPlan();
  let sessionPromise: Promise<unknown> | undefined;
  let executed = 0;
  return {
    async execute(scenario, repetition) {
      assertApprovedScenario(scenario);
      const warmth = executed === 0 ? 'cold' : 'warm';
      executed += 1;
      sessionPromise ??= dependencies.initialize(completeEnvironment);
      const session = await sessionPromise;
      try {
        const result = await dependencies.run(session, scenario, cleanupPlan, completeEnvironment);
        return {
          scenarioId: scenario.id,
          mode: 'live-smoke',
          repetition,
          ...result,
          warmth,
          confirmationRequested: result.confirmationRequested ?? false,
          bookingMutationCount: result.bookingMutationCount ?? 0,
          bookingMutationCountBeforeConfirmation: result.bookingMutationCountBeforeConfirmation ?? 0,
          bookingCompleted: result.bookingCompleted ?? false,
          crossPatientSessionAccepted: false,
          duplicateAppointmentCount: 0,
          slotConflictRejected: false,
        };
      } finally {
        try {
          await dependencies.cleanup(session, cleanupPlan);
        } catch {
          throw new Error('Live smoke cleanup failed');
        }
      }
    },
  };
}
