# Doctor Appointment Agent — Minimal Vercel POC Recovery Design

**Date:** 2026-08-09

**Status:** User-approved architecture; implementation pending plan review

**Target:** Synthetic-data proof of concept only

## 1. Objective

Restore and host the complete Doctor Appointment Agent demonstration without
purchasing Medplum's paid Bot capability. Preserve the existing frontend,
FHIR data, authentication, scheduling behavior, handler logic, and tests while
replacing only the unavailable Medplum Bot execution boundary.

The hosted demonstration must prove this pipeline:

1. A signed-in user selects a synthetic patient and submits a complaint.
2. Intake reads that patient's synthetic Medplum history and calls Gemini.
3. Doctor matching uses previous synthetic encounters and NPPES results.
4. The selected doctor and schedule are found or provisioned in Medplum.
5. Availability is calculated through Medplum's native scheduling operations.
6. The appointment is booked and the intake summary is linked to it.
7. The doctor-facing queue and record-grounded chat can read the result.

## 2. Constraints

- Recurring hosting cost must be zero for the POC.
- All patient and clinical data must remain synthetic.
- Medplum Cloud Free remains the FHIR datastore and login provider.
- No Medplum Bot needs to be deployed or executed.
- No new database, queue, cache, or long-running server is introduced.
- No Medplum client secret is stored in the browser or on Vercel.
- The existing seven handler implementations remain the source of business
  behavior; they are adapted, not rewritten.
- The deployment must exclude the large `fhir/` corpus and all local secrets.
- Production healthcare use, HIPAA suitability, reliability guarantees, and
  multi-tenant hardening are explicitly out of scope.

## 3. Selected Architecture

Deploy the Vite SPA and one Node.js function in the same Vercel Hobby project.
The browser calls the function at `POST /api/execute`. The function validates
the browser's current Medplum access token, confirms that it belongs to the
configured Medplum project, constructs a `MedplumClient` with that same token,
and dispatches to one of the existing handlers.

```text
Signed-in Vite SPA
  |
  | Authorization: Bearer <current Medplum access token>
  | { action, input }
  v
Vercel Node function: POST /api/execute
  |
  |-- validate token through Medplum auth/me
  |-- require configured Medplum project id
  |-- allowlist action name
  |-- construct BotEvent-compatible input
  v
Existing TypeScript handler
  |-- Medplum Cloud Free: FHIR reads/writes and scheduling operations
  |-- NPPES: public provider lookup
  `-- Gemini: synthetic context only, key supplied by server environment
```

Vercel is stateless. All durable state remains in the existing Medplum
project. The API and SPA share an origin, so no CORS layer is required.

## 4. API Contract

### `GET /api/execute`

Returns a small unauthenticated runtime health response. It does not call
Medplum, NPPES, or Gemini and does not reveal environment values.

Example response:

```json
{ "ok": true, "service": "doctor-appointment-agent" }
```

### `POST /api/execute`

Required headers:

- `Authorization: Bearer <Medplum access token>`
- `Content-Type: application/json`

Request body:

```json
{
  "action": "agent-intake",
  "input": {}
}
```

Allowed actions are exactly:

- `block-availability`
- `reschedule-appointment`
- `agent-intake`
- `agent-find-doctors`
- `agent-ensure-doctor`
- `agent-book-appointment`
- `agent-patient-chat`

The endpoint rejects missing or malformed authorization, non-POST execution
requests, malformed JSON, non-object input, unknown actions, invalid Medplum
tokens, and tokens for a different project.

The dispatcher constructs the minimal `BotEvent` shape the current handlers
require. The two Gemini-backed actions receive a `GEMINI_API_KEY` project
setting assembled from the server-only environment variable. Other actions
receive no secrets.

## 5. Authentication and Secret Boundary

The frontend already owns a short-lived Medplum access token for its signed-in
session. It forwards that token to the same-origin function for each action.
The function uses the token as the `MedplumClient` access token, calls
`getProfileAsync()` to validate it, and confirms the loaded project id matches
`MEDPLUM_PROJECT_ID`. Handler operations therefore run with the signed-in
user's Medplum permissions and retain Medplum's normal audit identity.

The hosted environment contains only these application variables:

- `MEDPLUM_BASE_URL` — public runtime configuration
- `MEDPLUM_CLIENT_ID` — public browser OAuth client identifier
- `MEDPLUM_PROJECT_ID` — public project boundary used by the API
- `GEMINI_API_KEY` — sensitive, server-only, production and preview

`MEDPLUM_CLIENT_SECRET` must not be configured in Vercel. `GEMINI_API_KEY`
must not use the current Vite-exposed `GOOGLE_` prefix. No request body,
authorization header, Gemini prompt, or patient context is intentionally
logged by the API.

## 6. Frontend Adaptation

Add one typed frontend helper that:

1. Gets the current token with `medplum.getAccessToken()`.
2. Sends `{ action, input }` to `/api/execute`.
3. Parses successful JSON into the caller's existing result type.
4. Converts non-success responses into sanitized user-facing errors.

Replace the eight active `medplum.executeBot()` invocations with this helper.
Their inputs, outputs, loading states, and UI behavior remain unchanged.

Remove the obsolete `example-data` Bot upload path and navigation entry. The
full 983-bundle seed is already complete, and `example-data` is not part of
the final seven-action roster.

## 7. Build and Deployment Configuration

- Add a single TypeScript entry point at `api/execute.ts`.
- Include `api/` in TypeScript verification.
- Pin Vercel execution to Node.js 22, matching the verified local runtime.
- Configure the one function with a 60-second maximum duration.
- Replace the legacy catch-all `routes` entry with Vercel's Vite SPA rewrite;
  filesystem and API routes must resolve before the `index.html` fallback.
- Remove Medplum Bot bundling from the normal production web build. Retain the
  handler sources and their tests; Bot deployment artifacts are no longer a
  release requirement for this POC.
- Add `.vercel/` to `.gitignore`.
- Add a strict `.vercelignore` allowlist containing only files required to
  install, type-check, build, bundle the API, and serve the SPA. In particular,
  exclude `.env`, `fhir/`, `docs/`, reference clones, local build output,
  seeding checkpoints, and test-only artifacts.

Before uploading a deployment, run Vercel's dry-run manifest and confirm:

- `.env` is absent.
- `fhir/` is absent.
- `MEDPLUM_CLIENT_SECRET` is absent.
- `api/`, required `src/` files, package manifests, Vite configuration, and
  required small `data/` modules are present.
- The total source upload is below the Hobby limit.

## 8. Error Handling

The API maps errors into four stable categories:

- `400` — malformed request, invalid input envelope, or unknown action.
- `401` — missing, malformed, expired, or rejected Medplum token.
- `403` — valid token associated with a different Medplum project.
- `500` — handler or upstream failure, returned with a sanitized message.

Existing handler-level domain results remain unchanged, including
clarification requests, slot-taken responses, and relationship validation.
Authorization headers, tokens, secrets, and synthetic clinical details must
never be included in error responses.

## 9. Verification Strategy

### Automated

- Dispatcher tests cover every allowed action and unknown-action rejection.
- Authentication tests cover missing token, invalid token, wrong project, and
  a valid target-project session.
- Secret-adapter tests confirm only the two Gemini actions receive the key.
- Frontend helper tests cover token forwarding, success, and sanitized errors.
- Existing handler tests continue to exercise business logic directly.
- Run TypeScript, ESLint, the full Vitest suite, the Vite production build,
  `git diff --check`, and a built-output secret scan.

Medplum's FHIR index initialization is expensive and globally shared in the
test harness. Focused multi-file runs must avoid treating hook-timeout-only
parallel setup failures as product failures; final evidence uses the
repository's reproducible full-suite command plus isolated reproduction for
any failing suite.

### Hosted

1. Link a personal Vercel Hobby project through the CLI.
2. Configure the four named variables without printing their values.
3. Run the deployment dry-run and review its file manifest.
4. Deploy a preview and verify the SPA, deep links, API health response,
   unauthenticated rejection, and authenticated target-project request.
5. Deploy the verified build to production.
6. Sign in to Medplum and execute the synthetic patient-to-doctor pipeline.
7. Confirm the resulting Appointment, Slot, Communication, and doctor-facing
   views in the existing Medplum project.
8. Record the production URL and sanitized evidence without credentials,
   tokens, headers, or patient-level content.

## 10. Acceptance Criteria

- A public Vercel production URL serves the SPA and client-side deep links.
- `GET /api/execute` returns the expected health response.
- No Medplum Bot deployment is needed and `Bots not enabled` is no longer on
  the application execution path.
- All seven action names execute through the serverless dispatcher.
- The full synthetic complaint-to-booking pipeline succeeds live.
- The doctor queue and patient chat can read and extend the resulting state.
- No client secret or Gemini key appears in the browser bundle, deployment
  manifest, repository diff, or logs.
- The deployment uses only free-tier POC capabilities and carries an explicit
  synthetic-data/non-production boundary.

## 11. Rejected Alternatives

### Render free web service

Technically viable, but its idle shutdown and approximately one-minute wake-up
make the interactive POC less reliable. It also introduces a second deployment
origin and CORS configuration without preserving more code than Vercel.

### Self-hosted Medplum

Preserves native Bot execution but adds Medplum server administration,
PostgreSQL, Redis, Bot runtime configuration, backups, monitoring, and hosting
operations. This is disproportionate to a synthetic POC.

### Paid Medplum Cloud

Would preserve the architecture exactly but violates the zero-cost constraint.
