import { describe, expect, it } from 'vitest';

import { nearestRank, summarizeDurations, summarizePerformance } from './performance';
import type { AgentEvalObservation } from './types';

const pricing = {
  version: 1 as const,
  models: { 'gemini-3.5-flash-lite': { inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5, source: 'fixture', retrievedOn: '2026-09-28' } },
};

function observation(overrides: Partial<AgentEvalObservation>): AgentEvalObservation {
  return {
    scenarioId: 's', mode: 'model', repetition: 1, terminalKind: 'options', toolNames: [], loopSteps: 1,
    displayedOptions: [], availableOptionKeys: [], searchedProviderAliases: [], clarificationAsked: false,
    confirmationRequested: false, bookingMutationCount: 0, bookingMutationCountBeforeConfirmation: 0,
    crossPatientSessionAccepted: false, duplicateAppointmentCount: 0, slotConflictRejected: false, sessionResumed: false,
    ...overrides,
  };
}

describe('nearestRank', () => {
  it('uses the nearest-rank method', () => {
    const values = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(nearestRank(values, 50)).toBe(10);
    expect(nearestRank(values, 95)).toBe(19);
    expect(nearestRank([7], 95)).toBe(7);
    expect(nearestRank([], 50)).toBeNull();
  });
});

describe('summarizeDurations', () => {
  it('labels fewer than 20 samples as low-sample but still reports p95', () => {
    expect(summarizeDurations([30, 10, 20])).toEqual({ count: 3, p50: 20, p95: 30, max: 30, lowSample: true });
    expect(summarizeDurations([])).toEqual({ count: 0, p50: null, p95: null, max: null, lowSample: true });
  });
});

describe('summarizePerformance', () => {
  it('sums a stage within a turn, separates cold turns, and splits turn totals by terminal kind', () => {
    const summary = summarizePerformance(
      [
        observation({ warmth: 'cold', telemetry: { stages: [{ stage: 'model.call', durationMs: 900, outcome: 'ok' }], modelCalls: [] } }),
        observation({
          warmth: 'warm',
          terminalKind: 'options',
          telemetry: {
            stages: [
              { stage: 'model.call', durationMs: 100, outcome: 'ok' },
              { stage: 'model.call', durationMs: 150, outcome: 'ok' },
              { stage: 'tool.find', durationMs: 40, outcome: 'error', errorCategory: 'http-5xx' },
              { stage: 'turn.total', durationMs: 400, outcome: 'ok' },
            ],
            modelCalls: [],
          },
        }),
      ],
      pricing,
      'gemini-3.5-flash-lite'
    );
    expect(summary.stages['model.call']).toMatchObject({ count: 1, p50: 250 });
    expect(summary.coldStages['model.call']).toMatchObject({ count: 1, p50: 900 });
    expect(summary.modelCallLatency).toMatchObject({ count: 2, max: 150 });
    expect(summary.turnTotalByTerminal.options).toMatchObject({ count: 1, p50: 400 });
    expect(summary.turnTotalByTerminal.question.count).toBe(0);
    expect(summary.stageErrorRate['tool.find']).toEqual({ numerator: 1, denominator: 1, value: 1 });
  });

  it('averages tokens only over turns with complete usage and counts missing usage', () => {
    const summary = summarizePerformance(
      [
        observation({ telemetry: { stages: [], modelCalls: [
          { promptTokens: 1000, completionTokens: 100, totalTokens: 1100, retries: 1 },
          { promptTokens: 2000, completionTokens: 100, totalTokens: 2100, retries: 0 },
        ] } }),
        observation({ terminalKind: 'question', telemetry: { stages: [], modelCalls: [{ retries: 0 }] } }),
      ],
      pricing,
      'gemini-3.5-flash-lite'
    );
    expect(summary.tokens).toMatchObject({ modelCalls: 3, callsMissingUsage: 1, meanPromptPerTurn: 3000, meanOutputPerTurn: 200, meanTotalPerTurn: 3200, meanTotalPerOptionsTurn: 3200 });
    expect(summary.retries).toBe(1);
    expect(summary.cost).toMatchObject({ status: 'priced', meanUsdPerTurn: (3000 * 0.3 + 200 * 2.5) / 1_000_000 });
  });

  it('reports cost as unavailable, not zero, when the model has no price entry', () => {
    const summary = summarizePerformance([observation({})], pricing, 'unknown-model');
    expect(summary.cost).toEqual({ status: 'unavailable', reason: 'No price entry for unknown-model' });
  });

  it('reports tokens per completed booking only from turns whose booking completed', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15, retries: 0 };
    const summary = summarizePerformance(
      [
        observation({ mode: 'live-smoke', bookingCompleted: true, telemetry: { stages: [{ stage: 'booking.total', durationMs: 700, outcome: 'ok' }], modelCalls: [usage] } }),
        observation({ mode: 'live-smoke', bookingCompleted: false, telemetry: { stages: [], modelCalls: [usage, usage] } }),
      ],
      pricing,
      'gemini-3.5-flash-lite'
    );
    expect(summary.tokens.meanTotalPerCompletedBooking).toBe(15);
    expect(summary.bookingTotal).toMatchObject({ count: 1, p50: 700 });
  });
});
