// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Appointment, Practitioner } from '@medplum/fhirtypes';

const NPI_SYSTEM = 'http://hl7.org/fhir/sid/us-npi';

export function getPractitionerReference(appointment: Appointment): string | undefined {
  return appointment.participant?.find((participant) =>
    participant.actor?.reference?.startsWith('Practitioner/')
  )?.actor?.reference;
}

export function getPractitionerNpi(practitioner: Practitioner): string | undefined {
  return practitioner.identifier?.find((identifier) => identifier.system === NPI_SYSTEM)?.value;
}
