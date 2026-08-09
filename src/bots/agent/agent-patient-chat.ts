// src/bots/agent/agent-patient-chat.ts
import type { BotEvent, MedplumClient } from '@medplum/core';
import { loadPatientClinicalContext } from './lib/patientContext.js';
import { CHAT_SYSTEM_PROMPT, buildChatUserPrompt, containsInterpretationLanguage } from './lib/prompts.js';

const REFUSAL =
  "I can only relay information from the patient's record — for clinical interpretation, please consult the record directly.";

export type ChatInput = { npi: string; patientId: string; question: string; threadId?: string };
export type ChatResult = { answer: string; threadId: string };

type GeminiCaller = (apiKey: string, systemPrompt: string, userPrompt: string) => Promise<string>;
let geminiCaller: GeminiCaller = callGeminiForChat;

/** Test-only seam. */
export function __setGeminiCallerForTests(fn: GeminiCaller): void {
  geminiCaller = fn;
}

async function callGeminiForChat(apiKey: string, systemPrompt: string, userPrompt: string): Promise<string> {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-2.5-flash-lite',
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status}`);
  }
  const body = await response.json();
  return body.choices[0].message.content as string;
}

export async function handler(medplum: MedplumClient, event: BotEvent<ChatInput>): Promise<ChatResult> {
  const { npi, patientId, question, threadId } = event.input;
  const apiKey = event.secrets['GEMINI_API_KEY']?.valueString as string;

  const practitioner = await medplum.searchOne('Practitioner', { identifier: `http://hl7.org/fhir/sid/us-npi|${npi}` });
  if (!practitioner) {
    throw new Error(`No Practitioner found for NPI ${npi}`);
  }

  // Cheap, real relationship check — not authentication (NPI entry stays a
  // display filter, per Design §11), but "has this NPI ever actually
  // booked with this patient" is a fact worth checking before answering,
  // and was simply absent before.
  const relationship = await medplum.searchOne('Appointment', {
    actor: `Practitioner/${practitioner.id}`,
    patient: `Patient/${patientId}`,
  });
  if (!relationship) {
    throw new Error(`No booking relationship between NPI ${npi} and patient ${patientId}`);
  }

  const context = await loadPatientClinicalContext(medplum, patientId);
  const userPrompt = buildChatUserPrompt(context, question);
  const rawAnswer = await geminiCaller(apiKey, CHAT_SYSTEM_PROMPT, userPrompt);
  const answer = containsInterpretationLanguage(rawAnswer) ? REFUSAL : rawAnswer;

  const questionCommunication = await medplum.createResource({
    resourceType: 'Communication',
    status: 'completed',
    category: [{ coding: [{ system: 'http://example.com/agent-communication-category', code: 'ai-chat' }] }],
    subject: { reference: `Patient/${patientId}` },
    sender: { reference: `Practitioner/${practitioner.id}` },
    payload: [{ contentString: question }],
    sent: new Date().toISOString(),
    partOf: threadId ? [{ reference: `Communication/${threadId}` }] : undefined,
  });

  // Id is server-assigned (seeded via POST + ifNoneExist), never a
  // literal — resolved the same way agent-book-appointment.ts resolves it
  // when it reads the equivalent sender field as an authorization check.
  const agentDevice = await medplum.searchOne('Device', {
    identifier: 'http://example.com/agent-config|ai-appointment-agent',
  });
  if (!agentDevice?.id) {
    throw new Error('The ai-appointment-agent Device is not configured');
  }

  await medplum.createResource({
    resourceType: 'Communication',
    status: 'completed',
    category: [{ coding: [{ system: 'http://example.com/agent-communication-category', code: 'ai-chat' }] }],
    subject: { reference: `Patient/${patientId}` },
    sender: { reference: `Device/${agentDevice.id}` },
    payload: [{ contentString: answer }],
    sent: new Date().toISOString(),
    meta: { tag: [{ code: 'ai-generated' }] },
    partOf: [{ reference: `Communication/${threadId ?? questionCommunication.id}` }],
  });

  return { answer, threadId: threadId ?? (questionCommunication.id as string) };
}
