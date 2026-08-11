// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Modal } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { createReference, normalizeErrorString } from '@medplum/core';
import type { Questionnaire, QuestionnaireResponse, Slot } from '@medplum/fhirtypes';
import { Loading, QuestionnaireForm } from '@medplum/react';
import { IconCircleOff } from '@tabler/icons-react';
import { useContext } from 'react';
import type { JSX } from 'react';
import type { Event } from 'react-big-calendar';
import { ScheduleContext } from '../../Schedule.context';

interface CreateUpdateSlotProps {
  event: Event | undefined;
  readonly opened: boolean;
  readonly handlers: {
    readonly open: () => void;
    readonly close: () => void;
    readonly toggle: () => void;
  };
  readonly onSlotsUpdated: () => void;
}

/**
 * CreateUpdateSlot component that allows the user to create or update a slot.
 * @param props - CreateUpdateSlotProps
 * @returns A React component that displays the modal.
 */
export function CreateUpdateSlot(props: CreateUpdateSlotProps): JSX.Element {
  const { event, opened, handlers } = props;
  const { schedule } = useContext(ScheduleContext);

  const editingSlot: Slot = event?.resource;

  if (!schedule) {
    return <Loading />;
  }

  // If an editing slot was passed, update it otherwise create a new slot
  async function handleQuestionnaireSubmit(_formData: QuestionnaireResponse): Promise<void> {
    try {
      throw new Error('Schedule editing is unavailable in the shared demo');
    } catch (err) {
      showNotification({
        color: 'red',
        icon: <IconCircleOff />,
        title: 'Error',
        message: normalizeErrorString(err),
      });
    }

    handlers.close();
  }

  const slotQuestionnaire: Questionnaire = {
    resourceType: 'Questionnaire',
    status: 'active',
    title: editingSlot ? 'Update Slot' : 'Create a Slot',
    id: 'new-slot',
    item: [
      {
        linkId: 'start-date',
        type: 'dateTime',
        text: 'Start date',
        required: true,
        initial: [{ valueDateTime: event?.start?.toISOString() }],
      },
      {
        linkId: 'end-date',
        type: 'dateTime',
        text: 'End date',
        required: true,
        initial: [{ valueDateTime: event?.end?.toISOString() }],
      },
    ],
  };

  return (
    <Modal opened={opened} onClose={handlers.close}>
      <QuestionnaireForm
        questionnaire={slotQuestionnaire}
        subject={createReference(schedule)}
        onSubmit={handleQuestionnaireSubmit}
      />
    </Modal>
  );
}
