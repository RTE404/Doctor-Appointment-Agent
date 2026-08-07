// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Stack, Table, Text, Title } from '@mantine/core';
import type { BundleEntry, Encounter, Organization, Practitioner, PractitionerRole, Resource } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import dayjs from 'dayjs';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';

interface HistoryRow {
  date: string;
  practitionerName: string;
  specialty: string;
  organizationName: string;
}

/**
 * PatientSummary (from @medplum/react) does not render an Encounter-history
 * section at all — confirmed directly against its source. This satisfies
 * FR-2's requirement for past encounters with practitioner, specialty, and
 * organization, which PatientSummary alone cannot.
 */
export function EncounterHistoryList({ patientId }: { patientId: string }): JSX.Element {
  const medplum = useMedplum();
  const [rows, setRows] = useState<HistoryRow[]>();

  useEffect(() => {
    async function load(): Promise<void> {
      // medplum.search() (not searchResources()) is used deliberately — it
      // returns the raw Bundle including the _include'd Practitioner/
      // Organization entries, which searchResources() would filter out.
      // URLSearchParams (rather than a plain Record) is required here because
      // QueryTypes' Record form only accepts scalar values, and _include
      // needs to be repeated once per included path.
      const query = new URLSearchParams();
      query.set('subject', `Patient/${patientId}`);
      query.append('_include', 'Encounter:practitioner');
      query.append('_include', 'Encounter:service-provider');
      query.set('_sort', '-date');
      query.set('_count', '50');
      const bundle = await medplum.search('Encounter', query);
      // search()'s return type is narrowed to Bundle<Encounter> by its
      // resourceType-keyed generic, but _include'd entries actually contain
      // Practitioner/Organization resources too — widen the entry type to
      // match what's really in the Bundle at runtime.
      const entries = (bundle.entry ?? []) as BundleEntry<Resource>[];
      const encounters = entries.filter((e) => e.resource?.resourceType === 'Encounter').map((e) => e.resource as Encounter);
      const practitioners = new Map<string, Practitioner>(
        entries.filter((e) => e.resource?.resourceType === 'Practitioner').map((e) => [e.resource!.id as string, e.resource as Practitioner])
      );
      const organizations = new Map<string, Organization>(
        entries.filter((e) => e.resource?.resourceType === 'Organization').map((e) => [e.resource!.id as string, e.resource as Organization])
      );

      const practitionerIds = [...practitioners.keys()];
      const roles: PractitionerRole[] = practitionerIds.length
        ? await medplum.searchResources('PractitionerRole', { practitioner: practitionerIds.map((id) => `Practitioner/${id}`).join(',') })
        : [];
      const specialtyByPractitionerId = new Map(
        roles.map((r) => [r.practitioner?.reference?.split('/')[1], r.specialty?.[0]?.coding?.[0]?.display ?? r.specialty?.[0]?.coding?.[0]?.code])
      );

      setRows(
        encounters.map((encounter) => {
          const practitionerId = encounter.participant?.[0]?.individual?.reference?.split('/')[1];
          const organizationId = encounter.serviceProvider?.reference?.split('/')[1];
          const practitioner = practitionerId ? practitioners.get(practitionerId) : undefined;
          return {
            date: encounter.period?.start ? dayjs(encounter.period.start).format('MMM D, YYYY') : 'Unknown date',
            practitionerName: practitioner
              ? `Dr. ${practitioner.name?.[0]?.given?.join(' ') ?? ''} ${practitioner.name?.[0]?.family ?? ''}`.trim()
              : 'Unknown',
            specialty: (practitionerId && specialtyByPractitionerId.get(practitionerId)) || 'Unknown specialty',
            organizationName: (organizationId && organizations.get(organizationId)?.name) || 'Unknown organization',
          };
        })
      );
    }
    load().catch(console.error);
  }, [medplum, patientId]);

  return (
    <Stack>
      <Title order={3}>Past Encounters</Title>
      {!rows && (
        <Text size="sm" c="dimmed">
          Loading...
        </Text>
      )}
      {rows?.length === 0 && (
        <Text size="sm" c="dimmed">
          No past encounters on record.
        </Text>
      )}
      {rows && rows.length > 0 && (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Date</Table.Th>
              <Table.Th>Practitioner</Table.Th>
              <Table.Th>Specialty</Table.Th>
              <Table.Th>Organization</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row, i) => (
              <Table.Tr key={i}>
                <Table.Td>{row.date}</Table.Td>
                <Table.Td>{row.practitionerName}</Table.Td>
                <Table.Td>{row.specialty}</Table.Td>
                <Table.Td>{row.organizationName}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
