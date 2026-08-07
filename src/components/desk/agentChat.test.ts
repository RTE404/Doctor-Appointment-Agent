// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'vitest';
import { prepareQuestion } from './chatModel';

describe('doctor chat question boundary', () => {
  test('trims a non-empty question', () => {
    expect(prepareQuestion('  What medications are they on?  ')).toBe('What medications are they on?');
  });

  test('rejects a whitespace-only question', () => {
    expect(prepareQuestion('   ')).toBeUndefined();
  });
});
