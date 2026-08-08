// tools/seed/upload.test.ts
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Bundle } from '@medplum/fhirtypes';
import { uploadBundle } from './upload';

afterEach(() => {
  vi.useRealTimers();
});

describe('uploadBundle', () => {
  test('calls executeBatch once on success and returns the response', async () => {
    const bundle: Bundle = { resourceType: 'Bundle', type: 'transaction', entry: [] };
    const response: Bundle = { resourceType: 'Bundle', type: 'transaction-response', entry: [] };
    const executeBatch = vi.fn().mockResolvedValue(response);
    const medplum = { executeBatch } as any;

    const result = await uploadBundle(medplum, bundle);

    expect(executeBatch).toHaveBeenCalledTimes(1);
    expect(executeBatch).toHaveBeenCalledWith(bundle);
    expect(result).toBe(response);
  });

  test('retries a raw network failure (no structured outcome), then succeeds', async () => {
    const bundle: Bundle = { resourceType: 'Bundle', type: 'transaction', entry: [] };
    const executeBatch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ resourceType: 'Bundle', type: 'transaction-response', entry: [] });
    const medplum = { executeBatch } as any;

    await uploadBundle(medplum, bundle);

    expect(executeBatch).toHaveBeenCalledTimes(2);
  });

  test('retries a transient OperationOutcome (e.g. timeout), then succeeds', async () => {
    const bundle: Bundle = { resourceType: 'Bundle', type: 'transaction', entry: [] };
    const transientError = { outcome: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'timeout' }] } };
    const executeBatch = vi
      .fn()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce({ resourceType: 'Bundle', type: 'transaction-response', entry: [] });
    const medplum = { executeBatch } as any;

    await uploadBundle(medplum, bundle);

    expect(executeBatch).toHaveBeenCalledTimes(2);
  });

  test('does not retry a validation error (a real, non-transient OperationOutcome issue code)', async () => {
    const bundle: Bundle = { resourceType: 'Bundle', type: 'transaction', entry: [] };
    const validationError = { outcome: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid' }] } };
    const executeBatch = vi.fn().mockRejectedValue(validationError);
    const medplum = { executeBatch } as any;

    await expect(uploadBundle(medplum, bundle)).rejects.toBe(validationError);
    expect(executeBatch).toHaveBeenCalledTimes(1);
  });

  test('throws if any entry in a batch response failed, even though the overall HTTP call resolved — a batch response can carry per-entry failures without the request itself rejecting', async () => {
    // Fixture resources are deliberately minimal (only the fields this test exercises) —
    // cast rather than fully satisfy @medplum/fhirtypes' Condition interface.
    const bundle = {
      resourceType: 'Bundle',
      type: 'batch',
      entry: [
        { resource: { resourceType: 'Condition', id: 'c1' }, request: { method: 'PUT', url: 'Condition/c1' } },
        { resource: { resourceType: 'Condition', id: 'c2' }, request: { method: 'PUT', url: 'Condition/c2' } },
      ],
    } as unknown as Bundle;
    const response: Bundle = {
      resourceType: 'Bundle',
      type: 'batch-response',
      entry: [
        { response: { status: '201' } },
        { response: { status: '400', outcome: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid' }] } } },
      ],
    };
    const executeBatch = vi.fn().mockResolvedValue(response);
    const medplum = { executeBatch } as any;

    await expect(uploadBundle(medplum, bundle)).rejects.toThrow(/1 failed entr/);
  });

  test('a throttled batch entry (429) retries after waiting the server-diagnosed backoff, then succeeds', async () => {
    // Reproduces a live failure: a real Medplum hosted project's rate limiter
    // returned 429s with `_msBeforeNext` still ~24-48s away, and the retry
    // loop was firing all 3 attempts with no delay — instantly re-hitting
    // the same exhausted rate-limit window every time.
    vi.useFakeTimers();
    const bundle = {
      resourceType: 'Bundle',
      type: 'batch',
      entry: [{ resource: { resourceType: 'Encounter', id: 'e1' }, request: { method: 'POST', url: 'Encounter' } }],
    } as unknown as Bundle;
    const throttledResponse: Bundle = {
      resourceType: 'Bundle',
      type: 'batch-response',
      entry: [
        {
          response: {
            status: '429',
            outcome: {
              resourceType: 'OperationOutcome',
              issue: [{ severity: 'error', code: 'throttled', diagnostics: JSON.stringify({ _msBeforeNext: 5000 }) }],
            },
          },
        },
      ],
    };
    const okResponse: Bundle = { resourceType: 'Bundle', type: 'batch-response', entry: [{ response: { status: '201' } }] };
    const executeBatch = vi.fn().mockResolvedValueOnce(throttledResponse).mockResolvedValueOnce(okResponse);
    const medplum = { executeBatch } as any;

    const resultPromise = uploadBundle(medplum, bundle);
    // Only 4999ms elapsed: must not have retried yet.
    await vi.advanceTimersByTimeAsync(4999);
    expect(executeBatch).toHaveBeenCalledTimes(1);
    // The remaining 1ms crosses the full 5000ms the server asked for.
    await vi.advanceTimersByTimeAsync(1);
    await resultPromise;

    expect(executeBatch).toHaveBeenCalledTimes(2);
  });

  test('retries a batch when a newly-created conditional reference is not searchable yet', async () => {
    vi.useFakeTimers();
    const bundle = {
      resourceType: 'Bundle',
      type: 'batch',
      entry: [{ resource: { resourceType: 'Encounter' }, request: { method: 'POST', url: 'Encounter' } }],
    } as unknown as Bundle;
    const notIndexedResponse: Bundle = {
      resourceType: 'Bundle',
      type: 'batch-response',
      entry: [
        {
          response: {
            status: '400',
            outcome: {
              resourceType: 'OperationOutcome',
              issue: [
                {
                  severity: 'error',
                  code: 'invalid',
                  details: {
                    text:
                      "Conditional reference 'Practitioner?identifier=https://synthea.mitre.org/identifier|p1' did not match any resources",
                  },
                },
              ],
            },
          },
        },
      ],
    };
    const okResponse: Bundle = {
      resourceType: 'Bundle',
      type: 'batch-response',
      entry: [{ response: { status: '201' } }],
    };
    const executeBatch = vi.fn().mockResolvedValueOnce(notIndexedResponse).mockResolvedValueOnce(okResponse);
    const medplum = { executeBatch } as any;

    const resultPromise = uploadBundle(medplum, bundle);
    const expectation = expect(resultPromise).resolves.toBe(okResponse);
    await vi.advanceTimersByTimeAsync(500);
    await expectation;
    expect(executeBatch).toHaveBeenCalledTimes(2);
  });

  test('retries a transaction response with a failed throttled entry', async () => {
    vi.useFakeTimers();
    const bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [{ resource: { resourceType: 'Practitioner' }, request: { method: 'POST', url: 'Practitioner' } }],
    } as unknown as Bundle;
    const throttledResponse: Bundle = {
      resourceType: 'Bundle',
      type: 'transaction-response',
      entry: [
        {
          response: {
            status: '429',
            outcome: {
              resourceType: 'OperationOutcome',
              issue: [
                {
                  severity: 'error',
                  code: 'throttled',
                  diagnostics: JSON.stringify({ _msBeforeNext: 5000 }),
                },
              ],
            },
          },
        },
      ],
    };
    const okResponse: Bundle = {
      resourceType: 'Bundle',
      type: 'transaction-response',
      entry: [{ response: { status: '201' } }],
    };
    const executeBatch = vi.fn().mockResolvedValueOnce(throttledResponse).mockResolvedValueOnce(okResponse);
    const medplum = { executeBatch } as any;

    const resultPromise = uploadBundle(medplum, bundle);
    const expectation = expect(resultPromise).resolves.toBe(okResponse);
    await vi.advanceTimersByTimeAsync(5000);
    await expectation;
    expect(executeBatch).toHaveBeenCalledTimes(2);
  });

  test('a fully successful batch response does not throw', async () => {
    const bundle = { resourceType: 'Bundle', type: 'batch', entry: [{ resource: { resourceType: 'Condition', id: 'c1' }, request: { method: 'PUT', url: 'Condition/c1' } }] } as unknown as Bundle;
    const response: Bundle = { resourceType: 'Bundle', type: 'batch-response', entry: [{ response: { status: '200' } }] };
    const medplum = { executeBatch: vi.fn().mockResolvedValue(response) } as any;

    await expect(uploadBundle(medplum, bundle)).resolves.toBe(response);
  });
});
