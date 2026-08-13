import type { BookInput, BookResult } from '../../bots/agent/agent-book-appointment.js';
import { bookingStarted, slotTaken } from './bookingAgentModel.js';
import type { BookingAgentState, BookingInProgressState } from './bookingAgentModel.js';

interface BookingDependencies {
  book: (input: BookInput) => Promise<BookResult>;
  navigate: (path: string) => void | Promise<void>;
  onBookingStarted?: (state: BookingInProgressState) => void;
}

export async function confirmSelectedOption(
  state: BookingAgentState,
  patientId: string,
  dependencies: BookingDependencies
): Promise<BookingAgentState> {
  const bookingState = bookingStarted(state);
  dependencies.onBookingStarted?.(bookingState);
  const selectedOption = bookingState.selectedOption;
  const result = await dependencies.book({
    patientId,
    practitionerId: selectedOption.practitionerId,
    scheduleId: selectedOption.scheduleId,
    start: selectedOption.start,
    end: selectedOption.end,
    summaryCommunicationId: bookingState.summaryCommunicationId,
  });

  if (!result.ok) {
    return slotTaken(bookingState);
  }
  if (!result.appointment.id) {
    throw new Error('The booking response did not include an appointment id.');
  }
  await dependencies.navigate(`/agent/${patientId}/confirmed/${result.appointment.id}`);
  return bookingState;
}
