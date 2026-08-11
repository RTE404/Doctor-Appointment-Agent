import { describe, expect, test } from 'vitest';
import type { BookableOption } from '../../bots/agent/lib/bookableOptions';
import {
  bookingStarted,
  clarificationRequested,
  initialBookingAgentState,
  optionSelected,
  optionsReceived,
  searchStarted,
  slotTaken,
} from './bookingAgentModel';

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
    previousDoctor: id === 'one',
    distanceMiles: 2,
  };
}

describe('bookingAgentModel', () => {
  test('allows one clarification and turns a second ambiguous result into an error', () => {
    const first = clarificationRequested(searchStarted(initialBookingAgentState, 'pain'));
    expect(first).toMatchObject({ phase: 'clarifying', clarificationCount: 1 });

    const second = clarificationRequested(searchStarted(first, 'pain near my jaw'));
    expect(second).toMatchObject({ phase: 'error', clarificationCount: 2 });
  });

  test('stores at most three grounded options and the authoritative summary id', () => {
    const received = optionsReceived(searchStarted(initialBookingAgentState, 'morning doctor'), {
      options: [option('one'), option('two'), option('three'), option('four')],
      preferences: { timeOfDay: 'morning', preferPreviousDoctor: true, preferNearby: true },
      summaryCommunicationId: 'summary-1',
    });

    expect(received.phase).toBe('showing-options');
    expect(received.options.map(({ id }) => id)).toEqual(['one', 'two', 'three']);
    expect(received.summaryCommunicationId).toBe('summary-1');
  });

  test('selecting an option enters confirmation with that exact option', () => {
    const selected = option('two');
    const state = optionSelected(
      optionsReceived(initialBookingAgentState, {
        options: [option('one'), selected],
        preferences: { preferPreviousDoctor: false, preferNearby: false },
        summaryCommunicationId: 'summary-1',
      }),
      selected
    );

    expect(state.phase).toBe('confirming');
    expect(state.selectedOption).toBe(selected);
  });

  test('booking can only start from a complete confirmation state', () => {
    expect(() => bookingStarted(initialBookingAgentState)).toThrow('Booking confirmation is not pending');
    const incomplete = { ...initialBookingAgentState, phase: 'confirming' as const, selectedOption: option('one') };
    expect(() => bookingStarted(incomplete)).toThrow('Booking confirmation is not pending');

    const complete = optionSelected(
      optionsReceived(initialBookingAgentState, {
        options: [option('one')],
        preferences: { preferPreviousDoctor: false, preferNearby: false },
        summaryCommunicationId: 'summary-1',
      }),
      option('one')
    );
    expect(bookingStarted(complete).phase).toBe('booking');
  });

  test('slot taken removes only the selected option and returns to the remaining results', () => {
    const selected = option('two');
    const confirming = optionSelected(
      optionsReceived(initialBookingAgentState, {
        options: [option('one'), selected, option('three')],
        preferences: { preferPreviousDoctor: false, preferNearby: false },
        summaryCommunicationId: 'summary-1',
      }),
      selected
    );

    const recovered = slotTaken(bookingStarted(confirming));

    expect(recovered.phase).toBe('showing-options');
    expect(recovered.options.map(({ id }) => id)).toEqual(['one', 'three']);
    expect(recovered.selectedOption).toBeUndefined();
    expect(recovered.slotTaken).toBe(true);
  });
});
