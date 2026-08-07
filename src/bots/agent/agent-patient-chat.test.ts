// src/bots/agent/agent-patient-chat.test.ts
import { beforeAll, describe, expect, test } from 'vitest';
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type { Bundle, SearchParameter } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { handler, __setGeminiCallerForTests } from './agent-patient-chat';

// The handler searches Practitioner.identifier, Appointment.actor/patient,
// and Communication.partOf — none indexed by a bare MockClient. See
// patientContext.test.ts for the same fix and its rationale.
beforeAll(() => {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-medplum.json') as Bundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
  }
});

describe('agent-patient-chat handler', () => {
  test('persists question and answer as threaded Communications, sender is the real practitioner, starts a new thread', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    const practitioner = await medplum.createResource({ resourceType: 'Practitioner', identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }] });
    await medplum.createResource({
      resourceType: 'Appointment',
      status: 'booked',
      participant: [{ actor: { reference: `Patient/${patient.id}` }, status: 'accepted' }, { actor: { reference: `Practitioner/${practitioner.id}` }, status: 'accepted' }],
    });
    __setGeminiCallerForTests(async () => 'The record shows no known allergies.');

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { npi: '1234567890', patientId: patient.id as string, question: 'Any known allergies?' },
      contentType: 'application/json',
      secrets: { GEMINI_API_KEY: { name: 'GEMINI_API_KEY', valueString: 'test-key' } },
    });

    expect(result.answer).toBe('The record shows no known allergies.');
    const question = await medplum.readResource('Communication', result.threadId);
    expect(question.sender).toStrictEqual({ reference: `Practitioner/${practitioner.id}` });
    expect(question.meta?.tag).toBeUndefined();

    // The search PARAMETER code is 'part-of' (kebab-case) even though the
    // resource FIELD is Communication.partOf (camelCase, FHIR JSON
    // convention) — confirmed against @medplum/definitions' real
    // search-parameters.json. Using 'partOf' here silently matches nothing.
    const answers = await medplum.searchResources('Communication', { 'part-of': `Communication/${result.threadId}` });
    expect(answers).toHaveLength(1);
    expect(answers[0].sender).toStrictEqual({ reference: 'Device/ai-appointment-agent' });
    expect(answers[0].meta?.tag).toContainEqual({ code: 'ai-generated' });
  });

  test('throws when no booking relationship exists between this NPI and this patient', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    await medplum.createResource({ resourceType: 'Practitioner', identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }] });
    // No Appointment created — no relationship exists.

    await expect(
      handler(medplum, {
        bot: { reference: 'Bot/123' },
        input: { npi: '1234567890', patientId: patient.id as string, question: 'Any known allergies?' },
        contentType: 'application/json',
        secrets: { GEMINI_API_KEY: { name: 'GEMINI_API_KEY', valueString: 'test-key' } },
      })
    ).rejects.toThrow(/no booking relationship/i);
  });

  test('substitutes the fixed refusal when the model answer contains interpretation language', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    const practitioner = await medplum.createResource({ resourceType: 'Practitioner', identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }] });
    await medplum.createResource({
      resourceType: 'Appointment',
      status: 'booked',
      participant: [{ actor: { reference: `Patient/${patient.id}` }, status: 'accepted' }, { actor: { reference: `Practitioner/${practitioner.id}` }, status: 'accepted' }],
    });
    __setGeminiCallerForTests(async () => 'You should consider a follow-up MRI.');

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { npi: '1234567890', patientId: patient.id as string, question: 'What do you think this means?' },
      contentType: 'application/json',
      secrets: { GEMINI_API_KEY: { name: 'GEMINI_API_KEY', valueString: 'test-key' } },
    });

    expect(result.answer).toContain('I can only relay information from the patient\'s record');
  });
});
