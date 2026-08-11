import { describe, expect, test, vi } from 'vitest';
import { handleDemoSessionRequest } from './demo-session';
import type { DemoSessionDependencies, DemoSessionEnvironment, DemoSessionRequest } from './demo-session';

const environment: DemoSessionEnvironment = {
  MEDPLUM_BASE_URL: 'https://api.example.test',
  MEDPLUM_PROJECT_ID: 'target-project',
  DEMO_ACCESS_CODE: 'shared-code',
  DEMO_MEDPLUM_CLIENT_ID: 'client-id',
  DEMO_MEDPLUM_CLIENT_SECRET: 'client-secret',
};

function request(body: unknown, contentType = 'application/json'): DemoSessionRequest {
  return { method: 'POST', headers: { 'content-type': contentType }, body };
}

function dependencies(): DemoSessionDependencies {
  return {
    login: vi.fn(async () => ({ accessToken: 'short-lived-token' })),
  };
}

describe('handleDemoSessionRequest', () => {
  test('returns a short-lived ClientApplication token for the shared code', async () => {
    const deps = dependencies();

    const response = await handleDemoSessionRequest(request({ code: 'shared-code' }), environment, deps);

    expect(response).toEqual({ status: 200, body: { accessToken: 'short-lived-token' } });
    expect(deps.login).toHaveBeenCalledWith(environment);
  });

  test.each([
    ['wrong code', { code: 'wrong-code' }],
    ['missing code', {}],
    ['non-string code', { code: 123 }],
  ])('rejects %s without attempting Medplum login', async (_name, body) => {
    const deps = dependencies();

    const response = await handleDemoSessionRequest(request(body), environment, deps);

    expect(response).toEqual({ status: 401, body: { error: 'Invalid demo code' } });
    expect(deps.login).not.toHaveBeenCalled();
  });

  test.each([
    ['unsupported method', { method: 'GET', headers: {}, body: undefined }],
    ['wrong content type', request({ code: 'shared-code' }, 'text/plain')],
    ['malformed JSON', request('{')],
    ['array body', request([])],
  ])('returns 400 for %s', async (_name, invalidRequest) => {
    const response = await handleDemoSessionRequest(invalidRequest, environment, dependencies());

    expect(response).toEqual({ status: 400, body: { error: 'Invalid request' } });
  });

  test('returns a sanitized unavailable response when configuration is missing', async () => {
    const deps = dependencies();
    const response = await handleDemoSessionRequest(request({ code: 'shared-code' }), { ...environment, DEMO_ACCESS_CODE: undefined }, deps);

    expect(response).toEqual({ status: 503, body: { error: 'Demo access unavailable' } });
    expect(deps.login).not.toHaveBeenCalled();
  });

  test('sanitizes ClientApplication login failures', async () => {
    const deps: DemoSessionDependencies = {
      login: async () => {
        throw new Error('client-secret shared-code server-marker');
      },
    };

    const response = await handleDemoSessionRequest(request({ code: 'shared-code' }), environment, deps);
    const serialized = JSON.stringify(response);

    expect(response).toEqual({ status: 503, body: { error: 'Demo access unavailable' } });
    expect(serialized).not.toContain('client-secret');
    expect(serialized).not.toContain('shared-code');
    expect(serialized).not.toContain('server-marker');
  });
});
