// src/bots/agent/lib/prompts.test.ts
import { describe, expect, test } from 'vitest';
import { CHAT_SYSTEM_PROMPT, INTAKE_SYSTEM_PROMPT, containsInterpretationLanguage } from './prompts';

describe('system prompts', () => {
  test('intake prompt instructs the model to never diagnose', () => {
    expect(INTAKE_SYSTEM_PROMPT.toLowerCase()).toContain('never diagnose');
  });

  test('chat prompt instructs relay-only behavior and a fixed refusal', () => {
    expect(CHAT_SYSTEM_PROMPT.toLowerCase()).toContain('never diagnose');
    expect(CHAT_SYSTEM_PROMPT.toLowerCase()).toContain('not recorded');
  });
});

describe('containsInterpretationLanguage', () => {
  test('flags common interpretation-flavored phrases', () => {
    expect(containsInterpretationLanguage('You should see a specialist soon.')).toBe(true);
    expect(containsInterpretationLanguage('I recommend increasing the dosage.')).toBe(true);
    expect(containsInterpretationLanguage('This likely has a viral cause.')).toBe(true);
  });

  test('does not flag a plain factual relay', () => {
    expect(containsInterpretationLanguage('The record shows a prescription for Albuterol, filled on 2026-01-05.')).toBe(false);
  });
});
