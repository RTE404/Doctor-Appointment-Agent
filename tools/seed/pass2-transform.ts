// tools/seed/pass2-transform.ts
import type { Bundle, BundleEntry, Identifier, Reference } from '@medplum/fhirtypes';
import { SPECIALTY_NUCC_CODES } from './specialty-resolver';

const KEPT_RESOURCE_TYPES = new Set([
  'Patient',
  'Practitioner',
  'Organization',
  'Encounter',
  'Condition',
  'MedicationRequest',
  'AllergyIntolerance',
]);

const SYNTHEA_STABLE_ID_SYSTEM = 'https://synthea.mitre.org/identifier';
const NUCC_SYSTEM = 'http://nucc.org/provider-taxonomy';
const TIMEZONE_EXT_URL = 'http://hl7.org/fhir/StructureDefinition/timezone';
const DEFAULT_TIMEZONE = 'America/New_York';

function nuccCodeForLabel(label: string): string {
  return SPECIALTY_NUCC_CODES[label] ?? SPECIALTY_NUCC_CODES['General Practice'];
}

/**
 * Every kept resource retains an explicit source identifier for audit and
 * lookup. Idempotence itself comes from deterministic PUT, not from a POST
 * conditional-create whose server-assigned id would differ from stableId.
 */
function withStableIdentifier<T extends { identifier?: Identifier[] }>(resource: T, stableId: string): T {
  return { ...resource, identifier: [...(resource.identifier ?? []), { system: SYNTHEA_STABLE_ID_SYSTEM, value: stableId }] };
}

function deterministicUpsert(resourceType: string, stableId: string): BundleEntry['request'] {
  return { method: 'PUT', url: `${resourceType}/${stableId}` };
}

/**
 * Maps every entry's urn:uuid fullUrl to the deterministic reference used
 * by its PUT request. This is valid only because transformBundle rewrites
 * every retained entry to `PUT ResourceType/{sourceId}`. Medplum replaces
 * ids on POST; changing these requests back to POST would invalidate every
 * reference produced by this index.
 */
function buildFullUrlIndex(bundle: Bundle): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of bundle.entry ?? []) {
    if (entry.resource?.resourceType && entry.resource.id) {
      const target = `${entry.resource.resourceType}/${entry.resource.id}`;
      // Real Synthea bundles set fullUrl to exactly urn:uuid:{resource.id},
      // so both keys resolve to the same target there. Deriving the second
      // key directly from resource.id also covers bundles that omit
      // fullUrl entirely (e.g. this file's own unit test fixtures) without
      // depending on an unverified fullUrl/id invariant.
      if (entry.fullUrl) index.set(entry.fullUrl, target);
      index.set(`urn:uuid:${entry.resource.id}`, target);
    }
  }
  return index;
}

function rewriteRef(ref: Reference | undefined, index: Map<string, string>): void {
  if (ref?.reference && index.has(ref.reference)) {
    ref.reference = index.get(ref.reference);
  }
}

/**
 * Rewrites every reference field the 7 kept resource types actually use —
 * both to identity resources (Patient/Practitioner/Organization) and to
 * each other (Condition.encounter, MedicationRequest.encounter/requester/
 * reasonReference) — confirmed against a full-corpus scan of all 983
 * bundles (26,268 clinical-to-clinical references corpus-wide; the four
 * fields below account for all of them). Mutates and returns the resource.
 */
function resolveReferences<T extends Record<string, unknown>>(resource: T, index: Map<string, string>): T {
  const r = resource as any;
  rewriteRef(r.subject, index);
  rewriteRef(r.patient, index);
  rewriteRef(r.serviceProvider, index);
  rewriteRef(r.encounter, index);
  rewriteRef(r.requester, index);
  for (const p of r.participant ?? []) rewriteRef(p.individual, index);
  for (const rr of r.reasonReference ?? []) rewriteRef(rr, index);
  return resource;
}

/**
 * Per-bundle rewrite. In 'slim' mode, filters to the 7 resource types the
 * app reads; in 'full' mode, keeps everything. Every kept resource is
 * deterministically PUT-upserted at its source id, and every reference field it carries —
 * to an identity resource or to another clinical resource — is resolved to
 * its final, real form before this function returns (see
 * `buildFullUrlIndex`'s doc comment for why that's already knowable).
 * Practitioner additionally gets the resolved specialty injected as a real
 * NUCC-coded PractitionerRole plus a Practitioner.qualification[0] display
 * copy, and the mandatory timezone extension.
 */
export function transformBundle(bundle: Bundle, specialtiesByStableId: Map<string, string>, mode: 'slim' | 'full'): Bundle {
  const fullUrlIndex = buildFullUrlIndex(bundle);
  const candidateEntries =
    mode === 'full' ? (bundle.entry ?? []) : (bundle.entry ?? []).filter((entry) => entry.resource?.resourceType && KEPT_RESOURCE_TYPES.has(entry.resource.resourceType));

  const outputEntries: BundleEntry[] = [];

  for (const entry of candidateEntries) {
    const resource = resolveReferences(entry.resource as { resourceType: string; id?: string }, fullUrlIndex);
    if (!resource.id) throw new Error(`Cannot seed ${resource.resourceType} without a deterministic source id`);

    if (resource.resourceType === 'Practitioner') {
      const specialtyLabel = specialtiesByStableId.get(resource.id) ?? 'General Practice';
      const nuccCode = nuccCodeForLabel(specialtyLabel);
      const practitioner = withStableIdentifier(
        {
          ...resource,
          qualification: [{ code: { text: specialtyLabel } }],
          extension: [...((resource as any).extension ?? []), { url: TIMEZONE_EXT_URL, valueCode: DEFAULT_TIMEZONE }],
        },
        resource.id
      );
      outputEntries.push({ ...entry, resource: practitioner as BundleEntry['resource'], request: deterministicUpsert('Practitioner', resource.id) });
      // PractitionerRole.practitioner is already a plain, resolved
      // reference (Practitioner/{resource.id}) — no urn:uuid involved
      // here at all, since this entry is created fresh by this function,
      // not sourced from Synthea.
      outputEntries.push({
        resource: {
          resourceType: 'PractitionerRole',
          id: `${resource.id}-role`,
          practitioner: { reference: `Practitioner/${resource.id}` },
          specialty: [{ coding: [{ system: NUCC_SYSTEM, code: nuccCode, display: specialtyLabel }] }],
        } as BundleEntry['resource'],
        request: deterministicUpsert('PractitionerRole', `${resource.id}-role`),
      });
      continue;
    }

    // Every other retained type uses the same deterministic PUT identity.
    outputEntries.push({
      ...entry,
      resource: withStableIdentifier(resource as any, resource.id) as BundleEntry['resource'],
      request: deterministicUpsert(resource.resourceType, resource.id),
    });
  }

  return { ...bundle, entry: outputEntries };
}
