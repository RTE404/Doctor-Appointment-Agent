import type { FindBookableOptionsResult } from '../../bots/agent/agent-find-bookable-options.js';
import type { BookableOption } from '../../bots/agent/lib/bookableOptions.js';

export type BookingAgentPhase =
  | 'collecting'
  | 'searching'
  | 'clarifying'
  | 'showing-options'
  | 'confirming'
  | 'booking'
  | 'error';

export interface BookingAgentState {
  phase: BookingAgentPhase;
  complaintText: string;
  clarificationCount: number;
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

type SuccessfulOptionsResult = Exclude<FindBookableOptionsResult, { needsClarification: true }>;

export const initialBookingAgentState: BookingAgentState = {
  phase: 'collecting',
  complaintText: '',
  clarificationCount: 0,
  options: [],
  slotTaken: false,
};

export function searchStarted(state: BookingAgentState, complaintText: string): BookingAgentState {
  return {
    ...state,
    phase: 'searching',
    complaintText,
    selectedOption: undefined,
    slotTaken: false,
  };
}

export function clarificationRequested(state: BookingAgentState): BookingAgentState {
  const clarificationCount = state.clarificationCount + 1;
  return {
    ...state,
    phase: clarificationCount > 1 ? 'error' : 'clarifying',
    clarificationCount,
    options: [],
    selectedOption: undefined,
    summaryCommunicationId: undefined,
  };
}

export function optionsReceived(
  state: BookingAgentState,
  result: SuccessfulOptionsResult
): BookingAgentState {
  return {
    ...state,
    phase: 'showing-options',
    options: result.options.slice(0, 3),
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

export function slotTaken(state: BookingAgentState): BookingAgentState {
  return {
    ...state,
    phase: 'showing-options',
    options: state.options.filter((option) => option.id !== state.selectedOption?.id),
    selectedOption: undefined,
    slotTaken: true,
  };
}
