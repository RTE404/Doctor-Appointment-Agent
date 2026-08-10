import type { MedplumClient } from '@medplum/core';
import type { Bundle, BundleEntry, Patient, Resource } from '@medplum/fhirtypes';

export interface CompletePatientContext {
  patient: Patient;
  resources: Resource[];
}

export async function loadCompletePatientContext(
  medplum: MedplumClient,
  patientId: string
): Promise<CompletePatientContext> {
  const firstPageUrl = medplum.fhirUrl('Patient', patientId, '$everything').toString();
  const allowedOrigin = new URL(firstPageUrl).origin;
  const seenPageUrls = new Set<string>();
  const resourcesByKey = new Map<string, Resource>();
  let pageUrl: string | undefined = firstPageUrl;

  while (pageUrl) {
    const parsedPageUrl = new URL(pageUrl);
    if (parsedPageUrl.origin !== allowedOrigin) {
      throw new Error('Patient everything pagination returned a cross-origin URL');
    }
    if (seenPageUrls.has(pageUrl)) {
      throw new Error('Patient everything pagination cycle detected');
    }
    seenPageUrls.add(pageUrl);

    const bundle: Bundle = await medplum.get<Bundle>(pageUrl, { cache: 'no-cache' });
    if (!bundle || bundle.resourceType !== 'Bundle' || !Array.isArray(bundle.entry ?? [])) {
      throw new Error('Patient everything returned an invalid Bundle');
    }

    for (const entry of bundle.entry ?? []) {
      const resource = entry.resource;
      if (!resource) continue;
      if (resource.resourceType === 'Patient' && resource.id !== patientId) continue;
      const key = resourceIdentity(entry);
      if (!resourcesByKey.has(key)) resourcesByKey.set(key, resource);
    }

    const nextUrl: string | undefined = bundle.link?.find((link) => link.relation === 'next')?.url;
    pageUrl = nextUrl ? new URL(nextUrl, pageUrl).toString() : undefined;
  }

  let patient = resourcesByKey.get(`Patient/${patientId}`) as Patient | undefined;
  if (!patient) {
    patient = await medplum.readResource('Patient', patientId, { cache: 'no-cache' });
    resourcesByKey.set(`Patient/${patientId}`, patient);
  }

  const resources = [...resourcesByKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, resource]) => resource);

  return { patient, resources };
}

function resourceIdentity(entry: BundleEntry): string {
  const resource = entry.resource as Resource;
  if (resource.id) return `${resource.resourceType}/${resource.id}`;
  if (entry.fullUrl) return `fullUrl:${entry.fullUrl}`;
  return `json:${stableStringify(resource)}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
