import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { billableOutputTokens, costUsd, loadPricing } from './pricing';

const price = { inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5, source: 'fixture', retrievedOn: '2026-09-28' };

const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function writeTemporaryPricingFile(contents: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'pricing-test-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'pricing.json');
  writeFileSync(path, JSON.stringify(contents), 'utf8');
  return path;
}

describe('pricing', () => {
  it('loads the checked-in table with a dated source and cached-input rate for the evaluated model', () => {
    const table = loadPricing();
    expect(table.version).toBe(1);
    expect(table.models['gemini-3.5-flash-lite']).toMatchObject({
      inputPerMillionUsd: 0.3,
      outputPerMillionUsd: 2.5,
      cachedInputPerMillionUsd: 0.03,
    });
    expect(table.models['gemini-3.5-flash-lite'].retrievedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('rejects a table whose cachedInputPerMillionUsd is negative', () => {
    const path = writeTemporaryPricingFile({
      version: 1,
      models: {
        'gemini-3.5-flash-lite': {
          inputPerMillionUsd: 0.3,
          outputPerMillionUsd: 2.5,
          cachedInputPerMillionUsd: -0.01,
          source: 'fixture',
          retrievedOn: '2026-09-28',
        },
      },
    });
    expect(() => loadPricing(path)).toThrow('Invalid pricing entry');
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

  it('prices cached prompt tokens at the cached rate and the remainder at the input rate', () => {
    const priceWithCache = { ...price, cachedInputPerMillionUsd: 0.03 };
    expect(
      costUsd(
        { promptTokens: 1_000_000, cachedPromptTokens: 400_000, completionTokens: 0, totalTokens: 1_000_000, retries: 0 },
        priceWithCache
      )
    ).toBeCloseTo(0.6 * 0.3 + 0.4 * 0.03, 10);
  });

  it('prices all prompt tokens at the input rate when cachedPromptTokens is absent', () => {
    expect(
      costUsd({ promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, retries: 0 }, { ...price, cachedInputPerMillionUsd: 0.03 })
    ).toBeCloseTo(0.3, 10);
  });

  it('prices all prompt tokens at the input rate when the price table has no cached rate, even if usage reports cached tokens', () => {
    expect(
      costUsd({ promptTokens: 1_000_000, cachedPromptTokens: 400_000, completionTokens: 0, totalTokens: 1_000_000, retries: 0 }, price)
    ).toBeCloseTo(0.3, 10);
  });

  it('rejects a malformed table', () => {
    expect(() => loadPricing('tools/eval/pricing.test.ts')).toThrow();
  });
});
