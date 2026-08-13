import { beforeAll, describe, expect, test } from 'vitest';
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import type { BotEvent } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type { Bundle, SearchParameter } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { __setGeminiToolCallerForTests, handler } from './agent-booking-chat';
import type { BookingChatInput } from './agent-booking-chat';
import type { BookingToolCall } from './lib/bookingSession';
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

function event(input: BookingChatInput): BotEvent<BookingChatInput> {
  return {
    bot: { identifier: { system: 'http://example.com', value: 'agent-booking-chat' } },
    contentType: 'application/json',
    input,
    secrets: { GEMINI_API_KEY: { name: 'GEMINI_API_KEY', valueString: 'test-key' } },
  };
}

function toolCallResponse(
  id: string,
  name: string,
  args: Record<string, unknown>
): { message: { role: 'assistant'; content: null; tool_calls: BookingToolCall[] } } {
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

  test('a single response with multiple tool_calls persists a tool-result message for every call, including {skipped:true} for calls after an early-return tool', async () => {
    const medplum = new MockClient();
    const { patientId } = await seedFixtures(medplum);
    // search_previous_physician needs no external stubbing (it just queries
    // the patient's own encounters via MockClient), so it's used here as the
    // "normal" tool call rather than check_availability — this test is about
    // the multi-tool_calls-per-response fan-out/skip mechanism itself, not
    // about any one tool's execution.
    __setGeminiToolCallerForTests(async () => ({
      message: {
        role: 'assistant' as const,
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function' as const,
            function: { name: 'search_previous_physician', arguments: JSON.stringify({ specialtyCode: '208D00000X' }) },
          },
          {
            id: 'call-2',
            type: 'function' as const,
            function: { name: 'ask_clarifying_question', arguments: JSON.stringify({ question: 'When works best?' }) },
          },
          {
            id: 'call-3',
            type: 'function' as const,
            function: { name: 'search_previous_physician', arguments: JSON.stringify({ specialtyCode: '208D00000X' }) },
          },
        ],
      },
    }));

    const result = await handler(medplum, event({ patientId, message: 'anything' }));

    expect(result).toMatchObject({ kind: 'question', reply: 'When works best?' });
    if (result.kind !== 'question') throw new Error('expected question');
    const communication = await medplum.readResource('Communication', result.sessionId);
    const transcript = JSON.parse(communication.payload?.[0]?.contentString ?? '[]') as {
      role: string;
      tool_call_id?: string;
      content?: string;
    }[];
    const toolMessages = transcript.filter((m) => m.role === 'tool');
    // call-1 (handled normally, before the early-return call), call-2 (the
    // early-return call itself), and call-3 (after it, never executed) must
    // each get exactly one tool-result message, in order.
    expect(toolMessages.map((m) => m.tool_call_id)).toStrictEqual(['call-1', 'call-2', 'call-3']);
    expect(JSON.parse(toolMessages[2].content as string)).toMatchObject({ result: { skipped: true } });
  });

  test('propose_options with ungrounded picks feeds the error back to the model and continues the loop instead of ending the turn', async () => {
    const medplum = new MockClient();
    const { patientId } = await seedFixtures(medplum);
    let call = 0;
    __setGeminiToolCallerForTests(async (transcript) => {
      call += 1;
      if (call === 1) {
        // No prior check_availability call exists in the transcript, so
        // these picks aren't grounded in anything — resolveProposedOptions
        // must return { ok: false }.
        return {
          message: {
            role: 'assistant' as const,
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function' as const,
                function: {
                  name: 'propose_options',
                  arguments: JSON.stringify({
                    specialty: 'General Practice',
                    reason: 'Routine visit',
                    summary: 'Patient requests a routine visit.',
                    picks: [{ npi: '1000000001', start: '2026-08-14T13:00:00.000Z', end: '2026-08-14T13:30:00.000Z', reasoning: 'earliest' }],
                  }),
                },
              },
            ],
          },
        };
      }
      expect(
        transcript.some((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('not grounded'))
      ).toBe(true);
      return toolCallResponse('call-2', 'ask_clarifying_question', { question: 'Which time works?' });
    });

    const result = await handler(medplum, event({ patientId, message: 'Find me a doctor' }));

    expect(call).toBe(2);
    expect(result).toMatchObject({ kind: 'question', sessionId: expect.any(String), reply: 'Which time works?' });
  });

  test('propose_options with an empty reason or summary feeds an error back to the model and continues the loop instead of writing a Communication', async () => {
    const medplum = new MockClient();
    const { patientId } = await seedFixtures(medplum);
    __setNppesLookupForTests(async (npi) => ({
      npi,
      firstName: 'Test',
      lastName: 'Doctor',
      nuccCode: '208D00000X',
      nuccDisplay: 'General Practice Physician',
      address: { state: 'MA', city: 'Boston' },
    }));
    const start = '2026-08-14T13:00:00.000Z';
    const end = '2026-08-14T13:30:00.000Z';
    const originalGet = medplum.get.bind(medplum);
    medplum.get = (async (url: string | URL, options?: unknown) => {
      const asUrl = typeof url === 'string' ? new URL(url) : url;
      if (asUrl.pathname.includes('$find')) {
        return {
          resourceType: 'Bundle',
          type: 'searchset',
          entry: [{ resource: { resourceType: 'Appointment', status: 'proposed', start, end, participant: [] } }],
        };
      }
      return originalGet(url as never, options as never);
    }) as typeof medplum.get;

    let call = 0;
    __setGeminiToolCallerForTests(async (transcript) => {
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
      if (call === 2) {
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
                    reason: '   ',
                    summary: 'Patient requests a routine visit.',
                    picks: [{ npi: '1000000001', start, end, reasoning: 'earliest' }],
                  }),
                },
              },
            ],
          },
        };
      }
      expect(
        transcript.some((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('must not be empty'))
      ).toBe(true);
      return toolCallResponse('call-3', 'ask_clarifying_question', { question: 'What is the reason for your visit?' });
    });

    const result = await handler(medplum, event({ patientId, message: 'Find me a doctor' }));

    expect(call).toBe(3);
    expect(result).toMatchObject({ kind: 'question', reply: 'What is the reason for your visit?' });
  });

  test('a read-only tool that throws feeds the error back to the model and continues the loop instead of crashing the turn', async () => {
    const medplum = new MockClient();
    const { patientId } = await seedFixtures(medplum);
    // __setNppesLookupForTests is a module-level seam shared across tests in
    // this file (there's no afterEach reset — see the plan ledger's deferred
    // minor findings), so an earlier test's successful stub could otherwise
    // leak forward and mask the failure this test needs. Set it explicitly
    // here so checkAvailabilityTool's underlying ensurePractitionerAndSchedule
    // call deterministically throws "No NPPES record found", regardless of
    // what order tests run in.
    __setNppesLookupForTests(async () => undefined);
    let call = 0;
    __setGeminiToolCallerForTests(async (transcript) => {
      call += 1;
      if (call === 1) {
        return {
          message: {
            role: 'assistant' as const,
            content: null,
            tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'check_availability', arguments: JSON.stringify({ npi: '9999999999' }) } }],
          },
        };
      }
      expect(
        transcript.some((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('No NPPES record found'))
      ).toBe(true);
      return toolCallResponse('call-2', 'ask_clarifying_question', { question: 'Let me try someone else — any preference?' });
    });

    const result = await handler(medplum, event({ patientId, message: 'Find me a doctor' }));

    expect(call).toBe(2);
    expect(result).toMatchObject({ kind: 'question', reply: 'Let me try someone else — any preference?' });
  });
});
