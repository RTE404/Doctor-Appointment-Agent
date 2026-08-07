// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Badge, Button, Card, Group, Stack, Text } from '@mantine/core';
import type { JSX } from 'react';

interface DoctorCardProps {
  npi: string;
  firstName: string;
  lastName: string;
  source: 'previous' | 'nppes';
  distanceMiles?: number;
  onSelect: () => void;
}

export function DoctorCard(props: DoctorCardProps): JSX.Element {
  const { firstName, lastName, source, distanceMiles, onSelect } = props;
  return (
    <Card withBorder>
      <Group justify="space-between">
        <Stack gap={0}>
          <Text fw={600}>
            Dr. {firstName} {lastName}
          </Text>
          {source === 'previous' ? (
            <Badge color="green">Previous physician</Badge>
          ) : distanceMiles !== undefined ? (
            <Text size="sm" c="dimmed">
              {distanceMiles.toFixed(1)} miles away
            </Text>
          ) : (
            <Text size="sm" c="dimmed">
              Distance unavailable
            </Text>
          )}
        </Stack>
        <Button onClick={onSelect}>Select</Button>
      </Group>
    </Card>
  );
}
