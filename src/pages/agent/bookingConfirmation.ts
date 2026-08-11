// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Appointment, Practitioner, PractitionerRole, Schedule } from '@medplum/fhirtypes';

const NPI_SYSTEM = 'http://hl7.org/fhir/sid/us-npi';
const NUCC_SYSTEM = 'http://nucc.org/provider-taxonomy';
const SCHEDULING_PARAMETERS_URL = 'https://medplum.com/fhir/StructureDefinition/SchedulingParameters';

export function getPractitionerReference(appointment: Appointment): string | undefined {
  return appointment.participant?.find((participant) =>
    participant.actor?.reference?.startsWith('Practitioner/')
  )?.actor?.reference;
}

export function getPractitionerNpi(practitioner: Practitioner): string | undefined {
  return practitioner.identifier?.find((identifier) => identifier.system === NPI_SYSTEM)?.value;
}

export function getAppointmentSlotReference(appointment: Appointment): string | undefined {
  return appointment.slot?.find((slot) => slot.reference?.startsWith('Slot/'))?.reference;
}

export function getScheduleTimeZone(schedule: Schedule): string | undefined {
  return schedule.extension
    ?.find((extension) => extension.url === SCHEDULING_PARAMETERS_URL)
    ?.extension?.find((parameter) => parameter.url === 'timezone')?.valueCode;
}

export function getPractitionerSpecialty(roles: PractitionerRole[]): string | undefined {
  for (const specialty of roles.flatMap((role) => role.specialty ?? [])) {
    const coding = specialty.coding?.find((item) => item.system === NUCC_SYSTEM);
    const label = coding?.display ?? specialty.text;
    if (label) {
      return label;
    }
  }
  return undefined;
}

export function formatAppointmentDateTime(
  start: string,
  end: string,
  timeZone: string
): { date: string; time: string } {
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  });
  return {
    date: dateFormatter.format(new Date(start)),
    time: `${timeFormatter.format(new Date(start))}–${timeFormatter.format(new Date(end))}`,
  };
}
