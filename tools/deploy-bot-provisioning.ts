// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { OperationOutcomeError } from '@medplum/core';
import type { MedplumClient, WithId } from '@medplum/core';
import type { Bot } from '@medplum/fhirtypes';

export async function getOrCreateDeploymentBot(
  medplum: MedplumClient,
  projectId: string,
  botName: string
): Promise<WithId<Bot>> {
  const existing = await medplum.searchOne('Bot', { name: botName });
  if (existing) {
    return existing;
  }

  try {
    return (await medplum.post(`admin/projects/${projectId}/bot`, { name: botName })) as WithId<Bot>;
  } catch (err) {
    if (err instanceof OperationOutcomeError && err.outcome.id === 'forbidden') {
      throw new Error(
        `Project administrator access is required to create Bot "${botName}" with its runnable ` +
          'ProjectMembership. Grant admin: true to the deployment client or use a project-admin credential.',
        { cause: err }
      );
    }
    throw err;
  }
}
