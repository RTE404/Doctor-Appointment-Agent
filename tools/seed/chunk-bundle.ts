// tools/seed/chunk-bundle.ts
import type { MedplumClient } from '@medplum/core';
import type { Bundle } from '@medplum/fhirtypes';
import { uploadBundle } from './upload';

// PractitionerRole belongs here — Task 6 creates it fresh, referencing a
// Practitioner in this same wave, and it's always small in count. An
// earlier version of this split checked only Patient/Practitioner/
// Organization and silently dropped every generated PractitionerRole.
const IDENTITY_TYPES = new Set(['Patient', 'Practitioner', 'Organization', 'PractitionerRole']);
const CLINICAL_TYPES = new Set(['Encounter', 'Condition', 'MedicationRequest', 'AllergyIntolerance']);
const MAX_CHUNK_ENTRIES = 300;

export interface SplitBundles {
  identityBundle: Bundle;
  clinicalChunks: Bundle[];
  /** Any resource type outside both allowlists — only ever populated in 'full' mode. */
  otherChunks: Bundle[];
}

/**
 * Splits one patient's transformed bundle into an identity wave (small,
 * uploaded as a single transaction), clinical chunks (Encounter/Condition/
 * MedicationRequest/AllergyIntolerance), and — in 'full' mode only — an
 * "other" bucket for every resource type outside both allowlists (e.g.
 * Observation, Claim), so 'full' mode actually keeps everything Task 6
 * decided to keep, instead of silently re-dropping it here. No reference
 * rewriting happens in this function — Task 6's transformBundle already
 * resolved every reference to its final, real form before this function
 * ever sees the bundle. The referenced ids are guaranteed because every
 * entry is an unconditional deterministic PUT, not a POST create whose id
 * Medplum would replace. Chunking exists purely because a single patient's full
 * transaction can exceed Medplum's default 1MB JSON body limit (largest
 * observed slim bundle: 2.42MB, measured directly against the real
 * corpus) — this avoids depending on a non-default server config that
 * isn't available on every hosting option.
 */
export function splitForUpload(bundle: Bundle): SplitBundles {
  const identityEntries = (bundle.entry ?? []).filter((e) => e.resource?.resourceType && IDENTITY_TYPES.has(e.resource.resourceType));
  const clinicalEntries = (bundle.entry ?? []).filter((e) => e.resource?.resourceType && CLINICAL_TYPES.has(e.resource.resourceType));
  const otherEntries = (bundle.entry ?? []).filter(
    (e) => e.resource?.resourceType && !IDENTITY_TYPES.has(e.resource.resourceType) && !CLINICAL_TYPES.has(e.resource.resourceType)
  );

  const identityBundle: Bundle = { resourceType: 'Bundle', type: 'transaction', entry: identityEntries };

  function chunk(entries: typeof clinicalEntries): Bundle[] {
    const chunks: Bundle[] = [];
    for (let i = 0; i < entries.length; i += MAX_CHUNK_ENTRIES) {
      chunks.push({ resourceType: 'Bundle', type: 'batch', entry: entries.slice(i, i + MAX_CHUNK_ENTRIES) });
    }
    return chunks;
  }

  return { identityBundle, clinicalChunks: chunk(clinicalEntries), otherChunks: chunk(otherEntries) };
}

/**
 * Full per-patient upload orchestration: identity transaction first, then
 * each clinical chunk, then each "other" chunk (empty in 'slim' mode).
 * This is what Task 9's CLI calls per bundle file — callers never call
 * uploadBundle directly for a whole transformed patient bundle.
 */
export async function uploadPatientBundle(medplum: MedplumClient, transformedBundle: Bundle): Promise<void> {
  const { identityBundle, clinicalChunks, otherChunks } = splitForUpload(transformedBundle);
  await uploadBundle(medplum, identityBundle);
  for (const chunk of [...clinicalChunks, ...otherChunks]) {
    if (chunk.entry?.length) {
      await uploadBundle(medplum, chunk);
    }
  }
}
