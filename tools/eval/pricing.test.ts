import { describe, expect, it } from 'vitest';

import { billableOutputTokens, costUsd, loadPricing } from './pricing';

const price = { inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5, source: 'fixture', retrievedOn: '2026-09-28' };

describe('pricing', () => {
  it('loads the checked-in table with a dated source for the evaluated model', () => {
    const table = loadPricing();
    expect(table.version).toBe(1);
    expect(table.models['gemini-3.5-flash-lite']).toMatchObject({ inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5 });
    expect(table.models['gemini-3.5-flash-lite'].retrievedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('bills hidden thinking tokens counted in total but not completion', () => {
    expect(billableOutputTokens({ promptTokens: 100, completionTokens: 10, totalTokens: 150, retries: 0 })).toBe(50);
    expect(billableOutputTokens({ promptTokens: 100, completionTokens: 10, totalTokens: 110, retries: 0 })).toBe(10);
    expect(billableOutputTokens({ completionTokens: 10, retries: 0 })).toBe(10);
    expect(billableOutputTokens({ retries: 0 })).toBeUndefined();
  });

  it('clamps a negative hidden-token delta at zero instead of billing negative output', () => {
    expect(billableOutputTokens({ promptTokens: 100, totalTokens: 50, retries: 0 })).toBe(0);
  });

  it('computes cost from prompt and billable output tokens and refuses to estimate missing usage', () => {
    expect(costUsd({ promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000, retries: 0 }, price))
      .toBeCloseTo(2.8, 10);
    expect(costUsd({ completionTokens: 5, retries: 0 }, price)).toBeUndefined();
  });

  it('rejects a malformed table', () => {
    expect(() => loadPricing('tools/eval/pricing.test.ts')).toThrow();
  });
});
