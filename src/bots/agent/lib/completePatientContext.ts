import type { MedplumClient } from '@medplum/core';
import type { Bundle, Patient, Resource } from '@medplum/fhirtypes';

export interface CompletePatientContext {
  patient: Patient;
  resources: Resource[];
}

export interface CompletePatientContextLimits {
  maxPages?: number;
  maxResources?: number;
  maxSerializedResourceBytes?: number;
  deadlineMs?: number;
}

interface ResolvedCompletePatientContextLimits {
  maxPages: number;
  maxResources: number;
  maxSerializedResourceBytes: number;
  deadlineMs: number;
}

const DEFAULT_LIMITS: ResolvedCompletePatientContextLimits = {
  maxPages: 100,
  maxResources: 25_000,
  maxSerializedResourceBytes: 6 * 1024 * 1024,
  deadlineMs: 45_000,
};
const TEXT_ENCODER = new TextEncoder();

export async function loadCompletePatientContext(
  medplum: MedplumClient,
  patientId: string,
  limits?: CompletePatientContextLimits
): Promise<CompletePatientContext> {
  const resolvedLimits = resolveLimits(limits);
  const deadlineAt = Date.now() + resolvedLimits.deadlineMs;
  const firstPage = new URL(medplum.fhirUrl('Patient', patientId, '$everything').toString());
  if (firstPage.protocol !== 'http:' && firstPage.protocol !== 'https:') {
    throw new Error('Patient everything endpoint must use HTTP or HTTPS');
  }

  const allowedOrigin = firstPage.origin;
  const allowedPathname = firstPage.pathname;
  const seenPageUrls = new Set<string>();
  const resourcesByKey = new Map<string, Resource>();
  let retainedSerializedBytes = 0;
  let pageCount = 0;
  let pageUrl: string | undefined = firstPage.toString();

  while (pageUrl) {
    assertWithinDeadline(deadlineAt);
    if (pageCount >= resolvedLimits.maxPages) {
      throw new Error('Complete patient context exceeded the page limit');
    }
    if (seenPageUrls.has(pageUrl)) {
      throw new Error('Patient everything pagination cycle detected');
    }
    seenPageUrls.add(pageUrl);
    pageCount += 1;

    const bundle = await requestWithinDeadline(deadlineAt, (signal) =>
      medplum.get<Bundle>(pageUrl as string, { cache: 'no-cache', signal })
    );
    if (!bundle || bundle.resourceType !== 'Bundle' || !Array.isArray(bundle.entry ?? [])) {
      throw new Error('Patient everything returned an invalid Bundle');
    }

    for (const entry of bundle.entry ?? []) {
      const resource = entry.resource;
      if (!resource) continue;
      if (resource.resourceType === 'Patient' && resource.id !== patientId) continue;

      const serialized = stableStringify(resource);
      const key = resourceIdentity(resource, serialized);
      retainedSerializedBytes = retainResource(
        resourcesByKey,
        key,
        resource,
        serialized,
        retainedSerializedBytes,
        resolvedLimits
      );
      assertWithinDeadline(deadlineAt);
    }

    const nextLinks = (bundle.link ?? []).filter((link) => link.relation === 'next');
    if (nextLinks.length > 1) {
      throw new Error('Patient everything pagination returned multiple next links');
    }
    if (nextLinks.length === 0) {
      pageUrl = undefined;
      continue;
    }

    const nextUrl = nextLinks[0].url;
    if (typeof nextUrl !== 'string' || nextUrl.trim().length === 0) {
      throw new Error('Patient everything pagination next link is missing a URL');
    }
    pageUrl = canonicalizeNextPageUrl(nextUrl, pageUrl, allowedOrigin, allowedPathname);
    if (seenPageUrls.has(pageUrl)) {
      throw new Error('Patient everything pagination cycle detected');
    }
  }

  let patient = resourcesByKey.get(`Patient/${patientId}`) as Patient | undefined;
  if (!patient) {
    const fallbackPatient = await requestWithinDeadline(deadlineAt, (signal) =>
      medplum.readResource('Patient', patientId, { cache: 'no-cache', signal })
    );
    if (fallbackPatient.resourceType !== 'Patient' || fallbackPatient.id !== patientId) {
      throw new Error('Patient everything fallback returned an invalid focal Patient identity');
    }

    const serialized = stableStringify(fallbackPatient);
    retainedSerializedBytes = retainResource(
      resourcesByKey,
      `Patient/${patientId}`,
      fallbackPatient,
      serialized,
      retainedSerializedBytes,
      resolvedLimits
    );
    patient = fallbackPatient;
  }

  const resources = [...resourcesByKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, resource]) => resource);
  assertWithinDeadline(deadlineAt);

  return { patient, resources };
}

function resolveLimits(limits?: CompletePatientContextLimits): ResolvedCompletePatientContextLimits {
  return {
    maxPages: limits?.maxPages ?? DEFAULT_LIMITS.maxPages,
    maxResources: limits?.maxResources ?? DEFAULT_LIMITS.maxResources,
    maxSerializedResourceBytes:
      limits?.maxSerializedResourceBytes ?? DEFAULT_LIMITS.maxSerializedResourceBytes,
    deadlineMs: limits?.deadlineMs ?? DEFAULT_LIMITS.deadlineMs,
  };
}

function canonicalizeNextPageUrl(
  nextUrl: string,
  currentPageUrl: string,
  allowedOrigin: string,
  allowedPathname: string
): string {
  let parsedPageUrl: URL;
  try {
    parsedPageUrl = new URL(nextUrl.trim(), currentPageUrl);
  } catch {
    throw new Error('Patient everything pagination returned an invalid URL');
  }

  if (parsedPageUrl.protocol !== 'http:' && parsedPageUrl.protocol !== 'https:') {
    throw new Error('Patient everything pagination returned an unsupported protocol');
  }
  if (parsedPageUrl.href.includes('#')) {
    throw new Error('Patient everything pagination returned a fragment-bearing URL');
  }
  if (parsedPageUrl.origin !== allowedOrigin) {
    throw new Error('Patient everything pagination returned a cross-origin URL');
  }
  if (parsedPageUrl.pathname !== allowedPathname) {
    throw new Error('Patient everything pagination left the selected endpoint');
  }

  return parsedPageUrl.toString();
}

function retainResource(
  resourcesByKey: Map<string, Resource>,
  key: string,
  resource: Resource,
  serialized: string,
  retainedSerializedBytes: number,
  limits: ResolvedCompletePatientContextLimits
): number {
  if (resourcesByKey.has(key)) {
    return retainedSerializedBytes;
  }
  if (resourcesByKey.size >= limits.maxResources) {
    throw new Error('Complete patient context exceeded the resource count limit');
  }

  const resourceBytes = TEXT_ENCODER.encode(serialized).byteLength;
  if (retainedSerializedBytes + resourceBytes > limits.maxSerializedResourceBytes) {
    throw new Error('Complete patient context exceeded the serialized resource byte limit');
  }
  resourcesByKey.set(key, resource);
  return retainedSerializedBytes + resourceBytes;
}

async function requestWithinDeadline<T>(
  deadlineAt: number,
  request: (signal: AbortSignal) => PromiseLike<T>
): Promise<T> {
  assertWithinDeadline(deadlineAt);
  const remainingMs = deadlineAt - Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingMs);

  try {
    const result = await request(controller.signal);
    assertWithinDeadline(deadlineAt);
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('Complete patient context deadline exceeded');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function assertWithinDeadline(deadlineAt: number): void {
  if (Date.now() >= deadlineAt) {
    throw new Error('Complete patient context deadline exceeded');
  }
}

function resourceIdentity(resource: Resource, serialized: string): string {
  if (resource.id) return `${resource.resourceType}/${resource.id}`;
  return `json:${serialized}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
