// src/bots/agent/agent-find-doctors.ts
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Encounter, Practitioner, PractitionerRole } from '@medplum/fhirtypes';
import { SPECIALTY_TABLE } from '../../config/specialties.js';
import { patientCoords } from './lib/geo.js';
import { rankCandidates } from './lib/ranking.js';
import type { DoctorCandidate, RankedCandidate } from './lib/ranking.js';
import { searchNppesDoctors } from './lib/nppes.js';

export type FindDoctorsInput = { patientId: string; specialtyCode: string };
export type FoundCandidate = (RankedCandidate | DoctorCandidate) & {
  source: 'previous' | 'nppes';
  npi: string;
  lastSeen?: string;
  organizationName?: string;
};
export type FindDoctorsResult = { candidates: FoundCandidate[] };

type NppesSearcher = typeof searchNppesDoctors;
let nppesSearcher: NppesSearcher = searchNppesDoctors;

/** Test-only seam — swaps the real NPPES call for a stub. */
export function __setNppesSearcherForTests(fn: NppesSearcher): void {
  nppesSearcher = fn;
}

const NUCC_SYSTEM = 'http://nucc.org/provider-taxonomy';

export async function handler(medplum: MedplumClient, event: BotEvent<FindDoctorsInput>): Promise<FindDoctorsResult> {
  const { patientId, specialtyCode } = event.input;
  const patient = await medplum.readResource('Patient', patientId);

  const previous = await findPreviousPhysician(medplum, patientId, specialtyCode);

  const specialtyDef = SPECIALTY_TABLE.find((s) => s.nuccCode === specialtyCode);
  const nppesResults = specialtyDef
    ? await nppesSearcher(
        specialtyDef.nppesTaxonomyDescription,
        patient.address?.[0]?.city ?? '',
        patient.address?.[0]?.state ?? '',
        specialtyCode
      )
    : [];
  const ranked = rankCandidates(patientCoords(patient), nppesResults);
  const nppesCandidates: FoundCandidate[] = ranked.slice(0, 10).map((c) => ({ ...c, source: 'nppes' as const, npi: c.npi }));

  return { candidates: previous ? [previous, ...nppesCandidates] : nppesCandidates };
}

export async function findPreviousPhysician(
  medplum: MedplumClient,
  patientId: string,
  specialtyCode: string
): Promise<FoundCandidate | undefined> {
  const encounters: Encounter[] = await medplum.searchResources('Encounter', {
    subject: `Patient/${patientId}`,
    _include: 'Encounter:practitioner',
    _count: '200',
  });

  const practitionerIds = [
    ...new Set(
      encounters
        .flatMap((e) => e.participant?.map((p) => p.individual?.reference))
        .filter((ref): ref is string => !!ref?.startsWith('Practitioner/'))
        .map((ref) => ref.split('/')[1])
    ),
  ];
  if (practitionerIds.length === 0) return undefined;

  const roles: PractitionerRole[] = await medplum.searchResources('PractitionerRole', {
    practitioner: practitionerIds.map((id) => `Practitioner/${id}`).join(','),
    specialty: `${NUCC_SYSTEM}|${specialtyCode}`,
  });
  if (roles.length === 0) return undefined;

  const matchingIds = new Set(roles.map((r) => r.practitioner?.reference?.split('/')[1]));

  // Tie-break: most recent Encounter.period.start wins among matching practitioners.
  let winnerId: string | undefined;
  let winnerDate = '';
  for (const encounter of encounters) {
    const id = encounter.participant?.[0]?.individual?.reference?.split('/')[1];
    if (id && matchingIds.has(id) && (encounter.period?.start ?? '') > winnerDate) {
      winnerId = id;
      winnerDate = encounter.period?.start ?? '';
    }
  }
  if (!winnerId) return undefined;

  const practitioner: Practitioner = await medplum.readResource('Practitioner', winnerId);
  const npi = practitioner.identifier?.find((i) => i.system === 'http://hl7.org/fhir/sid/us-npi')?.value ?? '';

  return {
    source: 'previous',
    npi,
    firstName: practitioner.name?.[0]?.given?.[0] ?? '',
    lastName: practitioner.name?.[0]?.family ?? '',
    nuccCode: specialtyCode,
    nuccDisplay: SPECIALTY_TABLE.find((s) => s.nuccCode === specialtyCode)?.nuccDisplay ?? '',
    address: {},
    lastSeen: winnerDate,
    distanceMiles: undefined,
  };
}
