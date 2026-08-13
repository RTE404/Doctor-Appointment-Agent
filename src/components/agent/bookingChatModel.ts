// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BookableOption } from '../../bots/agent/lib/bookableOptions';

export type BookingChatTurn =
  | { kind: 'patient'; text: string }
  | { kind: 'agent-question'; text: string }
  | { kind: 'agent-options'; options: BookableOption[] };

export function prepareBookingMessage(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}
