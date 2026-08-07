// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Stack, Title } from '@mantine/core';
import { Document, PatientSummary, useMedplum } from '@medplum/react';
import { normalizeErrorString } from '@medplum/core';
import type { JSX } from 'react';
import { useContext, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ComplaintForm } from '../../components/agent/ComplaintForm';
import { IntentCard } from '../../components/agent/IntentCard';
import { EncounterHistoryList } from '../../components/agent/EncounterHistoryList';
import { BookingContext } from '../../booking.context';

export function PatientHistoryPage(): JSX.Element {
  const { patientId } = useParams();
  const medplum = useMedplum();
  const navigate = useNavigate();
  const { booking, setBooking } = useContext(BookingContext);
  const [submitting, setSubmitting] = useState(false);
  const [needsClarification, setNeedsClarification] = useState(false);
  const [error, setError] = useState<string>();

  async function handleComplaintSubmit(complaintText: string): Promise<void> {
    setSubmitting(true);
    setError(undefined);
    setNeedsClarification(false);
    try {
      const result = await medplum.executeBot(
        { system: 'http://example.com', value: 'agent-intake' },
        { patientId, complaintText }
      );
      if ('needsClarification' in result) {
        setNeedsClarification(true);
        return;
      }
      setBooking({
        ...booking,
        intent: { ...result.intent, complaintText },
        summaryCommunicationId: result.summaryCommunicationId,
      });
      Promise.resolve(navigate(`/agent/${patientId}/doctors`)).catch(console.error);
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Document width={800}>
      <Stack>
        <Title order={1}>Patient History</Title>
        <PatientSummary patient={{ reference: `Patient/${patientId}` }} />
        <EncounterHistoryList patientId={patientId as string} />
        {error && <Alert color="red">{error}</Alert>}
        {booking.intent && <IntentCard intent={booking.intent} />}
        <ComplaintForm onSubmit={handleComplaintSubmit} submitting={submitting} needsClarification={needsClarification} />
      </Stack>
    </Document>
  );
}
