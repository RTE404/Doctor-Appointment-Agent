// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Button, Group, Stack, Text, Textarea } from '@mantine/core';
import type { JSX } from 'react';
import { useState } from 'react';

interface ComplaintFormProps {
  onSubmit: (complaintText: string) => void;
  submitting: boolean;
  needsClarification: boolean;
}

export function ComplaintForm(props: ComplaintFormProps): JSX.Element {
  const { onSubmit, submitting, needsClarification } = props;
  const [complaintText, setComplaintText] = useState('');

  return (
    <Stack>
      {needsClarification && (
        <Alert color="yellow" title="Could not determine a specialty">
          Please describe your issue a bit more specifically (e.g. name a body part or symptom).
        </Alert>
      )}
      <Textarea
        label="What brings you in today?"
        placeholder="e.g. My chest hurts when I run"
        value={complaintText}
        onChange={(e) => setComplaintText(e.currentTarget.value)}
        minRows={2}
        maxRows={3}
      />
      <Text size="xs" c="dimmed">
        This only helps schedule the right kind of visit — it is not a medical evaluation. If this is a medical
        emergency, call 911 or go to the nearest emergency room instead of using this form.
      </Text>
      <Group justify="flex-end">
        <Button disabled={!complaintText.trim() || submitting} loading={submitting} onClick={() => onSubmit(complaintText)}>
          Find a Doctor
        </Button>
      </Group>
    </Stack>
  );
}
