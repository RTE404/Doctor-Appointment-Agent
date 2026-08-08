// tools/seed/index.test.ts
import { describe, expect, test } from 'vitest';
import { parseCliArgs, shouldCheckpointManifest } from './index';

describe('parseCliArgs', () => {
  test('defaults: small limit, slim, not dry-run', () => {
    expect(parseCliArgs([])).toStrictEqual({ limit: 50, mode: 'slim', dryRun: false });
  });

  test('--limit overrides the default', () => {
    expect(parseCliArgs(['--limit', '200'])).toStrictEqual({ limit: 200, mode: 'slim', dryRun: false });
  });

  test('--full alone keeps the default limit — selection and transform mode are independent', () => {
    expect(parseCliArgs(['--full'])).toStrictEqual({ limit: 50, mode: 'full', dryRun: false });
  });

  test('--all clears the limit regardless of mode — the only way to select every file', () => {
    expect(parseCliArgs(['--all'])).toStrictEqual({ limit: undefined, mode: 'slim', dryRun: false });
    expect(parseCliArgs(['--slim', '--all'])).toStrictEqual({ limit: undefined, mode: 'slim', dryRun: false });
    expect(parseCliArgs(['--full', '--all'])).toStrictEqual({ limit: undefined, mode: 'full', dryRun: false });
  });

  test('--dry-run sets dryRun true', () => {
    expect(parseCliArgs(['--dry-run'])).toStrictEqual({ limit: 50, mode: 'slim', dryRun: true });
  });
});

describe('manifest checkpointing', () => {
  test('checkpoints every 10 completed uploads', () => {
    expect(shouldCheckpointManifest(9)).toBe(false);
    expect(shouldCheckpointManifest(10)).toBe(true);
    expect(shouldCheckpointManifest(20)).toBe(true);
  });
});
