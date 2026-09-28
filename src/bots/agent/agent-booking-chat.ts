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
import type { BookingChatMessage, BookingSession } from './lib/bookingSession.js';
import { runBookingChatLoop } from './lib/bookingChatLoop.js';
import type { BookingChatLoopResult, BookingChatModelResponse, BookingChatTraceEvent } from './lib/bookingChatLoop.js';
export { MAX_TOOL_LOOP_STEPS } from './lib/bookingChatLoop.js';
import type { resolveProposedOptions } from './lib/proposeOptions.js';
import { noopTelemetry } from './lib/agentTelemetry.js';
import type { AgentTelemetry } from './lib/agentTelemetry.js';

export type BookingChatInput = { patientId: string; message: string; sessionId?: string };

export type BookingChatResult = BookingChatLoopResult;

export const GEMINI_BOOKING_MODEL = 'gemini-3.5-flash-lite';

const GEMINI_RETRY_DELAYS_MS = [1_000, 4_000, 16_000, 60_000] as const;
const RETRYABLE_GEMINI_STATUSES = new Set([429, 500, 502, 503, 504]);

type GeminiToolCaller = (transcript: BookingChatMessage[], apiKey: string) => Promise<BookingChatModelResponse>;

let geminiToolCaller: GeminiToolCaller = callGeminiBookingModel;

/** Test-only seam. */
export function __setGeminiToolCallerForTests(fn: GeminiToolCaller): void {
  geminiToolCaller = fn;
}

export async function callGeminiBookingModel(
  transcript: BookingChatMessage[],
  apiKey: string
): Promise<BookingChatModelResponse> {
  for (let attempt = 0; attempt <= GEMINI_RETRY_DELAYS_MS.length; attempt += 1) {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GEMINI_BOOKING_MODEL,
        temperature: 0,
        messages: transcript,
        tools: BOOKING_CHAT_TOOL_SCHEMAS,
      }),
    });
    if (response.ok) {
      const body = await response.json();
      return { message: body.choices[0].message, usage: body.usage, retries: attempt };
    }
    if (!RETRYABLE_GEMINI_STATUSES.has(response.status) || attempt === GEMINI_RETRY_DELAYS_MS.length) {
      throw new Error(`Gemini request failed: ${response.status}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, GEMINI_RETRY_DELAYS_MS[attempt] + Math.random() * 250);
    });
  }
  throw new Error('Gemini request retry loop exhausted');
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
  transcript: BookingChatMessage[],
  telemetry: AgentTelemetry
): Promise<unknown> {
  switch (name) {
    case 'search_previous_physician':
      return telemetry.time('tool.previous-search', () =>
        searchPreviousPhysicianTool(medplum, patientId, args.specialtyCode as string)
      );
    case 'search_nppes':
      return telemetry.time('tool.nppes-search', async () => {
        const patient = await medplum.readResource('Patient', patientId);
        return searchNppesTool(medplum, patient, args.specialtyCode as string);
      });
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
      return checkAvailabilityTool(
        medplum,
        args as { npi: string; startOffsetDays?: number; windowDays?: number },
        candidate,
        telemetry
      );
    }
    default:
      throw new Error(`Unknown booking chat tool: ${name}`);
  }
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<BookingChatInput>,
  onTrace?: (event: BookingChatTraceEvent) => void,
  telemetry: AgentTelemetry = noopTelemetry
): Promise<BookingChatResult> {
  const { patientId, message, sessionId } = event.input;
  const apiKey = event.secrets['GEMINI_API_KEY']?.valueString as string;

  return telemetry.time('turn.total', async () => {
    let session: BookingSession;
    if (sessionId) {
      session = await telemetry.time('session.load', () => loadBookingSession(medplum, sessionId, patientId));
      session = { ...session, transcript: [...session.transcript, { role: 'user', content: message }] };
    } else {
      const context = await telemetry.time('context.load', () => loadPatientClinicalContext(medplum, patientId));
      const initialTranscript: BookingChatMessage[] = [
        { role: 'system', content: BOOKING_CHAT_SYSTEM_PROMPT },
        { role: 'system', content: buildPatientContextMessage(context) },
        { role: 'user', content: message },
      ];
      session = await telemetry.time('session.create', () =>
        createBookingSession(medplum, patientId, initialTranscript)
      );
    }

    return runBookingChatLoop(session, {
      callModel: (transcript) => geminiToolCaller(transcript, apiKey),
      executeTool: (name, args, transcript) =>
        executeReadOnlyTool(medplum, patientId, name, args, transcript, telemetry),
      writeSummary: (resolved) => writeSummaryCommunication(medplum, patientId, resolved),
      persist: (currentSession, status) => persistBookingSession(medplum, currentSession, status),
      onTrace,
      telemetry,
    });
  });
}
