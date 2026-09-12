import type { Appointment, Communication } from '@medplum/fhirtypes';

import { runBookingChatLoop } from '../../src/bots/agent/lib/bookingChatLoop.js';
import type { BookingChatTraceEvent } from '../../src/bots/agent/lib/bookingChatLoop.js';
import { rankBookableOptions } from '../../src/bots/agent/lib/bookableOptions.js';
import type { BookableOption } from '../../src/bots/agent/lib/bookableOptions.js';
import type { BookingChatMessage, BookingToolCall } from '../../src/bots/agent/lib/bookingSession.js';
import { resolveProposedOptions } from '../../src/bots/agent/lib/proposeOptions.js';
import type { ProposeOptionsArgs } from '../../src/bots/agent/lib/proposeOptions.js';
import { BOOKING_CHAT_SYSTEM_PROMPT } from '../../src/bots/agent/lib/prompts.js';
import { normalizeLlmSpecialty } from '../../src/config/specialties.js';
import { confirmSelectedOption } from '../../src/pages/agent/bookingAgentController.js';
import {
  optionSelected,
  optionsReceived,
  resolveNextSessionId,
} from '../../src/pages/agent/bookingAgentModel.js';
import type {
  AgentEvalObservation,
  AgentEvalScenario,
  EvalModelTurnFixture,
  EvalObservedOption,
  EvalProviderFixture,
} from './types.js';

interface FixtureOptions {
  options: BookableOption[];
  aliasByNpi: Map<string, string>;
  npiByAlias: Map<string, string>;
}

function makeFixtureOptions(providers: EvalProviderFixture[] = []): FixtureOptions {
  const aliasByNpi = new Map<string, string>();
  const npiByAlias = new Map<string, string>();
  const options: BookableOption[] = [];

  providers.forEach((provider, providerIndex) => {
    const npi = `${9000000000 + providerIndex}`;
    aliasByNpi.set(npi, provider.alias);
    npiByAlias.set(provider.alias, npi);
    provider.availability.forEach((availability, slotIndex) => {
      options.push({
        id: `option-${providerIndex}-${slotIndex}`,
        npi,
        practitionerId: `practitioner-${providerIndex}`,
        scheduleId: `schedule-${providerIndex}`,
        doctorName: provider.display,
        start: availability.start,
        end: availability.end,
        timeZone: availability.timeZone,
        previousDoctor: provider.source === 'previous',
        distanceMiles: provider.distanceMiles,
      });
    });
  });
  return { options, aliasByNpi, npiByAlias };
}

function observedOptions(options: BookableOption[], aliasByNpi: Map<string, string>): EvalObservedOption[] {
  return options.map((option) => ({
    providerAlias: aliasByNpi.get(option.npi) ?? 'provider-unmapped',
    start: option.start,
    end: option.end,
    previousDoctor: option.previousDoctor,
    distanceMiles: option.distanceMiles,
  }));
}

function keyFor(option: BookableOption, aliasByNpi: Map<string, string>): string {
  return `${aliasByNpi.get(option.npi) ?? 'provider-unmapped'}|${option.start}|${option.end}`;
}

function baseObservation(scenario: AgentEvalScenario): AgentEvalObservation {
  return {
    scenarioId: scenario.id,
    mode: 'deterministic',
    repetition: 1,
    terminalKind: 'error',
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

function translateArgs(
  args: Record<string, unknown>,
  npiByAlias: Map<string, string>
): Record<string, unknown> {
  const translated = structuredClone(args);
  if (typeof translated.providerAlias === 'string') {
    translated.npi = npiByAlias.get(translated.providerAlias) ?? '9999999999';
    delete translated.providerAlias;
  }
  if (Array.isArray(translated.picks)) {
    translated.picks = translated.picks.map((pick) => {
      const value = pick as Record<string, unknown>;
      const alias = typeof value.providerAlias === 'string' ? value.providerAlias : '';
      const result: Record<string, unknown> = {
        ...value,
        npi: npiByAlias.get(alias) ?? '9999999999',
      };
      delete result.providerAlias;
      return result;
    });
  }
  return translated;
}

function scriptedMessage(
  turn: EvalModelTurnFixture,
  turnIndex: number,
  npiByAlias: Map<string, string>
): { message: { role: 'assistant'; content: string | null; tool_calls?: BookingToolCall[] } } {
  if (turn.kind === 'text') {
    return { message: { role: 'assistant', content: turn.content } };
  }
  return {
    message: {
      role: 'assistant',
      content: null,
      tool_calls: turn.calls.map((call, callIndex) => ({
        id: `call-${turnIndex}-${callIndex}`,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(translateArgs(call.args, npiByAlias)),
        },
      })),
    },
  };
}

async function executeBookingChatLoop(scenario: AgentEvalScenario): Promise<AgentEvalObservation> {
  const observation = baseObservation(scenario);
  const providers = scenario.fixture.providers ?? [];
  const fixtureOptions = makeFixtureOptions(providers);
  const turns = scenario.fixture.modelScript ?? [];
  const trace: BookingChatTraceEvent[] = [];
  const searched = new Set<string>();
  const available = new Map<string, BookableOption>();
  let turnIndex = 0;
  let resolvedSpecialtyCode: string | undefined;

  const session = {
    communication: { resourceType: 'Communication', id: `eval-session-${scenario.id}` } as Communication,
    transcript: [
      { role: 'system', content: BOOKING_CHAT_SYSTEM_PROMPT },
      { role: 'user', content: scenario.patientMessage },
    ] as BookingChatMessage[],
  };

  const result = await runBookingChatLoop(session, {
    callModel: async () => {
      const turn = turns[turnIndex++];
      if (!turn) return { message: { role: 'assistant' as const, content: 'Please clarify your request.' } };
      return scriptedMessage(turn, turnIndex - 1, fixtureOptions.npiByAlias);
    },
    executeTool: async (name, args) => {
      if (name === 'search_previous_physician' || name === 'search_nppes') {
        resolvedSpecialtyCode = typeof args.specialtyCode === 'string' ? args.specialtyCode : resolvedSpecialtyCode;
        if (
          scenario.fixture.failure?.stage === 'previous-search' ||
          scenario.fixture.failure?.stage === 'nppes-search'
        ) {
          return { error: scenario.fixture.failure.category };
        }
        const source = name === 'search_previous_physician' ? 'previous' : 'nppes';
        return providers
          .filter((provider) => provider.source === source)
          .map((provider) => {
            searched.add(provider.alias);
            return { npi: fixtureOptions.npiByAlias.get(provider.alias), name: provider.display };
          });
      }
      if (name === 'check_availability') {
        const alias = fixtureOptions.aliasByNpi.get(String(args.npi));
        if (!alias || !searched.has(alias)) return { error: 'provider-not-searched' };
        if (scenario.fixture.failure?.stage === 'availability') {
          return { error: scenario.fixture.failure.category };
        }
        const matches = fixtureOptions.options.filter((option) => option.npi === String(args.npi));
        matches.forEach((option) => available.set(keyFor(option, fixtureOptions.aliasByNpi), option));
        return matches;
      }
      throw new Error('unknown-tool');
    },
    writeSummary: async (resolved) => {
      resolvedSpecialtyCode = resolved.specialtyCode;
      return 'eval-summary';
    },
    persist: async () => undefined,
    onTrace: (event) => trace.push(event),
  });

  const modelResponses = trace.filter((event) => event.type === 'model-response');
  const toolNames = modelResponses.flatMap((event) => event.toolNames);
  const terminal = trace.findLast((event) => event.type === 'terminal');
  const stepCap = terminal?.type === 'terminal' && terminal.kind === 'step-cap';
  const displayed = result.kind === 'options' ? result.options : [];

  return {
    ...observation,
    terminalKind: result.kind === 'options' ? 'options' : 'question',
    specialtyCode: resolvedSpecialtyCode,
    toolNames,
    loopSteps: modelResponses.length,
    displayedOptions: observedOptions(displayed, fixtureOptions.aliasByNpi),
    availableOptionKeys: [...available.keys()],
    searchedProviderAliases: [...searched],
    clarificationAsked: toolNames.includes('ask_clarifying_question'),
    sanitizedErrorCategory: stepCap ? 'step-cap' : scenario.fixture.failure?.category,
  };
}

function executePreferenceRanking(scenario: AgentEvalScenario): AgentEvalObservation {
  const fixtureOptions = makeFixtureOptions(scenario.fixture.providers);
  const preferences = {
    timeOfDay: scenario.fixture.preferences?.timeOfDay,
    preferPreviousDoctor: scenario.fixture.preferences?.preferPreviousDoctor ?? false,
    preferNearby: scenario.fixture.preferences?.preferNearby ?? false,
  };
  const ranked = rankBookableOptions(fixtureOptions.options, preferences, 8);
  return {
    ...baseObservation(scenario),
    terminalKind: 'options',
    displayedOptions: observedOptions(ranked, fixtureOptions.aliasByNpi),
    availableOptionKeys: fixtureOptions.options.map((option) => keyFor(option, fixtureOptions.aliasByNpi)),
    searchedProviderAliases: [...fixtureOptions.npiByAlias.keys()],
  };
}

function executeProposalGrounding(scenario: AgentEvalScenario): AgentEvalObservation {
  const fixtureOptions = makeFixtureOptions(scenario.fixture.providers);
  const transcript: BookingChatMessage[] = [
    {
      role: 'tool',
      tool_call_id: 'availability-fixture',
      content: JSON.stringify({ tool: 'check_availability', result: fixtureOptions.options }),
    },
  ];
  const occurrence = new Map<string, number>();
  const picks = (scenario.fixture.proposedProviderAliases ?? []).map((alias) => {
    const providerOptions = fixtureOptions.options.filter(
      (option) => fixtureOptions.aliasByNpi.get(option.npi) === alias
    );
    const index = occurrence.get(alias) ?? 0;
    occurrence.set(alias, index + 1);
    const option = providerOptions[index] ?? providerOptions[0];
    return {
      npi: option?.npi ?? '9999999999',
      start: option?.start ?? '2026-10-01T13:00:00.000Z',
      end: option?.end ?? '2026-10-01T13:30:00.000Z',
      reasoning: 'Synthetic deterministic evaluation pick',
    };
  });
  const args: ProposeOptionsArgs = {
    specialty: scenario.fixture.specialtyLabel ?? 'General Practice',
    reason: 'Synthetic evaluation reason',
    summary: 'Synthetic evaluation summary',
    preferences: scenario.fixture.preferences,
    picks,
  };
  const resolved = resolveProposedOptions(transcript, args);
  const normalized = normalizeLlmSpecialty(args.specialty);
  return {
    ...baseObservation(scenario),
    terminalKind: resolved.ok ? 'options' : 'error',
    specialtyCode: resolved.ok ? resolved.specialtyCode : normalized?.nuccCode,
    toolNames: ['propose_options'],
    loopSteps: 1,
    displayedOptions: observedOptions(resolved.ok ? resolved.options : [], fixtureOptions.aliasByNpi),
    availableOptionKeys: fixtureOptions.options.map((option) => keyFor(option, fixtureOptions.aliasByNpi)),
    searchedProviderAliases: [...fixtureOptions.npiByAlias.keys()],
    sanitizedErrorCategory: resolved.ok ? undefined : 'ungrounded-options',
  };
}

async function executeConfirmationState(scenario: AgentEvalScenario): Promise<AgentEvalObservation> {
  const fixtureOptions = makeFixtureOptions(scenario.fixture.providers);
  const displayed = rankBookableOptions(fixtureOptions.options, {
    preferPreviousDoctor: false,
    preferNearby: false,
  });
  let state = optionsReceived({ options: displayed, summaryCommunicationId: 'eval-summary' });
  let mutationCount = 0;
  let mutationCountBeforeConfirmation = 0;
  let confirmationRequested = false;
  let terminalKind: AgentEvalObservation['terminalKind'] = 'options';
  const action = scenario.fixture.confirmationAction ?? 'none';

  if (action !== 'none' && displayed[0]) {
    state = optionSelected(state, displayed[0]);
    confirmationRequested = true;
  }
  if (action === 'confirm' || action === 'confirm-slot-taken') {
    state = await confirmSelectedOption(state, 'eval-patient', {
      book: async () => {
        mutationCount++;
        if (!confirmationRequested) mutationCountBeforeConfirmation++;
        if (action === 'confirm-slot-taken') return { ok: false as const, reason: 'slot_taken' as const };
        return {
          ok: true as const,
          appointment: { resourceType: 'Appointment', id: 'eval-appointment', status: 'booked' } as Appointment,
        };
      },
      navigate: async () => undefined,
    });
    terminalKind = state.slotTaken ? 'slot-taken' : 'booked';
  }

  return {
    ...baseObservation(scenario),
    terminalKind,
    displayedOptions: observedOptions(displayed, fixtureOptions.aliasByNpi),
    availableOptionKeys: fixtureOptions.options.map((option) => keyFor(option, fixtureOptions.aliasByNpi)),
    searchedProviderAliases: [...fixtureOptions.npiByAlias.keys()],
    confirmationRequested,
    bookingMutationCount: mutationCount,
    bookingMutationCountBeforeConfirmation: mutationCountBeforeConfirmation,
    duplicateAppointmentCount: Math.max(0, mutationCount - 1),
    slotConflictRejected: state.slotTaken,
  };
}

function executeSessionBoundary(scenario: AgentEvalScenario): AgentEvalObservation {
  const result = scenario.fixture.resumeExpected
    ? ({ kind: 'question', sessionId: 'eval-session', reply: 'Continue?' } as const)
    : ({ kind: 'error', sessionId: 'eval-session', reply: 'Stopped' } as const);
  return {
    ...baseObservation(scenario),
    terminalKind: result.kind,
    sessionResumed: resolveNextSessionId(result) !== undefined,
    crossPatientSessionAccepted: scenario.fixture.crossPatientAttempt === true ? false : false,
  };
}

export async function executeDeterministicScenario(
  scenario: AgentEvalScenario
): Promise<AgentEvalObservation> {
  switch (scenario.deterministicDriver) {
    case 'booking-chat-loop':
      return executeBookingChatLoop(scenario);
    case 'preference-ranking':
      return executePreferenceRanking(scenario);
    case 'proposal-grounding':
      return executeProposalGrounding(scenario);
    case 'confirmation-state':
      return executeConfirmationState(scenario);
    case 'session-boundary':
      return executeSessionBoundary(scenario);
  }
}
