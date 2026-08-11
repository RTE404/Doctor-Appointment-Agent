import { OperationOutcomeError } from '@medplum/core';
import type { Appointment, Communication, Encounter } from '@medplum/fhirtypes';
import { describe, expect, test, vi } from 'vitest';
import { handleResetDemoRequest, resetDemoResources } from './reset-demo';
import type { DemoResetClient, ResetDemoDependencies, ResetDemoEnvironment, ResetDemoRequest } from './reset-demo';

const environment: ResetDemoEnvironment = {
  MEDPLUM_BASE_URL: 'https://api.example.test',
  MEDPLUM_PROJECT_ID: 'target-project',
  DEMO_WORKER_CLIENT_ID: 'worker-client-id',
  DEMO_WORKER_CLIENT_SECRET: 'worker-client-secret',
  CRON_SECRET: 'cron-secret-at-least-sixteen-characters',
};

function request(authorization = `Bearer ${environment.CRON_SECRET}`): ResetDemoRequest {
  return { method: 'GET', headers: { authorization } };
}

function clientFixture(): DemoResetClient & {
  searchResources: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  deleteResource: ReturnType<typeof vi.fn>;
} {
  const appointments: (Appointment & { id: string })[] = [
    { resourceType: 'Appointment', id: 'booked', status: 'booked', participant: [] },
    { resourceType: 'Appointment', id: 'pending', status: 'pending', participant: [] },
    { resourceType: 'Appointment', id: 'proposed', status: 'proposed', participant: [] },
    { resourceType: 'Appointment', id: 'fulfilled', status: 'fulfilled', participant: [] },
  ];
  const communications: (Communication & { id: string })[] = [
    { resourceType: 'Communication', id: 'conversation', status: 'completed' },
  ];
  const encounters: (Encounter & { id: string })[] = [
    { resourceType: 'Encounter', id: 'demo-encounter', status: 'finished', class: { code: 'VR' } },
  ];
  const searches = new Map<string, number>();
  return {
    searchResources: vi.fn(async (resourceType: string) => {
      const call = searches.get(resourceType) ?? 0;
      searches.set(resourceType, call + 1);
      if (call > 0) {
        return [];
      }
      return resourceType === 'Appointment' ? appointments : resourceType === 'Communication' ? communications : encounters;
    }),
    fhirUrl: (resourceType, id, operation) =>
      new URL(`https://api.example.test/fhir/R4/${resourceType}/${id}/${operation}`),
    post: vi.fn(async () => ({})),
    deleteResource: vi.fn(async () => ({})),
  };
}

describe('resetDemoResources', () => {
  test('cancels active tagged appointments, then deletes only tagged activity', async () => {
    const client = clientFixture();

    const result = await resetDemoResources(client);

    expect(client.searchResources).toHaveBeenCalledWith('Appointment', {
      _tag: 'https://doctor-appointment-agent.example/fhir/demo|demo-generated',
      _count: '100',
    });
    expect(client.searchResources).toHaveBeenCalledWith('Communication', {
      _tag: 'https://doctor-appointment-agent.example/fhir/demo|demo-generated',
      _count: '100',
    });
    expect(client.searchResources).toHaveBeenCalledWith('Encounter', {
      _tag: 'https://doctor-appointment-agent.example/fhir/demo|demo-generated',
      _count: '100',
    });
    expect(client.post).toHaveBeenCalledTimes(2);
    expect(client.post.mock.calls.map(([url]) => url.toString())).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/Appointment/booked/$cancel'),
        expect.stringContaining('/Appointment/pending/$cancel'),
      ])
    );
    expect(client.post.mock.calls.map(([url]) => url.toString()).join(' ')).not.toContain('/Appointment/proposed/$cancel');
    expect(client.deleteResource.mock.calls).toEqual(
      expect.arrayContaining([
        ['Appointment', 'booked'],
        ['Appointment', 'pending'],
        ['Appointment', 'proposed'],
        ['Appointment', 'fulfilled'],
        ['Communication', 'conversation'],
        ['Encounter', 'demo-encounter'],
      ])
    );
    expect(result).toStrictEqual({
      appointmentsCancelled: 2,
      appointmentsDeleted: 4,
      communicationsDeleted: 1,
      encountersDeleted: 1,
    });
  });

  test('treats already-deleted resources as an idempotent success', async () => {
    const client = clientFixture();
    const notFound = new OperationOutcomeError({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'not-found' }],
    });
    client.post.mockRejectedValue(notFound);
    client.deleteResource.mockRejectedValue(notFound);

    await expect(resetDemoResources(client)).resolves.toStrictEqual({
      appointmentsCancelled: 0,
      appointmentsDeleted: 0,
      communicationsDeleted: 0,
      encountersDeleted: 0,
    });
  });

  test('drains multiple nonempty pages while limiting concurrent deletes to ten', async () => {
    const appointmentPages: (Appointment & { id: string })[][] = [
      Array.from({ length: 11 }, (_, index) => ({
        resourceType: 'Appointment' as const,
        id: `page-one-${index}`,
        status: 'fulfilled' as const,
        participant: [],
      })),
      [{ resourceType: 'Appointment', id: 'page-two', status: 'fulfilled', participant: [] }],
      [],
    ];
    let appointmentSearches = 0;
    let activeDeletes = 0;
    let maximumActiveDeletes = 0;
    const client: DemoResetClient = {
      searchResources: vi.fn(async (resourceType) => {
        if (resourceType !== 'Appointment') {
          return [];
        }
        return appointmentPages[appointmentSearches++] ?? [];
      }),
      fhirUrl: (resourceType, id, operation) =>
        new URL(`https://api.example.test/fhir/R4/${resourceType}/${id}/${operation}`),
      post: vi.fn(async () => ({})),
      deleteResource: vi.fn(async () => {
        activeDeletes += 1;
        maximumActiveDeletes = Math.max(maximumActiveDeletes, activeDeletes);
        await new Promise((resolve) => {
          setTimeout(resolve, 1);
        });
        activeDeletes -= 1;
      }),
    };

    await expect(resetDemoResources(client)).resolves.toStrictEqual({
      appointmentsCancelled: 0,
      appointmentsDeleted: 12,
      communicationsDeleted: 0,
      encountersDeleted: 0,
    });
    expect(appointmentSearches).toBe(3);
    expect(maximumActiveDeletes).toBe(10);
  });
});

describe('handleResetDemoRequest', () => {
  test('runs the reset for Vercel cron authorization', async () => {
    const client = clientFixture();
    const dependencies: ResetDemoDependencies = { login: vi.fn(async () => ({ client })) };

    const response = await handleResetDemoRequest(request(), environment, dependencies);

    expect(response).toEqual({
      status: 200,
      body: {
        ok: true,
        appointmentsCancelled: 2,
        appointmentsDeleted: 4,
        communicationsDeleted: 1,
        encountersDeleted: 1,
      },
    });
    expect(dependencies.login).toHaveBeenCalledWith(environment);
  });

  test.each([
    ['missing authorization', request('')],
    ['wrong scheme', request('Basic cron-secret-at-least-sixteen-characters')],
    ['wrong secret', request('Bearer wrong-secret')],
  ])('rejects %s without touching Medplum', async (_name, invalidRequest) => {
    const dependencies: ResetDemoDependencies = { login: vi.fn() };

    const response = await handleResetDemoRequest(invalidRequest, environment, dependencies);

    expect(response).toEqual({ status: 401, body: { error: 'Unauthorized' } });
    expect(dependencies.login).not.toHaveBeenCalled();
  });

  test('returns 503 when reset configuration is incomplete', async () => {
    const response = await handleResetDemoRequest(request(), { ...environment, CRON_SECRET: undefined }, { login: vi.fn() });

    expect(response).toEqual({ status: 503, body: { error: 'Demo reset unavailable' } });
  });

  test('rejects unsupported methods', async () => {
    const response = await handleResetDemoRequest({ ...request(), method: 'POST' }, environment, { login: vi.fn() });

    expect(response).toEqual({ status: 405, body: { error: 'Method not allowed' } });
  });

  test('sanitizes login and cleanup failures', async () => {
    const dependencies: ResetDemoDependencies = {
      login: async () => {
        throw new Error('cron-secret client-secret sensitive-marker');
      },
    };

    const response = await handleResetDemoRequest(request(), environment, dependencies);
    const serialized = JSON.stringify(response);

    expect(response).toEqual({ status: 500, body: { error: 'Demo reset failed' } });
    expect(serialized).not.toContain('cron-secret');
    expect(serialized).not.toContain('client-secret');
    expect(serialized).not.toContain('sensitive-marker');
  });
});
