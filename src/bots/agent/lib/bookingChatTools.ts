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
        properties: {
          npi: { type: 'string' },
          startOffsetDays: { type: 'integer', minimum: 0, description: 'Days from now to start the search window. Default 0.' },
          windowDays: { type: 'integer', minimum: 1, maximum: 14, description: 'Length of the search window in days. Default 7.' },
          previousDoctor: { type: 'boolean', description: 'Set true if this NPI was returned by search_previous_physician.' },
          distanceMiles: { type: 'number', description: 'Distance in miles, if known from a prior search_nppes result.' },
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
    return [];
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

export async function checkAvailabilityTool(
  medplum: MedplumClient,
  args: { npi: string; startOffsetDays?: number; windowDays?: number; previousDoctor?: boolean; distanceMiles?: number }
): Promise<BookableOption[]> {
  const ensured = await ensurePractitionerAndSchedule(medplum, args.npi);
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
        previousDoctor: args.previousDoctor ?? false,
        distanceMiles: args.distanceMiles,
      },
    ];
  });
}
