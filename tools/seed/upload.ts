// tools/seed/upload.ts
import type { MedplumClient } from '@medplum/core';
import type { Bundle, OperationOutcome } from '@medplum/fhirtypes';

const MAX_RETRIES = 6;
// Fallback wait when a transient failure carries no server-diagnosed delay
// (e.g. a raw network timeout). A real 'throttled' outcome overrides this
// with the exact wait Medplum's rate limiter reports (see retryDelayMs).
const DEFAULT_RETRY_DELAY_MS = 500;
// Safety cap in case a diagnostics payload ever reports something absurd —
// never actually observed, but this is server-reported input, not our own.
const MAX_RETRY_DELAY_MS = 65_000;

// FHIR IssueType codes that represent a transient, retry-worthy condition —
// NOT the presence of an OperationOutcome at all, which was the earlier bug:
// a genuine 5xx can still come back as a well-formed OperationOutcome, and
// treating "has an outcome" as "never retry" silently ate those retries.
const TRANSIENT_ISSUE_CODES = new Set(['timeout', 'transient', 'throttled', 'lock-error']);

/**
 * Carries the first transient-coded OperationOutcome found across a batch
 * response's failed entries (if any), so retry/backoff logic downstream can
 * read it the same way it would read a single-request rejection's
 * `.outcome`. A batch entry can be permanently invalid (e.g. `invalid`)
 * while another entry in the same response is merely throttled — only the
 * transient one should drive whether/how long we wait before retrying.
 */
class BatchEntryFailureError extends Error {
  outcome?: OperationOutcome;
  retryable: boolean;

  constructor(message: string, outcome?: OperationOutcome, retryable = false) {
    super(message);
    this.outcome = outcome;
    this.retryable = retryable;
  }
}

function isTransient(err: unknown): boolean {
  if (err instanceof BatchEntryFailureError && err.retryable) {
    return true;
  }
  if (!(err && typeof err === 'object' && 'outcome' in err)) {
    return true; // no structured outcome at all -> raw network/timeout failure
  }
  const outcome = (err as { outcome?: { issue?: { code?: string }[] } }).outcome;
  const code = outcome?.issue?.[0]?.code;
  return code !== undefined && TRANSIENT_ISSUE_CODES.has(code);
}

/**
 * How long to wait before the next retry. A 'throttled' outcome's
 * diagnostics carry the rate limiter's own `_msBeforeNext` — retrying
 * before that elapses just re-hits the same exhausted window, which is
 * exactly what immediate no-delay retries were doing against a live
 * Medplum project's rate limit. Any other transient cause (or a
 * diagnostics payload we can't parse) falls back to a fixed short delay.
 */
function retryDelayMs(err: unknown): number {
  if (err && typeof err === 'object' && 'outcome' in err) {
    const issue = (err as { outcome?: OperationOutcome }).outcome?.issue?.[0];
    if (issue?.code === 'throttled' && issue.diagnostics) {
      try {
        const msBeforeNext = JSON.parse(issue.diagnostics)?._msBeforeNext;
        if (typeof msBeforeNext === 'number' && msBeforeNext > 0) {
          return Math.min(msBeforeNext, MAX_RETRY_DELAY_MS);
        }
      } catch {
        // Not parseable JSON — fall through to the default delay.
      }
    }
  }
  return DEFAULT_RETRY_DELAY_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A Bundle can resolve with HTTP 200 while individual response entries
 * failed (4xx/5xx). This was observed live for both batch and transaction
 * responses, so `executeBatch` resolving is never sufficient evidence of
 * success; every response entry must be checked.
 */
function assertNoFailedEntries(request: Bundle, response: Bundle): void {
  const failures: string[] = [];
  let transientOutcome: OperationOutcome | undefined;
  let unresolvedConditionalReference = false;
  (response.entry ?? []).forEach((entry, i) => {
    const status = entry.response?.status;
    if (!status?.startsWith('2')) {
      const resourceType = request.entry?.[i]?.resource?.resourceType ?? 'unknown';
      const outcome = entry.response?.outcome as OperationOutcome | undefined;
      if (
        outcome?.issue?.some((issue) =>
          issue.details?.text?.startsWith('Conditional reference ') &&
          issue.details.text.endsWith(' did not match any resources')
        )
      ) {
        unresolvedConditionalReference = true;
      }
      if (!transientOutcome && outcome?.issue?.[0]?.code && TRANSIENT_ISSUE_CODES.has(outcome.issue[0].code as string)) {
        transientOutcome = outcome;
      }
      const outcomeText = outcome ? ` — ${JSON.stringify(outcome)}` : '';
      failures.push(`entry ${i} (${resourceType}): status ${status ?? '(none)'}${outcomeText}`);
    }
  });
  if (failures.length > 0) {
    throw new BatchEntryFailureError(
      `Batch upload had ${failures.length} failed entr${failures.length === 1 ? 'y' : 'ies'}:\n${failures.join('\n')}`,
      transientOutcome,
      unresolvedConditionalReference
    );
  }
}

/**
 * Uploads one Bundle (transaction or batch). Retries transient failures
 * (raw network errors, a structured OperationOutcome whose issue code
 * indicates a transient server condition, or a batch response with a
 * transiently-failed entry — safe to retry since every entry is a
 * conditional-create against a stable identifier) up to MAX_RETRIES times,
 * waiting retryDelayMs() between attempts; a real validation error is not
 * retried — a retry can't fix a bad payload. Returns the response Bundle so
 * callers can read created-resource ids.
 */
export async function uploadBundle(medplum: MedplumClient, bundle: Bundle): Promise<Bundle> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await medplum.executeBatch(bundle);
      assertNoFailedEntries(bundle, response);
      return response;
    } catch (err) {
      lastError = err;
      if (!isTransient(err)) {
        throw err;
      }
      if (attempt < MAX_RETRIES) {
        await sleep(retryDelayMs(err));
      }
    }
  }
  throw lastError;
}
