// src/bots/agent/agent-patient-chat.test.ts
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { vi as fixtureVi } from 'vitest';
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import { ReadablePromise } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type { Bundle, SearchParameter } from '@medplum/fhirtypes';
import type { Patient } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { handler, __setGeminiCallerForTests } from './agent-patient-chat';
function stubPatientEverything(medplum: MockClient, patient: Patient): void {
  const everything: Bundle = {
    resourceType: 'Bundle',
    type: 'searchset',
    entry: [{ resource: patient }],
  };
  const originalGet = medplum.get.bind(medplum);
  fixtureVi.spyOn(medplum, 'get').mockImplementation((url, options) => {
    if (url.toString().endsWith(`/Patient/${patient.id}/$everything`)) {
      return new ReadablePromise(Promise.resolve(everything));
    }
    return originalGet(url, options);
  });
}

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

afterEach(() => {
  fixtureVi.unstubAllGlobals();
});

describe('agent-patient-chat handler', () => {
  test('omits response formatting on the real Gemini fetch path', async () => {
    __setGeminiCallerForTests();
    const fetchMock = fixtureVi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'The record shows no known allergies.' } }] }),
    });
    fixtureVi.stubGlobal('fetch', fetchMock);

    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    stubPatientEverything(medplum, patient);
    const practitioner = await medplum.createResource({
      resourceType: 'Practitioner',
      identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }],
    });
    await medplum.createResource({
      resourceType: 'Appointment',
      status: 'booked',
      participant: [
        { actor: { reference: `Patient/${patient.id}` }, status: 'accepted' },
        { actor: { reference: `Practitioner/${practitioner.id}` }, status: 'accepted' },
      ],
    });
    await medplum.createResource({
      resourceType: 'Device',
      identifier: [{ system: 'http://example.com/agent-config', value: 'ai-appointment-agent' }],
    });

    await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { npi: '1234567890', patientId: patient.id as string, question: 'Any known allergies?' },
      contentType: 'application/json',
      secrets: { GEMINI_API_KEY: { name: 'GEMINI_API_KEY', valueString: 'test-key' } },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(request.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'gemini-3.1-flash-lite' });
    expect(body).not.toHaveProperty('response_format');
  });

  test('persists question and answer as threaded Communications, sender is the real practitioner, starts a new thread', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    stubPatientEverything(medplum, patient);
    const practitioner = await medplum.createResource({ resourceType: 'Practitioner', identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }] });
    await medplum.createResource({
      resourceType: 'Appointment',
      status: 'booked',
      participant: [{ actor: { reference: `Patient/${patient.id}` }, status: 'accepted' }, { actor: { reference: `Practitioner/${practitioner.id}` }, status: 'accepted' }],
    });
    // Server-assigned id (no explicit `id`) — proves the handler resolves
    // the agent Device dynamically rather than assuming the old literal id
    // 'ai-appointment-agent'.
    const agentDevice = await medplum.createResource({
      resourceType: 'Device',
      identifier: [{ system: 'http://example.com/agent-config', value: 'ai-appointment-agent' }],
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
    expect(question.meta?.tag).toContainEqual({
      system: 'https://doctor-appointment-agent.example/fhir/demo',
      code: 'demo-generated',
    });

    // The search PARAMETER code is 'part-of' (kebab-case) even though the
    // resource FIELD is Communication.partOf (camelCase, FHIR JSON
    // convention) — confirmed against @medplum/definitions' real
    // search-parameters.json. Using 'partOf' here silently matches nothing.
    const answers = await medplum.searchResources('Communication', { 'part-of': `Communication/${result.threadId}` });
    expect(answers).toHaveLength(1);
    expect(answers[0].sender).toStrictEqual({ reference: `Device/${agentDevice.id}` });
    expect(answers[0].meta?.tag).toContainEqual({ code: 'ai-generated' });
    expect(answers[0].meta?.tag).toContainEqual({
      system: 'https://doctor-appointment-agent.example/fhir/demo',
      code: 'demo-generated',
    });
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

  test('uses the Practitioner that owns the patient relationship when an NPI is duplicated', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    stubPatientEverything(medplum, patient);
    await medplum.createResource({
      resourceType: 'Practitioner',
      identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }],
    });
    const relationshipPractitioner = await medplum.createResource({
      resourceType: 'Practitioner',
      identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }],
    });
    await medplum.createResource({
      resourceType: 'Appointment',
      status: 'booked',
      participant: [
        { actor: { reference: `Patient/${patient.id}` }, status: 'accepted' },
        { actor: { reference: `Practitioner/${relationshipPractitioner.id}` }, status: 'accepted' },
      ],
    });
    await medplum.createResource({
      resourceType: 'Device',
      identifier: [{ system: 'http://example.com/agent-config', value: 'ai-appointment-agent' }],
    });
    __setGeminiCallerForTests(async () => 'The record shows no known allergies.');

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { npi: '1234567890', patientId: patient.id as string, question: 'Any known allergies?' },
      contentType: 'application/json',
      secrets: { GEMINI_API_KEY: { name: 'GEMINI_API_KEY', valueString: 'test-key' } },
    });

    const question = await medplum.readResource('Communication', result.threadId);
    expect(question.sender).toStrictEqual({ reference: `Practitioner/${relationshipPractitioner.id}` });
  });

  test('substitutes the fixed refusal when the model answer contains interpretation language', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    stubPatientEverything(medplum, patient);
    const practitioner = await medplum.createResource({ resourceType: 'Practitioner', identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }] });
    await medplum.createResource({
      resourceType: 'Appointment',
      status: 'booked',
      participant: [{ actor: { reference: `Patient/${patient.id}` }, status: 'accepted' }, { actor: { reference: `Practitioner/${practitioner.id}` }, status: 'accepted' }],
    });
    await medplum.createResource({
      resourceType: 'Device',
      identifier: [{ system: 'http://example.com/agent-config', value: 'ai-appointment-agent' }],
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
