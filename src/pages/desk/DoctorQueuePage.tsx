// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Loader, Stack, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { Document, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { QueueTable } from '../../components/desk/QueueTable';
import { isValidNpi, normalizeNpi } from './doctorLookup';
import { loadDoctorQueueEntries } from './doctorQueue';
import type { QueueEntry } from './doctorQueue';

export function DoctorQueuePage(): JSX.Element {
  const { npi } = useParams();
  const medplum = useMedplum();
  const navigate = useNavigate();
  const [entries, setEntries] = useState<QueueEntry[]>();
  const [error, setError] = useState<string>();
  const providerIdentifier = npi ? normalizeNpi(npi) : undefined;
  const routeError =
    !providerIdentifier || !isValidNpi(providerIdentifier)
      ? 'A valid numeric provider identifier with 1 to 10 digits is required to load the doctor queue.'
      : undefined;

  useEffect(() => {
    if (!providerIdentifier || !isValidNpi(providerIdentifier)) {
      return;
    }
    const doctorIdentifier = providerIdentifier;

    async function load(): Promise<void> {
      setEntries(await loadDoctorQueueEntries(medplum, doctorIdentifier));
    }

    load().catch((err) => setError(normalizeErrorString(err)));
  }, [medplum, providerIdentifier]);

  function openPatient(patientId: string): void {
    if (!providerIdentifier) {
      return;
    }
    Promise.resolve(navigate(`/desk/${providerIdentifier}/patients/${patientId}`)).catch(console.error);
  }

  return (
    <Document width={800}>
      <Stack>
        <Title order={1}>Patient Queue — Provider {providerIdentifier ?? npi}</Title>
        {(routeError || error) && <Alert color="red">{routeError ?? error}</Alert>}
        {!entries && !routeError && !error && <Loader />}
        {entries?.length === 0 && (
          <Alert color="yellow">No patients have booked with this provider identifier yet.</Alert>
        )}
        {entries && <QueueTable entries={entries} onOpen={openPatient} />}
      </Stack>
    </Document>
  );
}
