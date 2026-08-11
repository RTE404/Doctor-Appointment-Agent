const DEMO_ACCESS_TOKEN_KEY = 'doctor-appointment-agent.demo-access-token';

export interface DemoSessionMedplum {
  setAccessToken(accessToken: string): void;
  getProfileAsync(): Promise<unknown>;
  clearActiveLogin(): void;
}

type FetchSession = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function establishDemoSession(
  code: string,
  medplum: DemoSessionMedplum,
  fetchSession: FetchSession = globalThis.fetch.bind(globalThis),
  storage: Storage = window.sessionStorage
): Promise<void> {
  let response: Response;
  try {
    response = await fetchSession('/api/demo-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch {
    throw new Error('The demo is temporarily unavailable.');
  }

  if (response.status === 401) {
    throw new Error('That demo code is not correct.');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('The demo is temporarily unavailable.');
  }

  if (!response.ok || !isAccessTokenResponse(body)) {
    throw new Error('The demo is temporarily unavailable.');
  }

  medplum.setAccessToken(body.accessToken);
  try {
    const profile = await medplum.getProfileAsync();
    if (!profile) {
      throw new Error('Missing demo profile');
    }
    storage.setItem(DEMO_ACCESS_TOKEN_KEY, body.accessToken);
  } catch {
    clearDemoSession(medplum, storage);
    throw new Error('The demo is temporarily unavailable.');
  }
}

export function getStoredDemoAccessToken(storage: Storage = window.sessionStorage): string | undefined {
  return storage.getItem(DEMO_ACCESS_TOKEN_KEY) ?? undefined;
}

export function clearDemoSession(
  medplum: Pick<DemoSessionMedplum, 'clearActiveLogin'>,
  storage: Storage = window.sessionStorage
): void {
  try {
    storage.removeItem(DEMO_ACCESS_TOKEN_KEY);
  } catch {
    // Storage can be unavailable in hardened browser modes.
  }
  try {
    medplum.clearActiveLogin();
  } catch {
    // The app-owned token is already gone; logout must remain fail-closed.
  }
}

export function getBrowserDemoAccessToken(): string | undefined {
  try {
    return getStoredDemoAccessToken(window.sessionStorage);
  } catch {
    return undefined;
  }
}

export function clearBrowserDemoAccessToken(): void {
  try {
    window.sessionStorage.removeItem(DEMO_ACCESS_TOKEN_KEY);
  } catch {
    // Storage can be unavailable in hardened browser modes.
  }
}

function isAccessTokenResponse(value: unknown): value is { accessToken: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'accessToken' in value &&
    typeof value.accessToken === 'string' &&
    value.accessToken.length > 0
  );
}
