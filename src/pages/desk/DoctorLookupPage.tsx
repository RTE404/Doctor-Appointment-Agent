// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Button, Group, Stack, Text, TextInput, Title } from '@mantine/core';
import { Document } from '@medplum/react';
import type { JSX } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { isValidNpi, normalizeNpi } from './doctorLookup';

export function DoctorLookupPage(): JSX.Element {
  const navigate = useNavigate();
  const [npi, setNpi] = useState('');
  const showValidationError = npi.length > 0 && !isValidNpi(npi);

  function handleSubmit(): void {
    if (!isValidNpi(npi)) {
      return;
    }
    Promise.resolve(navigate(`/desk/${normalizeNpi(npi)}`)).catch(console.error);
  }

  return (
    <Document width={500}>
      <Stack>
        <Title order={1}>Doctor Desk</Title>
        <Text size="sm" c="dimmed">
          Enter a doctor's 10-digit NPI to view appointments booked with that practitioner. The NPI is a demo filter;
          it is not identity verification or an access-control check.
        </Text>
        <TextInput
          label="NPI"
          value={npi}
          onChange={(event) => setNpi(event.currentTarget.value)}
          placeholder="e.g. 1234567890"
          error={showValidationError ? 'Enter a 10-digit NPI.' : undefined}
        />
        <Group justify="flex-end">
          <Button disabled={!isValidNpi(npi)} onClick={handleSubmit}>
            View Queue
          </Button>
        </Group>
      </Stack>
    </Document>
  );
}
