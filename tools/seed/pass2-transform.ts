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
 * Every kept resource retains an explicit source identifier for audit,
 * lookup, and idempotence: only a super-admin account can choose a
 * resource's id (Medplum's `canSetId()`), so a normal client-credentials
 * login can't rely on deterministic PUT. Idempotence instead comes from
 * POST conditional-create against this identifier (see conditionalCreate).
 */
function withStableIdentifier<T extends { identifier?: Identifier[] }>(resource: T, stableId: string): T {
  return { ...resource, identifier: [...(resource.identifier ?? []), { system: SYNTHEA_STABLE_ID_SYSTEM, value: stableId }] };
}

function conditionalCreate(resourceType: string, stableId: string): BundleEntry['request'] {
  return { method: 'POST', url: resourceType, ifNoneExist: `identifier=${SYNTHEA_STABLE_ID_SYSTEM}|${stableId}` };
}

/**
 * Maps every entry's urn:uuid fullUrl to the conditional reference
 * (`ResourceType?identifier=...`) that resolves to it once uploaded. The
 * target's real id is server-assigned on conditional-create and unknown at
 * transform time, so a plain `ResourceType/{id}` reference isn't available
 * here — Medplum resolves the conditional form by search when the
 * referencing resource is written, which requires the target to already
 * exist (see chunk-bundle.ts's identity-before-clinical upload order).
 */
function buildFullUrlIndex(bundle: Bundle): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of bundle.entry ?? []) {
    if (entry.resource?.resourceType && entry.resource.id) {
      const target = `${entry.resource.resourceType}?identifier=${SYNTHEA_STABLE_ID_SYSTEM}|${entry.resource.id}`;
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
 * conditionally-created (POST + ifNoneExist against its source identifier —
 * see conditionalCreate), and every reference field it carries — to an
 * identity resource or to another clinical resource — is rewritten to the
 * corresponding conditional reference (see `buildFullUrlIndex`'s doc
 * comment). Practitioner additionally gets the resolved specialty injected
 * as a real NUCC-coded PractitionerRole plus a Practitioner.qualification[0] display
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

    const stableId = resource.id;

    if (resource.resourceType === 'Practitioner') {
      const specialtyLabel = specialtiesByStableId.get(stableId) ?? 'General Practice';
      const nuccCode = nuccCodeForLabel(specialtyLabel);
      const { id: _discardedId, ...resourceWithoutId } = resource as any;
      const practitionerWithQualification = {
        ...resourceWithoutId,
        qualification: [{ code: { text: specialtyLabel } }],
        extension: [...(resourceWithoutId.extension ?? []), { url: TIMEZONE_EXT_URL, valueCode: DEFAULT_TIMEZONE }],
      };
      const practitioner = withStableIdentifier(practitionerWithQualification, stableId);
      outputEntries.push({ ...entry, resource: practitioner as BundleEntry['resource'], request: conditionalCreate('Practitioner', stableId) });
      // PractitionerRole.practitioner is a conditional reference, not a
      // plain one — this entry is created fresh by this function (never
      // sourced from Synthea), but the Practitioner it points to is
      // conditionally-created too, so its real id isn't known here either.
      outputEntries.push({
        resource: {
          resourceType: 'PractitionerRole',
          identifier: [{ system: SYNTHEA_STABLE_ID_SYSTEM, value: `${stableId}-role` }],
          practitioner: { reference: `Practitioner?identifier=${SYNTHEA_STABLE_ID_SYSTEM}|${stableId}` },
          specialty: [{ coding: [{ system: NUCC_SYSTEM, code: nuccCode, display: specialtyLabel }] }],
        } as BundleEntry['resource'],
        request: conditionalCreate('PractitionerRole', `${stableId}-role`),
      });
      continue;
    }

    // Every other retained type uses the same conditional-create identity.
    const { id: _discardedId, ...resourceWithoutId } = resource as any;
    outputEntries.push({
      ...entry,
      resource: withStableIdentifier(resourceWithoutId, stableId) as BundleEntry['resource'],
      request: conditionalCreate(resource.resourceType, stableId),
    });
  }

  return { ...bundle, entry: outputEntries };
}
