// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Anchor, Button, Stack, Text, Title } from '@mantine/core';
import { Document } from '@medplum/react';
import type { JSX } from 'react';
import { Link } from 'react-router';

export function LandingPage(): JSX.Element {
  return (
    <Document width={500}>
      <Stack align="center">
        <Title order={1} fz={36}>
          Doctor Appointment Agent
        </Title>
        <Text>
          Sign in to access the synthetic patient-booking and doctor-desk demo. Your Medplum account authorizes access
          to the demo project; it does not identify you as one of the doctors listed in the app. If you need a Medplum
          project, <Anchor href="https://app.medplum.com/register">register here</Anchor> first.
        </Text>
        <Button component={Link} to="/signin" size="lg" radius="xl">
          Sign in
        </Button>
      </Stack>
    </Document>
  );
}
