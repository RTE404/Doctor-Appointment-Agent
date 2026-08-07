// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, CopyButton, Loader, Stack, Text, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { Document, useMedplum } from '@medplum/react';
import type { Appointment, Practitioner } from '@medplum/fhirtypes';
import dayjs from 'dayjs';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { getPractitionerNpi, getPractitionerReference } from './bookingConfirmation';

export function BookingConfirmationPage(): JSX.Element {
  const { apptId } = useParams();
  const medplum = useMedplum();
  const [appointment, setAppointment] = useState<Appointment>();
  const [npi, setNpi] = useState<string>();
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

      setAppointment(loadedAppointment);
      setNpi(practitionerNpi);
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

  if (!appointment) {
    return (
      <Document width={600}>
        <Loader />
      </Document>
    );
  }

  return (
    <Document width={600}>
      <Stack align="center">
        <Title order={1}>Appointment Confirmed</Title>
        <Text>{dayjs(appointment.start).format('dddd, MMMM D, YYYY [at] h:mm A')}</Text>
        <Text size="sm" c="dimmed">
          Give this NPI to the front desk if asked:
        </Text>
        <Text size="48px" fw={700}>
          {npi}
        </Text>
        {npi && (
          <CopyButton value={npi}>
            {({ copied, copy }) => <Text onClick={copy} style={{ cursor: 'pointer' }}>{copied ? 'Copied!' : 'Copy NPI'}</Text>}
          </CopyButton>
        )}
      </Stack>
    </Document>
  );
}
