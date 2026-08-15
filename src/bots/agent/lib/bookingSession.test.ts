import { beforeAll, describe, expect, test } from 'vitest';
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type { Bundle, SearchParameter } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { createBookingSession, loadBookingSession, persistBookingSession } from './bookingSession';
import type { BookingChatMessage } from './bookingSession';

beforeAll(() => {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-medplum.json') as Bundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
  }
});

async function seedAgentDevice(medplum: MockClient): Promise<void> {
  await medplum.createResource({
    resourceType: 'Device',
    identifier: [{ system: 'http://example.com/agent-config', value: 'ai-appointment-agent' }],
  });
}

describe('createBookingSession', () => {
  test('creates an in-progress, tagged Communication carrying the initial transcript', async () => {
    const medplum = new MockClient();
    await seedAgentDevice(medplum);
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    const initialTranscript: BookingChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];

    const session = await createBookingSession(medplum, patient.id as string, initialTranscript);

    expect(session.communication.status).toBe('in-progress');
    expect(session.communication.subject).toStrictEqual({ reference: `Patient/${patient.id}` });
    expect(session.communication.category?.[0]?.coding?.[0]).toStrictEqual({
      system: 'http://example.com/agent-communication-category',
      code: 'ai-booking-session',
    });
    expect(session.communication.meta?.tag).toContainEqual({ code: 'ai-generated' });
    expect(session.communication.meta?.tag).toContainEqual({
      system: 'https://doctor-appointment-agent.example/fhir/demo',
      code: 'demo-generated',
    });
    expect(session.transcript).toStrictEqual(initialTranscript);
  });

  test('throws when the agent Device is not configured', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient' });

    await expect(createBookingSession(medplum, patient.id as string, [])).rejects.toThrow(
      'ai-appointment-agent Device is not configured'
    );
  });
});

describe('loadBookingSession', () => {
  test('round-trips a persisted transcript', async () => {
    const medplum = new MockClient();
    await seedAgentDevice(medplum);
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    const created = await createBookingSession(medplum, patient.id as string, [{ role: 'user', content: 'first' }]);
    await persistBookingSession(
      medplum,
      { ...created, transcript: [...created.transcript, { role: 'assistant', content: 'reply' }] },
      'in-progress'
    );

    const loaded = await loadBookingSession(medplum, created.communication.id as string, patient.id as string);

    expect(loaded.transcript).toStrictEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
    ]);
  });

  test('rejects a session id belonging to a different patient', async () => {
    const medplum = new MockClient();
    await seedAgentDevice(medplum);
    const patientA = await medplum.createResource({ resourceType: 'Patient' });
    const patientB = await medplum.createResource({ resourceType: 'Patient' });
    const session = await createBookingSession(medplum, patientA.id as string, []);

    await expect(loadBookingSession(medplum, session.communication.id as string, patientB.id as string)).rejects.toThrow(
      'Booking chat session not found for this patient'
    );
  });

  test('rejects a session that is no longer in-progress', async () => {
    const medplum = new MockClient();
    await seedAgentDevice(medplum);
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    const session = await createBookingSession(medplum, patient.id as string, []);
    await persistBookingSession(medplum, session, 'completed');

    await expect(loadBookingSession(medplum, session.communication.id as string, patient.id as string)).rejects.toThrow(
      'Booking chat session not found for this patient'
    );
  });
});

describe('persistBookingSession', () => {
  test('updates status without dropping subject, category, or sender', async () => {
    const medplum = new MockClient();
    await seedAgentDevice(medplum);
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    const session = await createBookingSession(medplum, patient.id as string, []);

    await persistBookingSession(medplum, session, 'completed');

    const updated = await medplum.readResource('Communication', session.communication.id as string);
    expect(updated.status).toBe('completed');
    expect(updated.subject).toStrictEqual({ reference: `Patient/${patient.id}` });
    expect(updated.category).toStrictEqual(session.communication.category);
    expect(updated.sender).toStrictEqual(session.communication.sender);
  });
});
