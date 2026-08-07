// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Stack } from '@mantine/core';
import type { JSX } from 'react';
import type { QueueEntry } from '../../pages/desk/doctorQueue';
import { PatientBriefCard } from './PatientBriefCard';

interface QueueTableProps {
  entries: QueueEntry[];
  onOpen: (patientId: string) => void;
}

export function QueueTable({ entries, onOpen }: QueueTableProps): JSX.Element {
  return (
    <Stack>
      {entries.map((entry) => (
        <PatientBriefCard key={entry.appointmentId} entry={entry} onOpen={() => onOpen(entry.patientId)} />
      ))}
    </Stack>
  );
}
