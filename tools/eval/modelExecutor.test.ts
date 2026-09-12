import { describe, expect, it, vi } from 'vitest';

import { BOOKING_CHAT_SYSTEM_PROMPT } from '../../src/bots/agent/lib/prompts';
import type { BookingChatMessage, BookingToolCall } from '../../src/bots/agent/lib/bookingSession';
import { loadScenarioCatalog } from './loadScenarios';
import { createModelExecutor } from './modelExecutor';

const catalog = loadScenarioCatalog('data/evals/booking-scenarios.json');

function byId(id: string) {
  const found = catalog.scenarios.find((scenario) => scenario.id === id);
  if (!found) throw new Error(`Missing test scenario ${id}`);
  return structuredClone(found);
}

function toolMessage(name: string, args: Record<string, unknown>, id: string) {
  const call: BookingToolCall = {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
  return { message: { role: 'assistant' as const, content: null, tool_calls: [call] } };
}

describe('createModelExecutor', () => {
  it('uses the production prompt and records only sanitized decisions', async () => {
    const scenario = byId('routing-generalpractice-explicit');
    const slot = scenario.fixture.providers?.[0]?.availability[0];
    if (!slot) throw new Error('Expected fixture slot');
    const transcripts: BookingChatMessage[][] = [];
    const responses = [
      toolMessage('search_nppes', { specialtyCode: '208D00000X' }, 'call-1'),
      toolMessage('check_availability', { npi: '9000000000' }, 'call-2'),
      toolMessage(
        'propose_options',
        {
          specialty: 'General Practice',
          reason: 'Synthetic reason that must not be serialized',
          summary: 'Synthetic summary that must not be serialized',
          picks: [
            {
              npi: '9000000000',
              start: slot.start,
              end: slot.end,
              reasoning: 'Private model rationale',
            },
          ],
        },
        'call-3'
      ),
    ];
    const callModel = vi.fn(async (transcript: BookingChatMessage[]) => {
      transcripts.push(structuredClone(transcript));
      const response = responses.shift();
      if (!response) throw new Error('Unexpected model call');
      return response;
    });
    const executor = createModelExecutor({ apiKey: 'test-only', concurrency: 1, callModel });

    const result = await executor.execute(scenario, 1);

    expect(transcripts[0][0]).toEqual({ role: 'system', content: BOOKING_CHAT_SYSTEM_PROMPT });
    expect(result.mode).toBe('model');
    expect(result.terminalKind).toBe('options');
    expect(result.toolNames).toEqual(['search_nppes', 'check_availability', 'propose_options']);
    expect(result.displayedOptions[0].providerAlias).toBe('provider-a');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(scenario.patientMessage);
    expect(serialized).not.toContain('Private model rationale');
    expect(serialized).not.toContain('Synthetic summary');
    expect(serialized).not.toContain(BOOKING_CHAT_SYSTEM_PROMPT.slice(0, 40));
  });

  it('enforces search-before-availability provenance for model-selected tools', async () => {
    const scenario = byId('routing-generalpractice-explicit');
    const responses = [
      toolMessage('check_availability', { npi: '9000000000' }, 'call-1'),
      { message: { role: 'assistant' as const, content: 'Could you try another provider?' } },
    ];
    const executor = createModelExecutor({
      apiKey: 'test-only',
      concurrency: 1,
      callModel: async () => {
        const response = responses.shift();
        if (!response) throw new Error('Unexpected model call');
        return response;
      },
    });

    const result = await executor.execute(scenario, 1);

    expect(result.terminalKind).toBe('question');
    expect(result.searchedProviderAliases).toEqual([]);
    expect(result.availableOptionKeys).toEqual([]);
    expect(result.toolNames).toEqual(['check_availability']);
  });

  it('rejects non-model-eligible scenarios before calling the model', async () => {
    const callModel = vi.fn();
    const executor = createModelExecutor({ apiKey: 'test-only', concurrency: 1, callModel });

    await expect(executor.execute(byId('preference-morning-citycenter'), 1)).rejects.toThrow(
      'not model eligible'
    );
    expect(callModel).not.toHaveBeenCalled();
  });

  it('fails closed on missing credentials or invalid concurrency', () => {
    expect(() => createModelExecutor({ apiKey: '', concurrency: 1 })).toThrow(
      'GEMINI_API_KEY is required'
    );
    expect(() => createModelExecutor({ apiKey: 'test-only', concurrency: 0 })).toThrow(
      'concurrency must be a positive integer'
    );
  });
});
