const GEMINI_MODEL = 'gemini-3.5-flash-lite';

interface GeminiChatCompletionOptions {
  jsonResponse?: boolean;
}

export function buildGeminiChatCompletionBody(
  systemPrompt: string,
  userPrompt: string,
  options: GeminiChatCompletionOptions = {}
): Record<string, unknown> {
  return {
    model: GEMINI_MODEL,
    ...(options.jsonResponse ? { response_format: { type: 'json_object' } } : {}),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };
}
