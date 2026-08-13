import { describe, expect, test, vi } from 'vitest';
import type { BookableOption } from '../../bots/agent/lib/bookableOptions';
import { confirmSelectedOption } from './bookingAgentController';
import { optionSelected, optionsReceived } from './bookingAgentModel';

function option(id: string): BookableOption {
  return {
    id,
    npi: `npi-${id}`,
    practitionerId: `practitioner-${id}`,
    scheduleId: `schedule-${id}`,
    doctorName: `Dr. ${id}`,
    start: '2026-08-12T13:00:00.000Z',
    end: '2026-08-12T13:30:00.000Z',
    timeZone: 'America/New_York',
    previousDoctor: true,
    distanceMiles: 2,
  };
}

function confirmingState(): ReturnType<typeof optionSelected> {
  const selected = option('one');
  return optionSelected(optionsReceived({ options: [selected, option('two')], summaryCommunicationId: 'summary-1' }), selected);
}

describe('bookingAgentController', () => {
  test('selection alone never books; confirmation books once with the exact grounded payload and navigates', async () => {
    const state = confirmingState();
    const book = vi.fn(async () => ({
      ok: true as const,
      appointment: { resourceType: 'Appointment' as const, id: 'appointment-1', status: 'booked' as const, participant: [] },
    }));
    const navigate = vi.fn();
    const onBookingStarted = vi.fn();

    expect(book).not.toHaveBeenCalled();
    const result = await confirmSelectedOption(state, 'patient-1', { book, navigate, onBookingStarted });

    expect(onBookingStarted).toHaveBeenCalledWith(expect.objectContaining({ phase: 'booking' }));
    expect(book).toHaveBeenCalledTimes(1);
    expect(book).toHaveBeenCalledWith({
      patientId: 'patient-1',
      practitionerId: 'practitioner-one',
      scheduleId: 'schedule-one',
      start: '2026-08-12T13:00:00.000Z',
      end: '2026-08-12T13:30:00.000Z',
      summaryCommunicationId: 'summary-1',
    });
    expect(navigate).toHaveBeenCalledWith('/agent/patient-1/confirmed/appointment-1');
    expect(result.phase).toBe('booking');
  });

  test('slot taken removes the selected option and does not navigate', async () => {
    const navigate = vi.fn();
    const result = await confirmSelectedOption(confirmingState(), 'patient-1', {
      book: async () => ({ ok: false, reason: 'slot_taken' }),
      navigate,
    });

    expect(result.phase).toBe('showing-options');
    expect(result.options.map(({ id }) => id)).toEqual(['two']);
    expect(result.slotTaken).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });

  test('rejects booking before confirmation without calling the booking action', async () => {
    const book = vi.fn();
    const showingOptions = optionsReceived({ options: [option('one')], summaryCommunicationId: 'summary-1' });

    await expect(confirmSelectedOption(showingOptions, 'patient-1', { book, navigate: vi.fn() })).rejects.toThrow(
      'Booking confirmation is not pending'
    );
    expect(book).not.toHaveBeenCalled();
  });
});
