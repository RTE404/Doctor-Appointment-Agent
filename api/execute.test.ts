import type { BotEvent, MedplumClient } from '@medplum/core';
import { describe, expect, test, vi } from 'vitest';
import {
  ALLOWED_ACTIONS,
  dispatchAction,
  handleExecuteRequest,
} from './execute';
import type {
  ActionName,
  ExecuteDependencies,
  ExecuteEnvironment,
  ExecuteRequest,
  RuntimeActionHandler,
} from './execute';

const environment: ExecuteEnvironment = {
  MEDPLUM_BASE_URL: 'https://api.example.test',
  MEDPLUM_PROJECT_ID: 'target-project',
  GEMINI_API_KEY: 'gemini-key',
};

const profile = { resourceType: 'Practitioner' as const, id: 'synthetic-user' };
const medplum = { getProfileAsync: async () => profile } as unknown as MedplumClient;

function request(body: unknown, authorization?: string, contentType = 'application/json'): ExecuteRequest {
  return {
    method: 'POST',
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(contentType ? { 'content-type': contentType } : {}),
    },
    body,
  };
}

function createHandlers(): {
  handlers: Record<ActionName, RuntimeActionHandler>;
  seen: Partial<Record<ActionName, BotEvent<Record<string, unknown>>>>;
} {
  const seen: Partial<Record<ActionName, BotEvent<Record<string, unknown>>>> = {};
  const handlers = Object.fromEntries(
    ALLOWED_ACTIONS.map((action) => [
      action,
      async (_client: MedplumClient, event: BotEvent<Record<string, unknown>>) => {
        seen[action] = event;
        return { action };
      },
    ])
  ) as Record<ActionName, RuntimeActionHandler>;

  return { handlers, seen };
}

function createDependencies(handlers: Record<ActionName, RuntimeActionHandler>): ExecuteDependencies {
  return {
    handlers,
    authenticate: async () => ({ medplum, profile, projectId: 'target-project' }),
  };
}

describe('dispatchAction', () => {
  test.each(ALLOWED_ACTIONS)('dispatches the allowlisted %s action', async (action) => {
    const { handlers, seen } = createHandlers();
    const result = await dispatchAction(medplum, action, { marker: action }, 'gemini-key', handlers);

    expect(result).toEqual({ action });
    expect(seen[action]?.input).toEqual({ marker: action });
  });

  test.each(['agent-intake', 'agent-patient-chat'] as const)('passes GEMINI_API_KEY only to %s', async (action) => {
    const { handlers, seen } = createHandlers();

    await dispatchAction(medplum, action, {}, 'gemini-key', handlers);

    expect(seen[action]?.secrets).toEqual({
      GEMINI_API_KEY: { name: 'GEMINI_API_KEY', valueString: 'gemini-key' },
    });
  });

  test.each(['block-availability', 'reschedule-appointment', 'agent-find-doctors', 'agent-ensure-doctor', 'agent-book-appointment'] as const)(
    'does not pass secrets to %s',
    async (action) => {
      const { handlers, seen } = createHandlers();

      await dispatchAction(medplum, action, {}, 'gemini-key', handlers);

      expect(seen[action]?.secrets).toEqual({});
    }
  );
});

describe('handleExecuteRequest', () => {
  test('returns the unauthenticated GET health response', async () => {
    const response = await handleExecuteRequest({ method: 'GET', headers: {} }, environment, createDependencies(createHandlers().handlers));

    expect(response).toEqual({ status: 200, body: { ok: true, service: 'doctor-appointment-agent' } });
  });

  test('returns 400 for unsupported methods', async () => {
    const response = await handleExecuteRequest({ method: 'PUT', headers: {} }, environment, createDependencies(createHandlers().handlers));

    expect(response).toEqual({ status: 400, body: { error: 'Invalid request' } });
  });

  test('returns 401 without a bearer token', async () => {
    const response = await handleExecuteRequest(
      request({ action: 'agent-intake', input: {} }),
      environment,
      createDependencies(createHandlers().handlers)
    );

    expect(response).toEqual({ status: 401, body: { error: 'Authentication required' } });
  });

  test('returns 401 when auth/me rejects the bearer token', async () => {
    const dependencies = createDependencies(createHandlers().handlers);
    dependencies.authenticate = async () => {
      throw new Error('invalid-token-marker');
    };

    const response = await handleExecuteRequest(request({ action: 'agent-intake', input: {} }, 'Bearer valid-token'), environment, dependencies);

    expect(response).toEqual({ status: 401, body: { error: 'Authentication required' } });
    expect(JSON.stringify(response)).not.toContain('valid-token');
  });

  test('returns 403 when the token belongs to another Medplum project', async () => {
    const dependencies = createDependencies(createHandlers().handlers);
    dependencies.authenticate = async () => ({ medplum, profile, projectId: 'other-project' });

    const response = await handleExecuteRequest(request({ action: 'agent-intake', input: {} }, 'Bearer valid-token'), environment, dependencies);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'Project access denied' });
  });

  test('executes an allowlisted action for a valid target-project session', async () => {
    const handlers = createHandlers();
    handlers.handlers['agent-intake'] = async () => ({ ok: true });
    const response = await handleExecuteRequest(
      request({ action: 'agent-intake', input: { patientId: 'synthetic' } }, 'Bearer valid-token'),
      environment,
      createDependencies(handlers.handlers)
    );

    expect(response).toEqual({ status: 200, body: { ok: true } });
  });

  test('accepts application/json with a charset parameter', async () => {
    const response = await handleExecuteRequest(
      request({ action: 'block-availability', input: {} }, 'Bearer valid-token', 'application/json; charset=utf-8'),
      environment,
      createDependencies(createHandlers().handlers)
    );

    expect(response).toEqual({ status: 200, body: { action: 'block-availability' } });
  });

  test.each([
    ['missing content type', request({ action: 'agent-intake', input: {} }, 'Bearer valid-token', '')],
    ['wrong content type', request({ action: 'agent-intake', input: {} }, 'Bearer valid-token', 'text/plain')],
    ['JSONP content type', request({ action: 'agent-intake', input: {} }, 'Bearer valid-token', 'application/jsonp')],
    ['malformed JSON', request('{', 'Bearer valid-token')],
    ['non-object body', request(['not', 'an', 'object'], 'Bearer valid-token')],
    ['non-object input', request({ action: 'agent-intake', input: [] }, 'Bearer valid-token')],
    ['unknown action', request({ action: 'not-allowlisted', input: {} }, 'Bearer valid-token')],
  ])('returns 400 for %s', async (_name, invalidRequest) => {
    const response = await handleExecuteRequest(invalidRequest, environment, createDependencies(createHandlers().handlers));

    expect(response).toEqual({ status: 400, body: { error: 'Invalid request' } });
  });

  test('returns a sanitized 500 response when server configuration is missing', async () => {
    const response = await handleExecuteRequest(
      request({ action: 'block-availability', input: {} }, 'Bearer valid-token'),
      { ...environment, MEDPLUM_BASE_URL: undefined },
      createDependencies(createHandlers().handlers)
    );

    expect(response).toEqual({ status: 500, body: { error: 'Action execution failed' } });
  });

  test('returns a sanitized 500 response when Gemini configuration is missing for a Gemini action', async () => {
    const response = await handleExecuteRequest(
      request({ action: 'agent-intake', input: {} }, 'Bearer valid-token'),
      { ...environment, GEMINI_API_KEY: undefined },
      createDependencies(createHandlers().handlers)
    );

    expect(response).toEqual({ status: 500, body: { error: 'Action execution failed' } });
  });

  test('sanitizes handler failures without echoing token, key, or input markers', async () => {
    const { handlers } = createHandlers();
    handlers['agent-intake'] = async () => {
      throw new Error('handler-input-marker gemini-key valid-token');
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await handleExecuteRequest(
        request({ action: 'agent-intake', input: { marker: 'handler-input-marker' } }, 'Bearer valid-token'),
        environment,
        createDependencies(handlers)
      );
      const serialized = JSON.stringify({ response, logs: errorSpy.mock.calls });

      expect(response).toEqual({ status: 500, body: { error: 'Action execution failed' } });
      expect(errorSpy).toHaveBeenCalledWith('Action execution failed', 'unclassified');
      expect(serialized).not.toContain('valid-token');
      expect(serialized).not.toContain('gemini-key');
      expect(serialized).not.toContain('handler-input-marker');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('logs only a safe diagnostic code for a Gemini HTTP failure', async () => {
    const { handlers } = createHandlers();
    handlers['agent-intake'] = async () => {
      throw new Error('Gemini request failed: 403');
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await handleExecuteRequest(
        request({ action: 'agent-intake', input: { marker: 'sensitive-input-marker' } }, 'Bearer sensitive-token-marker'),
        environment,
        createDependencies(handlers)
      );

      expect(response).toEqual({ status: 500, body: { error: 'Action execution failed' } });
      expect(errorSpy).toHaveBeenCalledWith('Action execution failed', 'gemini-http-403');
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('sensitive-input-marker');
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('sensitive-token-marker');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
