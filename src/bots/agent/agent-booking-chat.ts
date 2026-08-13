// src/bots/agent/agent-booking-chat.ts
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Communication } from '@medplum/fhirtypes';
import { BOOKING_CHAT_SYSTEM_PROMPT, buildPatientContextMessage } from './lib/prompts.js';
import { loadPatientClinicalContext } from './lib/patientContext.js';
import {
  BOOKING_CHAT_TOOL_SCHEMAS,
  checkAvailabilityTool,
  collectSearchedCandidates,
  searchNppesTool,
  searchPreviousPhysicianTool,
} from './lib/bookingChatTools.js';
import { createBookingSession, loadBookingSession, persistBookingSession } from './lib/bookingSession.js';
import type { BookingChatMessage, BookingSession, BookingToolCall } from './lib/bookingSession.js';
import { resolveProposedOptions } from './lib/proposeOptions.js';
import type { ProposeOptionsArgs } from './lib/proposeOptions.js';
import type { BookableOption } from './lib/bookableOptions.js';

export type BookingChatInput = { patientId: string; message: string; sessionId?: string };

export type BookingChatResult =
  | { kind: 'question'; sessionId: string; reply: string }
  | { kind: 'options'; sessionId: string; options: BookableOption[]; summaryCommunicationId: string }
  | { kind: 'error'; sessionId: string; reply: string };

export const MAX_TOOL_LOOP_STEPS = 8;

interface GeminiToolResponse {
  message: { role: 'assistant'; content: string | null; tool_calls?: BookingToolCall[] };
}

type GeminiToolCaller = (transcript: BookingChatMessage[], apiKey: string) => Promise<GeminiToolResponse>;

let geminiToolCaller: GeminiToolCaller = callGeminiWithTools;

/** Test-only seam. */
export function __setGeminiToolCallerForTests(fn: GeminiToolCaller): void {
  geminiToolCaller = fn;
}

async function callGeminiWithTools(transcript: BookingChatMessage[], apiKey: string): Promise<GeminiToolResponse> {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-3.5-flash-lite',
      temperature: 0,
      messages: transcript,
      tools: BOOKING_CHAT_TOOL_SCHEMAS,
    }),
  });
  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status}`);
  }
  const body = await response.json();
  return { message: body.choices[0].message };
}

function toolResultMessage(callId: string, toolName: string, result: unknown): BookingChatMessage {
  return { role: 'tool', tool_call_id: callId, content: JSON.stringify({ tool: toolName, result }) };
}

async function writeSummaryCommunication(
  medplum: MedplumClient,
  patientId: string,
  resolved: Extract<ReturnType<typeof resolveProposedOptions>, { ok: true }>
): Promise<string> {
  const agentDevice = await medplum.searchOne('Device', {
    identifier: 'http://example.com/agent-config|ai-appointment-agent',
  });
  if (!agentDevice?.id) {
    throw new Error('The ai-appointment-agent Device is not configured');
  }
  const communication: Communication = await medplum.createResource({
    resourceType: 'Communication',
    status: 'preparation',
    category: [{ coding: [{ system: 'http://example.com/agent-communication-category', code: 'ai-previsit-summary' }] }],
    reasonCode: [{ text: resolved.reason }],
    note: [{ text: resolved.reason }],
    topic: { coding: [{ system: 'http://nucc.org/provider-taxonomy', code: resolved.specialtyCode }] },
    subject: { reference: `Patient/${patientId}` },
    sender: { reference: `Device/${agentDevice.id}` },
    payload: [{ contentString: resolved.summary }],
    meta: { tag: [{ code: 'ai-generated' }] },
  });
  return communication.id as string;
}

async function executeReadOnlyTool(
  medplum: MedplumClient,
  patientId: string,
  name: string,
  args: Record<string, unknown>,
  transcript: BookingChatMessage[]
): Promise<unknown> {
  switch (name) {
    case 'search_previous_physician':
      return searchPreviousPhysicianTool(medplum, patientId, args.specialtyCode as string);
    case 'search_nppes': {
      const patient = await medplum.readResource('Patient', patientId);
      return searchNppesTool(medplum, patient, args.specialtyCode as string);
    }
    case 'check_availability': {
      const npi = typeof args.npi === 'string' ? args.npi : '';
      // Provenance gate: ensurePractitionerAndSchedule creates real
      // Practitioner/PractitionerRole/Schedule resources, so it must only ever
      // run for an NPI a search tool actually returned in this session. The
      // resolved candidate additionally carries the specialty the provider was
      // matched on and its real ranked distance — both of which
      // check_availability derives from it rather than trusting the model.
      const candidate = collectSearchedCandidates(transcript).get(npi);
      if (!candidate) {
        return {
          error: `NPI ${npi} was not returned by search_previous_physician or search_nppes in this conversation. Run one of those searches first and only check availability for an NPI it returned.`,
        };
      }
      return checkAvailabilityTool(medplum, args as { npi: string; startOffsetDays?: number; windowDays?: number }, candidate);
    }
    default:
      throw new Error(`Unknown booking chat tool: ${name}`);
  }
}

export async function handler(medplum: MedplumClient, event: BotEvent<BookingChatInput>): Promise<BookingChatResult> {
  const { patientId, message, sessionId } = event.input;
  const apiKey = event.secrets['GEMINI_API_KEY']?.valueString as string;

  let session: BookingSession;
  if (sessionId) {
    session = await loadBookingSession(medplum, sessionId, patientId);
    session = { ...session, transcript: [...session.transcript, { role: 'user', content: message }] };
  } else {
    const context = await loadPatientClinicalContext(medplum, patientId);
    const initialTranscript: BookingChatMessage[] = [
      { role: 'system', content: BOOKING_CHAT_SYSTEM_PROMPT },
      { role: 'system', content: buildPatientContextMessage(context) },
      { role: 'user', content: message },
    ];
    session = await createBookingSession(medplum, patientId, initialTranscript);
  }

  for (let step = 0; step < MAX_TOOL_LOOP_STEPS; step++) {
    const response = await geminiToolCaller(session.transcript, apiKey);
    const toolCalls = response.message.tool_calls ?? [];

    if (toolCalls.length === 0) {
      session = { ...session, transcript: [...session.transcript, { role: 'assistant', content: response.message.content }] };
      await persistBookingSession(medplum, session, 'in-progress');
      return { kind: 'question', sessionId: session.communication.id as string, reply: response.message.content ?? '' };
    }

    session = { ...session, transcript: [...session.transcript, { role: 'assistant', content: response.message.content, tool_calls: toolCalls }] };

    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        session = { ...session, transcript: [...session.transcript, toolResultMessage(call.id, call.function.name, { error: `Could not parse tool arguments: ${errorMessage}` })] };
        continue;
      }

      if (call.function.name === 'ask_clarifying_question') {
        session = { ...session, transcript: appendSkippedRemainder(session.transcript, toolCalls, i, call, 'ok') };
        await persistBookingSession(medplum, session, 'in-progress');
        return { kind: 'question', sessionId: session.communication.id as string, reply: args.question as string };
      }

      if (call.function.name === 'propose_options') {
        const resolved = resolveProposedOptions(session.transcript, args as unknown as ProposeOptionsArgs);
        if (!resolved.ok) {
          session = { ...session, transcript: [...session.transcript, toolResultMessage(call.id, 'propose_options', { error: resolved.errorForModel })] };
          continue;
        }
        if (resolved.reason.trim() === '' || resolved.summary.trim() === '') {
          session = {
            ...session,
            transcript: [
              ...session.transcript,
              toolResultMessage(call.id, 'propose_options', { error: 'reason and summary must not be empty' }),
            ],
          };
          continue;
        }
        const summaryCommunicationId = await writeSummaryCommunication(medplum, patientId, resolved);
        session = { ...session, transcript: appendSkippedRemainder(session.transcript, toolCalls, i, call, { ok: true }) };
        await persistBookingSession(medplum, session, 'completed');
        return { kind: 'options', sessionId: session.communication.id as string, options: resolved.options, summaryCommunicationId };
      }

      try {
        const output = await executeReadOnlyTool(medplum, patientId, call.function.name, args, session.transcript);
        session = { ...session, transcript: [...session.transcript, toolResultMessage(call.id, call.function.name, output)] };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        session = { ...session, transcript: [...session.transcript, toolResultMessage(call.id, call.function.name, { error: errorMessage })] };
      }
    }
  }

  await persistBookingSession(medplum, session, 'stopped');
  return { kind: 'error', sessionId: session.communication.id as string, reply: "I wasn't able to find a good match — let's start again." };
}

function appendSkippedRemainder(
  transcript: BookingChatMessage[],
  toolCalls: BookingToolCall[],
  handledIndex: number,
  handledCall: BookingToolCall,
  handledResult: unknown
): BookingChatMessage[] {
  const messages = [...transcript, toolResultMessage(handledCall.id, handledCall.function.name, handledResult)];
  for (let j = handledIndex + 1; j < toolCalls.length; j++) {
    messages.push(toolResultMessage(toolCalls[j].id, toolCalls[j].function.name, { skipped: true }));
  }
  return messages;
}
