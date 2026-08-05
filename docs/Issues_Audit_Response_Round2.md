# Response to `issues.md` (2026-08-04 Re-Scan) — Verification Report

This is the second round of the same process as `docs/Issues_Audit_Response.md`:
`issues.md` was updated with a re-scan of the corrected plan, claiming 4 of
the original 14 findings fully fixed, 7 partially fixed, 3 unresolved, plus
12 new P0s, 12 P1s, and 4 P2s. Every P0 claim was independently re-verified
against real source (`medplum/`, `medplum-scheduling-demo/`) before fixing
anything — including re-checking the most consequential claim (whether
`$find`/`$book` responses are `Parameters`-wrapped or a bare `Bundle`)
against `buildOutputParameters` directly, since the prior fix pass's
answer to that exact question turned out to be wrong.

**Bottom line: all 12 P0 claims were confirmed true, several against my own
code again.** The most serious was self-inflicted: my prior fix for the
`$find`/`$book` response shape replaced one wrong assumption
(`slot`-output-parameter) with a different wrong one
(`Parameters.return.resource`) — the real shape is a bare `Bundle`, full
stop, confirmed directly in `buildOutputParameters`'s single-output
shortcut. All 12 are now fixed in
`docs/superpowers/plans/2026-08-04-medplum-native-implementation.md`
(commit `538de48`).

## P0s — verified and fixed

| # | Claim | Verdict | Fix |
|---|---|---|---|
| 1 | `$find`/`$book` response is `Parameters`-wrapped, not a bare `Bundle` | **Confirmed** — and my prior fix had this backwards | `buildOutputParameters` bypasses the `Parameters` envelope entirely when an operation has exactly one `return` output parameter (both `find` and `book` do) — confirmed at `parameters.ts:210-219`. Official example client code and `appointment-book.md` agree; `appointment-find.md` is the one stale Medplum doc. Fixed in Task 21, 25, 31. |
| 2 | Booked Appointment has no Patient participant | **Confirmed** | `find.ts` builds `participant` purely from `Schedule.actor` — no patient ever enters it. `agent-book-appointment.ts` now injects `{actor: {reference: 'Patient/'+patientId}, status:'accepted'}` before calling `$book`. |
| 3 | Booking can commit, then report failure | **Confirmed as a real design gap** | Post-`$book` metadata writes (stated-issue fields, Communication link) are now wrapped so a failure there is logged, never propagated — the booking already succeeded by that point. |
| 4 | Uploader drops every generated `PractitionerRole` | **Confirmed against my own `IDENTITY_TYPES` set** | `PractitionerRole` was in neither `IDENTITY_TYPES` nor `CLINICAL_TYPES` in `chunk-bundle.ts` — silently filtered out of both. Added to `IDENTITY_TYPES`. |
| 5 | Chunking leaves clinical-to-clinical references dangling (26,268 corpus-wide) | **Confirmed, and the fix simplifies the design** | Confirmed a load-bearing fact first: a client-supplied `id` is preserved for *any* create processed as a bundle entry (`batch` or `transaction` — same code path, `{batch:true}` passed either way, `fhir-router/src/batch.ts:692`). This means every reference is resolvable client-side, up front, using each resource's already-known stable id — no need to wait for a live response. Redesigned `transformBundle` to resolve every reference (`subject`, `patient`, `serviceProvider`, `participant.individual`, `encounter`, `requester`, `reasonReference[]`) before chunking; deleted the response-based rewrite step entirely. |
| 6 | Batch failures silently counted as success | **Confirmed** | `uploadBundle` now inspects `response.entry[].response.status` for `batch`-type bundles and throws on any non-2xx entry. |
| 7 | `--full`/`--slim`/manifest semantics don't mean what the plan said | **Confirmed** | Task 36's `--slim --full` was genuinely self-contradictory (last flag wins → selects full mode, the opposite of the stated intent). Fixed to run explicit `--slim` for the real corpus. Also fixed: `splitForUpload` now has a third "other" bucket so `--full` mode's extra resource types aren't silently dropped a second time; Task 10's smoke test now explicitly targets a disposable project to avoid specialty-poisoning a partial run into the real target. |
| 8 | Bootstrap `HealthcareService`s aren't idempotent | **Confirmed** | Neither `HealthcareService` carried the identifier its own `ifNoneExist` queried for. Added it to both. (Checked separately: the `Device`'s hard-coded id *is* preserved, since that bundle is `type: transaction` — this sub-claim didn't apply.) |
| 9 | Seed CLI doesn't start on Windows | **Confirmed** | `import.meta.url` (`file:///D:/...`, encoded, forward slashes) never equals `` `file://${process.argv[1]}` `` (`D:\...`, raw backslashes) — confirmed as a real mismatch. Replaced with `pathToFileURL(process.argv[1]).href`. Also fixed: credential casting → validation; `tsconfig.json` extended to typecheck `tools/`. |
| 10 | Bot deployment sends the same code to every bot | **Confirmed against my own script** | The fix from the prior pass matched Binary code with a predicate that didn't reference the bot being deployed — always found the same first match. Rewritten to match each bot's own `executableCode.url` to its Binary by `fullUrl`, exactly like `UploadDataPage.tsx`'s real (and correct) logic. Also fixed: missing-bot creation now uses the admin `admin/projects/{id}/bot` endpoint (creates the `ProjectMembership` a bot needs to actually run), not a bare `createResource` call. |
| 11 | NPPES discovery broken for this corpus | **Confirmed** | All 983 patients store `address.state` as `"Massachusetts"`, never `"MA"`; NPPES requires the 2-letter code. Added a full-name→code normalizer inside `searchNppesDoctors`, plus a state-only fallback when an exact city+state search returns nothing. |
| 12 | Repository has conflicting "authoritative" docs | **Confirmed** | The 7 previously-authoritative docs (Design/Specs/HLD/LLD/Data Model/Backend/Context) still described `$hold`/`$confirm`, `agent-expire-holds`, and a hand-rolled cancel bot. Added explicit superseding banners to all 7, naming exactly which points the implementation plan now overrides, pointing at this file's evidence trail. |

## Bugs found while fixing the above (not in the re-scan)

- Reschedule (`reschedule-appointment.ts`) copied only `serviceType`/
  `participant` from the original Appointment, silently dropping
  `description`/`comment`/`reasonCode`/`priority`, and left the summary
  Communication linked to the now-cancelled original instead of the new
  Appointment. Fixed: metadata copied forward, Communication re-linked
  (found via `subject`+`category` search, then filtered on `about` in
  memory, since `about` isn't searchable).
- `SchedulingParameters`'s `alignmentInterval` defaults to 60 minutes if
  unset (confirmed in `scheduling-parameters.ts`) — `$find` steps candidate
  times by this interval regardless of duration, so an unset value would
  have silently offered only one start time per hour for either the
  15-minute or 30-minute service. Now set explicitly to match each
  service's own duration.

## Where I'd push back / what's still open

Consistent with the first round, I didn't attempt to fix everything in
the P1/P2 lists this pass — most of it is real and worth doing, but this
was already a large correction pass and several items are genuine product
decisions rather than bugs:

- **P1-01's remaining sub-point** (an existing bare `Schedule` — e.g. one
  App.tsx auto-creates for any logged-in Practitioner profile — gets
  reused without being checked/repaired) is real but lower-priority for
  this project's actual usage pattern: the previous-physician/NPPES doctor
  pool isn't expected to correspond to real logged-in app users. Left open.
- **P1-05** (urgency classification as a form of clinical judgment) — I'd
  still push back on treating this as equivalent to the P0s; it's a
  scheduling-duration signal, not a diagnosis. Not changed further this
  pass beyond the disclaimer already added in the first round.
- **P1-07/P1-10** (hard caps, pagination) match this project's own stated
  POC scope (single user per role, no SLA/load targets) — left as
  accepted trade-offs, not bugs, same call as round one.
- **P1-09** (demo-only auth model, `threadId` not verified against the
  same patient/practitioner) — the core relationship check was added in
  round one; the remaining edges (verifying `threadId` ownership, status
  restriction on the relationship query) are real but incremental
  hardening on top of an already-explicit "not real auth" design decision.
- **P1-12** (fork pins Medplum `5.0.12`, verification was done against
  `5.1.27`) is a genuine, unresolved deployment-verification gate — no
  code fix closes this, only checking against the actual deployed server
  version can, which the plan already flags as an outstanding manual step.
- **P2s** (test coverage gaps, retry backoff/jitter, verification-command
  overclaiming, one EOF whitespace nit) are legitimate engineering-hygiene
  items, not correctness defects — not addressed this pass.

These are open, not silently resolved — flagging that plainly rather than
implying a broader cleanup happened than actually did.
