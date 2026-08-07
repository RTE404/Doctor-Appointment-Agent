// src/bots/agent/agent-intake.test.ts
import { beforeAll, describe, expect, test } from 'vitest';
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type { Bundle, SearchParameter } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { handler, __setGeminiCallerForTests } from './agent-intake';

// The handler searches Device.identifier — not indexed by a bare
// MockClient. See patientContext.test.ts for the same fix and its
// rationale.
beforeAll(() => {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-medplum.json') as Bundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
  }
});

describe('agent-intake handler', () => {
  test('creates a preparation Communication and returns normalized intent', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient', name: [{ given: ['Test'], family: 'Patient' }] });
    // Server-assigned id (no explicit `id`) — proves the handler resolves
    // the agent Device dynamically rather than assuming the old literal id
    // 'ai-appointment-agent'.
    const agentDevice = await medplum.createResource({
      resourceType: 'Device',
      identifier: [{ system: 'http://example.com/agent-config', value: 'ai-appointment-agent' }],
    });
    __setGeminiCallerForTests(async () => ({
      specialty: 'cardiology',
      reason: 'Chest discomfort during exercise',
      summary: 'Patient reports exertional chest discomfort over the past week.',
    }));

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { patientId: patient.id as string, complaintText: 'My chest hurts when I run' },
      contentType: 'application/json',
      secrets: { GEMINI_API_KEY: { name: 'GEMINI_API_KEY', valueString: 'test-key' } },
    });

    expect(result).toMatchObject({
      intent: { specialtyLabel: 'Cardiology', reason: 'Chest discomfort during exercise' },
    });
    if (!('summaryCommunicationId' in result)) throw new Error('expected summaryCommunicationId');
    const communication = await medplum.readResource('Communication', result.summaryCommunicationId);
    expect(communication.status).toBe('preparation');
    expect(communication.recipient).toBeUndefined();
    expect(communication.sender).toStrictEqual({ reference: `Device/${agentDevice.id}` });
    expect(communication.meta?.tag).toContainEqual({ code: 'ai-generated' });
    expect(communication.reasonCode).toStrictEqual([{ text: 'Chest discomfort during exercise' }]);
    expect(communication.note).toStrictEqual([{ text: 'My chest hurts when I run' }]);
    expect(communication.topic?.coding).toContainEqual({
      system: 'http://nucc.org/provider-taxonomy',
      code: '207RC0000X',
      display: 'Cardiology',
    });
  });

  test('returns needsClarification when the specialty cannot be normalized', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient', name: [{ given: ['Test'], family: 'Patient' }] });
    __setGeminiCallerForTests(async () => ({
      specialty: 'quantum flux specialist',
      reason: 'Unclear',
      summary: 'Unclear complaint.',
    }));

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { patientId: patient.id as string, complaintText: 'something weird' },
      contentType: 'application/json',
      secrets: { GEMINI_API_KEY: { name: 'GEMINI_API_KEY', valueString: 'test-key' } },
    });

    expect(result).toStrictEqual({ needsClarification: true });
  });
});
