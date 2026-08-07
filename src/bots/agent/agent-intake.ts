// src/bots/agent/agent-intake.ts
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Communication } from '@medplum/fhirtypes';
import { normalizeLlmSpecialty } from '../../config/specialties';
import { loadPatientClinicalContext } from './lib/patientContext';
import { INTAKE_SYSTEM_PROMPT, buildIntakeUserPrompt } from './lib/prompts';

interface GeminiIntakeResult {
  specialty: string;
  reason: string;
  summary: string;
}

export type IntakeInput = { patientId: string; complaintText: string };
export type IntakeResult =
  | { intent: { specialtyCode: string; specialtyLabel: string; reason: string }; summaryCommunicationId: string }
  | { needsClarification: true };

type GeminiCaller = (apiKey: string, systemPrompt: string, userPrompt: string) => Promise<GeminiIntakeResult>;

let geminiCaller: GeminiCaller = callGeminiForIntake;

/** Test-only seam — swaps the real Gemini call for a stub. */
export function __setGeminiCallerForTests(fn: GeminiCaller): void {
  geminiCaller = fn;
}

async function callGeminiForIntake(apiKey: string, systemPrompt: string, userPrompt: string): Promise<GeminiIntakeResult> {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-2.5-flash-lite',
      temperature: 0,
      response_format: { type: 'json_object' },
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
  return JSON.parse(body.choices[0].message.content) as GeminiIntakeResult;
}

export async function handler(medplum: MedplumClient, event: BotEvent<IntakeInput>): Promise<IntakeResult> {
  const { patientId, complaintText } = event.input;
  const apiKey = event.secrets['GEMINI_API_KEY']?.valueString as string;

  const context = await loadPatientClinicalContext(medplum, patientId);
  const userPrompt = buildIntakeUserPrompt(context, complaintText);
  const geminiResult = await geminiCaller(apiKey, INTAKE_SYSTEM_PROMPT, userPrompt);

  const specialty = normalizeLlmSpecialty(geminiResult.specialty);
  if (!specialty) {
    return { needsClarification: true };
  }

  // Id is server-assigned (seeded via POST + ifNoneExist), never a
  // literal — resolved the same way agent-book-appointment.ts resolves it
  // when it later reads this same sender field as an authorization check.
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
    reasonCode: [{ text: geminiResult.reason }],
    note: [{ text: complaintText }],
    topic: {
      coding: [{ system: 'http://nucc.org/provider-taxonomy', code: specialty.nuccCode, display: specialty.label }],
    },
    subject: { reference: `Patient/${patientId}` },
    sender: { reference: `Device/${agentDevice.id}` },
    payload: [{ contentString: geminiResult.summary }],
    meta: { tag: [{ code: 'ai-generated' }] },
  });

  return {
    intent: {
      specialtyCode: specialty.nuccCode,
      specialtyLabel: specialty.label,
      reason: geminiResult.reason,
    },
    summaryCommunicationId: communication.id as string,
  };
}
