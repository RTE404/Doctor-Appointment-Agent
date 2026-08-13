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

  test('keeps the rendered option list in sync with slotTaken filtering instead of the stale chat turn', async () => {
    const source = await patientHistorySource();

    // BookingChat must be fed the resynced turn list, not the raw `turns` state directly,
    // so a slotTaken filter of agentState.options is reflected in what the patient sees.
    expect(source).toContain('turns={displayTurns}');
    expect(source).not.toContain('turns={turns}');
    // The last agent-options turn is rebuilt from the authoritative, filtered agentState.options.
    expect(source).toContain('options: agentState.options');
    // An empty remaining-options list must give the patient a way to continue rather than a dead end.
    expect(source).toContain('agentState.options.length === 0');
  });
});
