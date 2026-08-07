// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Modal } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { getQuestionnaireAnswers, normalizeErrorString } from '@medplum/core';
import type { Appointment, Questionnaire, QuestionnaireResponse } from '@medplum/fhirtypes';
import { QuestionnaireForm, useMedplum } from '@medplum/react';
import { IconCircleCheck, IconCircleOff } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router';

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

  async function handleQuestionnaireSubmit(formData: QuestionnaireResponse): Promise<void> {
    const answers = getQuestionnaireAnswers(formData);
    const startDateTime = answers['start-date'].valueDateTime as string;
    const endDateTime = answers['end-date'].valueDateTime as string;

    try {
      // Native $book + $cancel round trip, with real availability checking —
      // no custom bot; see AppointmentActions.tsx's $cancel for the same shift.
      const result = await medplum.executeBot(
        { system: 'http://example.com', value: 'reschedule-appointment' },
        { appointmentId: appointment.id, newStart: startDateTime, newEnd: endDateTime }
      );

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
      <QuestionnaireForm questionnaire={rescheduleAppointmentQuestionnaire} onSubmit={handleQuestionnaireSubmit} />
    </Modal>
  );
}

const rescheduleAppointmentQuestionnaire: Questionnaire = {
  resourceType: 'Questionnaire',
  id: 'reschedule-appointment',
  title: 'Reschedule Appointment',
  status: 'active',
  item: [
    {
      linkId: 'start-date',
      type: 'dateTime',
      text: 'Start date',
      required: true,
    },
    {
      linkId: 'end-date',
      type: 'dateTime',
      text: 'End date',
      required: true,
    },
  ],
};
