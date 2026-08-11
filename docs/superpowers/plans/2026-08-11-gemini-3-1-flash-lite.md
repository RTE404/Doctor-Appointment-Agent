# Gemini 3.1 Flash-Lite Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route both production Gemini features through the stable `gemini-3.1-flash-lite` model without sending explicit sampling parameters.

**Architecture:** Add a focused shared request-body builder that owns the Gemini model ID, common messages, and optional JSON response format. Keep the existing fetch, authentication, status handling, and response parsing in the two current call sites.

**Tech Stack:** TypeScript 5.9, Vitest 4, Node.js 22, Vite 7, Google's OpenAI-compatible Gemini REST endpoint.

## Global Constraints

- Use the exact stable model ID `gemini-3.1-flash-lite`.
- Do not send `temperature`, `top_p`, or `top_k`.
- Intake must retain `response_format: { type: 'json_object' }`.
- Patient chat must not add a response-format override.
- Do not change prompts, environment variables, authentication, endpoint, error handling, response parsing, Medplum behavior, or clinical boundaries.
- Preserve the safe production failure classifier added in commit `1cedff3`.

---

### Task 1: Add the Shared Gemini Request-Body Builder

**Files:**

- Create: `src/bots/agent/lib/geminiRequest.ts`
- Test: `src/bots/agent/lib/geminiRequest.test.ts`

**Interfaces:**

- Consumes: `systemPrompt: string`, `userPrompt: string`, and optional `{ jsonResponse?: boolean }`.
- Produces: `buildGeminiChatCompletionBody(systemPrompt, userPrompt, options?)`, returning the JSON-serializable OpenAI-compatible request body.

- [ ] **Step 1: Write the failing builder tests**

Create `src/bots/agent/lib/geminiRequest.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { buildGeminiChatCompletionBody } from './geminiRequest';

describe('buildGeminiChatCompletionBody', () => {
  test('uses Gemini 3.1 Flash-Lite without sampling parameters', () => {
    const body = buildGeminiChatCompletionBody('system prompt', 'user prompt');

    expect(body).toStrictEqual({
      model: 'gemini-3.1-flash-lite',
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user prompt' },
      ],
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k');
  });

  test('adds JSON-object formatting only when requested', () => {
    const body = buildGeminiChatCompletionBody('system prompt', 'user prompt', { jsonResponse: true });

    expect(body).toStrictEqual({
      model: 'gemini-3.1-flash-lite',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user prompt' },
      ],
    });
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm test -- src/bots/agent/lib/geminiRequest.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL because `./geminiRequest` does not exist.

- [ ] **Step 3: Implement the minimal shared builder**

Create `src/bots/agent/lib/geminiRequest.ts`:

```ts
const GEMINI_MODEL = 'gemini-3.1-flash-lite';

interface GeminiChatCompletionOptions {
  jsonResponse?: boolean;
}

export function buildGeminiChatCompletionBody(
  systemPrompt: string,
  userPrompt: string,
  options: GeminiChatCompletionOptions = {}
): Record<string, unknown> {
  return {
    model: GEMINI_MODEL,
    ...(options.jsonResponse ? { response_format: { type: 'json_object' } } : {}),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
npm test -- src/bots/agent/lib/geminiRequest.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: 1 test file passes with 2 passing tests.

- [ ] **Step 5: Commit the tested builder**

```powershell
git add -- src/bots/agent/lib/geminiRequest.ts src/bots/agent/lib/geminiRequest.test.ts
git diff --cached --check
git commit -m "feat: configure Gemini 3.1 Flash-Lite requests"
```

---

### Task 2: Route Intake and Patient Chat Through the Shared Builder

**Files:**

- Modify: `src/bots/agent/agent-intake.ts:4-40`
- Modify: `src/bots/agent/agent-patient-chat.ts:1-32`

**Interfaces:**

- Consumes: `buildGeminiChatCompletionBody(systemPrompt, userPrompt, options?)` from Task 1.
- Produces: Intake requests with JSON-object formatting and patient-chat requests without a response-format override, both using the shared stable model configuration.

- [ ] **Step 1: Wire intake to the shared builder**

Add this import to `src/bots/agent/agent-intake.ts`:

```ts
import { buildGeminiChatCompletionBody } from './lib/geminiRequest.js';
```

Replace the inline object passed to `JSON.stringify` with:

```ts
body: JSON.stringify(buildGeminiChatCompletionBody(systemPrompt, userPrompt, { jsonResponse: true })),
```

This removes the duplicated model ID and `temperature: 0` while preserving intake's structured JSON request.

- [ ] **Step 2: Wire patient chat to the shared builder**

Add this import to `src/bots/agent/agent-patient-chat.ts`:

```ts
import { buildGeminiChatCompletionBody } from './lib/geminiRequest.js';
```

Replace the inline object passed to `JSON.stringify` with:

```ts
body: JSON.stringify(buildGeminiChatCompletionBody(systemPrompt, userPrompt)),
```

This removes the duplicated model ID and `temperature: 0` without adding a response-format override.

- [ ] **Step 3: Run the focused agent tests**

Run:

```powershell
npm test -- src/bots/agent/lib/geminiRequest.test.ts src/bots/agent/agent-intake.test.ts src/bots/agent/agent-patient-chat.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: all three test files pass.

- [ ] **Step 4: Verify the old model and sampling fields are absent from production call sites**

Run:

```powershell
rg -n "gemini-2\.5-flash-lite|temperature:|top_p:|top_k:" src/bots/agent/agent-intake.ts src/bots/agent/agent-patient-chat.ts src/bots/agent/lib/geminiRequest.ts
```

Expected: no matches and exit code 1.

- [ ] **Step 5: Commit the call-site migration**

```powershell
git add -- src/bots/agent/agent-intake.ts src/bots/agent/agent-patient-chat.ts
git diff --cached --check
git commit -m "fix: migrate Gemini agents to 3.1 Flash-Lite"
```

---

### Task 3: Verify, Publish, and Validate the Production Deployment

**Files:**

- Verify: all changed source, test, design, and plan files.
- No additional production files should change.

**Interfaces:**

- Consumes: the completed model migration from Tasks 1 and 2.
- Produces: a verified `main` push and a Ready Vercel production deployment.

- [ ] **Step 1: Run TypeScript and lint checks**

Run:

```powershell
npx tsc --noEmit
npx eslint src/bots/agent/lib/geminiRequest.ts src/bots/agent/lib/geminiRequest.test.ts src/bots/agent/agent-intake.ts src/bots/agent/agent-patient-chat.ts
```

Expected: both commands exit 0 with no errors.

- [ ] **Step 2: Run the complete test suite**

Run:

```powershell
npm test -- --maxWorkers=1 --no-file-parallelism
```

Expected: every test file and test passes with zero failures.

- [ ] **Step 3: Run the production build**

Run:

```powershell
npm run build
```

Expected: TypeScript and Vite build complete with exit code 0. Vite's existing large-chunk advisory is acceptable.

- [ ] **Step 4: Review the exact branch diff**

Run:

```powershell
git status -sb
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- src/bots/agent/lib/geminiRequest.ts src/bots/agent/lib/geminiRequest.test.ts src/bots/agent/agent-intake.ts src/bots/agent/agent-patient-chat.ts docs/superpowers/specs/2026-08-11-gemini-3-1-flash-lite-design.md docs/superpowers/plans/2026-08-11-gemini-3-1-flash-lite.md
```

Expected: only the approved design, plan, builder, builder tests, and two call sites differ from `origin/main`.

- [ ] **Step 5: Commit the implementation plan if it remains uncommitted**

```powershell
git add -- docs/superpowers/plans/2026-08-11-gemini-3-1-flash-lite.md
git diff --cached --check
git commit -m "docs: plan Gemini 3.1 Flash-Lite migration"
```

Expected: the plan is committed and `git status --short` is empty.

- [ ] **Step 6: Fetch and verify a fast-forward push**

```powershell
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git status --short
```

Expected: the ancestor check exits 0 and the worktree is clean. If `origin/main` advanced independently, stop and reconcile before pushing.

- [ ] **Step 7: Push the verified commits to main**

```powershell
git push origin HEAD:main
```

Expected: Git reports a successful fast-forward update of `main`.

- [ ] **Step 8: Confirm Vercel readiness and run one production retry**

Use the authenticated Vercel deployment view or CLI to confirm the deployment for the pushed commit is `Ready`. Then have the user click Find a Doctor once. Query production logs for the new `/api/execute` request and verify it no longer emits `gemini-http-404`.

If the request still fails, preserve the safe status evidence and return to root-cause investigation; do not stack another speculative model change.
