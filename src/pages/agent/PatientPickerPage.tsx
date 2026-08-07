// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Anchor, Stack, Table, Title } from '@mantine/core';
import type { Patient } from '@medplum/fhirtypes';
import { Document, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';

export function PatientPickerPage(): JSX.Element {
  const medplum = useMedplum();
  const [patients, setPatients] = useState<Patient[]>();

  useEffect(() => {
    medplum
      .searchResources('Patient', { _count: '50', _sort: 'family' })
      .then((result) => setPatients([...result]))
      .catch(console.error);
  }, [medplum]);

  return (
    <Document width={800}>
      <Stack>
        <Title order={1}>Select a Patient</Title>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Date of Birth</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(patients ?? []).map((patient) => (
              <Table.Tr key={patient.id}>
                <Table.Td>
                  <Anchor component={Link} to={`/agent/${patient.id}`}>
                    {patient.name?.[0]?.given?.join(' ')} {patient.name?.[0]?.family}
                  </Anchor>
                </Table.Td>
                <Table.Td>{patient.birthDate}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Stack>
    </Document>
  );
}
