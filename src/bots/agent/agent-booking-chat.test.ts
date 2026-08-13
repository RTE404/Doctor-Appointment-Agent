import { beforeAll, describe, expect, test } from 'vitest';
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type { Bundle, SearchParameter } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { __setGeminiToolCallerForTests, handler } from './agent-booking-chat';
import type { BookingChatInput } from './agent-booking-chat';
import { __setNppesLookupForTests } from './lib/ensurePractitionerAndSchedule';

beforeAll(() => {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-medplum.json') as Bundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
  }
});

async function seedFixtures(medplum: MockClient): Promise<{ patientId: string }> {
  await medplum.createResource({
    resourceType: 'Device',
    identifier: [{ system: 'http://example.com/agent-config', value: 'ai-appointment-agent' }],
  });
  await medplum.createResource({ resourceType: 'HealthcareService', name: 'Office Visit', active: true });
  const patient = await medplum.createResource({ resourceType: 'Patient' });
  return { patientId: patient.id as string };
}

function event(input: BookingChatInput) {
  return {
    bot: { identifier: { system: 'http://example.com', value: 'agent-booking-chat' } },
    contentType: 'application/json',
    input,
    secrets: { GEMINI_API_KEY: { name: 'GEMINI_API_KEY', valueString: 'test-key' } },
  };
}

function toolCallResponse(id: string, name: string, args: Record<string, unknown>) {
  return {
    message: {
      role: 'assistant' as const,
      content: null,
      tool_calls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }],
    },
  };
}

describe('agent-booking-chat handler', () => {
  test('starts a new session and returns a clarifying question, persisted for resume', async () => {
    const medplum = new MockClient();
    const { patientId } = await seedFixtures(medplum);
    __setGeminiToolCallerForTests(async () =>
      toolCallResponse('call-1', 'ask_clarifying_question', { question: 'Which body part hurts?' })
    );

    const result = await handler(medplum, event({ patientId, message: 'I have pain' }));

    expect(result).toMatchObject({ kind: 'question', reply: 'Which body part hurts?' });
    if (result.kind !== 'question') throw new Error('expected question');
    const communication = await medplum.readResource('Communication', result.sessionId);
    expect(communication.status).toBe('in-progress');
  });

  test('resumes an existing session and appends the new patient message to the persisted transcript', async () => {
    const medplum = new MockClient();
    const { patientId } = await seedFixtures(medplum);
    __setGeminiToolCallerForTests(async () =>
      toolCallResponse('call-1', 'ask_clarifying_question', { question: 'first question' })
    );
    const first = await handler(medplum, event({ patientId, message: 'I have pain' }));
    if (first.kind !== 'question') throw new Error('expected question');

    __setGeminiToolCallerForTests(async (transcript) => {
      expect(transcript.some((m) => m.role === 'user' && m.content === 'my jaw')).toBe(true);
      return toolCallResponse('call-2', 'ask_clarifying_question', { question: 'second question' });
    });
    const second = await handler(medplum, event({ patientId, message: 'my jaw', sessionId: first.sessionId }));

    expect(second).toMatchObject({ kind: 'question', reply: 'second question', sessionId: first.sessionId });
  });

  test('rejects a stopped step-cap session and never leaks that state to a mismatched patient', async () => {
    const medplum = new MockClient();
    const { patientId } = await seedFixtures(medplum);
    const otherPatient = await medplum.createResource({ resourceType: 'Patient' });
    __setGeminiToolCallerForTests(async () =>
      toolCallResponse('call-1', 'ask_clarifying_question', { question: 'q' })
    );
    const first = await handler(medplum, event({ patientId, message: 'hi' }));
    if (first.kind !== 'question') throw new Error('expected question');

    await expect(
      handler(medplum, event({ patientId: otherPatient.id as string, message: 'hi', sessionId: first.sessionId }))
    ).rejects.toThrow('Booking chat session not found for this patient');
  });

  test('stops after the step cap and marks the session stopped', async () => {
    const medplum = new MockClient();
    const { patientId } = await seedFixtures(medplum);
    let calls = 0;
    __setGeminiToolCallerForTests(async () => {
      calls += 1;
      return toolCallResponse(`call-${calls}`, 'search_previous_physician', { specialtyCode: '208D00000X' });
    });

    const result = await handler(medplum, event({ patientId, message: 'anything' }));

    expect(result.kind).toBe('error');
    expect(calls).toBe(8);
    const communication = await medplum.readResource('Communication', result.sessionId);
    expect(communication.status).toBe('stopped');
  });

  test('propose_options success returns grounded options and a summary Communication id, and completes the session', async () => {
    const medplum = new MockClient();
    const { patientId } = await seedFixtures(medplum);
    // ensurePractitionerAndSchedule lazily provisions a Practitioner/Schedule
    // for an NPI it hasn't seen before by calling out to the real NPPES
    // registry (see ./lib/ensurePractitionerAndSchedule.ts). The synthetic
    // NPI used below ('1000000001') isn't a real NPPES record, so without
    // this stub the live lookup returns nothing and the tool call throws
    // "No NPPES record found for NPI 1000000001" instead of exercising the
    // check_availability -> propose_options path this test is about.
    __setNppesLookupForTests(async (npi) => ({
      npi,
      firstName: 'Test',
      lastName: 'Doctor',
      nuccCode: '208D00000X',
      nuccDisplay: 'General Practice Physician',
      address: { state: 'MA', city: 'Boston' },
    }));
    const availability = [
      {
        id: '1000000001|2026-08-14T13:00:00.000Z|2026-08-14T13:30:00.000Z',
        npi: '1000000001',
        practitionerId: 'practitioner-1',
        scheduleId: 'schedule-1',
        doctorName: 'Dr. Test',
        start: '2026-08-14T13:00:00.000Z',
        end: '2026-08-14T13:30:00.000Z',
        timeZone: 'America/New_York',
        previousDoctor: false,
      },
    ];
    let call = 0;
    __setGeminiToolCallerForTests(async () => {
      call += 1;
      if (call === 1) {
        return {
          message: {
            role: 'assistant' as const,
            content: null,
            tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'check_availability', arguments: JSON.stringify({ npi: '1000000001' }) } }],
          },
        };
      }
      return {
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: 'call-2',
              type: 'function' as const,
              function: {
                name: 'propose_options',
                arguments: JSON.stringify({
                  specialty: 'General Practice',
                  reason: 'Routine visit',
                  summary: 'Patient requests a routine visit.',
                  picks: [{ npi: '1000000001', start: availability[0].start, end: availability[0].end, reasoning: 'earliest' }],
                }),
              },
            },
          ],
        },
      };
    });

    // Stub the underlying tool executors indirectly via a fake $find response.
    const originalGet = medplum.get.bind(medplum);
    medplum.get = (async (url: string | URL, options?: unknown) => {
      const asUrl = typeof url === 'string' ? new URL(url) : url;
      if (asUrl.pathname.includes('$find')) {
        return {
          resourceType: 'Bundle',
          type: 'searchset',
          entry: [
            {
              resource: {
                resourceType: 'Appointment',
                status: 'proposed',
                start: availability[0].start,
                end: availability[0].end,
                participant: [],
              },
            },
          ],
        };
      }
      return originalGet(url as never, options as never);
    }) as typeof medplum.get;

    const result = await handler(medplum, event({ patientId, message: 'Find me a doctor' }));

    expect(result.kind).toBe('options');
    if (result.kind !== 'options') throw new Error('expected options');
    expect(result.options).toHaveLength(1);
    expect(result.options[0].npi).toBe('1000000001');
    const summary = await medplum.readResource('Communication', result.summaryCommunicationId);
    expect(summary.status).toBe('preparation');
    expect(summary.topic?.coding?.[0]).toMatchObject({ code: '208D00000X' });
    const session = await medplum.readResource('Communication', result.sessionId);
    expect(session.status).toBe('completed');
  });
});
