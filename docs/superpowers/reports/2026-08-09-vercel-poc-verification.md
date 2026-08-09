# Vercel POC Verification — 2026-08-09

## Outcome

The approved Vercel POC implementation passes the complete local gate. Deployment is **BLOCKED** before project linkage, build upload, or deployment because the required `MEDPLUM_PROJECT_ID` and `GEMINI_API_KEY` values are not available locally. No Vercel project was created or linked, no files were uploaded, and no deployment URL exists from this run.

This verification covers a synthetic-data, non-production POC only. It does not establish production healthcare, HIPAA, reliability, or multi-tenant readiness.

## Complete local gate

The commands were run sequentially from repository root on `main` at `0b63e26`:

| Gate | Result | Evidence |
|---|---|---|
| `npm run lint` | PASS | Exit 0; ESLint checked `src/` and `api/` with no findings. |
| `npx tsc --noEmit` | PASS | Exit 0; no TypeScript diagnostics. |
| `npm test -- --maxWorkers=1 --no-file-parallelism` | PASS | Exit 0; 31 test files passed and 142 tests passed. |
| `npm run build` | PASS | Exit 0; TypeScript and Vite completed, 7,226 modules transformed. |
| `git diff --check` | PASS | Exit 0; no whitespace errors. |
| `git status --short --branch` | PASS | `main...origin/main [ahead 57]`; no changed or untracked paths. Git also printed a local global-ignore permission warning, which did not change repository status. |

The Vite output contained:

- `dist/index.html`: 0.49 kB, 0.32 kB gzip.
- Main CSS: 254.21 kB, 37.61 kB gzip.
- Main JavaScript: 1,336.22 kB, 408.29 kB gzip.
- Build duration reported by Vite: 20.30 seconds.

Vite repeated the pre-existing, non-failing advisory that the main JavaScript chunk exceeds 500 kB after minification. This is a performance optimization item, not a failed gate. The repository also has pre-existing npm audit advisories; dependency remediation was not part of Task 5, and a fresh audit was not run after network operations were explicitly stopped.

## Sanitized configuration readiness

Only variable names and presence were inspected. No values were printed, copied into tracked files, or included in this report.

| Name | Local state | Deployment decision |
|---|---|---|
| `MEDPLUM_BASE_URL` | Present in `.env` and `.env.defaults` | Required; available locally. |
| `MEDPLUM_CLIENT_ID` | Present in `.env` and `.env.defaults` | Required; available locally. |
| `MEDPLUM_PROJECT_ID` | Missing | Required; blocks upload/deployment. |
| `GEMINI_API_KEY` | Missing; no unambiguous local Gemini-key alias exists | Required; blocks upload/deployment. |
| `MEDPLUM_CLIENT_SECRET` | A legacy local name exists in `.env` | Explicitly prohibited for this architecture; it was not read, used, uploaded, or configured. |

`.seed-manifest.json` is a 983-entry seeding checkpoint array and contains no project configuration. It is not a source for `MEDPLUM_PROJECT_ID`.

## Vercel CLI, authentication, and project state

- No local or global Vercel CLI was initially available.
- `.vercel/project.json` is absent; the checkout is not linked to any Vercel project.
- A transient read-only `npx vercel whoami` attempt could not finish installing/running within the allowed time and was interrupted. Authentication therefore remains unverified.
- The interrupted probe left no `.vercel` link or deployment state.
- Because two required values are missing, no Vercel project was created or linked and no `vercel build`, upload, preview deployment, or production deployment was attempted.

## Pre-upload source manifest evidence

No generated Vercel build manifest exists because the deployment prerequisites were blocked. Before any upload, the source allowlist was evaluated locally with the installed Git-ignore-compatible matcher against `.vercelignore`.

Required runtime/build material was included:

- `api/execute.ts`
- `src/api/executeAction.ts` and required runtime source under `src/`
- `package.json` and `package-lock.json`
- `tsconfig.json`, `vite.config.ts`, `postcss.config.mjs`, and `vercel.json`
- `data/core/appointment-service-types.json`

Excluded material was confirmed:

- `.env` and other root files not explicitly allowed
- `fhir/`
- `docs/`, including this report
- `.seed-manifest.json`
- `medplum/` and `medplum-scheduling-demo/`
- `api/**/*.test.ts` and `src/**/*.test.ts`
- `src/scripts/`
- extra `data/` content, including `data/core/example-bots.json`

The fresh built-output name-only scan found zero matches for `MEDPLUM_CLIENT_SECRET` or `GEMINI_API_KEY`. It found `GOOGLE_CLIENT_ID__` in one generated bundle file. As established during Task 4, this is an inert placeholder embedded in the third-party `@medplum/react` 5.1.27 distribution, not an application configuration value or credential. The application has no Google public configuration.

## Hosted endpoint verification

No deployment URL exists. Every hosted check is therefore blocked, not passed.

| Check | Status | Evidence |
|---|---|---|
| `GET /api/execute` health response | **BLOCKED** | No deployment. |
| `POST /api/execute` without authorization returns 401 | **BLOCKED** | No deployment. |
| SPA root returns 200 | **BLOCKED** | No deployment. |
| SPA deep link `/agent` returns 200 | **BLOCKED** | No deployment. |

## Authenticated live scenarios

No browser authentication or synthetic live-data action was attempted because there is no deployment. The following remain **BLOCKED**:

- All seven serverless action names.
- Synthetic complaint-to-booking flow.
- Doctor queue.
- Patient chat.
- Conflict rejection.
- Cancellation cleanup.
- Rescheduling preservation.
- Doctor-scoped blocking.

No tokens, authorization headers, prompts, Gemini inputs, or patient-level content were captured.

## Precise next actions

1. Authenticate the Vercel CLI or use the Vercel dashboard, then link this checkout to the intended personal Hobby project `doctor-appointment-agent`. Confirm no unrelated project link is overwritten.
2. Configure `MEDPLUM_PROJECT_ID` and `GEMINI_API_KEY` through Vercel's protected environment-variable UI or a secret-safe CLI flow. Do not send raw values through chat, logs, command arguments, or tracked files.
3. Configure the existing public `MEDPLUM_BASE_URL` and `MEDPLUM_CLIENT_ID` values for the required preview and production environments.
4. Do **not** configure `MEDPLUM_CLIENT_SECRET`.
5. Run `vercel build`, inspect the generated/source manifest again, and only then run the approved prebuilt preview deployment.
6. Verify the four public checks, complete the synthetic authenticated scenario matrix using an already signed-in authorized browser profile, and deploy the verified build to production.

Until those actions are completed with fresh evidence, the POC is locally verified but not hosted or live-validated.
