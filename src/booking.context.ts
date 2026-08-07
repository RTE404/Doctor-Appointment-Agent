// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { createContext } from 'react';

export interface BookingIntent {
  specialtyCode: string;
  specialtyLabel: string;
  reason: string;
  complaintText: string;
}

export interface ChosenCandidate {
  npi: string;
  firstName: string;
  lastName: string;
  source: 'previous' | 'nppes';
}

export interface BookingState {
  intent?: BookingIntent;
  summaryCommunicationId?: string;
  chosenCandidate?: ChosenCandidate;
}

export const BookingContext = createContext<{
  booking: BookingState;
  setBooking: (state: BookingState) => void;
}>({
  booking: {},
  setBooking: () => {},
});
