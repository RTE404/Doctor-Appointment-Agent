# Shared Demo Access Design

## Goal

Replace Medplum's individual-account sign-in with one shared demo code, while preserving the existing patient-agent and doctor-desk workflows. Automatically remove demo-created appointments and conversations each day without deleting seeded patients, NPPES practitioners, schedules, or clinical history.

## Access flow

1. An unauthenticated visitor sees a single shared-code form at `/`.
2. The browser sends the code to `POST /api/demo-session` over HTTPS.
3. The server compares it with `DEMO_ACCESS_CODE` and signs in a dedicated read-only Medplum `ClientApplication` using server-only credentials.
4. The server verifies that Medplum returned the configured `MEDPLUM_PROJECT_ID`, then returns only the short-lived access token.
5. The browser keeps that token in `sessionStorage`, loads the Medplum profile, and opens the existing app. Reloading the tab works; closing the tab ends the local session. Token expiry returns the visitor to the code form.

The browser uses this token only to read and search the resources displayed by the UI. The ClientApplication must have an explicit read-only AccessPolicy; the session endpoint rejects a missing or writable policy. All mutations use the narrow, allowlisted `/api/execute` endpoint, which verifies the browser identity and then signs in a separate server-only worker ClientApplication. Mutation handlers re-read trusted FHIR resources and only cancel, reschedule, or complete Appointments carrying the exact demo tag. The worker credentials and token are never returned to the browser. All visitors share one browser audit identity; the shared code does not provide individual attribution.

There is intentionally no rate limiter. Invalid codes receive a generic response, and server configuration errors do not disclose secrets.

## Reset flow

Every demo-created `Appointment`, conversation `Communication`, and completed-visit `Encounter` receives one stable FHIR tag. A Vercel cron calls `GET /api/reset-demo` once per day with `CRON_SECRET` in the Authorization header. The endpoint authenticates as the server-only worker ClientApplication, verifies the project, finds only tagged resources, cancels pending or booked appointments so slots are released, and deletes tagged appointments, communications, and encounters.

The cron expression is `30 20 * * *` because Vercel cron uses UTC and 20:30 UTC is 02:00 IST the next day. On Vercel Hobby, a daily cron may run anywhere within that UTC hour, so the practical reset window is approximately 01:30-02:29 IST.

The reset is idempotent: running it again finds no previously deleted resources. Failures return a non-success response so Vercel records the failed invocation.

## Data boundaries

Deleted daily:

- Appointments created or recreated by the demo booking and rescheduling flows.
- Patient-agent and doctor-desk Communications created by the demo.
- Encounters created when a demo Appointment is completed.

Preserved:

- Seeded Patients and their clinical history.
- NPPES Practitioner resources.
- Schedules and Slots, except that canceling a demo appointment releases its slot through the existing Medplum workflow.
- Any Appointment, Communication, or Encounter that does not carry the demo tag.

## Configuration

Browser-visible:

- `MEDPLUM_BASE_URL`

Server-only:

- `MEDPLUM_PROJECT_ID`
- `DEMO_ACCESS_CODE`
- `DEMO_MEDPLUM_CLIENT_ID`
- `DEMO_MEDPLUM_CLIENT_SECRET`
- `DEMO_WORKER_CLIENT_ID`
- `DEMO_WORKER_CLIENT_SECRET`
- `CRON_SECRET`
- `GEMINI_API_KEY`

Server secrets deliberately do not start with `MEDPLUM_`, because Vite exposes variables with that prefix to browser bundles in this repository.

## Scope decisions

- Remove the Medplum `SignInForm` and redirect the legacy `/signin` URL to `/`.
- Remove the upload-data route and navigation entry from the public demo.
- Keep direct Medplum reads, but route every mutation through the allowlisted server endpoint.
- Do not expose schedule editing in the shared demo.
- Do not add individual users, invitations, per-user identities, rate limiting, or a complete FHIR proxy.
