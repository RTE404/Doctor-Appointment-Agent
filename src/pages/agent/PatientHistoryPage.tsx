// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Button, Card, Stack, Text, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { Document, PatientSummary, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { BookInput, BookResult } from '../../bots/agent/agent-book-appointment';
import type { BookingChatInput, BookingChatResult } from '../../bots/agent/agent-booking-chat';
import type { BookableOption } from '../../bots/agent/lib/bookableOptions';
import { BookableOptionDetails } from '../../components/agent/BookableOptionCard';
import { BookingChat } from '../../components/agent/BookingChat';
import type { BookingChatTurn } from '../../components/agent/bookingChatModel';
import { EncounterHistoryList } from '../../components/agent/EncounterHistoryList';
import { executeAction } from '../../api/executeAction';
import { confirmSelectedOption } from './bookingAgentController';
import { optionSelected, optionsReceived } from './bookingAgentModel';
import type { BookingAgentState, BookingInProgressState } from './bookingAgentModel';

export function PatientHistoryPage(): JSX.Element {
  const { patientId } = useParams();
  const medplum = useMedplum();
  const navigate = useNavigate();
  const [turns, setTurns] = useState<BookingChatTurn[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [agentState, setAgentState] = useState<BookingAgentState>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  async function handleSend(message: string): Promise<void> {
    setSending(true);
    setError(undefined);
    setTurns((previous) => [...previous, { kind: 'patient', text: message }]);
    try {
      const input: BookingChatInput = { patientId: patientId as string, message, sessionId };
      const result = await executeAction<BookingChatInput, BookingChatResult>(medplum, 'agent-booking-chat', input);
      setSessionId(result.sessionId);
      if (result.kind === 'question' || result.kind === 'error') {
        setTurns((previous) => [...previous, { kind: 'agent-question', text: result.reply }]);
      } else {
        setTurns((previous) => [...previous, { kind: 'agent-options', options: result.options }]);
        setAgentState(optionsReceived({ options: result.options, summaryCommunicationId: result.summaryCommunicationId }));
      }
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setSending(false);
    }
  }

  function handleSelectOption(option: BookableOption): void {
    if (!agentState) return;
    setAgentState(optionSelected(agentState, option));
  }

  async function handleBookingConfirmation(): Promise<void> {
    if (!agentState) return;
    let bookingState: BookingInProgressState | undefined;
    try {
      setError(undefined);
      const nextState = await confirmSelectedOption(agentState, patientId as string, {
        book: (input) => executeAction<BookInput, BookResult>(medplum, 'agent-book-appointment', input),
        navigate: (path) => navigate(path),
        onBookingStarted: (state) => {
          bookingState = state;
          setAgentState(state);
        },
      });
      setAgentState(nextState);
    } catch (err) {
      setError(normalizeErrorString(err));
      if (bookingState) {
        setAgentState({ ...bookingState, phase: 'confirming' });
      }
    }
  }

  const selectedOption = agentState?.selectedOption;

  return (
    <Document width={800}>
      <Stack>
        <Title order={1}>Patient History</Title>
        <PatientSummary patient={{ reference: `Patient/${patientId}` }} />
        <EncounterHistoryList patientId={patientId as string} />
        {error && <Alert color="red">{error}</Alert>}
        {agentState?.slotTaken && (
          <Alert color="yellow">That appointment was just taken. Please choose one of the remaining options.</Alert>
        )}
        {(agentState?.phase === 'confirming' || agentState?.phase === 'booking') && selectedOption && (
          <Card withBorder>
            <Stack>
              <BookableOptionDetails option={selectedOption} />
              <Text>This appointment has not been booked yet. Do you confirm the booking?</Text>
              <Button loading={agentState.phase === 'booking'} onClick={handleBookingConfirmation}>
                Confirm booking
              </Button>
            </Stack>
          </Card>
        )}
        {agentState?.phase !== 'confirming' && agentState?.phase !== 'booking' && (
          <BookingChat turns={turns} onSend={handleSend} sending={sending} onSelectOption={handleSelectOption} />
        )}
      </Stack>
    </Document>
  );
}
