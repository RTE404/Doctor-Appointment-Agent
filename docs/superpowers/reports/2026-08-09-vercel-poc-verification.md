# Vercel POC Verification — 2026-08-10

## Outcome

The Vercel POC is deployed from `main` to the linked `doctor-appointment-agent` project.

- Production alias: `https://doctor-appointment-agent-rte404s-projects.vercel.app`
- Verified deployment: `https://doctor-appointment-agent-e2t57ygk9-rte404s-projects.vercel.app`
- Vercel inspection: `https://vercel.com/rte404s-projects/doctor-appointment-agent/7n2irAmcag9AzCPwEGRGDTh4c4pd`

The serverless health endpoint, unauthenticated rejection, SPA root, and `/agent` deep link all pass through Vercel's authenticated deployment-protection bypass. Chrome also renders the current production client bundle and shows the Medplum sign-in page without a current-bundle console error.

Vercel Authentication currently protects both the generated deployment URL and the production alias. Direct anonymous requests are redirected to Vercel SSO or rejected by Vercel before reaching the application. Authenticated Medplum workflow verification remains pending because the browser is waiting for user sign-in.

This verification covers a synthetic-data, non-production POC only. It does not establish production healthcare, HIPAA, reliability, or multi-tenant readiness.

## Complete local gate

The post-runtime-fix commands were run from the repository root on `main`:

| Gate | Result | Evidence |
|---|---|---|
| Focused API test | PASS | 1 file and 32 tests passed, including the Node ESM runtime-graph regression. |
| `npm run lint` | PASS | Exit 0; ESLint checked `src/` and `api/` with no findings. |
| `npx tsc --noEmit` | PASS | Exit 0; no TypeScript diagnostics. |
| `npm test` | PASS | Exit 0; 31 test files and 144 tests passed. |
| Local `vercel build --prod` | PASS | Vite transformed 7,226 modules and Vercel emitted a Node 22 function plus SPA output. |
| Emitted function import smoke test | PASS | Node imported `.vercel/output/functions/api/execute.func/api/execute.js` successfully. |

The regression test was observed RED with 14 missing-extension diagnostics from the serverless entrypoint. The first hosted function also failed with `ERR_MODULE_NOT_FOUND` for `src/bots/core/block-availability`. Relative imports in the serverless runtime graph now use explicit `.js` specifiers, and the regression is GREEN.

Vite continues to report the non-failing advisory that the main JavaScript chunk exceeds 500 kB after minification. The Vercel remote install also reported six dependency audit findings (one moderate, four high, one critical); dependency remediation was not part of this deployment change.

## Sanitized configuration evidence

Only variable names, presence, and placeholder classification were inspected. No values were printed, copied into tracked files, or included in this report.

| Name | Production state | Use |
|---|---|---|
| `MEDPLUM_BASE_URL` | Present; Sensitive | Public Medplum browser base URL and server runtime configuration. |
| `MEDPLUM_CLIENT_ID` | Present; Sensitive | Public OAuth client identifier and server runtime configuration. |
| `MEDPLUM_PROJECT_ID` | Present; Sensitive | Server-only project authorization boundary. |
| `GEMINI_API_KEY` | Present; Sensitive | Server-only intake/chat secret. |
| `MEDPLUM_CLIENT_SECRET` | Not configured or used | Explicitly prohibited by this architecture. |

Because Vercel replaces Sensitive values with `[Sensitive]` during `vercel pull`, a local prebuilt deployment could not embed the two public Medplum values into the Vite bundle. The final deployment therefore used Vercel's remote Linux build, where the real production values were available at build time. Chrome confirmed that the resulting current bundle renders correctly.

The repository's Node `22.x` engine intentionally overrides the linked project's `24.x` setting. Both local and remote build logs confirmed Node 22 for the function.

## Upload and artifact evidence

The corrected local prebuilt artifact contained 47 files and passed the following checks before the final remote build:

- One `api/execute` Node 22 function and the SPA assets were present.
- The required Medplum runtime and server handler/data closure were present.
- No `.env`, FHIR seed, docs, tests, legacy Medplum directory, or `.seed-manifest.json` path was present.
- No `MEDPLUM_CLIENT_SECRET` reference was present.
- The emitted function module graph loaded successfully under Node 22.

The final Vercel remote build uploaded 71 allowlisted source/build files, ran `npm ci`, TypeScript, Vite, and the Vercel function builder successfully, then assigned the production alias.

## Hosted endpoint verification

Checks targeted the exact final deployment through `vercel curl`, which supplied a deployment-protection bypass without exposing its value.

| Check | Status | Evidence |
|---|---|---|
| `GET /api/execute` | PASS | HTTP 200; `{"ok":true,"service":"doctor-appointment-agent"}`. |
| Allowlisted `POST /api/execute` without Authorization | PASS | HTTP 401; `{"error":"Authentication required"}`. |
| SPA root `/` | PASS | HTTP 200 and HTML document returned. |
| SPA deep link `/agent` | PASS | HTTP 200 and HTML document returned. |
| Current production browser bundle | PASS | Welcome/sign-in UI rendered; current asset had no captured console errors. |
| Direct anonymous access | PROTECTED | Vercel Authentication returns a 302 SSO redirect or Vercel-owned 401 before the app. |

No tokens, authorization headers, bypass values, prompts, Gemini inputs, or patient-level content were captured.

## Authenticated live scenarios

The browser is open at the Medplum email sign-in screen. The following synthetic scenarios remain pending until an authorized user signs in:

- All seven serverless action names.
- Synthetic complaint-to-booking flow.
- Doctor queue.
- Patient chat.
- Conflict rejection.
- Cancellation cleanup.
- Rescheduling preservation.
- Doctor-scoped blocking.

## Remaining user actions

1. Sign in to Medplum in the open production Chrome tab, then tell Codex to continue the synthetic authenticated checks.
2. Decide whether the POC should remain restricted to Vercel project members. If anonymous users must reach the Medplum sign-in page, change the project's Deployment Protection scope so the production domain is public.
3. Review and schedule the reported dependency-audit findings separately; do not apply a forced audit upgrade as part of this deployment without compatibility testing.
