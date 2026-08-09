// src/bots/agent/lib/ensurePractitionerAndSchedule.ts
import type { MedplumClient } from '@medplum/core';
import type { CodeableConcept, Extension, HealthcareService, Practitioner, Schedule } from '@medplum/fhirtypes';
import { getNppesDoctorByNpi } from './nppes.js';
import type { DoctorCandidate } from './ranking.js';
import { timezoneForState } from './timezones.js';

const NPI_SYSTEM = 'http://hl7.org/fhir/sid/us-npi';
const NUCC_SYSTEM = 'http://nucc.org/provider-taxonomy';
const SCHEDULING_PARAMETERS_URL = 'https://medplum.com/fhir/StructureDefinition/SchedulingParameters';
const SERVICE_TYPE_REF_URL = 'https://medplum.com/fhir/service-type-reference';
const DAY_CODES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

type NppesLookup = typeof getNppesDoctorByNpi;
let nppesLookup: NppesLookup = getNppesDoctorByNpi;

/** Test-only seam. */
export function __setNppesLookupForTests(fn: NppesLookup): void {
  nppesLookup = fn;
}

interface WeeklyTemplate {
  workDays: number[];
  startHour: number;
  lunchStartHour: number;
  endHour: number;
}

function hashNpi(npi: string): number {
  let hash = 0;
  for (let i = 0; i < npi.length; i++) {
    hash = (hash * 31 + npi.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function deriveWeeklyTemplate(npi: string): WeeklyTemplate {
  const h = hashNpi(npi);
  const patterns = [[1, 2, 3, 4, 5], [1, 3, 5], [2, 4], [1, 2, 3, 4]];
  const workDays = patterns[h % patterns.length];
  const startHour = 8 + (h % 3); // 8, 9, or 10
  return { workDays, startHour, lunchStartHour: startHour + 4, endHour: startHour + 8 };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function buildAvailabilityExtension(template: WeeklyTemplate): Extension {
  const dayExtensions: Extension[] = template.workDays.map((day) => ({ url: 'daysOfWeek', valueCode: DAY_CODES[day] }));
  return {
    url: 'availability',
    extension: [
      {
        url: 'availableTime',
        extension: [
          ...dayExtensions,
          { url: 'availableStartTime', valueTime: `${pad(template.startHour)}:00:00` },
          { url: 'availableEndTime', valueTime: `${pad(template.lunchStartHour)}:00:00` },
        ],
      },
      {
        url: 'availableTime',
        extension: [
          ...dayExtensions,
          { url: 'availableStartTime', valueTime: `${pad(template.lunchStartHour + 1)}:00:00` },
          { url: 'availableEndTime', valueTime: `${pad(template.endHour)}:00:00` },
        ],
      },
    ],
  };
}

/**
 * Builds ONE SchedulingParameters extension scoped to a single
 * HealthcareService via its `service` sub-extension — confirmed directly
 * against Medplum's matching logic (scheduling-parameters.ts): a Schedule
 * extension with no `service` sub-extension never matches any requested
 * HealthcareService and is silently skipped. The caller builds one of
 * these per HealthcareService (see ensurePractitionerAndSchedule below) —
 * never a single shared one.
 */
function buildSchedulingParametersExtension(
  template: WeeklyTemplate,
  timezone: string,
  healthcareServiceId: string,
  durationMinutes: number
): Extension {
  return {
    url: SCHEDULING_PARAMETERS_URL,
    extension: [
      { url: 'service', valueReference: { reference: `HealthcareService/${healthcareServiceId}` } },
      { url: 'duration', valueDuration: { value: durationMinutes, unit: 'min', system: 'http://unitsofmeasure.org', code: 'min' } },
      // Confirmed default is 60 minutes if unset (SERVICE_DEFAULTS in
      // scheduling-parameters.ts) — $find steps candidate start times by
      // this interval, independent of duration, so leaving it unset would
      // silently offer only one start time per hour (hiding 3 of 4 real
      // 15-minute slots, half of every 30-minute slot). Set explicitly to
      // match this service's own duration so every real opening is offered.
      { url: 'alignmentInterval', valueDuration: { value: durationMinutes, unit: 'min', system: 'http://unitsofmeasure.org', code: 'min' } },
      { url: 'timezone', valueCode: timezone },
      buildAvailabilityExtension(template),
    ],
  };
}

function serviceTypeConcept(healthcareServiceId: string): CodeableConcept {
  return {
    extension: [{ url: SERVICE_TYPE_REF_URL, valueReference: { reference: `HealthcareService/${healthcareServiceId}` } }],
  };
}

/**
 * Lazy provisioning — the sole caller is agent-ensure-doctor (never
 * agent-find-doctors, never the UI directly), since NPPES lookups need a bot.
 */
export async function ensurePractitionerAndSchedule(
  medplum: MedplumClient,
  npi: string,
  candidate?: DoctorCandidate
): Promise<{ practitionerId: string; scheduleId: string; healthcareServiceId: string }> {
  const officeVisit: HealthcareService = (await medplum.searchOne('HealthcareService', { name: 'Office Visit' })) as HealthcareService;
  const healthcareServiceId = officeVisit.id as string;

  let practitioner = await medplum.searchOne('Practitioner', { identifier: `${NPI_SYSTEM}|${npi}` });
  if (!practitioner) {
    const doctor = candidate ?? (await nppesLookup(npi));
    if (!doctor) {
      throw new Error(`No NPPES record found for NPI ${npi}`);
    }
    const created = await medplum.createResource<Practitioner>({
      resourceType: 'Practitioner',
      identifier: [{ system: NPI_SYSTEM, value: npi }],
      name: [{ given: [doctor.firstName], family: doctor.lastName }],
    });
    await medplum.createResource({
      resourceType: 'PractitionerRole',
      practitioner: { reference: `Practitioner/${created.id}` },
      specialty: [{ coding: [{ system: NUCC_SYSTEM, code: doctor.nuccCode, display: doctor.nuccDisplay }] }],
    });
    practitioner = created;
  }
  const practitionerId = practitioner.id;

  let schedule = await medplum.searchOne('Schedule', { actor: `Practitioner/${practitionerId}` });
  if (!schedule) {
    const template = deriveWeeklyTemplate(npi);
    const timezone = timezoneForState(candidate?.address.state);
    schedule = await medplum.createResource<Schedule>({
      resourceType: 'Schedule',
      actor: [{ reference: `Practitioner/${practitionerId}` }],
      serviceType: [serviceTypeConcept(healthcareServiceId)],
      extension: [buildSchedulingParametersExtension(template, timezone, healthcareServiceId, 30)],
    });
  }

  return { practitionerId, scheduleId: schedule.id as string, healthcareServiceId };
}
