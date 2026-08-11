import type { BotEvent, MedplumClient } from '@medplum/core';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
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
  DEMO_MEDPLUM_CLIENT_ID: 'browser-client',
  DEMO_WORKER_CLIENT_ID: 'worker-client',
  DEMO_WORKER_CLIENT_SECRET: 'worker-secret',
  GEMINI_API_KEY: 'gemini-key',
};

const profile = { resourceType: 'ClientApplication' as const, id: 'browser-client' };
const medplum = { getProfileAsync: async () => profile } as unknown as MedplumClient;
const workerMedplum = { getProfileAsync: async () => ({ resourceType: 'ClientApplication' as const, id: 'worker-client' }) } as unknown as MedplumClient;

test('allows the patient concierge discovery action', () => {
  expect(ALLOWED_ACTIONS).toContain('agent-find-bookable-options');
});

test('compiles the serverless runtime graph with Node ESM import semantics', () => {
  const entrypoint = fileURLToPath(new URL('./execute.ts', import.meta.url));
  const program = ts.createProgram([entrypoint], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (!diagnostic.file || diagnostic.start === undefined) {
      return message;
    }
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} ${message}`;
  });

  expect(diagnostics).toEqual([]);
}, 60_000);

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
    loginWorker: async () => ({ medplum: workerMedplum }),
  };
}

describe('dispatchAction', () => {
  test.each(ALLOWED_ACTIONS)('dispatches the allowlisted %s action', async (action) => {
    const { handlers, seen } = createHandlers();
    const result = await dispatchAction(medplum, action, { marker: action }, 'gemini-key', handlers);

    expect(result).toEqual({ action });
    expect(seen[action]?.input).toEqual({ marker: action });
  });

  test.each(['agent-intake', 'agent-find-bookable-options', 'agent-patient-chat'] as const)('passes GEMINI_API_KEY only to %s', async (action) => {
    const { handlers, seen } = createHandlers();

    await dispatchAction(medplum, action, {}, 'gemini-key', handlers);

    expect(seen[action]?.secrets).toEqual({
      GEMINI_API_KEY: { name: 'GEMINI_API_KEY', valueString: 'gemini-key' },
    });
  });

  test.each([
    'cancel-appointment',
    'complete-appointment',
    'reschedule-appointment',
    'agent-find-doctors',
    'agent-ensure-doctor',
    'agent-book-appointment',
  ] as const)(
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

  test('returns 403 when the token is not the configured read-only browser client', async () => {
    const dependencies = createDependencies(createHandlers().handlers);
    dependencies.authenticate = async () => ({
      medplum,
      profile: { resourceType: 'Practitioner', id: 'personal-user' },
      projectId: 'target-project',
    });

    const response = await handleExecuteRequest(request({ action: 'agent-intake', input: {} }, 'Bearer personal-token'), environment, dependencies);

    expect(response).toEqual({ status: 403, body: { error: 'Project access denied' } });
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

  test('executes allowlisted actions with the server-only worker client', async () => {
    const handlers = createHandlers();
    const workerLogin = vi.fn(async () => ({ medplum: workerMedplum }));
    const dependencies = { ...createDependencies(handlers.handlers), loginWorker: workerLogin };
    let receivedClient: MedplumClient | undefined;
    handlers.handlers['agent-find-doctors'] = async (client) => {
      receivedClient = client;
      return { ok: true };
    };

    const response = await handleExecuteRequest(
      request({ action: 'agent-find-doctors', input: {} }, 'Bearer browser-token'),
      environment,
      dependencies
    );

    expect(response.status).toBe(200);
    expect(workerLogin).toHaveBeenCalledWith(environment);
    expect(receivedClient).toBe(workerMedplum);
  });

  test('accepts application/json with a charset parameter', async () => {
    const response = await handleExecuteRequest(
      request({ action: 'cancel-appointment', input: {} }, 'Bearer valid-token', 'application/json; charset=utf-8'),
      environment,
      createDependencies(createHandlers().handlers)
    );

    expect(response).toEqual({ status: 200, body: { action: 'cancel-appointment' } });
  });

  test.each([
    ['missing content type', request({ action: 'agent-intake', input: {} }, 'Bearer valid-token', '')],
    ['wrong content type', request({ action: 'agent-intake', input: {} }, 'Bearer valid-token', 'text/plain')],
    ['JSONP content type', request({ action: 'agent-intake', input: {} }, 'Bearer valid-token', 'application/jsonp')],
    ['malformed JSON', request('{', 'Bearer valid-token')],
    ['non-object body', request(['not', 'an', 'object'], 'Bearer valid-token')],
    ['non-object input', request({ action: 'agent-intake', input: [] }, 'Bearer valid-token')],
    ['removed schedule mutation action', request({ action: 'block-availability', input: {} }, 'Bearer valid-token')],
  ])('returns 400 for %s', async (_name, invalidRequest) => {
    const response = await handleExecuteRequest(invalidRequest, environment, createDependencies(createHandlers().handlers));

    expect(response).toEqual({ status: 400, body: { error: 'Invalid request' } });
  });

  test('returns a sanitized 500 response when server configuration is missing', async () => {
    const response = await handleExecuteRequest(
      request({ action: 'cancel-appointment', input: {} }, 'Bearer valid-token'),
      { ...environment, MEDPLUM_BASE_URL: undefined },
      createDependencies(createHandlers().handlers)
    );

    expect(response).toEqual({ status: 500, body: { error: 'Action execution failed' } });
  });

  test('returns a sanitized 500 response when worker configuration is missing', async () => {
    const response = await handleExecuteRequest(
      request({ action: 'agent-find-doctors', input: {} }, 'Bearer valid-token'),
      { ...environment, DEMO_WORKER_CLIENT_SECRET: undefined },
      createDependencies(createHandlers().handlers)
    );

    expect(response).toEqual({ status: 500, body: { error: 'Action execution failed' } });
  });

  test.each(['agent-intake', 'agent-find-bookable-options'] as const)(
    'returns a sanitized 500 response when Gemini configuration is missing for %s',
    async (action) => {
      const response = await handleExecuteRequest(
        request({ action, input: {} }, 'Bearer valid-token'),
        { ...environment, GEMINI_API_KEY: undefined },
        createDependencies(createHandlers().handlers)
      );

      expect(response).toEqual({ status: 500, body: { error: 'Action execution failed' } });
    }
  );

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
