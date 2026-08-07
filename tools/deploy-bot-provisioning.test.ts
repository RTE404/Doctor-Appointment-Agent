// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MedplumClient, OperationOutcomeError } from '@medplum/core';
import { describe, expect, test, vi } from 'vitest';
import { getOrCreateDeploymentBot } from './deploy-bot-provisioning';

describe('deployment bot provisioning', () => {
  test('fails closed when the admin creation endpoint is forbidden', async () => {
    const forbidden = new OperationOutcomeError({
      resourceType: 'OperationOutcome',
      id: 'forbidden',
      issue: [{ severity: 'error', code: 'forbidden', details: { text: 'Forbidden' } }],
    });
    const createResource = vi.fn();
    const client = {
      searchOne: vi.fn().mockResolvedValue(undefined),
      post: vi.fn().mockRejectedValue(forbidden),
      createResource,
    } as unknown as MedplumClient;

    await expect(getOrCreateDeploymentBot(client, 'project-1', 'agent-intake')).rejects.toThrow(
      'Project administrator access is required'
    );
    expect(createResource).not.toHaveBeenCalled();
  });

  test('reuses an existing bot without calling the admin endpoint', async () => {
    const existingBot = { resourceType: 'Bot' as const, id: 'bot-1', name: 'agent-intake' };
    const post = vi.fn();
    const client = {
      searchOne: vi.fn().mockResolvedValue(existingBot),
      post,
    } as unknown as MedplumClient;

    await expect(getOrCreateDeploymentBot(client, 'project-1', 'agent-intake')).resolves.toBe(existingBot);
    expect(post).not.toHaveBeenCalled();
  });
});
