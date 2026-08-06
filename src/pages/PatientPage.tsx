// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Grid, Loader } from '@mantine/core';
import type { Patient } from '@medplum/fhirtypes';
import { PatientSummary, useResource } from '@medplum/react';
import type { JSX } from 'react';
import { useParams } from 'react-router';
import { PatientDetails } from '../components/PatientDetails';

export function PatientPage(): JSX.Element {
  const { id } = useParams();

  const patient = useResource<Patient>({ reference: `Patient/${id}` });

  if (!patient) {
    return <Loader />;
  }

  return (
    <Grid>
      <Grid.Col span={5}>
        <PatientSummary patient={patient} />
      </Grid.Col>
      <Grid.Col span={7}>
        <PatientDetails patient={patient} />
      </Grid.Col>
    </Grid>
  );
}
