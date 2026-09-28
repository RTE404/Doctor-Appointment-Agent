import { describe, expect, it } from 'vitest';

import {
  AGENT_STAGES,
  categorizeError,
  createAgentTelemetry,
  isToolErrorResult,
  noopTelemetry,
} from './agentTelemetry';

function fakeClock(...readings: number[]): () => number {
  let index = 0;
  return () => readings[Math.min(index++, readings.length - 1)];
}

describe('createAgentTelemetry', () => {
  it('records an ok stage with the clock-measured duration and returns the result', async () => {
    const telemetry = createAgentTelemetry(fakeClock(10, 35));
    await expect(telemetry.time('model.call', async () => 'value')).resolves.toBe('value');
    expect(telemetry.snapshot().stages).toEqual([{ stage: 'model.call', durationMs: 25, outcome: 'ok' }]);
  });

  it('records a thrown error with a sanitized category and rethrows the original error', async () => {
    const telemetry = createAgentTelemetry(fakeClock(0, 5));
    const original = new Error('Gemini request failed: 503');
    await expect(telemetry.time('model.call', async () => { throw original; })).rejects.toBe(original);
    expect(telemetry.snapshot().stages).toEqual([
      { stage: 'model.call', durationMs: 5, outcome: 'error', errorCategory: 'http-5xx' },
    ]);
  });

  it('records a resolved { error } tool result as a validation error and returns it unchanged', async () => {
    const telemetry = createAgentTelemetry(fakeClock(0, 2));
    const result = { error: 'NPI 1234567890 was not returned by a search' };
    await expect(
      telemetry.time('tool.find', async () => result, { isErrorResult: isToolErrorResult })
    ).resolves.toBe(result);
    expect(telemetry.snapshot().stages[0]).toEqual({
      stage: 'tool.find', durationMs: 2, outcome: 'error', errorCategory: 'validation',
    });
  });

  it('still returns the work result when the clock throws', async () => {
    let calls = 0;
    const telemetry = createAgentTelemetry(() => {
      calls += 1;
      if (calls > 1) throw new Error('clock failure');
      return 0;
    });
    await expect(telemetry.time('session.persist', async () => 42)).resolves.toBe(42);
    expect(telemetry.snapshot().stages).toEqual([]);
  });

  it('records model usage and returns copies from snapshot', () => {
    const telemetry = createAgentTelemetry();
    telemetry.recordModelUsage({ promptTokens: 100, completionTokens: 20, totalTokens: 120, retries: 1 });
    const first = telemetry.snapshot();
    first.modelCalls.push({ retries: 9 });
    expect(telemetry.snapshot().modelCalls).toEqual([
      { promptTokens: 100, completionTokens: 20, totalTokens: 120, retries: 1 },
    ]);
  });

  it('serializes only allowlisted keys and enum string values, whatever the inputs contained', async () => {
    const telemetry = createAgentTelemetry(fakeClock(0, 1, 1, 3, 3, 4));
    await telemetry.time('tool.nppes-search', async () => ({ patientId: 'Patient/abc', npi: '1234567890' }));
    await telemetry.time('model.call', async () => { throw new Error('Bearer secret-token Patient/abc'); }).catch(() => undefined);
    await telemetry.time('tool.find', async () => ({ error: 'Practitioner/xyz transcript text' }), { isErrorResult: isToolErrorResult });
    telemetry.recordModelUsage({ promptTokens: 1, completionTokens: 1, totalTokens: 2, retries: 0 });

    const allowedKeys = new Set(['stages', 'modelCalls', 'stage', 'durationMs', 'outcome', 'errorCategory',
      'promptTokens', 'completionTokens', 'totalTokens', 'retries']);
    const allowedStrings = new Set<string>([...AGENT_STAGES, 'ok', 'error', 'skipped',
      'timeout', 'http-4xx', 'http-5xx', 'validation', 'unknown']);
    JSON.parse(JSON.stringify(telemetry.snapshot()), (key, value) => {
      if (key !== '' && !/^\d+$/.test(key)) expect(allowedKeys.has(key)).toBe(true);
      if (typeof value === 'string') expect(allowedStrings.has(value)).toBe(true);
      return value;
    });
  });
});

describe('categorizeError', () => {
  it('maps error names and statuses to categories without reading other text', () => {
    expect(categorizeError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('timeout');
    expect(categorizeError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(categorizeError(Object.assign(new Error('x'), { status: 404 }))).toBe('http-4xx');
    expect(categorizeError(new Error('Gemini request failed: 429'))).toBe('http-4xx');
    expect(categorizeError(new Error('Gemini request failed: 502'))).toBe('http-5xx');
    expect(categorizeError(new Error('NPPES search failed: 503'))).toBe('http-5xx');
    expect(categorizeError(new Error('something else'))).toBe('unknown');
    expect(categorizeError('not an error')).toBe('unknown');
  });
});

describe('noopTelemetry', () => {
  it('passes results and errors through and records nothing', async () => {
    await expect(noopTelemetry.time('turn.total', async () => 'x')).resolves.toBe('x');
    await expect(noopTelemetry.time('turn.total', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    noopTelemetry.recordModelUsage({ retries: 0 });
    expect(noopTelemetry.snapshot()).toEqual({ stages: [], modelCalls: [] });
  });
});
