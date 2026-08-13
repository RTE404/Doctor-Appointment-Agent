import type { MedplumClient } from '@medplum/core';

import { executeAction } from './executeAction';

function medplumWithToken(token: string | undefined): MedplumClient {
  return { getAccessToken: () => token } as unknown as MedplumClient;
}

test('forwards the current Medplum token and action envelope', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );

  const result = await executeAction<{ patientId: string }, { ok: true }>(
    medplumWithToken('session-token'),
    'agent-booking-chat',
    { patientId: 'synthetic-patient' },
    fetchImpl
  );

  expect(result).toEqual({ ok: true });
  expect(fetchImpl).toHaveBeenCalledWith('/api/execute', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer session-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'agent-booking-chat', input: { patientId: 'synthetic-patient' } }),
  });
});

test('rejects locally when the session has no access token', async () => {
  await expect(executeAction(medplumWithToken(undefined), 'agent-booking-chat', {})).rejects.toEqual(
    new Error('Your session has expired. Please enter the demo code again.')
  );
});

test.each([
  [400, 'The request could not be processed.'],
  [401, 'Your session has expired. Please enter the demo code again.'],
  [403, 'This session cannot access the configured project.'],
  [500, 'The appointment service is temporarily unavailable.'],
])('maps HTTP %i to a sanitized message', async (status, message) => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'secret upstream detail' }), { status }));

  await expect(executeAction(medplumWithToken('token'), 'agent-booking-chat', {}, fetchImpl)).rejects.toEqual(new Error(message));
});

test('does not expose an invalid success response body', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response('secret invalid body', { status: 200 }));

  await expect(executeAction(medplumWithToken('token'), 'agent-booking-chat', {}, fetchImpl)).rejects.toEqual(
    new Error('The appointment service returned an invalid response.')
  );
});

test('does not expose a network failure', async () => {
  const fetchImpl = vi.fn().mockRejectedValue(new Error('secret network detail'));

  await expect(executeAction(medplumWithToken('token'), 'agent-booking-chat', {}, fetchImpl)).rejects.toEqual(
    new Error('Unable to reach the appointment service.')
  );
});
