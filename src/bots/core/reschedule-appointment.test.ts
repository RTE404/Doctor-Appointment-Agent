// src/bots/core/reschedule-appointment.test.ts
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { OperationOutcomeError, indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type { Bundle, SearchParameter } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { handler } from './reschedule-appointment';

// The handler searches Communication.subject/category — not indexed by a
// bare MockClient. See patientContext.test.ts for the same fix and its
// rationale.
beforeAll(() => {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-medplum.json') as Bundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
  }
});

const SERVICE_TYPE = [{ extension: [{ url: 'https://medplum.com/fhir/service-type-reference', valueReference: { reference: 'HealthcareService/office-visit' } }] }];
const PARTICIPANTS = [{ actor: { reference: 'Patient/p1' }, status: 'accepted' as const }, { actor: { reference: 'Practitioner/dr-1' }, status: 'accepted' as const }];

describe('reschedule-appointment handler', () => {
  test('on success: books the new time via $book (parsing its real bare-Bundle response), copies stated-issue metadata, re-links the summary Communication, cancels the original via native $cancel', async () => {
    const medplum = new MockClient();
    const schedule = await medplum.createResource({ resourceType: 'Schedule', actor: [{ reference: 'Practitioner/dr-1' }] });
    const oldSlot = await medplum.createResource({ resourceType: 'Slot', schedule: { reference: `Schedule/${schedule.id}` }, status: 'busy', start: '2026-09-01T09:00:00Z', end: '2026-09-01T09:30:00Z' });
    const communication = await medplum.createResource({
      resourceType: 'Communication',
      status: 'completed',
      category: [{ coding: [{ system: 'http://example.com/agent-communication-category', code: 'ai-previsit-summary' }] }],
      subject: { reference: 'Patient/p1' },
      sender: { reference: 'Device/ai-appointment-agent' },
      payload: [{ contentString: 'summary' }],
      about: [{ reference: 'placeholder' }],
    });
    const appointment = await medplum.createResource({
      resourceType: 'Appointment',
      status: 'booked',
      slot: [{ reference: `Slot/${oldSlot.id}` }],
      serviceType: SERVICE_TYPE,
      participant: PARTICIPANTS,
      description: 'Chest discomfort during exercise',
      comment: 'My chest hurts when I run',
      reasonCode: [{ text: 'Chest discomfort during exercise' }],
    });
    await medplum.updateResource({ ...communication, about: [{ reference: `Appointment/${appointment.id}` }] });

    // $book persists and echoes back whatever extra fields were submitted on
    // the proposal (confirmed against Medplum server source — see
    // reschedule-appointment.ts), so a realistic mocked response includes them.
    const bookedAppointment = {
      resourceType: 'Appointment',
      id: 'appt-new',
      status: 'booked',
      description: 'Chest discomfort during exercise',
      comment: 'My chest hurts when I run',
      reasonCode: [{ text: 'Chest discomfort during exercise' }],
    };
    // $book's real response is a BARE Bundle — no Parameters envelope.
    const bookResponseBundle = { resourceType: 'Bundle', type: 'transaction-response', entry: [{ resource: bookedAppointment }] };
    const posted: { url: string; body: any }[] = [];
    vi.spyOn(medplum, 'post').mockImplementation(async (url: string | URL, body: any) => {
      const resolvedUrl = url.toString();
      posted.push({ url: resolvedUrl, body });
      if (resolvedUrl === medplum.fhirUrl('Appointment', '$book').toString()) return bookResponseBundle as any;
      if (resolvedUrl === medplum.fhirUrl('Appointment', appointment.id as string, '$cancel').toString()) return { resourceType: 'Appointment', id: appointment.id, status: 'cancelled' } as any;
      throw new Error(`unexpected post ${resolvedUrl}`);
    });

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { appointmentId: appointment.id as string, newStart: '2026-09-02T09:00:00Z', newEnd: '2026-09-02T09:30:00Z' },
      contentType: 'application/json',
      secrets: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.appointment.description).toBe('Chest discomfort during exercise');
    expect(result.appointment.comment).toBe('My chest hurts when I run');

    const bookCall = posted.find((p) => p.url === medplum.fhirUrl('Appointment', '$book').toString());
    const proposedAppointment = bookCall?.body.parameter[0].resource;
    expect(proposedAppointment.contained[0]).toMatchObject({ resourceType: 'Slot', start: '2026-09-02T09:00:00Z', end: '2026-09-02T09:30:00Z', schedule: { reference: `Schedule/${schedule.id}` } });
    // Proves the metadata was actually submitted on the proposal (one atomic
    // write), not merely echoed by the mocked $book response fixture.
    expect(proposedAppointment.description).toBe('Chest discomfort during exercise');
    expect(proposedAppointment.comment).toBe('My chest hurts when I run');
    expect(posted.some((p) => p.url === medplum.fhirUrl('Appointment', appointment.id as string, '$cancel').toString())).toBe(true);

    const updatedCommunication = await medplum.readResource('Communication', communication.id as string);
    expect(updatedCommunication.about?.[0].reference).toBe('Appointment/appt-new'); // re-linked to the NEW appointment, not the cancelled one
  });

  test('on slot-taken $book rejection: leaves the original appointment untouched, does not call $cancel', async () => {
    const medplum = new MockClient();
    const schedule = await medplum.createResource({ resourceType: 'Schedule', actor: [{ reference: 'Practitioner/dr-1' }] });
    const oldSlot = await medplum.createResource({ resourceType: 'Slot', schedule: { reference: `Schedule/${schedule.id}` }, status: 'busy', start: '2026-09-01T09:00:00Z', end: '2026-09-01T09:30:00Z' });
    const appointment = await medplum.createResource({
      resourceType: 'Appointment',
      status: 'booked',
      slot: [{ reference: `Slot/${oldSlot.id}` }],
      serviceType: SERVICE_TYPE,
      participant: PARTICIPANTS,
    });
    const posted: string[] = [];
    vi.spyOn(medplum, 'post').mockImplementation(async (url: string | URL) => {
      posted.push(url.toString());
      throw new OperationOutcomeError({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid', details: { text: 'Requested time slot is not available' } }] });
    });

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { appointmentId: appointment.id as string, newStart: '2026-09-02T09:00:00Z', newEnd: '2026-09-02T09:30:00Z' },
      contentType: 'application/json',
      secrets: {},
    });

    expect(result).toStrictEqual({ ok: false, reason: 'slot_taken' });
    const original = await medplum.readResource('Appointment', appointment.id as string);
    expect(original.status).toBe('booked'); // untouched
    expect(posted).not.toContain(medplum.fhirUrl('Appointment', appointment.id as string, '$cancel').toString());
  });
});
