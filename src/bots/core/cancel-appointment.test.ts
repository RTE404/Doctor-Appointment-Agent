import { describe, expect, test, vi } from 'vitest';
import type { Appointment } from '@medplum/fhirtypes';
import { handler } from './cancel-appointment';
import { DEMO_GENERATED_TAG } from '../../demo/demoTag';

const event = {
  bot: { reference: 'Bot/123' as const },
  input: { appointmentId: 'appointment-1' },
  contentType: 'application/json',
  secrets: {},
};

function createClient(appointment: Appointment): {
  medplum: any;
  post: ReturnType<typeof vi.fn>;
} {
  const post = vi.fn().mockResolvedValue({ ...appointment, status: 'cancelled' });
  return {
    medplum: {
      readResource: vi.fn().mockResolvedValue(appointment),
      fhirUrl: (...parts: string[]) => new URL(`https://api.example.test/fhir/R4/${parts.join('/')}`),
      post,
    },
    post,
  };
}

describe('cancel-appointment handler', () => {
  test('cancels a tagged booked appointment through Medplum native $cancel', async () => {
    const { medplum, post } = createClient({
      resourceType: 'Appointment',
      id: 'appointment-1',
      status: 'booked',
      meta: { tag: [DEMO_GENERATED_TAG] },
      participant: [],
    });

    await expect(handler(medplum, event)).resolves.toEqual({ ok: true });
    expect(post).toHaveBeenCalledWith(
      new URL('https://api.example.test/fhir/R4/Appointment/appointment-1/$cancel'),
      {}
    );
  });

  test('rejects an untagged appointment without mutating it', async () => {
    const { medplum, post } = createClient({
      resourceType: 'Appointment',
      id: 'appointment-1',
      status: 'booked',
      participant: [],
    });

    await expect(handler(medplum, event)).rejects.toThrow('Only demo-generated appointments can be cancelled');
    expect(post).not.toHaveBeenCalled();
  });

  test('rejects a tagged appointment whose status cannot be cancelled', async () => {
    const { medplum, post } = createClient({
      resourceType: 'Appointment',
      id: 'appointment-1',
      status: 'fulfilled',
      meta: { tag: [DEMO_GENERATED_TAG] },
      participant: [],
    });

    await expect(handler(medplum, event)).rejects.toThrow('Only pending or booked appointments can be cancelled');
    expect(post).not.toHaveBeenCalled();
  });
});
