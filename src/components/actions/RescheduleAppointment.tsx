// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Button, Modal, Stack, TextInput } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { Appointment } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconCircleCheck, IconCircleOff } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { executeAction } from '../../api/executeAction';
import type { RescheduleInput, RescheduleResult } from '../../bots/core/reschedule-appointment';
import { buildRescheduleInput } from './dateTimeActionInputs';

interface RescheduleAppointmentProps {
  appointment: Appointment;
  readonly opened: boolean;
  readonly handlers: {
    readonly open: () => void;
    readonly close: () => void;
    readonly toggle: () => void;
  };
}

export function RescheduleAppointment(props: RescheduleAppointmentProps): JSX.Element {
  const { appointment, opened, handlers } = props;
  const medplum = useMedplum();
  const navigate = useNavigate();
  const [startDateTime, setStartDateTime] = useState('');
  const [endDateTime, setEndDateTime] = useState('');

  async function handleSubmit(): Promise<void> {
    if (!appointment.id) {
      showNotification({
        icon: <IconCircleOff />,
        title: 'Error',
        message: 'Unable to reschedule an appointment without an ID.',
      });
      return;
    }

    try {
      // Native $book + $cancel round trip, with real availability checking —
      // no custom bot; see AppointmentActions.tsx's $cancel for the same shift.
      const input = buildRescheduleInput(appointment.id, startDateTime, endDateTime);
      const result = await executeAction<RescheduleInput, RescheduleResult>(medplum, 'reschedule-appointment', input);

      if (!result.ok) {
        showNotification({
          color: 'red',
          icon: <IconCircleOff />,
          title: 'Time unavailable',
          message: 'That time is no longer available. The original appointment was not changed — please pick another time.',
        });
        return;
      }

      navigate(`/Appointment/${result.appointment.id}/details`)?.catch(console.error);
      showNotification({
        icon: <IconCircleCheck />,
        title: 'Success',
        message: 'Appointment rescheduled',
      });
      handlers.close();
    } catch (err) {
      showNotification({
        icon: <IconCircleOff />,
        title: 'Error',
        message: normalizeErrorString(err),
      });
    }
  }

  return (
    <Modal opened={opened} onClose={handlers.close}>
      <Stack>
        <TextInput
          label="Start date"
          type="datetime-local"
          required
          value={startDateTime}
          onChange={(event) => setStartDateTime(event.currentTarget.value)}
        />
        <TextInput
          label="End date"
          type="datetime-local"
          required
          value={endDateTime}
          onChange={(event) => setEndDateTime(event.currentTarget.value)}
        />
        <Button
          disabled={!startDateTime || !endDateTime}
          onClick={() => {
            handleSubmit().catch(() =>
              showNotification({ color: 'red', title: 'Error', message: 'Unable to submit the reschedule request.' })
            );
          }}
        >
          Submit
        </Button>
      </Stack>
    </Modal>
  );
}
