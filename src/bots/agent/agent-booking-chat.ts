// src/bots/agent/agent-booking-chat.ts
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Communication } from '@medplum/fhirtypes';
import { withDemoGeneratedTag } from '../../demo/demoTag.js';
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
import { runBookingChatLoop } from './lib/bookingChatLoop.js';
import type { BookingChatLoopResult, BookingChatTraceEvent } from './lib/bookingChatLoop.js';
export { MAX_TOOL_LOOP_STEPS } from './lib/bookingChatLoop.js';
import { resolveProposedOptions } from './lib/proposeOptions.js';

export type BookingChatInput = { patientId: string; message: string; sessionId?: string };

export type BookingChatResult = BookingChatLoopResult;

interface GeminiToolResponse {
  message: { role: 'assistant'; content: string | null; tool_calls?: BookingToolCall[] };
}

type GeminiToolCaller = (transcript: BookingChatMessage[], apiKey: string) => Promise<GeminiToolResponse>;

let geminiToolCaller: GeminiToolCaller = callGeminiBookingModel;

/** Test-only seam. */
export function __setGeminiToolCallerForTests(fn: GeminiToolCaller): void {
  geminiToolCaller = fn;
}

export async function callGeminiBookingModel(
  transcript: BookingChatMessage[],
  apiKey: string
): Promise<GeminiToolResponse> {
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
    meta: withDemoGeneratedTag({ tag: [{ code: 'ai-generated' }] }),
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

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<BookingChatInput>,
  onTrace?: (event: BookingChatTraceEvent) => void
): Promise<BookingChatResult> {
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

  return runBookingChatLoop(session, {
    callModel: (transcript) => geminiToolCaller(transcript, apiKey),
    executeTool: (name, args, transcript) => executeReadOnlyTool(medplum, patientId, name, args, transcript),
    writeSummary: (resolved) => writeSummaryCommunication(medplum, patientId, resolved),
    persist: (currentSession, status) => persistBookingSession(medplum, currentSession, status),
    onTrace,
  });
}
