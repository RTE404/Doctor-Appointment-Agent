// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'vitest';
import { isValidNpi, normalizeNpi } from './doctorLookup';

describe('doctor NPI entry', () => {
  test('normalizes spaces and hyphens from an NPI', () => {
    expect(normalizeNpi(' 12345-67890 ')).toBe('1234567890');
  });

  test('accepts exactly ten digits', () => {
    expect(isValidNpi('1234567890')).toBe(true);
    expect(isValidNpi('12345')).toBe(false);
    expect(isValidNpi('123456789A')).toBe(false);
  });
});
