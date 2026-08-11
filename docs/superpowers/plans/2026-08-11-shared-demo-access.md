# Shared Demo Access Implementation Plan

**Goal:** Replace individual Medplum sign-in with one shared demo code and add safe daily cleanup of demo-generated activity.

**Architecture:** A Vercel session endpoint exchanges the shared code for a short-lived token belonging to an explicitly read-only Medplum ClientApplication. Browser reads remain direct. Allowlisted mutations and cleanup authenticate a separate server-only worker ClientApplication. Demo-created resources are tagged at creation, and a CRON_SECRET-protected endpoint cancels and deletes only tagged activity.

**Tech stack:** React, Mantine, Medplum FHIR SDK, Vercel Functions/Cron, TypeScript, Vitest.

---

### Task 1: Shared server helpers

**Files:**
- Create: `api/server/medplumClientApplication.ts`
- Create: `api/server/request.ts`
- Test: `api/server/medplumClientApplication.test.ts`

Implement strict environment validation, constant-time shared-code comparison, ClientApplication login, and target-project verification. Keep response errors sanitized.

### Task 2: Demo session endpoint and browser session

**Files:**
- Create: `api/demo-session.ts`
- Create: `api/demo-session.test.ts`
- Create: `src/demoSession.ts`
- Create: `src/demoSession.test.ts`
- Modify: `src/main.tsx`
- Modify: `src/pages/LandingPage.tsx`
- Modify: `src/App.tsx`
- Delete: `src/pages/SignInPage.tsx`

Test invalid methods, malformed bodies, invalid code, missing configuration, project mismatch, sanitized failures, token storage, and session clearing. Implement the shared-code form and redirect `/signin` to `/`.

### Task 3: Tag every resettable resource

**Files:**
- Create: `src/demo/demoTag.ts`
- Create: `src/demo/demoTag.test.ts`
- Modify: `src/bots/agent/agent-book-appointment.ts`
- Modify: `src/bots/core/reschedule-appointment.ts`
- Modify: `src/bots/agent/agent-intake.ts`
- Modify: `src/bots/agent/agent-patient-chat.ts`
- Modify relevant existing tests beside each bot.

First add failing assertions that each created or recreated Appointment and Communication has the stable demo tag while retaining existing tags. Then add the shared helper and update creation paths.

### Task 4: Daily reset endpoint

**Files:**
- Create: `api/reset-demo.ts`
- Create: `api/reset-demo.test.ts`
- Modify: `vercel.json`

Test CRON_SECRET authentication, configuration validation, project verification, tagged searches, active-appointment cancellation before deletion, communication deletion, idempotent not-found handling, and sanitized failures. Configure the daily `30 20 * * *` UTC cron and a 60-second function duration.

### Task 5: Remove public setup/admin affordances and document operation

**Files:**
- Modify: `src/operatorMode.tsx`
- Modify: `src/operatorMode.test.tsx`
- Modify: `.env.defaults`
- Modify: `README.md`
- Modify: `src/config/deploymentConfig.test.ts`

Remove the upload navigation/route, document the Medplum ClientApplication and Vercel variables, explain session and reset behavior, and assert server secret names cannot enter the Vite-exposed prefix.

### Task 6: Verification

Run targeted tests during each red/green cycle, followed by:

1. `npm test -- --maxWorkers=1 --no-file-parallelism`
2. `npx tsc --noEmit`
3. `npm run lint`
4. `npm run build`
5. `git diff --check`

Review the final diff for accidental changes, secret exposure, untagged creation paths, and deletion outside the demo tag.

### Task 7: Security hardening after independent review

**Files:**
- Modify: `api/server/medplumClientApplication.ts`
- Modify: `api/demo-session.ts`
- Modify: `api/execute.ts`
- Modify: `api/reset-demo.ts`
- Create: `src/bots/core/cancel-appointment.ts`
- Create: `src/bots/core/complete-appointment.ts`
- Modify: `src/bots/core/reschedule-appointment.ts`
- Modify: `src/components/actions/AppointmentActions.tsx`
- Modify: `src/components/actions/CreateEncounter.tsx`

Require an explicit read-only policy for the browser ClientApplication. Use a separate worker identity for every mutation and reset. Remove schedule mutation from the public allowlist, reject untagged mutation targets, paginate reset searches, bound deletion concurrency, and include tagged Encounters in cleanup.
