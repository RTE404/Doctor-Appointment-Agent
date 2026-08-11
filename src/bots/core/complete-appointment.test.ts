import { describe, expect, test, vi } from 'vitest';
import type { Appointment, Bundle, Encounter } from '@medplum/fhirtypes';
import { handler } from './complete-appointment';
import { DEMO_GENERATED_TAG } from '../../demo/demoTag';

const input = {
  appointmentId: 'appointment-1',
  encounterType: {
    system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
    code: 'VR',
    display: 'virtual',
  },
};

const event = {
  bot: { reference: 'Bot/123' as const },
  input,
  contentType: 'application/json',
  secrets: {},
};

function taggedAppointment(status: Appointment['status'] = 'booked'): Appointment {
  return {
    resourceType: 'Appointment',
    id: 'appointment-1',
    status,
    meta: { tag: [DEMO_GENERATED_TAG] },
    start: '2026-09-01T09:00:00Z',
    end: '2026-09-01T09:30:00Z',
    serviceType: [{ text: 'Office Visit' }],
    participant: [
      { actor: { reference: 'Patient/patient-1' }, status: 'accepted' },
      { actor: { reference: 'Practitioner/practitioner-1' }, status: 'accepted' },
    ],
  };
}

function createClient(
  initialAppointment: Appointment,
  initialEncounter?: Encounter
): {
  medplum: any;
  executeBatch: ReturnType<typeof vi.fn>;
  readResource: ReturnType<typeof vi.fn>;
} {
  let appointment = initialAppointment;
  let encounter = initialEncounter;
  const readResource = vi.fn(async (resourceType: string, id: string) => {
    if (resourceType === 'Appointment' && id === appointment.id) {
      return appointment;
    }
    if (resourceType === 'Encounter' && id === encounter?.id) {
      return encounter;
    }
    throw new Error(`not found: ${resourceType}/${id}`);
  });
  const executeBatch = vi.fn(async (bundle: Bundle) => {
    appointment = bundle.entry?.[0]?.resource as Appointment;
    encounter = bundle.entry?.[1]?.resource as Encounter;
    return { resourceType: 'Bundle', type: 'transaction-response' };
  });
  return { medplum: { readResource, executeBatch }, executeBatch, readResource };
}

describe('complete-appointment handler', () => {
  test('atomically fulfills a tagged booked appointment and creates a deterministic tagged encounter', async () => {
    const appointment = taggedAppointment();
    const { medplum, executeBatch } = createClient(appointment);

    const result = await handler(medplum, event);

    expect(executeBatch).toHaveBeenCalledWith({
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        {
          resource: { ...appointment, status: 'fulfilled' },
          request: { method: 'PUT', url: 'Appointment/appointment-1' },
        },
        {
          resource: expect.objectContaining({
            resourceType: 'Encounter',
            id: 'appointment-1',
            status: 'finished',
            subject: { reference: 'Patient/patient-1' },
            appointment: [{ reference: 'Appointment/appointment-1' }],
            type: [{ coding: [input.encounterType] }],
            length: { value: 30, unit: 'minutes' },
            meta: { tag: [DEMO_GENERATED_TAG] },
          }),
          request: { method: 'PUT', url: 'Encounter/appointment-1' },
        },
      ],
    });
    expect(result).toMatchObject({ resourceType: 'Encounter', id: 'appointment-1' });
  });

  test('returns the existing matching encounter when a successful completion is retried', async () => {
    const existingEncounter: Encounter = {
      resourceType: 'Encounter',
      id: 'appointment-1',
      status: 'finished',
      meta: { tag: [DEMO_GENERATED_TAG] },
      appointment: [{ reference: 'Appointment/appointment-1' }],
      class: { code: 'VR' },
    };
    const { medplum, executeBatch } = createClient(taggedAppointment('fulfilled'), existingEncounter);

    await expect(handler(medplum, event)).resolves.toEqual(existingEncounter);
    expect(executeBatch).not.toHaveBeenCalled();
  });

  test('leaves the appointment booked when the atomic transaction fails', async () => {
    const appointment = taggedAppointment();
    const { medplum, executeBatch } = createClient(appointment);
    executeBatch.mockRejectedValueOnce(new Error('transaction failed'));

    await expect(handler(medplum, event)).rejects.toThrow('transaction failed');
    expect(appointment.status).toBe('booked');
  });

  test('rejects an untagged appointment without mutating it', async () => {
    const appointment = { ...taggedAppointment(), meta: undefined };
    const { medplum, executeBatch } = createClient(appointment);

    await expect(handler(medplum, event)).rejects.toThrow('Only demo-generated appointments can be completed');
    expect(executeBatch).not.toHaveBeenCalled();
  });

  test('rejects invalid status, references, times, and encounter type before mutation', async () => {
    const invalidAppointments: Appointment[] = [
      taggedAppointment('cancelled'),
      {
        ...taggedAppointment(),
        participant: [{ actor: { reference: 'Practitioner/practitioner-1' }, status: 'accepted' }],
      },
      { ...taggedAppointment(), end: '2026-09-01T08:30:00Z' },
    ];

    for (const appointment of invalidAppointments) {
      const { medplum, executeBatch } = createClient(appointment);
      await expect(handler(medplum, event)).rejects.toThrow();
      expect(executeBatch).not.toHaveBeenCalled();
    }

    const { medplum, executeBatch } = createClient(taggedAppointment());
    await expect(
      handler(medplum, { ...event, input: { ...input, encounterType: { display: 'missing code' } } })
    ).rejects.toThrow();
    expect(executeBatch).not.toHaveBeenCalled();
  });
});
