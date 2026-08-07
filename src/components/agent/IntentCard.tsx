// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Card, Group, Text } from '@mantine/core';
import type { JSX } from 'react';
import type { BookingIntent } from '../../booking.context';

export function IntentCard({ intent }: { intent: BookingIntent }): JSX.Element {
  return (
    <Card withBorder>
      <Group justify="space-between">
        <Text fw={600}>{intent.specialtyLabel}</Text>
      </Group>
      <Text size="sm" c="dimmed">
        {intent.reason}
      </Text>
    </Card>
  );
}
