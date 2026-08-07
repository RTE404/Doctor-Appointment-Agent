// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Loader, Stack, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { Document, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useContext, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { DoctorCard } from '../../components/agent/DoctorCard';
import { BookingContext } from '../../booking.context';

interface Candidate {
  npi: string;
  firstName: string;
  lastName: string;
  source: 'previous' | 'nppes';
  distanceMiles?: number;
}

export function DoctorResultsPage(): JSX.Element {
  const { patientId } = useParams();
  const medplum = useMedplum();
  const navigate = useNavigate();
  const { booking, setBooking } = useContext(BookingContext);
  const [candidates, setCandidates] = useState<Candidate[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!booking.intent) {
      navigate(`/agent/${patientId}`).catch(console.error);
      return;
    }
    medplum
      .executeBot(
        { system: 'http://example.com', value: 'agent-find-doctors' },
        { patientId, specialtyCode: booking.intent.specialtyCode }
      )
      .then((result) => setCandidates(result.candidates))
      .catch((err) => setError(normalizeErrorString(err)));
  }, [medplum, patientId, booking.intent, navigate]);

  function handleSelect(candidate: Candidate): void {
    setBooking({ ...booking, chosenCandidate: candidate });
    navigate(`/agent/${patientId}/doctors/${candidate.npi}/slots`).catch(console.error);
  }

  return (
    <Document width={800}>
      <Stack>
        <Title order={1}>Matching Doctors</Title>
        {error && <Alert color="red">{error}</Alert>}
        {!candidates && !error && <Loader />}
        {candidates?.length === 0 && <Alert color="yellow">No doctors found for this specialty and location.</Alert>}
        {(candidates ?? []).map((candidate) => (
          <DoctorCard key={candidate.npi} {...candidate} onSelect={() => handleSelect(candidate)} />
        ))}
      </Stack>
    </Document>
  );
}
