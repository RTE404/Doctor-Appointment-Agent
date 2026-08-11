// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Badge, Button, Card, Group, Stack, Text } from '@mantine/core';
import type { JSX } from 'react';
import type { BookableOption } from '../../bots/agent/lib/bookableOptions';

interface BookableOptionCardProps {
  option: BookableOption;
  number: number;
  onSelect: () => void;
  disabled: boolean;
}

interface BookableOptionDetailsProps {
  option: BookableOption;
  label?: string;
}

function formatBookableOptionDate(option: BookableOption): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: option.timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(option.start));
}

function formatBookableOptionTime(option: BookableOption): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: option.timeZone,
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${formatter.format(new Date(option.start))}–${formatter.format(new Date(option.end))}`;
}

export function BookableOptionDetails(props: BookableOptionDetailsProps): JSX.Element {
  const { option, label } = props;
  return (
    <Stack gap="xs">
      <Text fw={600}>
        {label ? `${label}: ` : ''}
        {option.doctorName}
      </Text>
      <Text>{formatBookableOptionDate(option)}</Text>
      <Text>{formatBookableOptionTime(option)}</Text>
      <Badge color={option.previousDoctor ? 'green' : 'gray'}>
        {option.previousDoctor ? 'Previously visited' : 'New doctor'}
      </Badge>
      {option.distanceMiles !== undefined && (
        <Text size="sm" c="dimmed">
          {option.distanceMiles.toFixed(1)} miles away
        </Text>
      )}
    </Stack>
  );
}

export function BookableOptionCard(props: BookableOptionCardProps): JSX.Element {
  const { option, number, onSelect, disabled } = props;
  return (
    <Card withBorder>
      <Group justify="space-between" align="flex-start">
        <BookableOptionDetails option={option} label={`Option ${number}`} />
        <Button disabled={disabled} onClick={onSelect}>
          Select option {number}
        </Button>
      </Group>
    </Card>
  );
}
