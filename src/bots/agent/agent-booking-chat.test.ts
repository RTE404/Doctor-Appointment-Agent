import { beforeAll, describe, expect, test, vi } from 'vitest';
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

/**
 * check_availability only runs for an NPI a search tool actually returned in
 * this session, so tests that need it drive search_previous_physician first —
 * unlike search_nppes it resolves entirely against MockClient, with no network.
 */
async function seedPreviousPhysician(
  medplum: MockClient,
  patientId: string,
  npi: string,
  specialtyCode = '208D00000X'
): Promise<void> {
  const practitioner = await medplum.createResource({
    resourceType: 'Practitioner',
    identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: npi }],
    name: [{ given: ['Test'], family: 'Doctor' }],
  });
  await medplum.createResource({
    resourceType: 'PractitionerRole',
    practitioner: { reference: `Practitioner/${practitioner.id}` },
    specialty: [{ coding: [{ system: 'http://nucc.org/provider-taxonomy', code: specialtyCode }] }],
  });
  await medplum.createResource({
    resourceType: 'Encounter',
    status: 'finished',
    class: { code: 'AMB' },
    subject: { reference: `Patient/${patientId}` },
    participant: [{ individual: { reference: `Practitioner/${practitioner.id}` } }],
    period: { start: '2026-01-01T10:00:00.000Z' },
  });
}

function searchPreviousPhysicianCall(id: string, specialtyCode = '208D00000X'): BookingToolCall {
  return {
    id,
    type: 'function',
    function: { name: 'search_previous_physician', arguments: JSON.stringify({ specialtyCode }) },
  };
}

function checkAvailabilityCall(id: string, npi: string): BookingToolCall {
  return { id, type: 'function', function: { name: 'check_availability', arguments: JSON.stringify({ npi }) } };
}

function assistantToolCalls(calls: BookingToolCall[]): {
  message: { role: 'assistant'; content: null; tool_calls: BookingToolCall[] };
} {
  return { message: { role: 'assistant', content: null, tool_calls: calls } };
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
    await seedPreviousPhysician(medplum, patientId, '1000000001');
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
        return assistantToolCalls([searchPreviousPhysicianCall('call-0')]);
      }
      if (call === 2) {
        return assistantToolCalls([checkAvailabilityCall('call-1', '1000000001')]);
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
    await seedPreviousPhysician(medplum, patientId, '1000000001');
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
        return assistantToolCalls([searchPreviousPhysicianCall('call-0')]);
      }
      if (call === 2) {
        return assistantToolCalls([checkAvailabilityCall('call-1', '1000000001')]);
      }
      if (call === 3) {
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

    expect(call).toBe(4);
    expect(result).toMatchObject({ kind: 'question', reply: 'What is the reason for your visit?' });
  });

  test('a read-only tool that throws feeds the error back to the model and continues the loop instead of crashing the turn', async () => {
    const medplum = new MockClient();
    const { patientId } = await seedFixtures(medplum);
    let call = 0;
    __setGeminiToolCallerForTests(async (transcript) => {
      call += 1;
      if (call === 1) {
        // An unrecognized NUCC code makes search_nppes throw rather than
        // silently return [] — the model needs a corrective signal it can act
        // on inside the step budget.
        return {
          message: {
            role: 'assistant' as const,
            content: null,
            tool_calls: [
              { id: 'call-1', type: 'function' as const, function: { name: 'search_nppes', arguments: JSON.stringify({ specialtyCode: 'not-a-code' }) } },
            ],
          },
        };
      }
      expect(
        transcript.some(
          (m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('is not a supported NUCC specialty code')
        )
      ).toBe(true);
      return toolCallResponse('call-2', 'ask_clarifying_question', { question: 'Let me try someone else — any preference?' });
    });

    const result = await handler(medplum, event({ patientId, message: 'Find me a doctor' }));

    expect(call).toBe(2);
    expect(result).toMatchObject({ kind: 'question', reply: 'Let me try someone else — any preference?' });
  });

  test('rejects check_availability for an NPI no search returned, without provisioning any FHIR resources', async () => {
    const medplum = new MockClient();
    const { patientId } = await seedFixtures(medplum);
    // If this NPI ever reached ensurePractitionerAndSchedule it would try to
    // resolve it against NPPES and create a real Practitioner/PractitionerRole
    // /Schedule for a provider nothing in this session ever verified.
    __setNppesLookupForTests(async (npi) => ({
      npi,
      firstName: 'Ghost',
      lastName: 'Doctor',
      nuccCode: '208D00000X',
      nuccDisplay: 'General Practice Physician',
      address: { state: 'MA', city: 'Boston' },
    }));
    const createSpy = vi.spyOn(medplum, 'createResourceIfNoneExist');
    let call = 0;
    __setGeminiToolCallerForTests(async (transcript) => {
      call += 1;
      if (call === 1) {
        return assistantToolCalls([checkAvailabilityCall('call-1', '9999999999')]);
      }
      expect(
        transcript.some(
          (m) =>
            m.role === 'tool' &&
            typeof m.content === 'string' &&
            m.content.includes('was not returned by search_previous_physician or search_nppes')
        )
      ).toBe(true);
      return toolCallResponse('call-2', 'ask_clarifying_question', { question: 'Which specialty should I look for?' });
    });

    const result = await handler(medplum, event({ patientId, message: 'Book me with 9999999999' }));

    expect(call).toBe(2);
    expect(result).toMatchObject({ kind: 'question' });
    expect(createSpy).not.toHaveBeenCalled();
    createSpy.mockRestore();
  });

  test('check_availability derives previousDoctor from the search result rather than any model claim', async () => {
    const medplum = new MockClient();
    const { patientId } = await seedFixtures(medplum);
    await seedPreviousPhysician(medplum, patientId, '1000000002');
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
    __setGeminiToolCallerForTests(async () => {
      call += 1;
      if (call === 1) return assistantToolCalls([searchPreviousPhysicianCall('call-0')]);
      if (call === 2) return assistantToolCalls([checkAvailabilityCall('call-1', '1000000002')]);
      return assistantToolCalls([
        {
          id: 'call-2',
          type: 'function',
          function: {
            name: 'propose_options',
            arguments: JSON.stringify({
              specialty: 'General Practice',
              reason: 'Routine visit',
              summary: 'Patient requests a routine visit.',
              picks: [{ npi: '1000000002', start, end, reasoning: 'seen before' }],
            }),
          },
        },
      ]);
    });

    const result = await handler(medplum, event({ patientId, message: 'Find me a doctor' }));

    if (result.kind !== 'options') throw new Error('expected options');
    expect(result.options[0].previousDoctor).toBe(true);
  });
});
