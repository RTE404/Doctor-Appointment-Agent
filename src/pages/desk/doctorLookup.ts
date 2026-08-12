// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

export function normalizeNpi(value: string): string {
  return value.trim().replaceAll(' ', '').replaceAll('-', '');
}

export function isValidNpi(value: string): boolean {
  return /^\d{1,10}$/.test(normalizeNpi(value));
}
