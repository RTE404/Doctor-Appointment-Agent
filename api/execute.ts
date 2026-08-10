import { createReference, MedplumClient } from '@medplum/core';
import type { BotEvent, ProfileResource } from '@medplum/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handler as blockAvailabilityHandler } from '../src/bots/core/block-availability.js';
import type { BlockAvailabilityEvent } from '../src/bots/core/block-availability.js';
import { handler as rescheduleAppointmentHandler } from '../src/bots/core/reschedule-appointment.js';
import type { RescheduleInput } from '../src/bots/core/reschedule-appointment.js';
import { handler as agentBookAppointmentHandler } from '../src/bots/agent/agent-book-appointment.js';
import type { BookInput } from '../src/bots/agent/agent-book-appointment.js';
import { handler as agentEnsureDoctorHandler } from '../src/bots/agent/agent-ensure-doctor.js';
import type { EnsureDoctorInput } from '../src/bots/agent/agent-ensure-doctor.js';
import { handler as agentFindDoctorsHandler } from '../src/bots/agent/agent-find-doctors.js';
import type { FindDoctorsInput } from '../src/bots/agent/agent-find-doctors.js';
import { handler as agentIntakeHandler } from '../src/bots/agent/agent-intake.js';
import type { IntakeInput } from '../src/bots/agent/agent-intake.js';
import { handler as agentPatientChatHandler } from '../src/bots/agent/agent-patient-chat.js';
import type { ChatInput } from '../src/bots/agent/agent-patient-chat.js';

export const ALLOWED_ACTIONS = [
  'block-availability',
  'reschedule-appointment',
  'agent-intake',
  'agent-find-doctors',
  'agent-ensure-doctor',
  'agent-book-appointment',
  'agent-patient-chat',
] as const;

export type ActionName = (typeof ALLOWED_ACTIONS)[number];

export interface ExecuteEnvelope {
  action: ActionName;
  input: Record<string, unknown>;
}

export interface ExecuteResponse {
  status: number;
  body: unknown;
}

export interface ExecuteEnvironment {
  MEDPLUM_BASE_URL?: string;
  MEDPLUM_PROJECT_ID?: string;
  GEMINI_API_KEY?: string;
}

export interface ExecuteRequest {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export type RuntimeActionHandler = (medplum: MedplumClient, event: BotEvent<Record<string, unknown>>) => Promise<unknown>;

interface AuthenticatedSession {
  medplum: MedplumClient;
  profile: AuthenticatedProfile;
  projectId?: string;
}

type AuthenticatedProfile = ProfileResource & { id: string };

export interface ExecuteDependencies {
  authenticate: (accessToken: string, environment: ExecuteEnvironment) => Promise<AuthenticatedSession>;
  handlers?: Record<ActionName, RuntimeActionHandler>;
}

const GEMINI_ACTIONS = new Set<ActionName>(['agent-intake', 'agent-patient-chat']);

const HANDLERS: Record<ActionName, RuntimeActionHandler> = {
  'block-availability': (medplum, event) => blockAvailabilityHandler(medplum, event as unknown as BotEvent<BlockAvailabilityEvent>),
  'reschedule-appointment': (medplum, event) => rescheduleAppointmentHandler(medplum, event as BotEvent<RescheduleInput>),
  'agent-intake': (medplum, event) => agentIntakeHandler(medplum, event as BotEvent<IntakeInput>),
  'agent-find-doctors': (medplum, event) => agentFindDoctorsHandler(medplum, event as BotEvent<FindDoctorsInput>),
  'agent-ensure-doctor': (medplum, event) => agentEnsureDoctorHandler(medplum, event as BotEvent<EnsureDoctorInput>),
  'agent-book-appointment': (medplum, event) => agentBookAppointmentHandler(medplum, event as BotEvent<BookInput>),
  'agent-patient-chat': (medplum, event) => agentPatientChatHandler(medplum, event as BotEvent<ChatInput>),
};

async function authenticate(accessToken: string, environment: ExecuteEnvironment): Promise<AuthenticatedSession> {
  const medplum = new MedplumClient({ baseUrl: environment.MEDPLUM_BASE_URL, accessToken });
  const profile = await medplum.getProfileAsync();
  if (!profile) {
    throw new Error('Missing authenticated profile');
  }

  return { medplum, profile, projectId: medplum.getProject()?.id };
}

const productionDependencies: ExecuteDependencies = { authenticate, handlers: HANDLERS };

export async function dispatchAction(
  medplum: MedplumClient,
  action: ActionName,
  input: Record<string, unknown>,
  geminiApiKey: string,
  handlers: Record<ActionName, RuntimeActionHandler> = HANDLERS,
  profile?: AuthenticatedProfile
): Promise<unknown> {
  const requester = profile ?? (await medplum.getProfileAsync());
  if (!requester) {
    throw new Error('Missing authenticated profile');
  }

  const event: BotEvent<Record<string, unknown>> = {
    bot: { identifier: { system: 'http://example.com', value: action } },
    contentType: 'application/json',
    input,
    requester: createReference(requester),
    secrets: GEMINI_ACTIONS.has(action)
      ? { GEMINI_API_KEY: { name: 'GEMINI_API_KEY', valueString: geminiApiKey } }
      : {},
  };

  return handlers[action](medplum, event);
}

export async function handleExecuteRequest(
  request: ExecuteRequest,
  environment: ExecuteEnvironment,
  dependencies: ExecuteDependencies = productionDependencies
): Promise<ExecuteResponse> {
  if (request.method === 'GET') {
    return { status: 200, body: { ok: true, service: 'doctor-appointment-agent' } };
  }

  if (request.method !== 'POST') {
    return invalidRequest();
  }

  if (!isJsonContentType(headerValue(request.headers, 'content-type'))) {
    return invalidRequest();
  }

  const envelope = parseEnvelope(request.body);
  if (!envelope) {
    return invalidRequest();
  }

  const accessToken = bearerToken(headerValue(request.headers, 'authorization'));
  if (!accessToken) {
    return { status: 401, body: { error: 'Authentication required' } };
  }

  if (!environment.MEDPLUM_BASE_URL || !environment.MEDPLUM_PROJECT_ID) {
    return executionFailed();
  }

  let session: AuthenticatedSession;
  try {
    session = await dependencies.authenticate(accessToken, environment);
  } catch {
    return { status: 401, body: { error: 'Authentication required' } };
  }

  if (session.projectId !== environment.MEDPLUM_PROJECT_ID) {
    return { status: 403, body: { error: 'Project access denied' } };
  }

  if (GEMINI_ACTIONS.has(envelope.action) && !environment.GEMINI_API_KEY) {
    return executionFailed();
  }

  try {
    const body = await dispatchAction(
      session.medplum,
      envelope.action,
      envelope.input,
      environment.GEMINI_API_KEY ?? '',
      dependencies.handlers ?? HANDLERS,
      session.profile
    );
    return { status: 200, body };
  } catch (error) {
    console.error('Action execution failed', executionFailureCode(error));
    return executionFailed();
  }
}

export default async function execute(request: IncomingMessage & { body?: unknown }, response: ServerResponse): Promise<void> {
  const body = request.body === undefined ? await readRequestBody(request) : request.body;
  const result = await handleExecuteRequest(
    { method: request.method, headers: request.headers, body },
    {
      MEDPLUM_BASE_URL: process.env.MEDPLUM_BASE_URL,
      MEDPLUM_PROJECT_ID: process.env.MEDPLUM_PROJECT_ID,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    },
    productionDependencies
  );

  response.statusCode = result.status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(result.body));
}

function invalidRequest(): ExecuteResponse {
  return { status: 400, body: { error: 'Invalid request' } };
}

function executionFailed(): ExecuteResponse {
  return { status: 500, body: { error: 'Action execution failed' } };
}

function executionFailureCode(error: unknown): string {
  if (error instanceof Error) {
    const geminiStatus = /^Gemini request failed: ([1-5]\d{2})$/.exec(error.message);
    if (geminiStatus) {
      return `gemini-http-${geminiStatus[1]}`;
    }
  }
  return 'unclassified';
}

function headerValue(headers: ExecuteRequest['headers'], name: string): string | undefined {
  if (!headers) {
    return undefined;
  }

  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function isJsonContentType(contentType: string | undefined): boolean {
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}

function bearerToken(authorization: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/.exec(authorization ?? '');
  return match?.[1];
}

function parseEnvelope(body: unknown): ExecuteEnvelope | undefined {
  let value = body;
  if (typeof body === 'string') {
    try {
      value = JSON.parse(body);
    } catch {
      return undefined;
    }
  }

  if (!isRecord(value) || !isActionName(value.action) || !isRecord(value.input)) {
    return undefined;
  }

  return { action: value.action, input: value.input };
}

function isActionName(value: unknown): value is ActionName {
  return typeof value === 'string' && ALLOWED_ACTIONS.includes(value as ActionName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  }
  return body;
}
