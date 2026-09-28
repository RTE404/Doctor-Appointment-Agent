import type { Communication } from '@medplum/fhirtypes';

import { callGeminiBookingModel } from '../../src/bots/agent/agent-booking-chat.js';
import { createAgentTelemetry } from '../../src/bots/agent/lib/agentTelemetry.js';
import { runBookingChatLoop } from '../../src/bots/agent/lib/bookingChatLoop.js';
import type { BookingChatModelResponse, BookingChatTraceEvent } from '../../src/bots/agent/lib/bookingChatLoop.js';
import type { BookableOption } from '../../src/bots/agent/lib/bookableOptions.js';
import type { BookingChatMessage } from '../../src/bots/agent/lib/bookingSession.js';
import { BOOKING_CHAT_SYSTEM_PROMPT } from '../../src/bots/agent/lib/prompts.js';
import type { AgentEvalExecutor } from './runAgentEval.js';
import type {
  AgentEvalObservation,
  AgentEvalScenario,
  EvalObservedOption,
  EvalProviderFixture,
} from './types.js';

export type EvalModelCaller = (
  transcript: BookingChatMessage[],
  apiKey: string
) => Promise<BookingChatModelResponse>;

export interface ModelExecutorOptions {
  apiKey: string;
  concurrency: number;
  callModel?: EvalModelCaller;
}

interface ControlledFixture {
  options: BookableOption[];
  aliasByNpi: Map<string, string>;
  npiByAlias: Map<string, string>;
  providerByAlias: Map<string, EvalProviderFixture>;
}

function makeControlledFixture(providers: EvalProviderFixture[] = []): ControlledFixture {
  const aliasByNpi = new Map<string, string>();
  const npiByAlias = new Map<string, string>();
  const providerByAlias = new Map<string, EvalProviderFixture>();
  const options: BookableOption[] = [];
  providers.forEach((provider, providerIndex) => {
    const npi = String(9000000000 + providerIndex);
    aliasByNpi.set(npi, provider.alias);
    npiByAlias.set(provider.alias, npi);
    providerByAlias.set(provider.alias, provider);
    provider.availability.forEach((slot, slotIndex) => {
      options.push({
        id: `model-option-${providerIndex}-${slotIndex}`,
        npi,
        practitionerId: `model-practitioner-${providerIndex}`,
        scheduleId: `model-schedule-${providerIndex}`,
        doctorName: provider.display,
        start: slot.start,
        end: slot.end,
        timeZone: slot.timeZone,
        previousDoctor: provider.source === 'previous',
        distanceMiles: provider.distanceMiles,
      });
    });
  });
  return { options, aliasByNpi, npiByAlias, providerByAlias };
}

function optionKey(option: BookableOption, aliasByNpi: Map<string, string>): string {
  return `${aliasByNpi.get(option.npi) ?? 'provider-unmapped'}|${option.start}|${option.end}`;
}

function sanitizeOptions(
  options: BookableOption[],
  aliasByNpi: Map<string, string>
): EvalObservedOption[] {
  return options.map((option) => ({
    providerAlias: aliasByNpi.get(option.npi) ?? 'provider-unmapped',
    start: option.start,
    end: option.end,
    previousDoctor: option.previousDoctor,
    distanceMiles: option.distanceMiles,
  }));
}

async function executeModelScenario(
  scenario: AgentEvalScenario,
  repetition: number,
  apiKey: string,
  callModel: EvalModelCaller
): Promise<AgentEvalObservation> {
  if (!scenario.modelEligible) {
    throw new Error(`Scenario ${scenario.id} is not model eligible`);
  }

  const fixture = makeControlledFixture(scenario.fixture.providers);
  const searchedNpis = new Set<string>();
  const available = new Map<string, BookableOption>();
  const trace: BookingChatTraceEvent[] = [];
  let specialtyCode: string | undefined;
  const telemetry = createAgentTelemetry();

  const result = await runBookingChatLoop(
    {
      communication: {
        resourceType: 'Communication',
        id: `model-eval-session-${scenario.id}-${repetition}`,
      } as Communication,
      transcript: [
        { role: 'system', content: BOOKING_CHAT_SYSTEM_PROMPT },
        {
          role: 'system',
          content:
            'Synthetic evaluation context only. No prior clinical record details are available unless a controlled tool returns them.',
        },
        { role: 'user', content: scenario.patientMessage },
      ],
    },
    {
      callModel: (transcript) => callModel(transcript, apiKey),
      executeTool: async (name, args) => {
        if (name === 'search_previous_physician' || name === 'search_nppes') {
          specialtyCode = typeof args.specialtyCode === 'string' ? args.specialtyCode : specialtyCode;
          const source = name === 'search_previous_physician' ? 'previous' : 'nppes';
          return [...fixture.providerByAlias.values()]
            .filter((provider) => provider.source === source)
            .map((provider) => {
              const npi = fixture.npiByAlias.get(provider.alias) as string;
              searchedNpis.add(npi);
              return {
                npi,
                name: provider.display,
                specialtyCode,
                previousDoctor: source === 'previous',
                distanceMiles: provider.distanceMiles,
              };
            });
        }
        if (name === 'check_availability') {
          const npi = typeof args.npi === 'string' ? args.npi : '';
          if (!searchedNpis.has(npi)) {
            return { error: 'provider-not-returned-by-search' };
          }
          const options = fixture.options.filter((option) => option.npi === npi);
          options.forEach((option) => available.set(optionKey(option, fixture.aliasByNpi), option));
          return options;
        }
        throw new Error('unknown-controlled-tool');
      },
      writeSummary: async (resolved) => {
        specialtyCode = resolved.specialtyCode;
        return 'model-eval-summary';
      },
      persist: async () => undefined,
      onTrace: (event) => trace.push(event),
      telemetry,
    }
  );

  const modelResponses = trace.filter((event) => event.type === 'model-response');
  const toolNames = modelResponses.flatMap((event) => event.toolNames);
  const terminal = trace.findLast((event) => event.type === 'terminal');
  const stepCap = terminal?.type === 'terminal' && terminal.kind === 'step-cap';
  const displayed = result.kind === 'options' ? result.options : [];

  return {
    scenarioId: scenario.id,
    mode: 'model',
    repetition,
    terminalKind: result.kind === 'options' ? 'options' : result.kind === 'error' ? 'error' : 'question',
    specialtyCode,
    toolNames,
    loopSteps: modelResponses.length,
    displayedOptions: sanitizeOptions(displayed, fixture.aliasByNpi),
    availableOptionKeys: [...available.keys()],
    searchedProviderAliases: [...searchedNpis].map(
      (npi) => fixture.aliasByNpi.get(npi) ?? 'provider-unmapped'
    ),
    clarificationAsked: toolNames.includes('ask_clarifying_question'),
    confirmationRequested: false,
    bookingMutationCount: 0,
    bookingMutationCountBeforeConfirmation: 0,
    crossPatientSessionAccepted: false,
    duplicateAppointmentCount: 0,
    slotConflictRejected: false,
    sessionResumed: false,
    sanitizedErrorCategory: stepCap ? 'step-cap' : undefined,
    telemetry: telemetry.snapshot(),
  };
}

export function createModelExecutor(options: ModelExecutorOptions): AgentEvalExecutor {
  if (options.apiKey.trim() === '') {
    throw new Error('GEMINI_API_KEY is required for model evaluation');
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('concurrency must be a positive integer');
  }
  const callModel = options.callModel ?? callGeminiBookingModel;
  return {
    execute: (scenario, repetition) =>
      executeModelScenario(scenario, repetition, options.apiKey, callModel),
  };
}
