import { OperationOutcomeError } from '@medplum/core';
import type { MedplumClient } from '@medplum/core';
import type { Appointment, Communication, Encounter } from '@medplum/fhirtypes';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEMO_GENERATED_TAG_SEARCH } from '../src/demo/demoTag.js';
import { loginClientApplication } from './server/medplumClientApplication.js';

export interface ResetDemoEnvironment {
  MEDPLUM_BASE_URL?: string;
  MEDPLUM_PROJECT_ID?: string;
  DEMO_WORKER_CLIENT_ID?: string;
  DEMO_WORKER_CLIENT_SECRET?: string;
  CRON_SECRET?: string;
}

export interface ResetDemoRequest {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
}

export interface ResetDemoResponse {
  status: number;
  body: unknown;
}

type DemoActivityResourceType = 'Appointment' | 'Communication' | 'Encounter';
type TaggedActivity = (Appointment | Communication | Encounter) & { id: string };

export interface DemoResetClient {
  searchResources(
    resourceType: DemoActivityResourceType,
    query: Record<string, string>
  ): Promise<TaggedActivity[]>;
  fhirUrl(resourceType: string, id: string, operation: string): URL;
  post(url: URL, body: unknown): Promise<unknown>;
  deleteResource(resourceType: DemoActivityResourceType, id: string): Promise<unknown>;
}

export interface ResetDemoDependencies {
  login: (environment: ResetDemoEnvironment) => Promise<{ client: DemoResetClient }>;
}

const productionDependencies: ResetDemoDependencies = {
  login: async (environment) => {
    const session = await loginClientApplication({
      MEDPLUM_BASE_URL: environment.MEDPLUM_BASE_URL,
      MEDPLUM_PROJECT_ID: environment.MEDPLUM_PROJECT_ID,
      DEMO_MEDPLUM_CLIENT_ID: environment.DEMO_WORKER_CLIENT_ID,
      DEMO_MEDPLUM_CLIENT_SECRET: environment.DEMO_WORKER_CLIENT_SECRET,
    });
    return { client: session.client as MedplumClient as DemoResetClient };
  },
};

const CANCELLABLE_APPOINTMENT_STATUSES = new Set(['pending', 'booked']);

export async function resetDemoResources(client: DemoResetClient): Promise<{
  appointmentsCancelled: number;
  appointmentsDeleted: number;
  communicationsDeleted: number;
  encountersDeleted: number;
}> {
  const search = { _tag: DEMO_GENERATED_TAG_SEARCH, _count: '100' };
  let appointmentsCancelled = 0;
  let appointmentsDeleted = 0;
  let communicationsDeleted = 0;
  let encountersDeleted = 0;

  for (;;) {
    const appointments = (await client.searchResources('Appointment', search)) as (Appointment & { id: string })[];
    if (appointments.length === 0) {
      break;
    }
    await mapWithConcurrency(appointments, 10, async (appointment) => {
      if (CANCELLABLE_APPOINTMENT_STATUSES.has(appointment.status)) {
        const cancelled = await ignoreNotFound(() =>
          client.post(client.fhirUrl('Appointment', appointment.id, '$cancel'), {})
        );
        if (cancelled) {
          appointmentsCancelled += 1;
        }
      }

      const deleted = await ignoreNotFound(() => client.deleteResource('Appointment', appointment.id));
      if (deleted) {
        appointmentsDeleted += 1;
      }
    });
  }

  for (;;) {
    const communications = (await client.searchResources('Communication', search)) as (Communication & { id: string })[];
    if (communications.length === 0) {
      break;
    }
    await mapWithConcurrency(communications, 10, async (communication) => {
      const deleted = await ignoreNotFound(() => client.deleteResource('Communication', communication.id));
      if (deleted) {
        communicationsDeleted += 1;
      }
    });
  }

  for (;;) {
    const encounters = (await client.searchResources('Encounter', search)) as (Encounter & { id: string })[];
    if (encounters.length === 0) {
      break;
    }
    await mapWithConcurrency(encounters, 10, async (encounter) => {
      const deleted = await ignoreNotFound(() => client.deleteResource('Encounter', encounter.id));
      if (deleted) {
        encountersDeleted += 1;
      }
    });
  }

  return { appointmentsCancelled, appointmentsDeleted, communicationsDeleted, encountersDeleted };
}

export async function handleResetDemoRequest(
  request: ResetDemoRequest,
  environment: ResetDemoEnvironment,
  dependencies: ResetDemoDependencies = productionDependencies
): Promise<ResetDemoResponse> {
  if (request.method !== 'GET') {
    return { status: 405, body: { error: 'Method not allowed' } };
  }

  if (!hasCompleteConfiguration(environment)) {
    return { status: 503, body: { error: 'Demo reset unavailable' } };
  }

  const token = bearerToken(headerValue(request.headers, 'authorization'));
  if (!token || !matchesSecret(token, environment.CRON_SECRET)) {
    return { status: 401, body: { error: 'Unauthorized' } };
  }

  try {
    const { client } = await dependencies.login(environment);
    const counts = await resetDemoResources(client);
    return { status: 200, body: { ok: true, ...counts } };
  } catch {
    return { status: 500, body: { error: 'Demo reset failed' } };
  }
}

export default async function resetDemo(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const result = await handleResetDemoRequest(
    { method: request.method, headers: request.headers },
    {
      MEDPLUM_BASE_URL: process.env.MEDPLUM_BASE_URL,
      MEDPLUM_PROJECT_ID: process.env.MEDPLUM_PROJECT_ID,
      DEMO_WORKER_CLIENT_ID: process.env.DEMO_WORKER_CLIENT_ID,
      DEMO_WORKER_CLIENT_SECRET: process.env.DEMO_WORKER_CLIENT_SECRET,
      CRON_SECRET: process.env.CRON_SECRET,
    }
  );

  response.statusCode = result.status;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(result.body));
}

function hasCompleteConfiguration(environment: ResetDemoEnvironment): environment is Required<ResetDemoEnvironment> {
  return Boolean(
    environment.MEDPLUM_BASE_URL &&
      environment.MEDPLUM_PROJECT_ID &&
      environment.DEMO_WORKER_CLIENT_ID &&
      environment.DEMO_WORKER_CLIENT_SECRET &&
      environment.CRON_SECRET &&
      environment.CRON_SECRET.length >= 16
  );
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, operation: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += concurrency) {
    await Promise.all(items.slice(index, index + concurrency).map(operation));
  }
}

async function ignoreNotFound(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch (error) {
    if (error instanceof OperationOutcomeError && error.outcome.issue?.some((issue) => issue.code === 'not-found')) {
      return false;
    }
    throw error;
  }
}

function matchesSecret(candidate: string, expected: string): boolean {
  const candidateHash = createHash('sha256').update(candidate, 'utf8').digest();
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(candidateHash, expectedHash);
}

function bearerToken(authorization: string | undefined): string | undefined {
  return /^Bearer\s+(.+)$/.exec(authorization ?? '')?.[1];
}

function headerValue(headers: ResetDemoRequest['headers'], name: string): string | undefined {
  const value = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? value[0] : value;
}
