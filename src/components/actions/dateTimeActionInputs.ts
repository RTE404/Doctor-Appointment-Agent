import type { RescheduleInput } from '../../bots/core/reschedule-appointment';

export function buildRescheduleInput(
  appointmentId: string,
  newStart: string,
  newEnd: string
): RescheduleInput {
  return { appointmentId, newStart, newEnd };
}
