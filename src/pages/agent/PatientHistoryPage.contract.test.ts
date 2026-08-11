import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

async function patientHistorySource(): Promise<string> {
  return readFile(new URL('./PatientHistoryPage.tsx', import.meta.url), 'utf8');
}

describe('PatientHistoryPage concierge contract', () => {
  test('renders the approved response and confirmation copy without routing internals', async () => {
    const source = await patientHistorySource();

    expect(source).toContain('Here are the best available options:');
    expect(source).toContain('Option 1 best matches your preferences.');
    expect(source).toContain('Which option would you like to book?');
    expect(source).toContain('This appointment has not been booked yet. Do you confirm the booking?');
    expect(source).not.toContain('routed your request');
    expect(source).not.toContain('ranked the results');
    expect(source).not.toContain('Based on the configured scheduling rules');
  });

  test('wires selection and the two approved actions through the tested controller', async () => {
    const source = await patientHistorySource();

    expect(source.match(/'agent-find-bookable-options'/g)).toHaveLength(1);
    expect(source.match(/'agent-book-appointment'/g)).toHaveLength(1);
    expect(source).toContain('onSelect={() => setAgentState(optionSelected(agentState, option))}');
    expect(source).toContain('searchForBookableOptions(agentState');
    expect(source).toContain('confirmSelectedOption(agentState');
  });
});
