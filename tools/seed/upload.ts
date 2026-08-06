// tools/seed/upload.ts
import type { MedplumClient } from '@medplum/core';
import type { Bundle } from '@medplum/fhirtypes';

const MAX_RETRIES = 3;

// FHIR IssueType codes that represent a transient, retry-worthy condition —
// NOT the presence of an OperationOutcome at all, which was the earlier bug:
// a genuine 5xx can still come back as a well-formed OperationOutcome, and
// treating "has an outcome" as "never retry" silently ate those retries.
const TRANSIENT_ISSUE_CODES = new Set(['timeout', 'transient', 'throttled', 'lock-error']);

function isTransient(err: unknown): boolean {
  if (!(err && typeof err === 'object' && 'outcome' in err)) {
    return true; // no structured outcome at all -> raw network/timeout failure
  }
  const outcome = (err as { outcome?: { issue?: { code?: string }[] } }).outcome;
  const code = outcome?.issue?.[0]?.code;
  return code !== undefined && TRANSIENT_ISSUE_CODES.has(code);
}

/**
 * A `batch`-type Bundle can resolve with HTTP 200 while individual entries
 * inside it failed (4xx/5xx) — the overall request succeeding says nothing
 * about whether every entry did. `executeBatch` resolving is not evidence
 * of success; this is. (A `transaction`-type Bundle doesn't need this
 * check — Medplum's server already makes it all-or-nothing, so a partial
 * failure there surfaces as a thrown error instead.)
 */
function assertNoFailedEntries(request: Bundle, response: Bundle): void {
  const failures: string[] = [];
  (response.entry ?? []).forEach((entry, i) => {
    const status = entry.response?.status;
    if (!status?.startsWith('2')) {
      const resourceType = request.entry?.[i]?.resource?.resourceType ?? 'unknown';
      const outcomeText = entry.response?.outcome ? ` — ${JSON.stringify(entry.response.outcome)}` : '';
      failures.push(`entry ${i} (${resourceType}): status ${status ?? '(none)'}${outcomeText}`);
    }
  });
  if (failures.length > 0) {
    throw new Error(`Batch upload had ${failures.length} failed entr${failures.length === 1 ? 'y' : 'ies'}:\n${failures.join('\n')}`);
  }
}

/**
 * Uploads one Bundle (transaction or batch). Retries transient failures
 * (raw network errors, a structured OperationOutcome whose issue code
 * indicates a transient server condition, or a batch response with failed
 * entries — safe to retry since every entry is a deterministic PUT,
 * confirmed idempotent) up to MAX_RETRIES times; a real validation error
 * is not retried — a retry can't fix a bad payload. Returns the response
 * Bundle so callers can read created-resource ids.
 */
export async function uploadBundle(medplum: MedplumClient, bundle: Bundle): Promise<Bundle> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await medplum.executeBatch(bundle);
      if (bundle.type === 'batch') {
        assertNoFailedEntries(bundle, response);
      }
      return response;
    } catch (err) {
      lastError = err;
      if (!isTransient(err)) {
        throw err;
      }
    }
  }
  throw lastError;
}
