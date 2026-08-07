// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Button, SimpleGrid } from '@mantine/core';
import dayjs from 'dayjs';
import type { JSX } from 'react';

export interface SlotOption {
  start: string;
  end: string;
}

interface SlotGridProps {
  slots: SlotOption[];
  onPick: (slot: SlotOption) => void;
  disabled: boolean;
}

export function SlotGrid(props: SlotGridProps): JSX.Element {
  const { slots, onPick, disabled } = props;
  return (
    <SimpleGrid cols={3}>
      {slots.map((slot) => (
        <Button key={slot.start} variant="outline" disabled={disabled} onClick={() => onPick(slot)}>
          {dayjs(slot.start).format('MMM D, h:mm A')}
        </Button>
      ))}
    </SimpleGrid>
  );
}
