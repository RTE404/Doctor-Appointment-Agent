import { describe, expect, test } from 'vitest';
import type { BookingChatMessage } from './bookingSession';
import { MAX_BOOKABLE_OPTIONS, collectGroundedOptions, resolveProposedOptions } from './proposeOptions';
import type { BookableOption } from './bookableOptions';

function option(npi: string, start: string): BookableOption {
  return {
    id: `${npi}|${start}`,
    npi,
    practitionerId: `practitioner-${npi}`,
    scheduleId: `schedule-${npi}`,
    doctorName: `Dr. ${npi}`,
    start,
    end: new Date(Date.parse(start) + 30 * 60 * 1000).toISOString(),
    timeZone: 'America/New_York',
    previousDoctor: false,
  };
}

function toolResultMessage(tool: string, result: unknown): BookingChatMessage {
  return { role: 'tool', tool_call_id: 'call-1', content: JSON.stringify({ tool, result }) };
}

describe('collectGroundedOptions', () => {
  test('collects only check_availability results, ignoring other tool results', () => {
    const transcript: BookingChatMessage[] = [
      toolResultMessage('search_nppes', [{ npi: '1', firstName: 'A' }]),
      toolResultMessage('check_availability', [option('1', '2026-08-14T13:00:00.000Z')]),
      toolResultMessage('check_availability', [option('2', '2026-08-14T14:00:00.000Z')]),
    ];

    const pool = collectGroundedOptions(transcript);

    expect(pool.map((o) => o.npi)).toStrictEqual(['1', '2']);
  });
});

describe('resolveProposedOptions', () => {
  const grounded = [option('1', '2026-08-14T13:00:00.000Z'), option('2', '2026-08-14T14:00:00.000Z')];
  const transcript: BookingChatMessage[] = [toolResultMessage('check_availability', grounded)];

  test('rejects an unrecognized specialty', () => {
    const result = resolveProposedOptions(transcript, {
      specialty: 'quantum flux specialist',
      reason: 'r',
      summary: 's',
      picks: [{ npi: '1', start: grounded[0].start, end: grounded[0].end, reasoning: 'why' }],
    });

    expect(result).toStrictEqual({ ok: false, errorForModel: expect.stringContaining('not a supported specialty') });
  });

  test('drops ungrounded picks and fails if nothing groundable remains', () => {
    const result = resolveProposedOptions(transcript, {
      specialty: 'General Practice',
      reason: 'r',
      summary: 's',
      picks: [{ npi: 'not-real', start: '2026-08-14T13:00:00.000Z', end: '2026-08-14T13:30:00.000Z', reasoning: 'why' }],
    });

    expect(result).toStrictEqual({ ok: false, errorForModel: expect.stringContaining('not grounded') });
  });

  test('accepts the model picks in the model order when they satisfy the distinct-provider cap', () => {
    const result = resolveProposedOptions(transcript, {
      specialty: 'General Practice',
      reason: 'r',
      summary: 's',
      picks: [
        { npi: '2', start: grounded[1].start, end: grounded[1].end, reasoning: 'earlier for this doctor' },
        { npi: '1', start: grounded[0].start, end: grounded[0].end, reasoning: 'previously seen' },
      ],
    });

    if (!result.ok) throw new Error('expected ok');
    expect(result.specialtyCode).toBe('208D00000X');
    expect(result.options.map((o) => o.npi)).toStrictEqual(['2', '1']);
  });

  test('falls back to rankBookableOptions when picks exceed the distinct-provider cap', () => {
    const manyGrounded = Array.from({ length: 10 }, (_, i) => option(String(i + 1), `2026-08-14T${13 + i}:00:00.000Z`));
    const bigTranscript: BookingChatMessage[] = [toolResultMessage('check_availability', manyGrounded)];
    const duplicatePicks = manyGrounded.map((o) => ({ npi: o.npi, start: o.start, end: o.end, reasoning: 'dup' }));

    const result = resolveProposedOptions(bigTranscript, {
      specialty: 'General Practice',
      reason: 'r',
      summary: 's',
      picks: duplicatePicks,
    });

    if (!result.ok) throw new Error('expected ok');
    expect(result.options.length).toBe(MAX_BOOKABLE_OPTIONS);
    expect(new Set(result.options.map((o) => o.npi)).size).toBe(result.options.length);
  });

  test('falls back to rankBookableOptions when the model under-proposes relative to the grounded pool', () => {
    // Deduplication drops nothing here — the model simply proposed 2 providers
    // when 10 distinct grounded providers were available. The design's
    // deterministic floor must still fill the option list up to the cap.
    const manyGrounded = Array.from({ length: 10 }, (_, i) => option(String(i + 1), `2026-08-14T${13 + i}:00:00.000Z`));
    const bigTranscript: BookingChatMessage[] = [toolResultMessage('check_availability', manyGrounded)];

    const result = resolveProposedOptions(bigTranscript, {
      specialty: 'General Practice',
      reason: 'r',
      summary: 's',
      picks: manyGrounded.slice(0, 2).map((o) => ({ npi: o.npi, start: o.start, end: o.end, reasoning: 'pick' })),
    });

    if (!result.ok) throw new Error('expected ok');
    expect(result.options.length).toBe(MAX_BOOKABLE_OPTIONS);
    expect(new Set(result.options.map((o) => o.npi)).size).toBe(result.options.length);
  });

  test('keeps the model ordering when the grounded pool cannot fill the cap', () => {
    // Only 2 distinct providers exist, so proposing 2 is not under-proposing —
    // the model's ordering and reasoning must survive.
    const result = resolveProposedOptions(transcript, {
      specialty: 'General Practice',
      reason: 'r',
      summary: 's',
      picks: [
        { npi: '2', start: grounded[1].start, end: grounded[1].end, reasoning: 'b' },
        { npi: '1', start: grounded[0].start, end: grounded[0].end, reasoning: 'a' },
      ],
    });

    if (!result.ok) throw new Error('expected ok');
    expect(result.options.map((o) => o.npi)).toStrictEqual(['2', '1']);
  });
});
