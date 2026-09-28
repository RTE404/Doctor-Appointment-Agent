import type { BookableOption } from './bookableOptions.js';
import type { BookingChatMessage, BookingSession, BookingToolCall } from './bookingSession.js';
import { resolveProposedOptions } from './proposeOptions.js';
import type { ProposeOptionsArgs } from './proposeOptions.js';
import { noopTelemetry } from './agentTelemetry.js';
import type { AgentTelemetry } from './agentTelemetry.js';

export type BookingChatLoopResult =
  | { kind: 'question'; sessionId: string; reply: string }
  | { kind: 'options'; sessionId: string; options: BookableOption[]; summaryCommunicationId: string }
  | { kind: 'error'; sessionId: string; reply: string };

export type BookingChatTraceEvent =
  | { type: 'model-call'; step: number }
  | { type: 'model-response'; step: number; toolNames: string[] }
  | { type: 'tool-result'; step: number; toolName: string; outcome: 'ok' | 'error' | 'skipped' }
  | { type: 'terminal'; step: number; kind: 'question' | 'options' | 'step-cap' };

export interface GeminiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface BookingChatModelResponse {
  message: { role: 'assistant'; content: string | null; tool_calls?: BookingToolCall[] };
  usage?: GeminiUsage;
  retries?: number;
}

export interface BookingChatLoopRuntime {
  callModel(transcript: BookingChatMessage[]): Promise<BookingChatModelResponse>;
  executeTool(name: string, args: Record<string, unknown>, transcript: BookingChatMessage[]): Promise<unknown>;
  writeSummary(resolved: Extract<ReturnType<typeof resolveProposedOptions>, { ok: true }>): Promise<string>;
  persist(session: BookingSession, status: 'in-progress' | 'completed' | 'stopped'): Promise<void>;
  onTrace?(event: BookingChatTraceEvent): void;
  telemetry?: AgentTelemetry;
}

export const MAX_TOOL_LOOP_STEPS = 8;

function toolResultMessage(callId: string, toolName: string, result: unknown): BookingChatMessage {
  return { role: 'tool', tool_call_id: callId, content: JSON.stringify({ tool: toolName, result }) };
}

function resultIsError(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'error' in result;
}

function appendHandledAndSkipped(
  transcript: BookingChatMessage[],
  toolCalls: BookingToolCall[],
  handledIndex: number,
  handledResult: unknown,
  step: number,
  runtime: BookingChatLoopRuntime
): BookingChatMessage[] {
  const handledCall = toolCalls[handledIndex];
  const messages = [...transcript, toolResultMessage(handledCall.id, handledCall.function.name, handledResult)];
  runtime.onTrace?.({ type: 'tool-result', step, toolName: handledCall.function.name, outcome: 'ok' });
  for (let index = handledIndex + 1; index < toolCalls.length; index++) {
    const skippedCall = toolCalls[index];
    messages.push(toolResultMessage(skippedCall.id, skippedCall.function.name, { skipped: true }));
    runtime.onTrace?.({ type: 'tool-result', step, toolName: skippedCall.function.name, outcome: 'skipped' });
  }
  return messages;
}

export async function runBookingChatLoop(
  initialSession: BookingSession,
  runtime: BookingChatLoopRuntime
): Promise<BookingChatLoopResult> {
  let session = initialSession;
  const telemetry = runtime.telemetry ?? noopTelemetry;
  const persist = (current: BookingSession): Promise<void> =>
    telemetry.time('session.persist', () => runtime.persist(current, 'in-progress'));

  for (let step = 0; step < MAX_TOOL_LOOP_STEPS; step++) {
    runtime.onTrace?.({ type: 'model-call', step });
    const response = await telemetry.time('model.call', () => runtime.callModel(session.transcript));
    telemetry.recordModelUsage({
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
      totalTokens: response.usage?.total_tokens,
      retries: response.retries ?? 0,
    });
    const toolCalls = response.message.tool_calls ?? [];
    runtime.onTrace?.({ type: 'model-response', step, toolNames: toolCalls.map((call) => call.function.name) });

    if (toolCalls.length === 0) {
      session = {
        ...session,
        transcript: [...session.transcript, { role: 'assistant', content: response.message.content }],
      };
      await persist(session);
      runtime.onTrace?.({ type: 'terminal', step, kind: 'question' });
      return { kind: 'question', sessionId: session.communication.id as string, reply: response.message.content ?? '' };
    }

    session = {
      ...session,
      transcript: [
        ...session.transcript,
        { role: 'assistant', content: response.message.content, tool_calls: toolCalls },
      ],
    };

    for (let index = 0; index < toolCalls.length; index++) {
      const call = toolCalls[index];
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        session = {
          ...session,
          transcript: [
            ...session.transcript,
            toolResultMessage(call.id, call.function.name, {
              error: `Could not parse tool arguments: ${errorMessage}`,
            }),
          ],
        };
        runtime.onTrace?.({ type: 'tool-result', step, toolName: call.function.name, outcome: 'error' });
        continue;
      }

      if (call.function.name === 'ask_clarifying_question') {
        session = {
          ...session,
          transcript: appendHandledAndSkipped(session.transcript, toolCalls, index, 'ok', step, runtime),
        };
        await persist(session);
        runtime.onTrace?.({ type: 'terminal', step, kind: 'question' });
        return {
          kind: 'question',
          sessionId: session.communication.id as string,
          reply: typeof args.question === 'string' ? args.question : '',
        };
      }

      if (call.function.name === 'propose_options') {
        const resolved = await telemetry.time('options.resolve', async () =>
          resolveProposedOptions(session.transcript, args as unknown as ProposeOptionsArgs)
        );
        if (!resolved.ok) {
          session = {
            ...session,
            transcript: [
              ...session.transcript,
              toolResultMessage(call.id, 'propose_options', { error: resolved.errorForModel }),
            ],
          };
          runtime.onTrace?.({ type: 'tool-result', step, toolName: 'propose_options', outcome: 'error' });
          continue;
        }
        if (resolved.reason.trim() === '' || resolved.summary.trim() === '') {
          session = {
            ...session,
            transcript: [
              ...session.transcript,
              toolResultMessage(call.id, 'propose_options', { error: 'reason and summary must not be empty' }),
            ],
          };
          runtime.onTrace?.({ type: 'tool-result', step, toolName: 'propose_options', outcome: 'error' });
          continue;
        }
        const summaryCommunicationId = await telemetry.time('summary.write', () => runtime.writeSummary(resolved));
        session = {
          ...session,
          transcript: appendHandledAndSkipped(session.transcript, toolCalls, index, { ok: true }, step, runtime),
        };
        await persist(session);
        runtime.onTrace?.({ type: 'terminal', step, kind: 'options' });
        return {
          kind: 'options',
          sessionId: session.communication.id as string,
          options: resolved.options,
          summaryCommunicationId,
        };
      }

      try {
        const output = await runtime.executeTool(call.function.name, args, session.transcript);
        session = {
          ...session,
          transcript: [...session.transcript, toolResultMessage(call.id, call.function.name, output)],
        };
        runtime.onTrace?.({
          type: 'tool-result',
          step,
          toolName: call.function.name,
          outcome: resultIsError(output) ? 'error' : 'ok',
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        session = {
          ...session,
          transcript: [
            ...session.transcript,
            toolResultMessage(call.id, call.function.name, { error: errorMessage }),
          ],
        };
        runtime.onTrace?.({ type: 'tool-result', step, toolName: call.function.name, outcome: 'error' });
      }
    }
  }

  await persist(session);
  runtime.onTrace?.({ type: 'terminal', step: MAX_TOOL_LOOP_STEPS, kind: 'step-cap' });
  return {
    kind: 'question',
    sessionId: session.communication.id as string,
    reply:
      "I'm still narrowing this down — could you tell me a bit more about what you're looking for (like a preferred day, time, or doctor)?",
  };
}
