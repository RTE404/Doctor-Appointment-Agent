// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Stack, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { Document, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { AgentChat } from '../../components/desk/AgentChat';
import type { ChatTurn } from '../../components/desk/chatModel';
import { isValidNpi } from './doctorLookup';
import { executeAction } from '../../api/executeAction';
import type { ChatInput, ChatResult } from '../../bots/agent/agent-patient-chat';

export function PatientAgentChatPage(): JSX.Element {
  const { npi, patientId } = useParams();
  const medplum = useMedplum();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [threadId, setThreadId] = useState<string>();
  const [error, setError] = useState<string>();
  const routeError =
    !npi || !isValidNpi(npi) || !patientId
      ? 'A valid doctor NPI and patient id are required to use the patient agent.'
      : undefined;

  async function handleAsk(question: string): Promise<void> {
    if (!npi || !isValidNpi(npi) || !patientId) {
      setError('A valid doctor NPI and patient id are required to use the patient agent.');
      return;
    }

    setError(undefined);
    try {
      const input: ChatInput = { npi, patientId, question, threadId };
      const result = await executeAction<ChatInput, ChatResult>(medplum, 'agent-patient-chat', input);
      setThreadId(result.threadId);
      setTurns((previous) => [...previous, { question, answer: result.answer }]);
    } catch (err) {
      setError(normalizeErrorString(err));
    }
  }

  return (
    <Document width={800}>
      <Stack>
        <Title order={1}>Patient Agent Chat</Title>
        {(routeError || error) && <Alert color="red">{routeError ?? error}</Alert>}
        {!routeError && <AgentChat turns={turns} onAsk={handleAsk} />}
      </Stack>
    </Document>
  );
}
