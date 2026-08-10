import { describe, expect, test } from 'vitest';
import { buildGeminiChatCompletionBody } from './geminiRequest';

describe('buildGeminiChatCompletionBody', () => {
  test('uses Gemini 3.1 Flash-Lite without sampling parameters', () => {
    const body = buildGeminiChatCompletionBody('system prompt', 'user prompt');

    expect(body).toStrictEqual({
      model: 'gemini-3.1-flash-lite',
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user prompt' },
      ],
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k');
  });

  test('adds JSON-object formatting only when requested', () => {
    const body = buildGeminiChatCompletionBody('system prompt', 'user prompt', { jsonResponse: true });

    expect(body).toStrictEqual({
      model: 'gemini-3.1-flash-lite',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user prompt' },
      ],
    });
  });
});
