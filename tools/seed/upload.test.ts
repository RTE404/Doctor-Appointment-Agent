// tools/seed/upload.test.ts
import { describe, expect, test, vi } from 'vitest';
import type { Bundle } from '@medplum/fhirtypes';
import { uploadBundle } from './upload';

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

  test('a fully successful batch response does not throw', async () => {
    const bundle = { resourceType: 'Bundle', type: 'batch', entry: [{ resource: { resourceType: 'Condition', id: 'c1' }, request: { method: 'PUT', url: 'Condition/c1' } }] } as unknown as Bundle;
    const response: Bundle = { resourceType: 'Bundle', type: 'batch-response', entry: [{ response: { status: '200' } }] };
    const medplum = { executeBatch: vi.fn().mockResolvedValue(response) } as any;

    await expect(uploadBundle(medplum, bundle)).resolves.toBe(response);
  });
});
