import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

async function patientHistorySource(): Promise<string> {
  return readFile(new URL('./PatientHistoryPage.tsx', import.meta.url), 'utf8');
}

describe('PatientHistoryPage concierge contract', () => {
  test('renders the approved response and confirmation copy without routing internals', async () => {
    const source = await patientHistorySource();

    expect(source).toContain('This appointment has not been booked yet. Do you confirm the booking?');
    expect(source).not.toContain('routed your request');
    expect(source).not.toContain('ranked the results');
    expect(source).not.toContain('Based on the configured scheduling rules');
  });

  test('wires the chat and the two approved actions through the tested controller', async () => {
    const source = await patientHistorySource();

    expect(source.match(/'agent-booking-chat'/g)).toHaveLength(1);
    expect(source.match(/'agent-book-appointment'/g)).toHaveLength(1);
    expect(source).toContain('confirmSelectedOption(agentState');
  });
});
