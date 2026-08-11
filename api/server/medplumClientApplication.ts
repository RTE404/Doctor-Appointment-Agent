import { MedplumClient } from '@medplum/core';
import type { AccessPolicy } from '@medplum/fhirtypes';

export interface ClientApplicationEnvironment {
  MEDPLUM_BASE_URL?: string;
  MEDPLUM_PROJECT_ID?: string;
  DEMO_MEDPLUM_CLIENT_ID?: string;
  DEMO_MEDPLUM_CLIENT_SECRET?: string;
}

export interface ClientApplicationClient {
  startClientLogin(clientId: string, clientSecret: string): Promise<unknown>;
  getAccessToken(): string | undefined;
  getProject(): { id?: string } | undefined;
  getAccessPolicy(): AccessPolicy | undefined;
}

export interface ClientApplicationSession {
  client: ClientApplicationClient;
  profile: unknown;
  accessToken: string;
}

export async function loginClientApplication(
  environment: ClientApplicationEnvironment,
  createClient: (baseUrl: string) => ClientApplicationClient = (baseUrl) => new MedplumClient({ baseUrl }),
  options: { requireReadOnlyAccessPolicy?: boolean } = {}
): Promise<ClientApplicationSession> {
  const { MEDPLUM_BASE_URL, MEDPLUM_PROJECT_ID, DEMO_MEDPLUM_CLIENT_ID, DEMO_MEDPLUM_CLIENT_SECRET } = environment;
  if (!MEDPLUM_BASE_URL || !MEDPLUM_PROJECT_ID || !DEMO_MEDPLUM_CLIENT_ID || !DEMO_MEDPLUM_CLIENT_SECRET) {
    throw new Error('Demo Medplum configuration is incomplete');
  }

  const client = createClient(MEDPLUM_BASE_URL);
  const profile = await client.startClientLogin(DEMO_MEDPLUM_CLIENT_ID, DEMO_MEDPLUM_CLIENT_SECRET);
  if (client.getProject()?.id !== MEDPLUM_PROJECT_ID) {
    throw new Error('ClientApplication project mismatch');
  }
  const accessPolicy = client.getAccessPolicy();
  if (!accessPolicy) {
    throw new Error('ClientApplication AccessPolicy is required');
  }
  if (options.requireReadOnlyAccessPolicy && !isReadOnlyAccessPolicy(accessPolicy)) {
    throw new Error('Browser ClientApplication AccessPolicy must be read-only');
  }

  const accessToken = client.getAccessToken();
  if (!accessToken) {
    throw new Error('Missing ClientApplication access token');
  }

  return { client, profile, accessToken };
}

function isReadOnlyAccessPolicy(accessPolicy: AccessPolicy): boolean {
  const readInteractions = new Set(['read', 'vread', 'history', 'search']);
  return (
    (accessPolicy.resource?.length ?? 0) > 0 &&
    accessPolicy.resource?.every((rule) => {
      if (rule.interaction?.length) {
        return rule.interaction.every((item) => readInteractions.has(item));
      }
      return rule.readonly === true;
    }) === true
  );
}
