import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Appointment, Bundle, Schedule } from '@medplum/fhirtypes';
import { handler as intakeHandler } from './agent-intake.js';
import type { IntakeInput, IntakeResult } from './agent-intake.js';
import { handler as findDoctorsHandler } from './agent-find-doctors.js';
import type { FindDoctorsInput, FoundCandidate } from './agent-find-doctors.js';
import { rankBookableOptions } from './lib/bookableOptions.js';
import type { BookableOption } from './lib/bookableOptions.js';
import { ensurePractitionerAndSchedule } from './lib/ensurePractitionerAndSchedule.js';
import type { SchedulingPreferences } from './lib/schedulingPreferences.js';
import { timezoneForState } from './lib/timezones.js';

export interface FindBookableOptionsInput {
  patientId: string;
  complaintText: string;
}

export type FindBookableOptionsResult =
  | { needsClarification: true }
  | {
      options: BookableOption[];
      preferences: SchedulingPreferences;
      summaryCommunicationId: string;
    };

interface Dependencies {
  intake: (medplum: MedplumClient, event: BotEvent<IntakeInput>) => Promise<IntakeResult>;
  findDoctors: (
    medplum: MedplumClient,
    event: BotEvent<FindDoctorsInput>
  ) => Promise<{ candidates: FoundCandidate[] }>;
  ensureDoctor: typeof ensurePractitionerAndSchedule;
  now: () => Date;
}

const productionDependencies: Dependencies = {
  intake: intakeHandler,
  findDoctors: findDoctorsHandler,
  ensureDoctor: ensurePractitionerAndSchedule,
  now: () => new Date(),
};

let dependencies: Dependencies = productionDependencies;

export function __setFindBookableOptionsDependenciesForTests(overrides: Partial<Dependencies>): void {
  dependencies = { ...productionDependencies, ...overrides };
}

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<FindBookableOptionsInput>
): Promise<FindBookableOptionsResult> {
  const intakeResult = await dependencies.intake(medplum, event);
  if ('needsClarification' in intakeResult) {
    return { needsClarification: true };
  }

  const doctorResult = await dependencies.findDoctors(medplum, {
    ...event,
    input: {
      patientId: event.input.patientId,
      specialtyCode: intakeResult.intent.specialtyCode,
    },
  });
  const candidates = mergeCandidates(doctorResult.candidates).slice(0, 5);
  if (candidates.length === 0) {
    return {
      options: [],
      preferences: intakeResult.preferences,
      summaryCommunicationId: intakeResult.summaryCommunicationId,
    };
  }

  const start = dependencies.now();
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  const candidateResults = await Promise.allSettled(
    candidates.map((candidate) => loadCandidateOptions(medplum, candidate, start, end))
  );
  const successfulResults = candidateResults.filter(
    (result): result is PromiseFulfilledResult<BookableOption[]> => result.status === 'fulfilled'
  );

  if (successfulResults.length === 0) {
    throw new Error('Unable to retrieve appointment availability');
  }

  const options = deduplicateOptions(successfulResults.flatMap((result) => result.value));
  return {
    options: rankBookableOptions(options, intakeResult.preferences),
    preferences: intakeResult.preferences,
    summaryCommunicationId: intakeResult.summaryCommunicationId,
  };
}

async function loadCandidateOptions(
  medplum: MedplumClient,
  candidate: FoundCandidate,
  start: Date,
  end: Date
): Promise<BookableOption[]> {
  const ensured = await dependencies.ensureDoctor(medplum, candidate.npi, candidate);
  const schedule = await medplum.readResource('Schedule', ensured.scheduleId);
  const url = medplum.fhirUrl('Appointment', '$find');
  url.searchParams.set('service-type-reference', `HealthcareService/${ensured.healthcareServiceId}`);
  url.searchParams.set('schedule', `Schedule/${ensured.scheduleId}`);
  url.searchParams.set('start', start.toISOString());
  url.searchParams.set('end', end.toISOString());
  url.searchParams.set('_count', '100');
  const bundle = await medplum.get<Bundle<Appointment>>(url);
  const timeZone = scheduleTimeZone(schedule, ensured.healthcareServiceId, candidate.address.state);
  const doctorName = `Dr. ${candidate.firstName} ${candidate.lastName}`.trim();

  return (bundle.entry ?? []).flatMap(({ resource }) => {
    if (resource?.resourceType !== 'Appointment' || !resource.start || !resource.end) {
      return [];
    }

    return [
      {
        id: `${candidate.npi}|${resource.start}|${resource.end}`,
        npi: candidate.npi,
        practitionerId: ensured.practitionerId,
        scheduleId: ensured.scheduleId,
        doctorName,
        start: resource.start,
        end: resource.end,
        timeZone,
        previousDoctor: candidate.source === 'previous',
        distanceMiles: 'distanceMiles' in candidate ? candidate.distanceMiles : undefined,
      },
    ];
  });
}

function mergeCandidates(candidates: FoundCandidate[]): FoundCandidate[] {
  const byNpi = new Map<string, FoundCandidate>();
  for (const candidate of candidates) {
    const existing = byNpi.get(candidate.npi);
    if (!existing) {
      byNpi.set(candidate.npi, candidate);
      continue;
    }

    const preferred = existing.source === 'previous' ? existing : candidate.source === 'previous' ? candidate : existing;
    const supplemental = preferred === existing ? candidate : existing;
    const distances = [candidateDistance(existing), candidateDistance(candidate)].filter(
      (distance): distance is number => distance !== undefined
    );
    byNpi.set(candidate.npi, {
      ...supplemental,
      ...preferred,
      source: existing.source === 'previous' || candidate.source === 'previous' ? 'previous' : 'nppes',
      address: hasAddress(preferred) ? preferred.address : supplemental.address,
      distanceMiles: distances.length > 0 ? Math.min(...distances) : undefined,
    });
  }
  return [...byNpi.values()];
}

function candidateDistance(candidate: FoundCandidate): number | undefined {
  return 'distanceMiles' in candidate ? candidate.distanceMiles : undefined;
}

function hasAddress(candidate: FoundCandidate): boolean {
  const { line, city, state, postalCode } = candidate.address;
  return Boolean(line?.length || city || state || postalCode);
}

function deduplicateOptions(options: BookableOption[]): BookableOption[] {
  const unique = new Map<string, BookableOption>();
  for (const option of options) {
    const key = `${option.practitionerId}|${option.scheduleId}|${option.start}|${option.end}`;
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, option);
      continue;
    }
    const distances = [existing.distanceMiles, option.distanceMiles].filter(
      (distance): distance is number => distance !== undefined
    );
    unique.set(key, {
      ...existing,
      previousDoctor: existing.previousDoctor || option.previousDoctor,
      distanceMiles: distances.length > 0 ? Math.min(...distances) : undefined,
    });
  }
  return [...unique.values()];
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
