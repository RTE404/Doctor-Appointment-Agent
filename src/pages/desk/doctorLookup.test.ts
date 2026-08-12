// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'vitest';
import { isValidNpi, normalizeNpi } from './doctorLookup';

describe('doctor NPI entry', () => {
  test('normalizes spaces and hyphens from an NPI', () => {
    expect(normalizeNpi(' 12345-67890 ')).toBe('1234567890');
  });

  test.each(['7', '12345', '1234567890', ' 12-345 '])('accepts supported provider identifier %j', (value) => {
    expect(isValidNpi(value)).toBe(true);
  });

  test.each(['', 'abc', '123456789A', '123.45', '123_45', '12345678901'])(
    'rejects unsupported provider identifier %j',
    (value) => {
      expect(isValidNpi(value)).toBe(false);
    }
  );
});
