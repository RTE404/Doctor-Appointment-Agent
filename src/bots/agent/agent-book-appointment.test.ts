// src/bots/agent/agent-book-appointment.test.ts
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type { Bundle as FhirBundle, SearchParameter } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { handler } from './agent-book-appointment';
import type { Appointment } from '@medplum/fhirtypes';

// The handler searches PractitionerRole.practitioner — not indexed by a
// bare MockClient. See patientContext.test.ts for the same fix and its
// rationale.
beforeAll(() => {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as FhirBundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as FhirBundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-medplum.json') as FhirBundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as FhirBundle<SearchParameter>);
  }
});

const PROPOSED_APPOINTMENT: Appointment = {
  resourceType: 'Appointment',
  status: 'proposed',
  start: '2026-09-01T09:00:00Z',
  end: '2026-09-01T09:30:00Z',
  serviceType: [{ extension: [{ url: 'https://medplum.com/fhir/service-type-reference', valueReference: { reference: 'HealthcareService/office-visit' } }] }],
  participant: [
    { actor: { reference: 'Practitioner/practitioner-1' }, status: 'accepted' },
  ],
  contained: [{ resourceType: 'Slot', status: 'busy', start: '2026-09-01T09:00:00Z', end: '2026-09-01T09:30:00Z', schedule: { reference: 'Schedule/schedule-1' } }],
};

const BASE_INPUT = {
  patientId: 'patient-1',
  practitionerId: 'practitioner-1',
  scheduleId: 'schedule-1',
  start: '2026-09-01T09:00:00Z',
  end: '2026-09-01T09:30:00Z',
  summaryCommunicationId: 'summary-1',
};

describe('agent-book-appointment handler', () => {
  test('re-reads trusted resources, re-runs $find, then books its exact proposal', async () => {
    const medplum = new MockClient();
    const patient = await medplum.updateResource({ resourceType: 'Patient', id: 'patient-1' });
    await medplum.updateResource({ resourceType: 'Practitioner', id: 'practitioner-1' });
    await medplum.createResource({
      resourceType: 'PractitionerRole',
      practitioner: { reference: 'Practitioner/practitioner-1' },
      specialty: [{ coding: [{ system: 'http://nucc.org/provider-taxonomy', code: '207RC0000X' }] }],
    });
    // Server-assigned ids (no explicit `id`) — proves the handler resolves
    // HealthcareService/Device dynamically rather than assuming the old
    // literal ids 'office-visit' / 'ai-appointment-agent'.
    const officeVisit = await medplum.createResource({ resourceType: 'HealthcareService', name: 'Office Visit', active: true });
    const agentDevice = await medplum.createResource({
      resourceType: 'Device',
      identifier: [{ system: 'http://example.com/agent-config', value: 'ai-appointment-agent' }],
    });
    await medplum.updateResource({
      resourceType: 'Schedule',
      id: 'schedule-1',
      active: true,
      actor: [{ reference: 'Practitioner/practitioner-1' }],
      serviceType: [{ extension: [{ url: 'https://medplum.com/fhir/service-type-reference', valueReference: { reference: `HealthcareService/${officeVisit.id}` } }] }],
    });
    const communication = await medplum.createResource({
      resourceType: 'Communication',
      status: 'preparation',
      category: [{ coding: [{ system: 'http://example.com/agent-communication-category', code: 'ai-previsit-summary' }] }],
      reasonCode: [{ text: 'Chest discomfort during exercise' }],
      note: [{ text: 'My chest hurts when I run' }],
      topic: { coding: [{ system: 'http://nucc.org/provider-taxonomy', code: '207RC0000X' }] },
      subject: { reference: `Patient/${patient.id}` },
      sender: { reference: `Device/${agentDevice.id}` },
      payload: [{ contentString: 'This patient reports exertional chest discomfort.' }],
      meta: { tag: [{ code: 'ai-generated' }] },
    });

    const bookedAppointment: Appointment = {
      ...PROPOSED_APPOINTMENT,
      id: 'appt-1',
      status: 'booked',
      contained: undefined,
      slot: [{ reference: 'Slot/slot-1' }],
      description: 'Chest discomfort during exercise',
      comment: 'My chest hurts when I run',
      reasonCode: [{ text: 'Chest discomfort during exercise' }],
    };
    // $book's real response is a BARE Bundle — no Parameters envelope.
    const bookResponseBundle = {
      resourceType: 'Bundle',
      type: 'transaction-response',
      entry: [{ resource: bookedAppointment }, { resource: { resourceType: 'Slot', id: 'slot-1', status: 'busy' } }],
    };
    let capturedRequest: any;
    const originalGet = medplum.get.bind(medplum);
    // medplum.get returns a ReadablePromise, not a plain Promise — an async
    // mock implementation is structurally incompatible with that return
    // type, so it's cast to `any` here (the same workaround this exact
    // pattern uses elsewhere in the Medplum monorepo's own test suite).
    const getSpy = vi.spyOn(medplum, 'get').mockImplementation((async (url: string | URL, options?: any) => {
      if (url.toString().includes('/fhir/R4/Appointment/$find')) {
        return { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: PROPOSED_APPOINTMENT }] } as any;
      }
      return originalGet(url as any, options);
    }) as any);
    vi.spyOn(medplum, 'post').mockImplementation(async (url: string | URL, body: any) => {
      if (url.toString() === medplum.fhirUrl('Appointment', '$book').toString()) {
        capturedRequest = body;
        return bookResponseBundle as any;
      }
      throw new Error(`unexpected post to ${url}`);
    });

    const result = await handler(medplum, {
      bot: { reference: 'Bot/123' },
      input: { ...BASE_INPUT, patientId: patient.id as string, summaryCommunicationId: communication.id as string },
      contentType: 'application/json',
      secrets: {},
    });

    expect(getSpy.mock.calls.some(([url]) => url.toString().includes('/fhir/R4/Appointment/$find'))).toBe(true);
    // The request is a Parameters resource wrapping the newly fetched
    // proposal, with the Patient participant added server-side.
    expect(capturedRequest.resourceType).toBe('Parameters');
    expect(capturedRequest.parameter[0].name).toBe('appointment');
    expect(capturedRequest.parameter[0].resource.contained).toBeDefined();
    expect(capturedRequest.parameter[0].resource.participant).toContainEqual({
      actor: { reference: `Patient/${patient.id}` },
      status: 'accepted',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');
    expect(result.appointment.status).toBe('booked');
    expect(result.appointment.description).toBe('Chest discomfort during exercise');
    expect(result.appointment.comment).toBe('My chest hurts when I run');

    const updatedCommunication = await medplum.readResource('Communication', communication.id as string);
    // The fields agent-book-appointment is responsible for changed...
    expect(updatedCommunication.status).toBe('completed');
    expect(updatedCommunication.recipient?.[0].reference).toBe('Practitioner/practitioner-1');
    // ...but everything else survived the update, unlike a bare-object
    // PATCH that would have wiped these.
    expect(updatedCommunication.payload?.[0].contentString).toBe('This patient reports exertional chest discomfort.');
    expect(updatedCommunication.sender).toStrictEqual({ reference: `Device/${agentDevice.id}` });
    expect(updatedCommunication.category?.[0].coding?.[0].code).toBe('ai-previsit-summary');
    expect(updatedCommunication.meta?.tag).toContainEqual({ code: 'ai-generated' });
  });

  test('logs only a fixed event when post-booking summary linkage fails', async () => {
    const medplum = new MockClient();
    await medplum.updateResource({ resourceType: 'Patient', id: 'patient-1' });
    await medplum.updateResource({ resourceType: 'Practitioner', id: 'practitioner-1' });
    await medplum.createResource({
      resourceType: 'PractitionerRole',
      practitioner: { reference: 'Practitioner/practitioner-1' },
      specialty: [{ coding: [{ system: 'http://nucc.org/provider-taxonomy', code: '207RC0000X' }] }],
    });
    const officeVisit = await medplum.createResource({ resourceType: 'HealthcareService', name: 'Office Visit', active: true });
    const agentDevice = await medplum.createResource({
      resourceType: 'Device',
      identifier: [{ system: 'http://example.com/agent-config', value: 'ai-appointment-agent' }],
    });
    await medplum.updateResource({
      resourceType: 'Schedule',
      id: 'schedule-1',
      active: true,
      actor: [{ reference: 'Practitioner/practitioner-1' }],
      serviceType: [
        {
          extension: [
            {
              url: 'https://medplum.com/fhir/service-type-reference',
              valueReference: { reference: `HealthcareService/${officeVisit.id}` },
            },
          ],
        },
      ],
    });
    const communication = await medplum.createResource({
      resourceType: 'Communication',
      status: 'preparation',
      category: [{ coding: [{ system: 'http://example.com/agent-communication-category', code: 'ai-previsit-summary' }] }],
      reasonCode: [{ text: 'Chest discomfort during exercise' }],
      note: [{ text: 'My chest hurts when I run' }],
      topic: { coding: [{ system: 'http://nucc.org/provider-taxonomy', code: '207RC0000X' }] },
      subject: { reference: 'Patient/patient-1' },
      sender: { reference: `Device/${agentDevice.id}` },
      meta: { tag: [{ code: 'ai-generated' }] },
    });
    const bookedAppointment: Appointment = {
      ...PROPOSED_APPOINTMENT,
      id: 'appt-1',
      status: 'booked',
      contained: undefined,
      slot: [{ reference: 'Slot/slot-1' }],
    };
    const originalGet = medplum.get.bind(medplum);
    vi.spyOn(medplum, 'get').mockImplementation((async (url: string | URL, options?: any) => {
      if (url.toString().includes('/fhir/R4/Appointment/$find')) {
        return { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: PROPOSED_APPOINTMENT }] } as any;
      }
      return originalGet(url as any, options);
    }) as any);
    vi.spyOn(medplum, 'post').mockResolvedValue({
      resourceType: 'Bundle',
      type: 'transaction-response',
      entry: [{ resource: bookedAppointment }],
    } as any);
    const upstreamFailure = {
      resourceType: 'OperationOutcome',
      issue: [{ diagnostics: 'patient-sensitive-summary-link-failure' }],
    };
    const originalUpdate = medplum.updateResource.bind(medplum);
    vi.spyOn(medplum, 'updateResource').mockImplementation(((resource: any) => {
      if (resource.resourceType === 'Communication' && resource.id === communication.id) {
        return Promise.reject(upstreamFailure);
      }
      return originalUpdate(resource);
    }) as any);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await handler(medplum, {
        bot: { reference: 'Bot/123' },
        input: { ...BASE_INPUT, summaryCommunicationId: communication.id as string },
        contentType: 'application/json',
        secrets: {},
      });

      expect(result.ok).toBe(true);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith('Booking succeeded but post-booking metadata update failed');
      expect(errorSpy).not.toHaveBeenCalledWith(expect.any(String), upstreamFailure);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('rejects a summary that belongs to another Patient before $find or $book', async () => {
    const medplum = new MockClient();
    await medplum.updateResource({ resourceType: 'Patient', id: 'patient-1' });
    await medplum.updateResource({ resourceType: 'Practitioner', id: 'practitioner-1' });
    await medplum.updateResource({
      resourceType: 'Schedule',
      id: 'schedule-1',
      active: true,
      actor: [{ reference: 'Practitioner/practitioner-1' }],
    });
    await medplum.updateResource({
      resourceType: 'Communication',
      id: 'summary-1',
      status: 'preparation',
      subject: { reference: 'Patient/another-patient' },
      sender: { reference: 'Device/ai-appointment-agent' },
    });
    const getSpy = vi.spyOn(medplum, 'get');
    const postSpy = vi.spyOn(medplum, 'post');

    await expect(
      handler(medplum, { bot: { reference: 'Bot/123' }, input: BASE_INPUT, contentType: 'application/json', secrets: {} })
    ).rejects.toThrow(/not an authoritative preparation summary/);
    expect(getSpy.mock.calls.some(([url]) => url.toString().includes('/fhir/R4/Appointment/$find'))).toBe(false);
    expect(postSpy).not.toHaveBeenCalled();
  });
});
