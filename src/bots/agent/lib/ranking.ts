// src/bots/agent/lib/ranking.ts
import { haversineMiles, zip3Centroid } from './geo.js';

export interface DoctorCandidate {
  npi: string;
  firstName: string;
  lastName: string;
  nuccCode: string;
  nuccDisplay: string;
  address: { line?: string[]; city?: string; state?: string; postalCode?: string };
  phone?: string;
}

export interface RankedCandidate extends DoctorCandidate {
  distanceMiles: number | undefined;
}

/**
 * Orders NPPES candidates for agent-find-doctors. Does NOT handle the
 * previous-physician-first rule — that's applied directly in
 * agent-find-doctors (a previous-physician match, when present, is always
 * prepended ahead of this ranked list), not blended into this function.
 */
export function rankCandidates(
  patientCoords: { lat: number; lng: number } | undefined,
  candidates: DoctorCandidate[]
): RankedCandidate[] {
  const withDistance: RankedCandidate[] = candidates.map((candidate) => {
    const candidateCoords = candidate.address.postalCode ? zip3Centroid(candidate.address.postalCode) : undefined;
    const distanceMiles =
      patientCoords && candidateCoords ? haversineMiles(patientCoords, candidateCoords) : undefined;
    return { ...candidate, distanceMiles };
  });

  return withDistance.sort((a, b) => {
    if (a.distanceMiles === undefined && b.distanceMiles === undefined) return 0;
    if (a.distanceMiles === undefined) return 1; // unresolvable sorts last, never dropped
    if (b.distanceMiles === undefined) return -1;
    return a.distanceMiles - b.distanceMiles;
  });
}
