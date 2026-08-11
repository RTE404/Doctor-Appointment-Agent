import { describe, expect, test, vi } from 'vitest';
import { clearDemoSession, establishDemoSession, getStoredDemoAccessToken } from './demoSession';

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe('demo browser session', () => {
  test('exchanges the code, verifies the profile, and stores the token for this tab', async () => {
    const sessionStorage = storage();
    const medplum = {
      setAccessToken: vi.fn(),
      getProfileAsync: vi.fn(async () => ({ resourceType: 'ClientApplication', id: 'demo-client' })),
      clearActiveLogin: vi.fn(),
    };
    const fetchSession = vi.fn(async () => new Response(JSON.stringify({ accessToken: 'short-lived-token' }), { status: 200 }));

    await establishDemoSession('shared-code', medplum, fetchSession, sessionStorage);

    expect(fetchSession).toHaveBeenCalledWith('/api/demo-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'shared-code' }),
    });
    expect(medplum.setAccessToken).toHaveBeenCalledWith('short-lived-token');
    expect(medplum.getProfileAsync).toHaveBeenCalledOnce();
    expect(getStoredDemoAccessToken(sessionStorage)).toBe('short-lived-token');
  });

  test('reports an invalid code without storing a token', async () => {
    const sessionStorage = storage();
    const medplum = {
      setAccessToken: vi.fn(),
      getProfileAsync: vi.fn(),
      clearActiveLogin: vi.fn(),
    };
    const fetchSession = async (): Promise<Response> =>
      new Response(JSON.stringify({ error: 'Invalid demo code' }), { status: 401 });

    await expect(establishDemoSession('wrong', medplum, fetchSession, sessionStorage)).rejects.toThrow('That demo code is not correct.');
    expect(medplum.setAccessToken).not.toHaveBeenCalled();
    expect(getStoredDemoAccessToken(sessionStorage)).toBeUndefined();
  });

  test('clears a token when Medplum cannot verify the returned session', async () => {
    const sessionStorage = storage();
    const medplum = {
      setAccessToken: vi.fn(),
      getProfileAsync: vi.fn(async () => undefined),
      clearActiveLogin: vi.fn(),
    };
    const fetchSession = async (): Promise<Response> =>
      new Response(JSON.stringify({ accessToken: 'unverifiable-token' }), { status: 200 });

    await expect(establishDemoSession('shared-code', medplum, fetchSession, sessionStorage)).rejects.toThrow(
      'The demo is temporarily unavailable.'
    );
    expect(medplum.clearActiveLogin).toHaveBeenCalledOnce();
    expect(getStoredDemoAccessToken(sessionStorage)).toBeUndefined();
  });

  test('clears the current tab session', () => {
    const sessionStorage = storage();
    sessionStorage.setItem('doctor-appointment-agent.demo-access-token', 'token');
    const medplum = { clearActiveLogin: vi.fn() };

    clearDemoSession(medplum, sessionStorage);

    expect(getStoredDemoAccessToken(sessionStorage)).toBeUndefined();
    expect(medplum.clearActiveLogin).toHaveBeenCalledOnce();
  });

  test('still clears the stored token when SDK logout fails', () => {
    const sessionStorage = storage();
    sessionStorage.setItem('doctor-appointment-agent.demo-access-token', 'token');
    const medplum = {
      clearActiveLogin: vi.fn(() => {
        throw new Error('logout failed');
      }),
    };

    expect(() => clearDemoSession(medplum, sessionStorage)).not.toThrow();
    expect(getStoredDemoAccessToken(sessionStorage)).toBeUndefined();
  });
});
