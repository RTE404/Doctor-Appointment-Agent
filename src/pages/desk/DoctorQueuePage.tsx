// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Loader, Stack, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import type { Appointment, Communication, Patient, Practitioner } from '@medplum/fhirtypes';
import { Document, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { QueueTable } from '../../components/desk/QueueTable';
import { isValidNpi } from './doctorLookup';
import { buildQueueEntries } from './doctorQueue';
import type { QueueEntry } from './doctorQueue';

export function DoctorQueuePage(): JSX.Element {
  const { npi } = useParams();
  const medplum = useMedplum();
  const navigate = useNavigate();
  const [entries, setEntries] = useState<QueueEntry[]>();
  const [error, setError] = useState<string>();
  const routeError = !npi || !isValidNpi(npi) ? 'A valid 10-digit NPI is required to load the doctor queue.' : undefined;

  useEffect(() => {
    if (!npi || !isValidNpi(npi)) {
      return;
    }

    async function load(): Promise<void> {
      const practitioner: Practitioner | undefined = await medplum.searchOne('Practitioner', {
        identifier: `http://hl7.org/fhir/sid/us-npi|${npi}`,
      });
      if (!practitioner?.id) {
        setEntries([]);
        return;
      }

      const practitionerReference = `Practitioner/${practitioner.id}`;
      const [appointments, summaries]: [Appointment[], Communication[]] = await Promise.all([
        medplum.searchResources('Appointment', { actor: practitionerReference, _sort: '-date' }),
        medplum.searchResources('Communication', {
          recipient: practitionerReference,
          category: 'ai-previsit-summary',
        }),
      ]);
      const patientIds = [
        ...new Set(
          appointments.flatMap((appointment) =>
            appointment.participant
              .map((participant) => participant.actor?.reference)
              .filter((reference): reference is string => reference?.startsWith('Patient/') === true)
              .map((reference) => reference.split('/')[1])
          )
        ),
      ];
      const patients: Patient[] = await Promise.all(patientIds.map((patientId) => medplum.readResource('Patient', patientId)));
      setEntries(buildQueueEntries(appointments, summaries, patients));
    }

    load().catch((err) => setError(normalizeErrorString(err)));
  }, [medplum, npi]);

  function openPatient(patientId: string): void {
    Promise.resolve(navigate(`/desk/${npi}/patients/${patientId}`)).catch(console.error);
  }

  return (
    <Document width={800}>
      <Stack>
        <Title order={1}>Patient Queue — NPI {npi}</Title>
        {(routeError || error) && <Alert color="red">{routeError ?? error}</Alert>}
        {!entries && !routeError && !error && <Loader />}
        {entries?.length === 0 && <Alert color="yellow">No patients have booked with this NPI yet.</Alert>}
        {entries && <QueueTable entries={entries} onOpen={openPatient} />}
      </Stack>
    </Document>
  );
}
