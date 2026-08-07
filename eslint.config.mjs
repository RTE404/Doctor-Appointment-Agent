// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { medplumEslintConfig } from '@medplum/eslint-config';
import { defineConfig } from 'eslint/config';

export default defineConfig(medplumEslintConfig, {
  files: ['src/**/*.{ts,tsx}'],
  rules: {
    'header/header': 'off',
    'import/no-duplicates': 'off',
    'jsdoc/escape-inline-tags': 'off',
    'jsdoc/require-param': 'off',
    'jsdoc/require-returns': 'off',
    'no-nested-ternary': 'off',
    curly: 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'off',
    '@typescript-eslint/no-unnecessary-type-arguments': 'off',
    '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    '@typescript-eslint/prefer-optional-chain': 'off',
  },
});
