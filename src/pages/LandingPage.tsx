// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Button, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { Document, useMedplum } from '@medplum/react';
import { useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { useNavigate } from 'react-router';
import { establishDemoSession } from '../demoSession';

export function LandingPage(): JSX.Element {
  const medplum = useMedplum();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(undefined);
    setLoading(true);
    try {
      await establishDemoSession(code, medplum);
      await navigate('/agent', { replace: true });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'The demo is temporarily unavailable.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Document width={500}>
      <form onSubmit={(event) => handleSubmit(event)}>
        <Stack>
          <Title order={1} fz={36}>
            Doctor Appointment Agent
          </Title>
          <Text>Enter the shared demo code. You do not need a Medplum account.</Text>
          {error && <Alert color="red">{error}</Alert>}
          <PasswordInput
            label="Demo code"
            value={code}
            onChange={(event) => setCode(event.currentTarget.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
          <Button type="submit" size="lg" radius="xl" loading={loading} disabled={!code}>
            Open demo
          </Button>
        </Stack>
      </form>
    </Document>
  );
}
