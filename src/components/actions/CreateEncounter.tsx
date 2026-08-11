// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Modal } from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { getQuestionnaireAnswers, normalizeErrorString } from '@medplum/core';
import type { Appointment, Coding, Encounter, Questionnaire } from '@medplum/fhirtypes';
import { QuestionnaireForm, useMedplum } from '@medplum/react';
import { IconCircleCheck, IconCircleOff } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router';
import { executeAction } from '../../api/executeAction';
import type { CompleteAppointmentInput } from '../../bots/core/complete-appointment';

interface CreateEncounterProps {
  appointment: Appointment;
  readonly opened: boolean;
  readonly handlers: {
    readonly open: () => void;
    readonly close: () => void;
    readonly toggle: () => void;
  };
}

export function CreateEncounter(props: CreateEncounterProps): JSX.Element {
  const { appointment, opened, handlers } = props;
  const medplum = useMedplum();
  const navigate = useNavigate();

  async function handleCreateEncounter(formData: any): Promise<void> {
    const answers = getQuestionnaireAnswers(formData);

    try {
      const encounter = await executeAction<CompleteAppointmentInput, Encounter>(medplum, 'complete-appointment', {
        appointmentId: appointment.id as string,
        encounterType: answers['type'].valueCoding as Coding,
      });

      // Navigate to the encounter details page
      navigate(`/Encounter/${encounter.id}`)?.catch(console.error);
      showNotification({
        icon: <IconCircleCheck />,
        title: 'Success',
        message: 'Encounter created',
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
      <QuestionnaireForm questionnaire={createEncounterQuestionnaire} onSubmit={handleCreateEncounter} />
    </Modal>
  );
}

const createEncounterQuestionnaire: Questionnaire = {
  resourceType: 'Questionnaire',
  id: 'new-encounter',
  title: 'Create Encounter',
  status: 'active',
  item: [
    {
      linkId: 'info-note',
      type: 'display',
      text:
        "By submitting the form, the appointment status will be set to 'fulfilled' and " +
        'an Encounter resource will be created to capture details about the visit. ' +
        'To further explore the Encounter lifecycle, please visit the Medplum Charting Demo.',
    },
    {
      linkId: 'type',
      type: 'choice',
      text: 'Type',
      answerValueSet: 'http://hl7.org/fhir/ValueSet/encounter-type',
      required: true,
    },
  ],
};
