import { expect, test, vi } from 'vitest';
import type { Communication } from '@medplum/fhirtypes';
import { runBookingChatLoop } from './bookingChatLoop';
import type { BookingChatLoopRuntime, BookingChatTraceEvent } from './bookingChatLoop';
import type { BookingSession, BookingToolCall } from './bookingSession';

function session(): BookingSession {
  return {
    communication: {
      resourceType: 'Communication',
      id: 'eval-session',
      status: 'in-progress',
    } as Communication,
    transcript: [{ role: 'user', content: 'I need an appointment' }],
  };
}

function toolCall(name: string, args: Record<string, unknown>, id = 'call-1'): BookingToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function runtime(options: {
  responses: { message: { role: 'assistant'; content: string | null; tool_calls?: BookingToolCall[] } }[];
  trace: BookingChatTraceEvent[];
  executeTool?: BookingChatLoopRuntime['executeTool'];
}): BookingChatLoopRuntime {
  let responseIndex = 0;
  return {
    callModel: vi.fn(async () => options.responses[responseIndex++]),
    executeTool: options.executeTool ?? vi.fn(async () => ({ ok: true })),
    writeSummary: vi.fn(async () => 'summary-1'),
    persist: vi.fn(async () => undefined),
    onTrace: (event) => options.trace.push(event),
  };
}

test('records a question terminal without putting message content in the trace', async () => {
  const trace: BookingChatTraceEvent[] = [];
  const result = await runBookingChatLoop(
    session(),
    runtime({
      responses: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [toolCall('ask_clarifying_question', { question: 'Which specialty?' })],
          },
        },
      ],
      trace,
    })
  );

  expect(result).toEqual({ kind: 'question', sessionId: 'eval-session', reply: 'Which specialty?' });
  expect(trace).toEqual([
    { type: 'model-call', step: 0 },
    { type: 'model-response', step: 0, toolNames: ['ask_clarifying_question'] },
    { type: 'tool-result', step: 0, toolName: 'ask_clarifying_question', outcome: 'ok' },
    { type: 'terminal', step: 0, kind: 'question' },
  ]);
  expect(JSON.stringify(trace)).not.toContain('Which specialty?');
});
