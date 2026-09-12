import { describe, expect, it } from 'vitest';

import { loadScenarioCatalog } from './loadScenarios';
import { executeDeterministicScenario } from './deterministicExecutor';

const catalog = loadScenarioCatalog('data/evals/booking-scenarios.json');

function byId(id: string) {
  const found = catalog.scenarios.find((scenario) => scenario.id === id);
  if (!found) throw new Error(`Missing test scenario ${id}`);
  return structuredClone(found);
}

describe('executeDeterministicScenario', () => {
  it('drives the production booking loop and records tool-derived options', async () => {
    const result = await executeDeterministicScenario(byId('routing-cardiology-explicit'));

    expect(result.terminalKind).toBe('options');
    expect(result.specialtyCode).toBe('207RC0000X');
    expect(result.toolNames).toEqual(['search_nppes', 'check_availability', 'propose_options']);
    expect(result.displayedOptions.map((option) => option.providerAlias)).toEqual(['provider-a']);
    expect(result.loopSteps).toBe(3);
  });

  it('uses production ranking precedence rather than the fixture declaration order', async () => {
    const result = await executeDeterministicScenario(byId('preference-history-citycenter'));

    expect(result.displayedOptions[0].providerAlias).toBe('provider-b');
  });

  it('uses production proposal grounding to reject a fabricated provider', async () => {
    const result = await executeDeterministicScenario(byId('grounding-cardiology-fabricated'));

    expect(result.terminalKind).toBe('error');
    expect(result.displayedOptions).toEqual([]);
    expect(result.sanitizedErrorCategory).toBe('ungrounded-options');
  });

  it('keeps selection mutation-free until confirmation', async () => {
    const result = await executeDeterministicScenario(byId('confirmation-first-select'));

    expect(result.terminalKind).toBe('options');
    expect(result.confirmationRequested).toBe(true);
    expect(result.bookingMutationCount).toBe(0);
    expect(result.bookingMutationCountBeforeConfirmation).toBe(0);
  });

  it('runs confirmation through the controller and safely rejects a stale slot', async () => {
    const result = await executeDeterministicScenario(byId('confirmation-first-slottaken'));

    expect(result.terminalKind).toBe('slot-taken');
    expect(result.confirmationRequested).toBe(true);
    expect(result.bookingMutationCount).toBe(1);
    expect(result.bookingMutationCountBeforeConfirmation).toBe(0);
    expect(result.slotConflictRejected).toBe(true);
    expect(result.duplicateAppointmentCount).toBe(0);
    expect(result.displayedOptions.map((option) => option.providerAlias)).toEqual(['provider-a']);
  });

  it('does not copy a mutated expected result into the observation', async () => {
    const input = byId('routing-cardiology-explicit');
    input.expected.terminalKind = 'error';

    const result = await executeDeterministicScenario(input);

    expect(result.terminalKind).toBe('options');
  });
});
