// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Button, Group, Loader, Paper, Stack, Text, Textarea } from '@mantine/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { BookableOptionCard } from './BookableOptionCard';
import { prepareBookingMessage } from './bookingChatModel';
import type { BookingChatTurn } from './bookingChatModel';
import type { BookableOption } from '../../bots/agent/lib/bookableOptions';

interface BookingChatProps {
  turns: BookingChatTurn[];
  onSend: (message: string) => Promise<void>;
  sending: boolean;
  onSelectOption: (option: BookableOption) => void;
}

export function BookingChat({ turns, onSend, sending, onSelectOption }: BookingChatProps): JSX.Element {
  const [message, setMessage] = useState('');

  async function submit(): Promise<void> {
    const prepared = prepareBookingMessage(message);
    if (!prepared || sending) {
      return;
    }
    await onSend(prepared);
    setMessage('');
  }

  function send(): void {
    submit().catch(console.error);
  }

  const lastTurn = turns[turns.length - 1];
  const optionsShown = lastTurn?.kind === 'agent-options';

  return (
    <Stack>
      <Alert color="blue" title="Scheduling assistant">
        This assistant only helps find and book a visit. It does not diagnose, recommend treatment, or assess
        urgency — if this is a medical emergency, call 911 or go to the nearest emergency room.
      </Alert>
      <Stack>
        {turns.map((turn, index) => {
          if (turn.kind === 'patient') {
            return (
              <Paper key={index} withBorder p="sm">
                <Text fw={600}>You: {turn.text}</Text>
              </Paper>
            );
          }
          if (turn.kind === 'agent-question') {
            return (
              <Paper key={index} withBorder p="sm">
                <Text>{turn.text}</Text>
              </Paper>
            );
          }
          return (
            <Stack key={index}>
              <Text>Here are the best available options:</Text>
              {turn.options.map((option, optionIndex) => (
                <BookableOptionCard
                  key={option.id}
                  option={option}
                  number={optionIndex + 1}
                  disabled={sending}
                  onSelect={() => onSelectOption(option)}
                />
              ))}
              <Text>Which option would you like to book?</Text>
            </Stack>
          );
        })}
        {sending && <Loader size="sm" />}
      </Stack>
      {!optionsShown && (
        <Group align="flex-end">
          <Textarea
            style={{ flex: 1 }}
            label="What brings you in today?"
            placeholder="e.g. My chest hurts when I run"
            value={message}
            onChange={(event) => setMessage(event.currentTarget.value)}
            disabled={sending}
            minRows={2}
            maxRows={3}
          />
          <Button disabled={!prepareBookingMessage(message) || sending} loading={sending} onClick={send}>
            Send
          </Button>
        </Group>
      )}
    </Stack>
  );
}
