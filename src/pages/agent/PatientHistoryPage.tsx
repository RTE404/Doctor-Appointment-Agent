// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Button, Card, Stack, Text, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { Document, PatientSummary, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { FindBookableOptionsInput, FindBookableOptionsResult } from '../../bots/agent/agent-find-bookable-options';
import type { BookInput, BookResult } from '../../bots/agent/agent-book-appointment';
import { BookableOptionCard, BookableOptionDetails } from '../../components/agent/BookableOptionCard';
import { ComplaintForm } from '../../components/agent/ComplaintForm';
import { EncounterHistoryList } from '../../components/agent/EncounterHistoryList';
import { executeAction } from '../../api/executeAction';
import { confirmSelectedOption, searchForBookableOptions } from './bookingAgentController';
import { initialBookingAgentState, optionSelected } from './bookingAgentModel';
import type { BookingInProgressState } from './bookingAgentModel';

export function PatientHistoryPage(): JSX.Element {
  const { patientId } = useParams();
  const medplum = useMedplum();
  const navigate = useNavigate();
  const [agentState, setAgentState] = useState(initialBookingAgentState);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  async function handleComplaintSubmit(complaintText: string): Promise<void> {
    let searchingState = agentState;
    setSubmitting(true);
    setError(undefined);
    try {
      const nextState = await searchForBookableOptions(agentState, patientId as string, complaintText, {
        discover: (input) =>
          executeAction<FindBookableOptionsInput, FindBookableOptionsResult>(
            medplum,
            'agent-find-bookable-options',
            input
          ),
        onSearchStarted: (state) => {
          searchingState = state;
          setAgentState(state);
        },
      });
      setAgentState(nextState);
    } catch (err) {
      setError(normalizeErrorString(err));
      setAgentState({ ...searchingState, phase: 'collecting' });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleBookingConfirmation(): Promise<void> {
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

  const selectedOption = agentState.selectedOption;
  const complaintDisabled = !['collecting', 'clarifying'].includes(agentState.phase);

  return (
    <Document width={800}>
      <Stack>
        <Title order={1}>Patient History</Title>
        <PatientSummary patient={{ reference: `Patient/${patientId}` }} />
        <EncounterHistoryList patientId={patientId as string} />
        {error && <Alert color="red">{error}</Alert>}
        {agentState.phase === 'error' && (
          <Alert color="red">I couldn't match that request to a supported doctor category.</Alert>
        )}
        {agentState.slotTaken && (
          <Alert color="yellow">That appointment was just taken. Please choose one of the remaining options.</Alert>
        )}
        {agentState.phase === 'showing-options' && agentState.options.length > 0 && (
          <Stack>
            <Text>Here are the best available options:</Text>
            {agentState.options.map((option, index) => (
              <BookableOptionCard
                key={option.id}
                option={option}
                number={index + 1}
                disabled={submitting}
                onSelect={() => setAgentState(optionSelected(agentState, option))}
              />
            ))}
            <Text>Option 1 best matches your preferences.</Text>
            <Text>Which option would you like to book?</Text>
          </Stack>
        )}
        {agentState.phase === 'showing-options' && agentState.options.length === 0 && (
          <Alert color="yellow">No appointments are available in the next seven days.</Alert>
        )}
        {(agentState.phase === 'confirming' || agentState.phase === 'booking') && selectedOption && (
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
        <ComplaintForm
          onSubmit={handleComplaintSubmit}
          submitting={submitting}
          needsClarification={agentState.phase === 'clarifying'}
          disabled={complaintDisabled}
        />
      </Stack>
    </Document>
  );
}
