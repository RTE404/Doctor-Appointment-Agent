// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Button, Group, Loader, Paper, Stack, Text, Textarea } from '@mantine/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { prepareQuestion } from './chatModel';
import type { ChatTurn } from './chatModel';

interface AgentChatProps {
  turns: ChatTurn[];
  onAsk: (question: string) => Promise<void>;
}

const EXAMPLE_QUESTIONS = [
  'What medications are they on?',
  'When was their last visit?',
  'Any known allergies?',
  'Who have they seen before?',
];

export function AgentChat({ turns, onAsk }: AgentChatProps): JSX.Element {
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);

  async function submit(value: string): Promise<void> {
    const preparedQuestion = prepareQuestion(value);
    if (!preparedQuestion || asking) {
      return;
    }

    setAsking(true);
    try {
      await onAsk(preparedQuestion);
      setQuestion('');
    } finally {
      setAsking(false);
    }
  }

  function ask(value: string): void {
    submit(value).catch(console.error);
  }

  return (
    <Stack>
      <Alert color="blue" title="Record lookup only">
        This agent answers only from the patient&apos;s record. It never diagnoses, interprets findings, or gives
        clinical advice — even if asked directly.
      </Alert>
      <Group>
        {EXAMPLE_QUESTIONS.map((example) => (
          <Button key={example} size="xs" variant="light" onClick={() => ask(example)} disabled={asking}>
            {example}
          </Button>
        ))}
      </Group>
      <Stack>
        {turns.map((turn, index) => (
          <Paper key={`${index}-${turn.question}`} withBorder p="sm">
            <Text fw={600}>Q: {turn.question}</Text>
            <Text>{turn.answer}</Text>
          </Paper>
        ))}
        {asking && <Loader size="sm" />}
      </Stack>
      <Group align="flex-end">
        <Textarea
          style={{ flex: 1 }}
          value={question}
          onChange={(event) => setQuestion(event.currentTarget.value)}
          placeholder="Ask a factual question about this patient's record"
          disabled={asking}
        />
        <Button disabled={!prepareQuestion(question) || asking} onClick={() => ask(question)}>
          Ask
        </Button>
      </Group>
    </Stack>
  );
}
