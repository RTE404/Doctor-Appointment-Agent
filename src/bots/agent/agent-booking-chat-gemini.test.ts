import { afterEach, describe, expect, test, vi } from 'vitest';
import { callGeminiBookingModel } from './agent-booking-chat';

describe('callGeminiBookingModel', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('retries a transient 429 response and returns the next successful completion', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Synthetic response' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = expect(
      callGeminiBookingModel([{ role: 'user', content: 'Synthetic request' }], 'test-key')
    ).resolves.toMatchObject({ message: { role: 'assistant', content: 'Synthetic response' } });

    await vi.advanceTimersByTimeAsync(1_000);
    await resultPromise;
  });

  test('uses a minute-scale final backoff before returning a fifth-attempt completion', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Recovered response' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = expect(
      callGeminiBookingModel([{ role: 'user', content: 'Synthetic request' }], 'test-key')
    ).resolves.toMatchObject({ message: { role: 'assistant', content: 'Recovered response' } });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(66_000);
    await resultPromise;
  });

  test('stops after four 429 retries instead of retrying indefinitely', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = expect(
      callGeminiBookingModel([{ role: 'user', content: 'Synthetic request' }], 'test-key')
    ).rejects.toThrow('Gemini request failed: 429');

    await vi.advanceTimersByTimeAsync(81_000);
    await resultPromise;
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  test('retries a transient 503 response and returns the next successful completion', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'After overload' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = expect(
      callGeminiBookingModel([{ role: 'user', content: 'Synthetic request' }], 'test-key')
    ).resolves.toMatchObject({ message: { role: 'assistant', content: 'After overload' } });

    await vi.advanceTimersByTimeAsync(1_000);
    await resultPromise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test.each([500, 502, 504])('treats HTTP %i as transient', async (status) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status }));
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = expect(
      callGeminiBookingModel([{ role: 'user', content: 'Synthetic request' }], 'test-key')
    ).rejects.toThrow(`Gemini request failed: ${status}`);

    await vi.advanceTimersByTimeAsync(81_000);
    await resultPromise;
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  test('fails immediately on a non-retryable 400', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      callGeminiBookingModel([{ role: 'user', content: 'Synthetic request' }], 'test-key')
    ).rejects.toThrow('Gemini request failed: 400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('returns Gemini usage and the retry count', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = expect(
      callGeminiBookingModel([{ role: 'user', content: 'Synthetic request' }], 'test-key')
    ).resolves.toEqual({
      message: { role: 'assistant', content: 'ok' },
      usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 },
      retries: 1,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await resultPromise;
  });
});
