import { describe, expect, test } from 'vitest';
import { prepareBookingMessage } from './bookingChatModel';

describe('booking chat message boundary', () => {
  test('trims a non-empty message', () => {
    expect(prepareBookingMessage('  I have a headache  ')).toBe('I have a headache');
  });

  test('rejects a whitespace-only message', () => {
    expect(prepareBookingMessage('   ')).toBeUndefined();
  });
});
