import { describe, expect, test } from 'vitest';
import { buildRescheduleInput } from './dateTimeActionInputs';

describe('date-time action inputs', () => {
  test('builds the serverless reschedule payload from controlled form values', () => {
    expect(buildRescheduleInput('appointment-1', '2026-08-13T12:00', '2026-08-13T12:30')).toStrictEqual({
      appointmentId: 'appointment-1',
      newStart: '2026-08-13T12:00',
      newEnd: '2026-08-13T12:30',
    });
  });
});
