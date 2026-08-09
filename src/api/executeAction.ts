import type { MedplumClient } from '@medplum/core';

import type { ActionName } from '../../api/execute';

const ERROR_MESSAGES: Record<number, string> = {
  400: 'The request could not be processed.',
  401: 'Your session has expired. Please sign in again.',
  403: 'This session cannot access the configured project.',
  500: 'The appointment service is temporarily unavailable.',
};

const INVALID_RESPONSE_MESSAGE = 'The appointment service returned an invalid response.';
const NETWORK_FAILURE_MESSAGE = 'Unable to reach the appointment service.';
const UNKNOWN_ERROR_MESSAGE = 'The request could not be processed.';

export async function executeAction<TInput extends Record<string, unknown>, TResult>(
  medplum: MedplumClient,
  action: ActionName,
  input: TInput,
  fetchImpl: typeof fetch = fetch
): Promise<TResult> {
  const accessToken = medplum.getAccessToken();
  if (!accessToken) {
    throw new Error(ERROR_MESSAGES[401]);
  }

  let response: Response;
  try {
    response = await fetchImpl('/api/execute', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, input }),
    });
  } catch {
    throw new Error(NETWORK_FAILURE_MESSAGE);
  }

  if (!response.ok) {
    throw new Error(ERROR_MESSAGES[response.status] ?? UNKNOWN_ERROR_MESSAGE);
  }

  try {
    return (await response.json()) as TResult;
  } catch {
    throw new Error(INVALID_RESPONSE_MESSAGE);
  }
}
