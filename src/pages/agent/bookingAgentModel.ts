import type { BookingChatResult } from '../../bots/agent/agent-booking-chat.js';
import type { BookableOption } from '../../bots/agent/lib/bookableOptions.js';
import { MAX_BOOKABLE_OPTIONS } from '../../bots/agent/lib/proposeOptions.js';

export type BookingAgentPhase = 'showing-options' | 'confirming' | 'booking';

export interface BookingAgentState {
  phase: BookingAgentPhase;
  options: BookableOption[];
  selectedOption?: BookableOption;
  summaryCommunicationId?: string;
  slotTaken: boolean;
}

export interface BookingInProgressState extends BookingAgentState {
  phase: 'booking';
  selectedOption: BookableOption;
  summaryCommunicationId: string;
}

export function optionsReceived(result: { options: BookableOption[]; summaryCommunicationId: string }): BookingAgentState {
  return {
    phase: 'showing-options',
    options: result.options.slice(0, MAX_BOOKABLE_OPTIONS),
    selectedOption: undefined,
    summaryCommunicationId: result.summaryCommunicationId,
    slotTaken: false,
  };
}

export function optionSelected(state: BookingAgentState, option: BookableOption): BookingAgentState {
  return { ...state, phase: 'confirming', selectedOption: option, slotTaken: false };
}

export function bookingStarted(state: BookingAgentState): BookingInProgressState {
  if (state.phase !== 'confirming' || !state.selectedOption || !state.summaryCommunicationId) {
    throw new Error('Booking confirmation is not pending');
  }
  return {
    ...state,
    phase: 'booking',
    selectedOption: state.selectedOption,
    summaryCommunicationId: state.summaryCommunicationId,
  };
}

// Per the spec's "Session lifecycle" section, `kind: 'question'` and
// `kind: 'options'` both leave the session `status: 'in-progress'`
// (resumable) — a patient can keep chatting after seeing options to refine
// their preferences. Only `'error'` stops the session server-side, so
// storing the id in that case would hand the caller a dead sessionId with no
// way to recover it.
export function resolveNextSessionId(result: BookingChatResult): string | undefined {
  return result.kind === 'question' || result.kind === 'options' ? result.sessionId : undefined;
}

export function slotTaken(state: BookingAgentState): BookingAgentState {
  return {
    ...state,
    phase: 'showing-options',
    options: state.options.filter((option) => option.id !== state.selectedOption?.id),
    selectedOption: undefined,
    slotTaken: true,
  };
}
