// src/bots/agent/lib/nppes.test.ts
import { afterEach, describe, expect, test, vi } from 'vitest';
import { searchNppesDoctors, getNppesDoctorByNpi } from './nppes';

const SAMPLE_RESULT = {
  number: '1234567890',
  basic: { first_name: 'Jane', last_name: 'Doe' },
  taxonomies: [{ code: '207RC0000X', desc: 'Cardiovascular Disease', primary: true }],
  addresses: [{ address_purpose: 'LOCATION', address_1: '123 Main St', city: 'Boston', state: 'MA', postal_code: '021081234', telephone_number: '555-1212' }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchNppesDoctors', () => {
  test('maps NPPES results to DoctorCandidate', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [SAMPLE_RESULT] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchNppesDoctors('Cardiovascular Disease', 'Boston', 'MA', '207RC0000X');

    expect(result).toStrictEqual([
      {
        npi: '1234567890',
        firstName: 'Jane',
        lastName: 'Doe',
        nuccCode: '207RC0000X',
        nuccDisplay: 'Cardiovascular Disease',
        address: { line: ['123 Main St'], city: 'Boston', state: 'MA', postalCode: '021081234' },
        phone: '555-1212',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('taxonomy_description=Cardiovascular+Disease'));
  });

  test('propagates a network failure to the caller', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(searchNppesDoctors('Cardiology', 'Boston', 'MA', '207RC0000X')).rejects.toThrow('network down');
  });

  test('normalizes a full state name to its 2-letter code — every seeded patient stores the full name, and NPPES requires the code', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [SAMPLE_RESULT] }) });
    vi.stubGlobal('fetch', fetchMock);

    await searchNppesDoctors('Cardiovascular Disease', 'Boston', 'Massachusetts', '207RC0000X');

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('state=MA'));
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('Massachusetts'));
  });

  test('falls back to a state-only search when an exact city+state search returns zero results', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [SAMPLE_RESULT] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchNppesDoctors('Cardiovascular Disease', 'Nowheresville', 'MA', '207RC0000X');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('city=Nowheresville');
    expect(fetchMock.mock.calls[1][0]).not.toContain('city=');
    expect(result).toHaveLength(1);
  });

  test('rejects taxonomy-description false positives and retries state-wide using the exact NUCC code', async () => {
    const dentistResult = {
      number: '1427128701',
      basic: { first_name: 'Peter', last_name: 'Macgillivray' },
      taxonomies: [{ code: '1223G0001X', desc: 'Dentist, General Practice', primary: true }],
      addresses: [{ address_purpose: 'LOCATION', city: 'Sutton', state: 'MA' }],
    };
    const physicianResult = {
      number: '1111111111',
      basic: { first_name: 'Grace', last_name: 'Physician' },
      taxonomies: [
        { code: '207Q00000X', desc: 'Family Medicine', primary: true },
        { code: '208D00000X', desc: 'General Practice Physician', primary: false },
      ],
      addresses: [{ address_purpose: 'LOCATION', city: 'Worcester', state: 'MA' }],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [dentistResult] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [physicianResult] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchNppesDoctors(
      'General Practice',
      'Sutton',
      'MA',
      '208D00000X'
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('city=Sutton');
    expect(fetchMock.mock.calls[0][0]).toContain('limit=200');
    expect(fetchMock.mock.calls[1][0]).not.toContain('city=');
    expect(fetchMock.mock.calls[1][0]).toContain('limit=200');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      npi: '1111111111',
      nuccCode: '208D00000X',
      nuccDisplay: 'General Practice Physician',
    });
  });

  // Confirmed live against the real NPPES API: a state+city search can match
  // a provider via `practiceLocations`, not `addresses`, while their
  // addresses[LOCATION] entry is in a completely different state (e.g. one
  // real MA/Boston search result had addresses[LOCATION] in Cleveland, OH,
  // matched only because practiceLocations had a Boston, MA entry). Picking
  // addresses[LOCATION] unconditionally would silently attach the wrong
  // address (and therefore the wrong ranking distance) to a real result.
  test('prefers a practiceLocations entry over addresses[LOCATION] when only practiceLocations matches the searched state', async () => {
    const mismatchedLocationResult = {
      number: '1346730603',
      basic: { first_name: 'Mohammad', last_name: 'Abbasi' },
      taxonomies: [{ code: '207RC0000X', desc: 'Cardiovascular Disease', primary: false }],
      addresses: [
        { address_purpose: 'LOCATION', address_1: '9500 Euclid Ave', city: 'Cleveland', state: 'OH', postal_code: '441950002' },
      ],
      practiceLocations: [
        { address_1: '55 Fruit St', city: 'Boston', state: 'MA', postal_code: '021142696', telephone_number: '617-726-2000' },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [mismatchedLocationResult] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchNppesDoctors('Cardiovascular Disease', 'Boston', 'MA', '207RC0000X');

    expect(result[0].address).toStrictEqual({ line: ['55 Fruit St'], city: 'Boston', state: 'MA', postalCode: '021142696' });
    expect(result[0].phone).toBe('617-726-2000');
  });

  // A real MA search result (Stephen Abraham) has addresses[LOCATION]
  // already in the searched state (Boston, MA) AND a practiceLocations
  // entry in the same state but a different city (Woburn, MA). The already-
  // correct addresses[LOCATION] entry must not be swapped out just because
  // a practiceLocations entry also happens to match the state.
  test('keeps addresses[LOCATION] when it already matches the searched state, even if practiceLocations also matches', async () => {
    const bothMatchResult = {
      number: '1487743316',
      basic: { first_name: 'Stephen', last_name: 'Abraham' },
      taxonomies: [{ code: '207RC0000X', desc: 'Cardiovascular Disease', primary: true }],
      addresses: [
        { address_purpose: 'LOCATION', address_1: '1 Boston Address', city: 'Boston', state: 'MA', postal_code: '021081234' },
      ],
      practiceLocations: [{ address_1: '1 Woburn Address', city: 'Woburn', state: 'MA', postal_code: '018011234' }],
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [bothMatchResult] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchNppesDoctors('Cardiovascular Disease', 'Boston', 'MA', '207RC0000X');

    expect(result[0].address.city).toBe('Boston');
  });
});

describe('getNppesDoctorByNpi', () => {
  test('returns undefined, not an error, when NPPES has no record', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) }));
    expect(await getNppesDoctorByNpi('0000000000')).toBeUndefined();
  });
});
