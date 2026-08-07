// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Badge, Card, Group, Stack, Text } from '@mantine/core';
import dayjs from 'dayjs';
import type { JSX } from 'react';
import type { QueueEntry } from '../../pages/desk/doctorQueue';

interface PatientBriefCardProps {
  entry: QueueEntry;
  onOpen: () => void;
}

export function PatientBriefCard({ entry, onOpen }: PatientBriefCardProps): JSX.Element {
  return (
    <Card withBorder onClick={onOpen} style={{ cursor: 'pointer' }}>
      <Group justify="space-between" wrap="nowrap">
        <Stack gap={2}>
          <Text fw={600}>{entry.patientName}</Text>
          <Text size="sm">{entry.statedIssue}</Text>
          {entry.summary && (
            <Text size="sm" c="dimmed">
              {entry.summary}
            </Text>
          )}
        </Stack>
        <Badge>{entry.appointmentDate ? dayjs(entry.appointmentDate).format('MMM D, YYYY') : 'Date unavailable'}</Badge>
      </Group>
    </Card>
  );
}
