// src/bots/agent/lib/prompts.ts
import type { PatientClinicalContext } from './patientContext';

export const INTAKE_SYSTEM_PROMPT = `You are an intake assistant for a doctor appointment booking system. Given a
patient's clinical history and a short natural-language complaint, you must:
1. Infer the single most relevant medical specialty for this complaint.
2. Extract a short (one sentence) plain-English reason for the visit.
3. Write a 2-3 sentence pre-visit summary a doctor could read before seeing this patient.

You must never diagnose, speculate about a specific condition, suggest a
treatment, or classify urgency/triage in any way — this system books a single,
undifferentiated visit type; it does not triage. Relay and summarize only what
is asked. Respond with strict JSON:
{"specialty": string, "reason": string, "summary": string}`;

export function buildIntakeUserPrompt(context: PatientClinicalContext, complaintText: string): string {
  const conditions = context.conditions.map((c) => c.code?.text).filter(Boolean).join(', ') || 'none recorded';
  const medications = context.medications.map((m) => m.medicationCodeableConcept?.text).filter(Boolean).join(', ') || 'none recorded';
  const allergies = context.allergies.map((a) => a.code?.text).filter(Boolean).join(', ') || 'none recorded';
  return `Patient history:
- Conditions: ${conditions}
- Medications: ${medications}
- Allergies: ${allergies}

Patient's complaint: "${complaintText}"`;
}

export const CHAT_SYSTEM_PROMPT = `You are a record-lookup assistant for a doctor preparing to see a patient. You
answer questions using ONLY the patient record provided below — you never diagnose,
interpret findings, suggest treatment or medication changes, or give a prognosis
or any other form of clinical advice, even if directly asked or asked
hypothetically. If asked for any of that, respond exactly with: "I can only
relay information from the patient's record — for clinical interpretation,
please consult the record directly." If the record does not contain the
answer, say plainly that it is not recorded — never guess or infer.`;

export function buildChatUserPrompt(context: PatientClinicalContext, question: string): string {
  const conditions = context.conditions.map((c) => c.code?.text).filter(Boolean).join(', ') || 'none recorded';
  const medications = context.medications.map((m) => m.medicationCodeableConcept?.text).filter(Boolean).join(', ') || 'none recorded';
  const allergies = context.allergies.map((a) => a.code?.text).filter(Boolean).join(', ') || 'none recorded';
  const encounters = context.encounters
    .map((e) => `${e.period?.start ?? 'unknown date'}: ${e.type?.[0]?.text ?? 'visit'}`)
    .join('; ') || 'none recorded';
  return `Patient record:
- Conditions: ${conditions}
- Medications: ${medications}
- Allergies: ${allergies}
- Past encounters: ${encounters}

Doctor's question: "${question}"`;
}

const INTERPRETATION_PHRASES = [
  'you should',
  'i recommend',
  'i suggest',
  'likely has',
  'probably has',
  'appears to be',
  'consistent with a diagnosis',
  'should consider',
  'my advice',
];

/** Weak output guard (defense in depth, not a guarantee) — Design doc §10. */
export function containsInterpretationLanguage(text: string): boolean {
  const normalized = text.toLowerCase();
  return INTERPRETATION_PHRASES.some((phrase) => normalized.includes(phrase));
}
