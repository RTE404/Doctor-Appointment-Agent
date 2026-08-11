import type { AccessPolicy, ClientApplication, Project } from '@medplum/fhirtypes';
import { describe, expect, test, vi } from 'vitest';
import { loginClientApplication } from './medplumClientApplication';

const environment = {
  MEDPLUM_BASE_URL: 'https://api.example.test',
  MEDPLUM_PROJECT_ID: 'target-project',
  DEMO_MEDPLUM_CLIENT_ID: 'client-id',
  DEMO_MEDPLUM_CLIENT_SECRET: 'client-secret',
};

describe('loginClientApplication', () => {
  test('returns a verified target-project ClientApplication session', async () => {
    const profile: ClientApplication = { resourceType: 'ClientApplication', id: 'client-id' };
    const startClientLogin = vi.fn(async () => profile);
    const client = {
      startClientLogin,
      getAccessToken: () => 'short-lived-token',
      getProject: () => ({ resourceType: 'Project', id: 'target-project' }) as Project,
      getAccessPolicy: () => ({ resourceType: 'AccessPolicy' as const, resource: [{ resourceType: 'Patient', readonly: true }] }),
    };

    const result = await loginClientApplication(environment, () => client);

    expect(startClientLogin).toHaveBeenCalledWith('client-id', 'client-secret');
    expect(result).toEqual({ client, profile, accessToken: 'short-lived-token' });
  });

  test.each([
    ['MEDPLUM_BASE_URL', { MEDPLUM_BASE_URL: undefined }],
    ['MEDPLUM_PROJECT_ID', { MEDPLUM_PROJECT_ID: undefined }],
    ['DEMO_MEDPLUM_CLIENT_ID', { DEMO_MEDPLUM_CLIENT_ID: undefined }],
    ['DEMO_MEDPLUM_CLIENT_SECRET', { DEMO_MEDPLUM_CLIENT_SECRET: undefined }],
  ])('rejects missing %s configuration', async (_name, override) => {
    await expect(loginClientApplication({ ...environment, ...override })).rejects.toThrow('Demo Medplum configuration is incomplete');
  });

  test('rejects a token issued for a different project', async () => {
    const client = {
      startClientLogin: async () => ({ resourceType: 'ClientApplication' as const, id: 'client-id' }),
      getAccessToken: () => 'wrong-project-token',
      getProject: () => ({ resourceType: 'Project' as const, id: 'other-project' }),
      getAccessPolicy: () => ({ resourceType: 'AccessPolicy' as const, resource: [{ resourceType: 'Patient', readonly: true }] }),
    };

    await expect(loginClientApplication(environment, () => client)).rejects.toThrow('ClientApplication project mismatch');
  });

  test('rejects a login without an access token', async () => {
    const client = {
      startClientLogin: async () => ({ resourceType: 'ClientApplication' as const, id: 'client-id' }),
      getAccessToken: () => undefined,
      getProject: () => ({ resourceType: 'Project' as const, id: 'target-project' }),
      getAccessPolicy: () => ({ resourceType: 'AccessPolicy' as const, resource: [{ resourceType: 'Patient', readonly: true }] }),
    };

    await expect(loginClientApplication(environment, () => client)).rejects.toThrow('Missing ClientApplication access token');
  });

  test('rejects a ClientApplication without an explicit AccessPolicy', async () => {
    const client = {
      startClientLogin: async () => ({ resourceType: 'ClientApplication' as const, id: 'client-id' }),
      getAccessToken: () => 'unscoped-token',
      getProject: () => ({ resourceType: 'Project' as const, id: 'target-project' }),
      getAccessPolicy: () => undefined,
    };

    await expect(loginClientApplication(environment, () => client)).rejects.toThrow('ClientApplication AccessPolicy is required');
  });

  test('rejects a writable AccessPolicy for a browser session', async () => {
    const client = {
      startClientLogin: async () => ({ resourceType: 'ClientApplication' as const, id: 'client-id' }),
      getAccessToken: () => 'writable-browser-token',
      getProject: () => ({ resourceType: 'Project' as const, id: 'target-project' }),
      getAccessPolicy: () => ({ resourceType: 'AccessPolicy' as const, resource: [{ resourceType: 'Appointment' }] }),
    };

    await expect(loginClientApplication(environment, () => client, { requireReadOnlyAccessPolicy: true })).rejects.toThrow(
      'Browser ClientApplication AccessPolicy must be read-only'
    );
  });

  test('rejects a writable interaction even when the rule also says readonly', async () => {
    const client = {
      startClientLogin: async () => ({ resourceType: 'ClientApplication' as const, id: 'client-id' }),
      getAccessToken: () => 'writable-browser-token',
      getProject: () => ({ resourceType: 'Project' as const, id: 'target-project' }),
      getAccessPolicy: (): AccessPolicy => ({
        resourceType: 'AccessPolicy' as const,
        resource: [{ resourceType: 'Appointment', readonly: true, interaction: ['read', 'update'] }],
      }),
    };

    await expect(loginClientApplication(environment, () => client, { requireReadOnlyAccessPolicy: true })).rejects.toThrow(
      'Browser ClientApplication AccessPolicy must be read-only'
    );
  });
});
