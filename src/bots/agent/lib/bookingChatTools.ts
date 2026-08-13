// src/bots/agent/lib/bookingChatTools.ts
import type { MedplumClient } from '@medplum/core';
import type { Appointment, Bundle, Patient, Schedule } from '@medplum/fhirtypes';
import { SPECIALTY_TABLE } from '../../../config/specialties.js';
import { findPreviousPhysician } from '../agent-find-doctors.js';
import type { FoundCandidate } from '../agent-find-doctors.js';
import { ensurePractitionerAndSchedule } from './ensurePractitionerAndSchedule.js';
import { patientCoords } from './geo.js';
import { searchNppesDoctors } from './nppes.js';
import { rankCandidates } from './ranking.js';
import { timezoneForState } from './timezones.js';
import type { BookableOption } from './bookableOptions.js';
import type { BookingChatMessage } from './bookingSession.js';

const NPPES_SEARCH_LIMIT = 15;

let nowProvider: () => Date = () => new Date();

/** Test-only seam. */
export function __setBookingChatToolsNowForTests(fn: () => Date): void {
  nowProvider = fn;
}

export const BOOKING_CHAT_TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'search_previous_physician',
      description: "Find a physician the patient has previously seen who matches the given specialty.",
      parameters: {
        type: 'object',
        properties: { specialtyCode: { type: 'string', description: 'NUCC provider taxonomy code' } },
        required: ['specialtyCode'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_nppes',
      description: 'Search the NPPES public registry for doctors matching a specialty near the patient.',
      parameters: {
        type: 'object',
        properties: { specialtyCode: { type: 'string', description: 'NUCC provider taxonomy code' } },
        required: ['specialtyCode'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'check_availability',
      description: 'Check real bookable appointment times for one provider by NPI.',
      parameters: {
        type: 'object',
        // `previousDoctor` and `distanceMiles` are deliberately NOT model
        // inputs: both are rendered to the patient (a "Previously visited"
        // badge and a distance figure), so they are derived server-side from
        // the search result the NPI actually came from rather than trusted
        // from an unverifiable model claim.
        properties: {
          npi: { type: 'string', description: 'An NPI returned by a prior search_previous_physician or search_nppes call.' },
          startOffsetDays: { type: 'integer', minimum: 0, description: 'Days from now to start the search window. Default 0.' },
          windowDays: { type: 'integer', minimum: 1, maximum: 14, description: 'Length of the search window in days. Default 7.' },
        },
        required: ['npi'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'ask_clarifying_question',
      description: 'Ask the patient a clarifying question before continuing.',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'propose_options',
      description: 'Finalize the search with up to 8 grounded, distinct-provider options.',
      parameters: {
        type: 'object',
        properties: {
          specialty: { type: 'string', description: 'One label from the supported specialty list' },
          reason: { type: 'string' },
          summary: { type: 'string' },
          picks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                npi: { type: 'string' },
                start: { type: 'string' },
                end: { type: 'string' },
                reasoning: { type: 'string' },
              },
              required: ['npi', 'start', 'end', 'reasoning'],
            },
          },
        },
        required: ['specialty', 'reason', 'summary', 'picks'],
      },
    },
  },
];

export async function searchPreviousPhysicianTool(
  medplum: MedplumClient,
  patientId: string,
  specialtyCode: string
): Promise<FoundCandidate | null> {
  const found = await findPreviousPhysician(medplum, patientId, specialtyCode);
  return found ?? null;
}

export async function searchNppesTool(medplum: MedplumClient, patient: Patient, specialtyCode: string): Promise<FoundCandidate[]> {
  const specialtyDef = SPECIALTY_TABLE.find((s) => s.nuccCode === specialtyCode);
  if (!specialtyDef) {
    // An empty array here would be indistinguishable from "no doctors found
    // nearby", so a mistyped/hallucinated code would silently burn loop steps
    // with no corrective signal. The loop turns this throw into a tool-result
    // error the model can see and self-correct from.
    throw new Error(
      `"${specialtyCode}" is not a supported NUCC specialty code. Use one of the codes listed in the supported specialty table in your instructions.`
    );
  }
  const nppesResults = await searchNppesDoctors(
    specialtyDef.nppesTaxonomyDescription,
    patient.address?.[0]?.city ?? '',
    patient.address?.[0]?.state ?? '',
    specialtyCode,
    NPPES_SEARCH_LIMIT
  );
  const ranked = rankCandidates(patientCoords(patient), nppesResults);
  return ranked.slice(0, NPPES_SEARCH_LIMIT).map((c) => ({ ...c, source: 'nppes' as const, npi: c.npi }));
}

const SEARCH_TOOL_NAMES = new Set(['search_previous_physician', 'search_nppes']);

/**
 * Indexes, by NPI, every provider a search tool actually returned earlier in
 * this session's transcript. Two things depend on it:
 *
 * 1. `check_availability` must pass the originating candidate to
 *    `ensurePractitionerAndSchedule`, so a newly provisioned PractitionerRole
 *    is seeded with the specialty the provider was *found under* — NPPES can
 *    match a provider on a non-primary taxonomy, and a bare NPI re-lookup
 *    would pick their primary one instead, which `agent-book-appointment`
 *    then rejects as a specialty mismatch.
 * 2. Provenance: an NPI absent from this index never came from a real search,
 *    so no FHIR resources should be provisioned for it at all.
 *
 * Mirrors `collectGroundedOptions` in ./proposeOptions.ts, which scans the
 * same transcript for `check_availability` results.
 */
export function collectSearchedCandidates(transcript: BookingChatMessage[]): Map<string, FoundCandidate> {
  const index = new Map<string, FoundCandidate>();
  for (const message of transcript) {
    if (message.role !== 'tool') continue;
    let parsed: { tool?: string; result?: unknown };
    try {
      parsed = JSON.parse(message.content) as { tool?: string; result?: unknown };
    } catch {
      continue;
    }
    if (!parsed.tool || !SEARCH_TOOL_NAMES.has(parsed.tool)) continue;
    // search_nppes returns an array; search_previous_physician returns one
    // candidate or null. A failed call records an { error } object instead.
    const entries = Array.isArray(parsed.result) ? parsed.result : [parsed.result];
    for (const entry of entries) {
      const candidate = entry as FoundCandidate | null | undefined;
      if (!candidate || typeof candidate.npi !== 'string' || !candidate.npi) continue;
      // A previous-physician match is never downgraded by a later NPPES hit
      // on the same NPI: the 'previous' provenance drives the patient-visible
      // "Previously visited" badge and must not be lost.
      if (index.get(candidate.npi)?.source === 'previous') continue;
      index.set(candidate.npi, candidate);
    }
  }
  return index;
}

function candidateDistanceMiles(candidate: FoundCandidate): number | undefined {
  return 'distanceMiles' in candidate ? candidate.distanceMiles : undefined;
}

function scheduleTimeZone(schedule: Schedule, healthcareServiceId: string, fallbackState: string | undefined): string {
  const schedulingParameters = schedule.extension?.find(
    (extension) =>
      extension.url === 'https://medplum.com/fhir/StructureDefinition/SchedulingParameters' &&
      extension.extension?.some(
        (parameter) =>
          parameter.url === 'service' &&
          parameter.valueReference?.reference === `HealthcareService/${healthcareServiceId}`
      )
  );
  return (
    schedulingParameters?.extension?.find((parameter) => parameter.url === 'timezone')?.valueCode ??
    timezoneForState(fallbackState)
  );
}

/**
 * `candidate` is required, not optional: it is the search result this NPI came
 * from, resolved by the caller from the session transcript (see
 * collectSearchedCandidates). Making it mandatory is what structurally
 * guarantees both that a provisioned PractitionerRole carries the specialty
 * the provider was matched on, and that availability is never checked — and
 * FHIR resources never created — for an NPI no search ever returned.
 */
export async function checkAvailabilityTool(
  medplum: MedplumClient,
  args: { npi: string; startOffsetDays?: number; windowDays?: number },
  candidate: FoundCandidate
): Promise<BookableOption[]> {
  const ensured = await ensurePractitionerAndSchedule(medplum, args.npi, candidate);
  const [practitioner, schedule] = await Promise.all([
    medplum.readResource('Practitioner', ensured.practitionerId),
    medplum.readResource('Schedule', ensured.scheduleId),
  ]);
  const doctorName = `Dr. ${practitioner.name?.[0]?.given?.[0] ?? ''} ${practitioner.name?.[0]?.family ?? ''}`.trim();
  const timeZone = scheduleTimeZone(schedule, ensured.healthcareServiceId, undefined);

  const start = new Date(nowProvider().getTime() + (args.startOffsetDays ?? 0) * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + (args.windowDays ?? 7) * 24 * 60 * 60 * 1000);
  const url = medplum.fhirUrl('Appointment', '$find');
  url.searchParams.set('service-type-reference', `HealthcareService/${ensured.healthcareServiceId}`);
  url.searchParams.set('schedule', `Schedule/${ensured.scheduleId}`);
  url.searchParams.set('start', start.toISOString());
  url.searchParams.set('end', end.toISOString());
  url.searchParams.set('_count', '100');
  const bundle = await medplum.get<Bundle<Appointment>>(url);

  return (bundle.entry ?? []).flatMap(({ resource }) => {
    if (resource?.resourceType !== 'Appointment' || !resource.start || !resource.end) {
      return [];
    }
    return [
      {
        id: `${args.npi}|${resource.start}|${resource.end}`,
        npi: args.npi,
        practitionerId: ensured.practitionerId,
        scheduleId: ensured.scheduleId,
        doctorName,
        start: resource.start,
        end: resource.end,
        timeZone,
        // Derived from the search result, never from model-supplied args.
        previousDoctor: candidate.source === 'previous',
        distanceMiles: candidateDistanceMiles(candidate),
      },
    ];
  });
}
