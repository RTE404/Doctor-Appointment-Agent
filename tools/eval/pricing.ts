import { readFileSync } from 'node:fs';

import type { ModelUsageRecord } from '../../src/bots/agent/lib/agentTelemetry.js';

export interface ModelPrice {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cachedInputPerMillionUsd?: number;
  source: string;
  retrievedOn: string;
  notes?: string;
}

export interface PricingTable {
  version: 1;
  models: Record<string, ModelPrice>;
}

export function loadPricing(path = 'tools/eval/pricing.json'): PricingTable {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as PricingTable;
  if (parsed.version !== 1 || typeof parsed.models !== 'object' || parsed.models === null) {
    throw new Error('Invalid pricing table');
  }
  for (const price of Object.values(parsed.models)) {
    if (
      !(price.inputPerMillionUsd >= 0) ||
      !(price.outputPerMillionUsd >= 0) ||
      (price.cachedInputPerMillionUsd !== undefined && !(price.cachedInputPerMillionUsd >= 0)) ||
      typeof price.source !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(price.retrievedOn)
    ) {
      throw new Error('Invalid pricing entry');
    }
  }
  return parsed;
}

export function billableOutputTokens(usage: ModelUsageRecord): number | undefined {
  const hiddenInclusive =
    usage.totalTokens !== undefined && usage.promptTokens !== undefined
      ? Math.max(0, usage.totalTokens - usage.promptTokens)
      : undefined;
  if (usage.completionTokens === undefined) return hiddenInclusive;
  return hiddenInclusive === undefined ? usage.completionTokens : Math.max(usage.completionTokens, hiddenInclusive);
}

export function costUsd(usage: ModelUsageRecord, price: ModelPrice): number | undefined {
  const output = billableOutputTokens(usage);
  if (usage.promptTokens === undefined || output === undefined) return undefined;
  if (usage.cachedPromptTokens !== undefined && price.cachedInputPerMillionUsd !== undefined) {
    const cached = Math.min(usage.cachedPromptTokens, usage.promptTokens);
    const uncached = usage.promptTokens - cached;
    return (
      (cached * price.cachedInputPerMillionUsd +
        uncached * price.inputPerMillionUsd +
        output * price.outputPerMillionUsd) /
      1_000_000
    );
  }
  return (usage.promptTokens * price.inputPerMillionUsd + output * price.outputPerMillionUsd) / 1_000_000;
}
