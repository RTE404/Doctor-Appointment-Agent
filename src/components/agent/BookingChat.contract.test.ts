import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

async function bookingChatSource(): Promise<string> {
  return readFile(new URL('./BookingChat.tsx', import.meta.url), 'utf8');
}

describe('BookingChat input-availability contract', () => {
  test('never hides the message input once options are shown, so the patient can keep refining', async () => {
    const source = await bookingChatSource();

    // Regression guard: the input used to be wrapped in `{!optionsShown && (...)}`,
    // which removed the patient's only way to respond once options arrived.
    expect(source).not.toMatch(/\{!optionsShown\s*&&/);
    expect(source).toContain('<Textarea');
    expect(source).toContain('<Button');
  });

  test('hints that the patient can ask for something different once options are shown', async () => {
    const source = await bookingChatSource();

    expect(source).toContain('optionsShown');
    expect(source.toLowerCase()).toContain('something different');
  });
});
