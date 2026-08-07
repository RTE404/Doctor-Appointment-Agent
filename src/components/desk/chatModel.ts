// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

export interface ChatTurn {
  question: string;
  answer: string;
}

export function prepareQuestion(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}
