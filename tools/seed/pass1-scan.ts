import { readFileSync } from 'fs';
import { resolveSpecialty } from './specialty-resolver';

interface EncounterLike {
  resourceType: 'Encounter';
  participant?: { individual?: { reference?: string } }[];
  reasonCode?: { coding?: { display?: string }[] }[];
  type?: { text?: string }[];
}

interface PractitionerLike {
  resourceType: 'Practitioner';
  id?: string;
  identifier?: { system?: string; value?: string }[];
}

const NPI_SYSTEM = 'http://hl7.org/fhir/sid/us-npi';

function stableIdFromReference(reference: string | undefined): string | undefined {
  // Synthea references practitioners either by urn:uuid or by a stable-id
  // conditional-reference (identifier=...). Extract whichever form is present.
  if (!reference) return undefined;
  const identifierMatch = reference.match(/identifier=(?:[^|]*\|)?(.+)$/);
  if (identifierMatch) return identifierMatch[1];
  const uuidMatch = reference.match(/urn:uuid:(.+)$/);
  if (uuidMatch) return uuidMatch[1];
  return reference;
}

/**
 * Streams every bundle file, collects each practitioner's encounter reason/type
 * texts keyed by Synthea's stable id (not the fake NPI — see the
 * duplicate-Practitioner fix in Task 6), resolves a specialty per encounter via
 * resolveSpecialty, and majority-votes per practitioner. Asserts NPI uniqueness
 * across the corpus while iterating; throws naming the colliding NPI(s) if
 * violated rather than silently continuing.
 */
export function scanPractitionerSpecialties(filePaths: string[]): Map<string, string> {
  const votesByPractitioner = new Map<string, Map<string, number>>();
  const stableIdByNpi = new Map<string, string>();

  for (const filePath of filePaths) {
    const bundle = JSON.parse(readFileSync(filePath, 'utf-8')) as { entry?: { resource?: unknown }[] };
    const encounters: EncounterLike[] = [];
    const practitioners: PractitionerLike[] = [];

    for (const entry of bundle.entry ?? []) {
      const resource = entry.resource as { resourceType?: string } | undefined;
      if (resource?.resourceType === 'Encounter') {
        encounters.push(resource as EncounterLike);
      } else if (resource?.resourceType === 'Practitioner') {
        practitioners.push(resource as PractitionerLike);
      }
    }

    for (const practitioner of practitioners) {
      const npi = practitioner.identifier?.find((i) => i.system === NPI_SYSTEM)?.value;
      const stableId = practitioner.id;
      if (!npi || !stableId) continue;
      const existing = stableIdByNpi.get(npi);
      if (existing && existing !== stableId) {
        throw new Error(
          `NPI collision detected: NPI ${npi} is used by both Practitioner ${existing} and ${stableId}. ` +
            'NPI must be unique per practitioner — see Design doc §9 duplicate-Practitioner fix.'
        );
      }
      stableIdByNpi.set(npi, stableId);
    }

    for (const encounter of encounters) {
      const stableId = stableIdFromReference(encounter.participant?.[0]?.individual?.reference);
      if (!stableId) continue;

      const reasonTexts = (encounter.reasonCode ?? []).flatMap((rc) =>
        (rc.coding ?? []).map((c) => c.display).filter((d): d is string => !!d)
      );
      const typeTexts = (encounter.type ?? []).map((t) => t.text).filter((t): t is string => !!t);
      const specialty = resolveSpecialty(reasonTexts, typeTexts);

      const votes = votesByPractitioner.get(stableId) ?? new Map<string, number>();
      votes.set(specialty, (votes.get(specialty) ?? 0) + 1);
      votesByPractitioner.set(stableId, votes);
    }
  }

  const result = new Map<string, string>();
  for (const [stableId, votes] of votesByPractitioner) {
    let winner = 'General Practice';
    let winnerCount = -1;
    for (const [specialty, count] of votes) {
      if (count > winnerCount) {
        winner = specialty;
        winnerCount = count;
      }
    }
    result.set(stableId, winner);
  }
  return result;
}
