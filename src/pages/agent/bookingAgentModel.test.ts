import { describe, expect, test } from 'vitest';
import type { BookableOption } from '../../bots/agent/lib/bookableOptions';
import { bookingStarted, optionSelected, optionsReceived, slotTaken } from './bookingAgentModel';

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
  test('stores at most eight grounded options and the authoritative summary id', () => {
    const nineOptions = Array.from({ length: 9 }, (_, i) => option(String(i + 1)));
    const received = optionsReceived({ options: nineOptions, summaryCommunicationId: 'summary-1' });

    expect(received.phase).toBe('showing-options');
    expect(received.options).toHaveLength(8);
    expect(received.summaryCommunicationId).toBe('summary-1');
  });

  test('selecting an option enters confirmation with that exact option', () => {
    const selected = option('two');
    const state = optionSelected(optionsReceived({ options: [option('one'), selected], summaryCommunicationId: 'summary-1' }), selected);

    expect(state.phase).toBe('confirming');
    expect(state.selectedOption).toBe(selected);
  });

  test('booking can only start from a complete confirmation state', () => {
    const showingOptions = optionsReceived({ options: [option('one')], summaryCommunicationId: 'summary-1' });
    expect(() => bookingStarted(showingOptions)).toThrow('Booking confirmation is not pending');

    const complete = optionSelected(showingOptions, option('one'));
    expect(bookingStarted(complete).phase).toBe('booking');
  });

  test('slot taken removes only the selected option and returns to the remaining results', () => {
    const selected = option('two');
    const confirming = optionSelected(
      optionsReceived({ options: [option('one'), selected, option('three')], summaryCommunicationId: 'summary-1' }),
      selected
    );

    const recovered = slotTaken(bookingStarted(confirming));

    expect(recovered.phase).toBe('showing-options');
    expect(recovered.options.map(({ id }) => id)).toEqual(['one', 'three']);
    expect(recovered.selectedOption).toBeUndefined();
    expect(recovered.slotTaken).toBe(true);
  });
});
