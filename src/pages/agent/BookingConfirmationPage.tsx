// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, CopyButton, Loader, Stack, Text, Title } from '@mantine/core';
import { getDisplayString, normalizeErrorString } from '@medplum/core';
import { Document, useMedplum } from '@medplum/react';
import type { Appointment, Practitioner, PractitionerRole, Schedule, Slot } from '@medplum/fhirtypes';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import {
  formatAppointmentDateTime,
  getAppointmentSlotReference,
  getPractitionerNpi,
  getPractitionerReference,
  getPractitionerSpecialty,
  getScheduleTimeZone,
} from './bookingConfirmation';

interface ConfirmationDetails {
  appointment: Appointment;
  doctorName: string;
  npi: string;
  specialty: string;
  timeZone: string;
}

export function BookingConfirmationPage(): JSX.Element {
  const { apptId } = useParams();
  const medplum = useMedplum();
  const [details, setDetails] = useState<ConfirmationDetails>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    async function load(): Promise<void> {
      if (!apptId) {
        throw new Error('The appointment id is missing from this confirmation link.');
      }

      const loadedAppointment = await medplum.readResource('Appointment', apptId);
      const practitionerReference = getPractitionerReference(loadedAppointment);
      if (!practitionerReference) {
        throw new Error('The booked appointment does not identify a doctor.');
      }

      const practitioner: Practitioner = await medplum.readReference({ reference: practitionerReference });
      const practitionerNpi = getPractitionerNpi(practitioner);
      if (!practitionerNpi) {
        throw new Error('The booked doctor does not have a US NPI identifier.');
      }

      const slotReference = getAppointmentSlotReference(loadedAppointment);
      if (!slotReference) {
        throw new Error('The booked appointment does not identify its reserved slot.');
      }
      const slot: Slot = await medplum.readReference({ reference: slotReference });
      if (!slot.schedule.reference?.startsWith('Schedule/')) {
        throw new Error('The booked slot does not identify its provider schedule.');
      }
      const schedule: Schedule = await medplum.readReference(slot.schedule);
      const timeZone = getScheduleTimeZone(schedule);
      if (!timeZone) {
        throw new Error('The booked provider schedule does not identify its timezone.');
      }

      const roles: PractitionerRole[] = await medplum.searchResources('PractitionerRole', {
        practitioner: practitionerReference,
      });
      const displayName = getDisplayString(practitioner);
      const doctorName = /^dr\.?\s/i.test(displayName) ? displayName : `Dr. ${displayName}`;

      setDetails({
        appointment: loadedAppointment,
        doctorName,
        npi: practitionerNpi,
        specialty: getPractitionerSpecialty(roles) ?? 'Not specified',
        timeZone,
      });
    }

    setError(undefined);
    load().catch((err) => setError(normalizeErrorString(err)));
  }, [medplum, apptId]);

  if (error) {
    return (
      <Document width={600}>
        <Alert color="red" title="Unable to load confirmation">
          {error}
        </Alert>
      </Document>
    );
  }

  if (!details) {
    return (
      <Document width={600}>
        <Loader />
      </Document>
    );
  }

  const { appointment, doctorName, npi, specialty, timeZone } = details;
  const appointmentTime = formatAppointmentDateTime(appointment.start as string, appointment.end as string, timeZone);

  return (
    <Document width={600}>
      <Stack align="center">
        <Title order={1}>Appointment Confirmed</Title>
        <Text><strong>Doctor:</strong> {doctorName}</Text>
        <Text><strong>Specialty:</strong> {specialty}</Text>
        <Text><strong>Date:</strong> {appointmentTime.date}</Text>
        <Text><strong>Time:</strong> {appointmentTime.time} ({timeZone})</Text>
        <Text><strong>Status:</strong> {appointment.status === 'booked' ? 'Booked' : appointment.status}</Text>
        <Text><strong>Appointment ID:</strong> {appointment.id}</Text>
        <Text size="sm" c="dimmed">
          <strong>NPI:</strong> {npi}
        </Text>
        <CopyButton value={npi}>
          {({ copied, copy }) => <Text onClick={copy} style={{ cursor: 'pointer' }}>{copied ? 'Copied!' : 'Copy NPI'}</Text>}
        </CopyButton>
      </Stack>
    </Document>
  );
}
