// src/bots/agent/lib/bookingSession.ts
import type { MedplumClient } from '@medplum/core';
import type { Communication } from '@medplum/fhirtypes';

export interface BookingToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type BookingChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: BookingToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface BookingSession {
  communication: Communication;
  transcript: BookingChatMessage[];
}

const CATEGORY_SYSTEM = 'http://example.com/agent-communication-category';
const SESSION_CATEGORY_CODE = 'ai-booking-session';

async function resolveAgentDeviceReference(medplum: MedplumClient): Promise<string> {
  const agentDevice = await medplum.searchOne('Device', {
    identifier: 'http://example.com/agent-config|ai-appointment-agent',
  });
  if (!agentDevice?.id) {
    throw new Error('The ai-appointment-agent Device is not configured');
  }
  return `Device/${agentDevice.id}`;
}

export async function createBookingSession(
  medplum: MedplumClient,
  patientId: string,
  initialTranscript: BookingChatMessage[]
): Promise<BookingSession> {
  const senderReference = await resolveAgentDeviceReference(medplum);
  const communication = await medplum.createResource<Communication>({
    resourceType: 'Communication',
    status: 'in-progress',
    category: [{ coding: [{ system: CATEGORY_SYSTEM, code: SESSION_CATEGORY_CODE }] }],
    subject: { reference: `Patient/${patientId}` },
    sender: { reference: senderReference },
    payload: [{ contentString: JSON.stringify(initialTranscript) }],
    meta: { tag: [{ code: 'ai-generated' }] },
  });
  return { communication, transcript: initialTranscript };
}

export async function loadBookingSession(
  medplum: MedplumClient,
  sessionId: string,
  patientId: string
): Promise<BookingSession> {
  let communication: Communication;
  try {
    communication = await medplum.readResource('Communication', sessionId);
  } catch {
    throw new Error('Booking chat session not found for this patient');
  }
  if (
    communication.subject?.reference !== `Patient/${patientId}` ||
    communication.status !== 'in-progress' ||
    communication.category?.[0]?.coding?.[0]?.code !== SESSION_CATEGORY_CODE
  ) {
    throw new Error('Booking chat session not found for this patient');
  }
  const transcript = JSON.parse(communication.payload?.[0]?.contentString ?? '[]') as BookingChatMessage[];
  return { communication, transcript };
}

export async function persistBookingSession(
  medplum: MedplumClient,
  session: BookingSession,
  status: 'in-progress' | 'completed' | 'stopped'
): Promise<void> {
  await medplum.updateResource<Communication>({
    ...session.communication,
    status,
    payload: [{ contentString: JSON.stringify(session.transcript) }],
  });
}
