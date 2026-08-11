import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loginClientApplication } from './server/medplumClientApplication.js';
import type { ClientApplicationEnvironment } from './server/medplumClientApplication.js';

export interface DemoSessionEnvironment extends ClientApplicationEnvironment {
  DEMO_ACCESS_CODE?: string;
}

export interface DemoSessionRequest {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface DemoSessionResponse {
  status: number;
  body: unknown;
}

export interface DemoSessionDependencies {
  login: (environment: ClientApplicationEnvironment) => Promise<{ accessToken: string }>;
}

const productionDependencies: DemoSessionDependencies = {
  login: (environment) => loginClientApplication(environment, undefined, { requireReadOnlyAccessPolicy: true }),
};

export async function handleDemoSessionRequest(
  request: DemoSessionRequest,
  environment: DemoSessionEnvironment,
  dependencies: DemoSessionDependencies = productionDependencies
): Promise<DemoSessionResponse> {
  if (request.method !== 'POST' || !isJsonContentType(headerValue(request.headers, 'content-type'))) {
    return invalidRequest();
  }

  const body = parseBody(request.body);
  if (!body) {
    return invalidRequest();
  }

  if (
    !environment.DEMO_ACCESS_CODE ||
    !environment.MEDPLUM_BASE_URL ||
    !environment.MEDPLUM_PROJECT_ID ||
    !environment.DEMO_MEDPLUM_CLIENT_ID ||
    !environment.DEMO_MEDPLUM_CLIENT_SECRET
  ) {
    return unavailable();
  }

  if (typeof body.code !== 'string' || !matchesSecret(body.code, environment.DEMO_ACCESS_CODE)) {
    return { status: 401, body: { error: 'Invalid demo code' } };
  }

  try {
    const { accessToken } = await dependencies.login(environment);
    return { status: 200, body: { accessToken } };
  } catch {
    return unavailable();
  }
}

export default async function demoSession(request: IncomingMessage & { body?: unknown }, response: ServerResponse): Promise<void> {
  const body = request.body === undefined ? await readRequestBody(request) : request.body;
  const result = await handleDemoSessionRequest(
    { method: request.method, headers: request.headers, body },
    {
      MEDPLUM_BASE_URL: process.env.MEDPLUM_BASE_URL,
      MEDPLUM_PROJECT_ID: process.env.MEDPLUM_PROJECT_ID,
      DEMO_ACCESS_CODE: process.env.DEMO_ACCESS_CODE,
      DEMO_MEDPLUM_CLIENT_ID: process.env.DEMO_MEDPLUM_CLIENT_ID,
      DEMO_MEDPLUM_CLIENT_SECRET: process.env.DEMO_MEDPLUM_CLIENT_SECRET,
    }
  );

  response.statusCode = result.status;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(result.body));
}

function matchesSecret(candidate: string, expected: string): boolean {
  const candidateHash = createHash('sha256').update(candidate, 'utf8').digest();
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

function parseBody(body: unknown): Record<string, unknown> | undefined {
  let value = body;
  if (typeof body === 'string') {
    try {
      value = JSON.parse(body);
    } catch {
      return undefined;
    }
  }

  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function headerValue(headers: DemoSessionRequest['headers'], name: string): string | undefined {
  const value = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function isJsonContentType(contentType: string | undefined): boolean {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

function invalidRequest(): DemoSessionResponse {
  return { status: 400, body: { error: 'Invalid request' } };
}

function unavailable(): DemoSessionResponse {
  return { status: 503, body: { error: 'Demo access unavailable' } };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  }
  return body;
}
