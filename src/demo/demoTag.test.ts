import { describe, expect, test } from 'vitest';
import { DEMO_GENERATED_TAG, isDemoGenerated, withDemoGeneratedTag } from './demoTag';

describe('withDemoGeneratedTag', () => {
  test('adds the stable reset tag while preserving existing metadata and tags', () => {
    const meta = withDemoGeneratedTag({
      source: 'seed-source',
      tag: [{ code: 'ai-generated' }],
    });

    expect(meta.source).toBe('seed-source');
    expect(meta.tag).toStrictEqual([{ code: 'ai-generated' }, DEMO_GENERATED_TAG]);
  });

  test('does not duplicate an existing reset tag', () => {
    expect(withDemoGeneratedTag({ tag: [DEMO_GENERATED_TAG] }).tag).toStrictEqual([DEMO_GENERATED_TAG]);
  });

  test('recognizes only the exact reset tag', () => {
    expect(isDemoGenerated({ tag: [DEMO_GENERATED_TAG] })).toBe(true);
    expect(isDemoGenerated({ tag: [{ code: 'demo-generated' }] })).toBe(false);
    expect(isDemoGenerated(undefined)).toBe(false);
  });
});
