# Vercel POC Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace unavailable Medplum Bot execution with one authenticated Vercel Node function while preserving the existing synthetic-data scheduling workflows.

**Architecture:** The signed-in Vite SPA sends the current Medplum bearer token and an allowlisted action envelope to `POST /api/execute`. The Node function validates the session against Medplum, enforces the configured project boundary, adapts the request into the existing `BotEvent` shape, and invokes the existing seven handlers with the signed-in user's permissions.

**Tech Stack:** TypeScript 5.9, React 19, Vite 7, Vitest 4, Medplum 5.1.27, Vercel Node.js 22 Functions.

## Global Constraints

- Recurring hosting cost must be zero for the POC.
- All patient and clinical data must remain synthetic.
- Medplum Cloud Free remains the FHIR datastore and login provider.
- No Medplum Bot needs to be deployed or executed.
- No new database, queue, cache, or long-running server is introduced.
- No Medplum client secret is stored in the browser or on Vercel.
- The existing seven handler implementations remain the source of business behavior; they are adapted, not rewritten.
- The deployment must exclude the large `fhir/` corpus and all local secrets.
- Production healthcare use, HIPAA suitability, reliability guarantees, and multi-tenant hardening are explicitly out of scope.
- Do not print or commit access tokens, client secrets, Gemini keys, authorization headers, prompts, or patient-level content.

---

### Task 1: Authenticated action dispatcher and Node function

**Files:**
- Create: `api/execute.ts`
- Test: `api/execute.test.ts`
- Modify: `tsconfig.json`
- Modify: `eslint.config.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: the seven existing `handler(medplum, event)` exports under `src/bots/core` and `src/bots/agent`.
- Produces: `ALLOWED_ACTIONS`, `ActionName`, `dispatchAction()`, `handleExecuteRequest()`, and the default Vercel Node request handler for `GET|POST /api/execute`.

- [ ] **Step 1: Include the API directory in static verification**

Change `tsconfig.json` to include `api`, and change the lint command/configuration so `api/**/*.ts` is checked with `src/**/*.{ts,tsx}`:

```json
"include": ["api", "src", "tools"]
```

```json
"lint": "eslint src/ api/"
```

```js
files: ['src/**/*.{ts,tsx}', 'api/**/*.ts']
```

- [ ] **Step 2: Write failing dispatcher and request-boundary tests**

Create `api/execute.test.ts` with focused tests for:

```ts
test.each(ALLOWED_ACTIONS)('dispatches the allowlisted %s action', async (action) => {
  const result = await dispatchAction(medplum, action, { marker: action }, 'gemini-key', handlers);
  expect(result).toEqual({ action });
  expect(seen[action].input).toEqual({ marker: action });
});

test.each(['agent-intake', 'agent-patient-chat'] as const)('passes GEMINI_API_KEY only to %s', async (action) => {
  await dispatchAction(medplum, action, {}, 'gemini-key', handlers);
  expect(seen[action].secrets).toEqual({
    GEMINI_API_KEY: { name: 'GEMINI_API_KEY', valueString: 'gemini-key' },
  });
});

test('returns 401 without a bearer token', async () => {
  const response = await handleExecuteRequest(
    request({ action: 'agent-intake', input: {} }),
    environment,
    dependencies
  );
  expect(response).toEqual({ status: 401, body: { error: 'Authentication required' } });
});

test('returns 403 when the token belongs to another Medplum project', async () => {
  dependencies.authenticate = async () => ({ projectId: 'other-project' });
  const response = await handleExecuteRequest(
    request({ action: 'agent-intake', input: {} }, 'Bearer valid-token'),
    environment,
    dependencies
  );
  expect(response.status).toBe(403);
});

test('executes an allowlisted action for a valid target-project session', async () => {
  const response = await handleExecuteRequest(
    request({ action: 'agent-intake', input: { patientId: 'synthetic' } }, 'Bearer valid-token'),
    environment,
    dependencies
  );
  expect(response).toEqual({ status: 200, body: { ok: true } });
});
```

Also cover `GET` health, unsupported methods, missing/wrong content type, malformed JSON, non-object bodies, non-object `input`, unknown actions, rejected `auth/me`, missing server configuration, missing Gemini configuration, and sanitized handler failures. Test responses must never contain the supplied token, key, or input marker.

- [ ] **Step 3: Run the API test and verify RED**

Run:

```powershell
npm test -- api/execute.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL because `api/execute.ts` and its exported contract do not exist.

- [ ] **Step 4: Implement the allowlist, BotEvent adapter, authentication, and HTTP boundary**

Create `api/execute.ts` with these concrete boundaries:

```ts
export const ALLOWED_ACTIONS = [
  'block-availability',
  'reschedule-appointment',
  'agent-intake',
  'agent-find-doctors',
  'agent-ensure-doctor',
  'agent-book-appointment',
  'agent-patient-chat',
] as const;

export type ActionName = (typeof ALLOWED_ACTIONS)[number];

export interface ExecuteEnvelope {
  action: ActionName;
  input: Record<string, unknown>;
}

export interface ExecuteResponse {
  status: number;
  body: unknown;
}
```

Implement `dispatchAction()` with a fixed `Record<ActionName, RuntimeActionHandler>` containing only the seven existing handlers. Build this minimal event and never accept a handler name from a file path or dynamic import:

```ts
const event: BotEvent<Record<string, unknown>> = {
  bot: { identifier: { system: 'http://example.com', value: action } },
  contentType: 'application/json',
  input,
  requester: createReference(profile),
  secrets: GEMINI_ACTIONS.has(action)
    ? { GEMINI_API_KEY: { name: 'GEMINI_API_KEY', valueString: geminiApiKey } }
    : {},
};
```

Implement the production dependencies with:

```ts
const medplum = new MedplumClient({ baseUrl, accessToken });
const profile = await medplum.getProfileAsync();
const projectId = medplum.getProject()?.id;
```

`handleExecuteRequest()` must return only these stable external errors:

```ts
{ status: 400, body: { error: 'Invalid request' } }
{ status: 401, body: { error: 'Authentication required' } }
{ status: 403, body: { error: 'Project access denied' } }
{ status: 500, body: { error: 'Action execution failed' } }
```

The default export must use Node `IncomingMessage`/`ServerResponse`, return `{ ok: true, service: 'doctor-appointment-agent' }` for `GET`, parse an already-materialized Vercel body or a request stream for `POST`, set `Content-Type: application/json`, and never log request or error objects.

- [ ] **Step 5: Run the API tests and static checks**

Run:

```powershell
npm test -- api/execute.test.ts --maxWorkers=1 --no-file-parallelism
npx tsc --noEmit
npm run lint
```

Expected: the API tests pass, TypeScript passes, and ESLint reports zero errors.

- [ ] **Step 6: Commit the API boundary**

```powershell
git add api/execute.ts api/execute.test.ts tsconfig.json eslint.config.mjs package.json package-lock.json
git commit -m "feat(api): execute handlers through authenticated function"
```

---

### Task 2: Typed same-origin frontend execution client

**Files:**
- Create: `src/api/executeAction.ts`
- Test: `src/api/executeAction.test.ts`

**Interfaces:**
- Consumes: `MedplumClient.getAccessToken()`, browser `fetch`, and the `ActionName` contract from `api/execute.ts` as a type-only import.
- Produces: `executeAction<TInput extends Record<string, unknown>, TResult>(medplum, action, input, fetchImpl?)`.

- [ ] **Step 1: Write failing helper tests**

Create `src/api/executeAction.test.ts` with tests equivalent to:

```ts
test('forwards the current Medplum token and action envelope', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  const result = await executeAction<{ patientId: string }, { ok: true }>(
    medplumWithToken('session-token'),
    'agent-intake',
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
    body: JSON.stringify({ action: 'agent-intake', input: { patientId: 'synthetic-patient' } }),
  });
});

test('rejects locally when the session has no access token', async () => {
  await expect(executeAction(medplumWithToken(undefined), 'agent-intake', {})).rejects.toThrow(
    'Your session has expired. Please sign in again.'
  );
});

test.each([
  [400, 'The request could not be processed.'],
  [401, 'Your session has expired. Please sign in again.'],
  [403, 'This session cannot access the configured project.'],
  [500, 'The appointment service is temporarily unavailable.'],
])('maps HTTP %i to a sanitized message', async (status, message) => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'secret upstream detail' }), { status }));
  await expect(executeAction(medplumWithToken('token'), 'agent-intake', {}, fetchImpl)).rejects.toThrow(message);
});
```

Also cover invalid success JSON and network failure without echoing raw response bodies.

- [ ] **Step 2: Run the helper test and verify RED**

Run:

```powershell
npm test -- src/api/executeAction.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL because `executeAction` does not exist.

- [ ] **Step 3: Implement the helper**

Create `src/api/executeAction.ts` with a token precondition, a same-origin `POST`, JSON success parsing, and fixed status-based error messages. The helper must not surface the API response body on errors:

```ts
const ERROR_MESSAGES: Record<number, string> = {
  400: 'The request could not be processed.',
  401: 'Your session has expired. Please sign in again.',
  403: 'This session cannot access the configured project.',
  500: 'The appointment service is temporarily unavailable.',
};
```

- [ ] **Step 4: Run the helper tests and commit**

```powershell
npm test -- src/api/executeAction.test.ts --maxWorkers=1 --no-file-parallelism
git add src/api/executeAction.ts src/api/executeAction.test.ts
git commit -m "feat(ui): call same-origin handler API"
```

---

### Task 3: Migrate all active UI workflows away from Medplum Bots

**Files:**
- Modify: `src/components/actions/BlockAvailability.tsx`
- Modify: `src/components/actions/CreateUpdateSlot.tsx`
- Modify: `src/components/actions/RescheduleAppointment.tsx`
- Modify: `src/pages/agent/PatientHistoryPage.tsx`
- Modify: `src/pages/agent/DoctorResultsPage.tsx`
- Modify: `src/pages/agent/SlotPickerPage.tsx`
- Modify: `src/pages/desk/PatientAgentChatPage.tsx`
- Modify: `src/pages/UploadDataPage.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `executeAction()` from Task 2 and the existing handler input/result types.
- Produces: the same UI results and loading/error behavior without any active `medplum.executeBot()` call.

- [ ] **Step 1: Add a failing source-boundary test**

Add `src/api/noBotExecution.test.ts` that reads the eight workflow source files plus `UploadDataPage.tsx` and asserts they do not contain `.executeBot(` after migration. It must also assert `App.tsx` has no `/upload/example` navigation link and `UploadDataPage.tsx` has no `example-data` action.

- [ ] **Step 2: Run the boundary test and verify RED**

```powershell
npm test -- src/api/noBotExecution.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL and identify the existing Bot call sites.

- [ ] **Step 3: Replace the eight active calls with typed action requests**

Use the existing input and output types at each site:

```ts
await executeAction<BlockAvailabilityEvent, Bundle>(medplum, 'block-availability', input);
await executeAction<RescheduleInput, RescheduleResult>(medplum, 'reschedule-appointment', input);
await executeAction<IntakeInput, IntakeResult>(medplum, 'agent-intake', input);
await executeAction<FindDoctorsInput, FindDoctorsResult>(medplum, 'agent-find-doctors', input);
await executeAction<EnsureDoctorInput, EnsureDoctorResult>(medplum, 'agent-ensure-doctor', input);
await executeAction<BookInput, BookResult>(medplum, 'agent-book-appointment', input);
await executeAction<ChatInput, ChatResult>(medplum, 'agent-patient-chat', input);
```

Preserve each component's existing loading, notification, navigation, and domain-result branches. `SlotPickerPage.tsx` uses two actions, which accounts for eight invocations across seven action names.

- [ ] **Step 4: Remove the obsolete example-data Bot path**

Remove the `example` case, `uploadExampleData()`, the `IconHealthRecognition` import, and the `Upload Example Data` menu link. Keep core-data and optional Bot-upload code unchanged because those are separate existing administration paths.

- [ ] **Step 5: Run focused and full UI tests**

```powershell
npm test -- src/api/noBotExecution.test.ts src/api/executeAction.test.ts --maxWorkers=1 --no-file-parallelism
npm test -- --maxWorkers=1 --no-file-parallelism
```

Expected: no active Bot execution remains and all existing workflow tests pass.

- [ ] **Step 6: Commit the UI migration**

```powershell
git add src/App.tsx src/api/noBotExecution.test.ts src/components/actions src/pages/UploadDataPage.tsx src/pages/agent src/pages/desk/PatientAgentChatPage.tsx
git commit -m "refactor(ui): route workflows through Vercel API"
```

---

### Task 4: Secret-safe Vite and Vercel deployment configuration

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `vite.config.ts`
- Modify: `src/config.ts`
- Modify: `src/pages/SignInPage.tsx`
- Modify: `.env.defaults`
- Modify: `.gitignore`
- Create: `.vercelignore`
- Modify: `vercel.json`
- Test: `src/config/deploymentConfig.test.ts`

**Interfaces:**
- Consumes: Vercel's root `api/` function discovery, Vite's SPA build, and environment variables `MEDPLUM_BASE_URL`, `MEDPLUM_CLIENT_ID`, `MEDPLUM_PROJECT_ID`, `GEMINI_API_KEY`.
- Produces: Node 22 build/runtime selection, a 60-second function limit, filesystem-first SPA fallback, and a deployment upload allowlist.

- [ ] **Step 1: Write failing deployment-configuration tests**

Create `src/config/deploymentConfig.test.ts` to read configuration files and assert:

```ts
expect(packageJson.engines.node).toBe('22.x');
expect(packageJson.scripts.build).toBe('tsc && vite build');
expect(vercel.functions['api/execute.ts'].maxDuration).toBe(60);
expect(vercel.rewrites).toEqual([{ source: '/(.*)', destination: '/index.html' }]);
expect(viteConfig).not.toContain('GOOGLE_');
expect(viteConfig).not.toContain("copyFileSync");
expect(vercelIgnore).toContain('/*');
expect(vercelIgnore).toContain('!api');
expect(vercelIgnore).toContain('!src');
expect(vercelIgnore).not.toContain('!.env');
expect(gitignore).toContain('.vercel/');
```

Also assert the normal `build` script does not invoke `build:bots`, `.env.defaults` contains no Gemini key or Medplum client secret, and the public config does not expose `GEMINI_API_KEY`.

- [ ] **Step 2: Run the configuration test and verify RED**

```powershell
npm test -- src/config/deploymentConfig.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL against the legacy build, Vite prefixes, routing, and missing allowlist.

- [ ] **Step 3: Update the normal build and public environment boundary**

Set:

```json
"build": "tsc && vite build",
"engines": { "node": "22.x" }
```

Keep `build:bots` as an explicitly invoked legacy/admin command. Remove Vite's `.env.defaults` copy side effect, expose only `MEDPLUM_` variables, and remove `googleClientId` from the public app configuration and `SignInForm`. Keep `GOOGLE_CLIENT_ID` out of `.env.defaults` so Vercel needs only the four approved variables.

- [ ] **Step 4: Add Vercel routing, duration, and upload allowlist**

Replace `vercel.json` with:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "vite",
  "installCommand": "npm ci",
  "buildCommand": "npm run build",
  "functions": {
    "api/execute.ts": {
      "maxDuration": 60
    }
  },
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

Vercel applies filesystem routes before rewrites, so `/api/execute` continues to resolve to the function while client-side deep links fall back to `index.html`.

Create `.vercelignore` as a root allowlist:

```gitignore
/*
!api
!src
!data
!index.html
!package.json
!package-lock.json
!tsconfig.json
!vite.config.ts
!postcss.config.mjs
!vercel.json

api/**/*.test.ts
src/**/*.test.ts
src/scripts
data/*
!data/core
data/core/*
!data/core/appointment-service-types.json
```

Add `.vercel/` to `.gitignore`.

- [ ] **Step 5: Run config, type, lint, and production-build checks**

```powershell
npm test -- src/config/deploymentConfig.test.ts --maxWorkers=1 --no-file-parallelism
npx tsc --noEmit
npm run lint
npm run build
```

Expected: all commands pass and the production build does not deploy or bundle Medplum Bots as an operational prerequisite.

- [ ] **Step 6: Scan built output and tracked changes for secrets**

Use names only; never search for or print secret values:

```powershell
rg -n "MEDPLUM_CLIENT_SECRET|GEMINI_API_KEY|GOOGLE_" dist
git diff --check
```

Expected: no secret name in browser output; `git diff --check` passes.

- [ ] **Step 7: Commit deployment configuration**

```powershell
git add .env.defaults .gitignore .vercelignore package.json package-lock.json vite.config.ts vercel.json src/config.ts src/pages/SignInPage.tsx src/config/deploymentConfig.test.ts
git commit -m "chore(vercel): configure secret-safe POC deployment"
```

---

### Task 5: Full local gate and Vercel dry-run evidence

**Files:**
- Create: `docs/superpowers/reports/2026-08-09-vercel-poc-verification.md`

**Interfaces:**
- Consumes: the completed API, UI migration, build configuration, Vercel CLI login/project link, and approved environment-variable names.
- Produces: reproducible local verification plus sanitized deployment evidence or a precise external blocker.

- [ ] **Step 1: Run the complete local gate**

```powershell
npm run lint
npx tsc --noEmit
npm test -- --maxWorkers=1 --no-file-parallelism
npm run build
git diff --check
git status --short --branch
```

Record exact pass/fail counts and the non-secret build summary.

- [ ] **Step 2: Verify the deployment file manifest**

If the Vercel CLI is authenticated and the project can be linked without overwriting an unrelated link, run:

```powershell
npx vercel build
npx vercel deploy --prebuilt --archive=tgz
```

Before any upload, inspect the generated/source manifest and confirm `.env`, `fhir/`, `docs/`, `.seed-manifest.json`, `medplum/`, `medplum-scheduling-demo/`, tests, and `MEDPLUM_CLIENT_SECRET` are absent. Confirm `api/execute.ts`, runtime handler dependencies, package manifests, Vite configuration, and `data/core/appointment-service-types.json` are present.

If authentication, project selection, or environment configuration is missing, stop before deployment and record the exact sanitized external action required. Do not request or print raw credentials.

- [ ] **Step 3: Verify preview behavior when deployment is available**

Check:

```text
GET /api/execute -> 200 {"ok":true,"service":"doctor-appointment-agent"}
POST /api/execute without Authorization -> 401
SPA root -> 200
SPA deep link /agent -> 200
```

With an already signed-in authorized browser profile, run only synthetic-data actions and verify all seven action names, complaint-to-booking, doctor queue, patient chat, conflict rejection, cancellation cleanup, rescheduling preservation, and doctor-scoped blocking. Never capture tokens, headers, prompts, or patient-level content.

- [ ] **Step 4: Write and commit the verification report**

Create `docs/superpowers/reports/2026-08-09-vercel-poc-verification.md` with local gate results, deployment URL if one exists, sanitized endpoint outcomes, live scenario outcomes, and explicit blockers. Do not label blocked scenarios as passed.

```powershell
git add docs/superpowers/reports/2026-08-09-vercel-poc-verification.md
git commit -m "docs: record Vercel POC verification"
```

