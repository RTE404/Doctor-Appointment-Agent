# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A synthetic patient-booking and doctor-desk POC built on [Medplum](https://www.medplum.com/) (open-source FHIR EHR), forked from `medplum-scheduling-demo`. All patient/practitioner data is synthetic (NPPES-derived or seeded); this must never handle real patient data. The centerpiece is the **Patient Appointment Concierge** (`src/pages/agent/**` + `src/bots/agent/**`): a chat-based agent where Gemini runs a tool-calling loop to interpret the patient's request and decide which deterministic tools to call and when, while deterministic TypeScript enforces every decision that matters (specialty routing, grounding, ranking, booking authorization). See `AGENT_OVERVIEW.md` for the full agent spec (routing policy, preferences, safety boundaries, what's explicitly out of scope) and `README.md` for setup/deployment details — read both before changing agent behavior.

## Commands

```bash
npm run dev          # Vite dev server (UI only, no /api functions)
npm run dev:full      # vercel dev on :3000 — the only way to exercise /api locally
npm test              # vitest run (single pass)
npm run test:watch    # vitest watch
npm run test:coverage # vitest run --coverage
npm run lint           # eslint src/ api/
npm run lint:fix
npm run build          # tsc && vite build (production build gate)
npm run build:bots     # clean, compile, esbuild-bundle bots, then deploy to Medplum
```

Run a single test file: `npx vitest run path/to/file.test.ts`. Run by name: `npx vitest run -t "test name substring"`.

There is no local FHIR server config committed for `vercel dev` — it talks to the real Medplum project configured via env vars, so treat `dev:full` runs as touching shared demo data.

### Environment

Copy `.env.defaults` to `.env` and fill in values (see README "Getting Started" for what each Vercel env var does: `MEDPLUM_BASE_URL`, `MEDPLUM_PROJECT_ID`, `DEMO_ACCESS_CODE`, `DEMO_MEDPLUM_CLIENT_ID/SECRET`, `DEMO_WORKER_CLIENT_ID/SECRET`, `GEMINI_API_KEY`, `CRON_SECRET`, admin-only `SEED_MEDPLUM_CLIENT_ID/SECRET`). Secrets must never be committed or reach browser code — only `DEMO_MEDPLUM_CLIENT_ID` and `MEDPLUM_BASE_URL`/`MEDPLUM_PROJECT_ID` are browser-visible.

## Architecture

### Two Medplum identities, one API boundary

- **Browser `ClientApplication`**: read-only, shared by every demo visitor via one access code (`/api/demo-session`). It cannot create/update/delete/operate — Medplum itself enforces this via AccessPolicy, not just app code.
- **Server worker `ClientApplication`**: holds real write permissions. Its token never leaves the server.
- All mutations go through `api/execute.ts` → `dispatchAction`, which re-authenticates the browser token, verifies project/profile match, then logs in as the worker to actually run the action. The browser can only invoke actions listed in `ALLOWED_ACTIONS` (`api/execute.ts`). Server-side handlers re-validate everything (specialty match, schedule ownership, slot availability) instead of trusting client-supplied state — see `agent-book-appointment.ts` for the pattern.
- `src/api/executeAction.ts` is the browser-side counterpart: it POSTs `{action, input}` to `/api/execute` with the bearer token and maps HTTP status codes to user-facing error strings.

When adding a new mutation, wire it in three places: a bot handler under `src/bots/`, an entry in `ALLOWED_ACTIONS`/`HANDLERS` in `api/execute.ts`, and a caller using `executeAction`.

### Bots: `core` vs `agent`

- `src/bots/core/**` — generic appointment lifecycle bots (cancel, complete, reschedule, block-availability) usable independent of the concierge agent.
- `src/bots/agent/**` — the concierge's two callable actions plus internal-only bots:
  - `agent-booking-chat.ts`: a Gemini tool-calling loop, not a one-shot call — the model decides which tools to call (`search_previous_physician`, `search_nppes`, `check_availability`, `ask_clarifying_question`, `propose_options`), when to ask the patient something, and what to propose. Deterministic code grounds every proposed pick against a real tool result from that session, validates specialty (NUCC taxonomy), and caps the result at up to 8 distinct providers, falling back to a preference-aware ranking if the model's picks need correcting. Session state (the full transcript) persists server-side as a `Communication` and stays resumable — including after options are shown, so the patient can keep chatting to refine instead of restarting.
  - `agent-book-appointment.ts`: revalidates practitioner/schedule/specialty/slot from scratch, then calls Medplum's authoritative `$book`. Only reachable after explicit UI confirmation — selecting an option never books it.
  - `agent-patient-chat.ts`, `agent-ensure-doctor.ts`, `agent-find-doctors.ts`: supporting tools (doctor-desk chat, synthetic-provider creation; `agent-find-doctors`'s search helpers are also called directly by `agent-booking-chat`'s tools).
  - `lib/` holds the deterministic pieces shared across bots: `ranking.ts`/`bookableOptions.ts` (option ranking, including the `propose_options` fallback), `proposeOptions.ts` (grounding/cap/fallback logic), `bookingChatTools.ts` (tool schemas + implementations), `bookingSession.ts` (transcript persistence), `schedulingPreferences.ts`, `nppes.ts` (NPPES lookups), `geo.ts` (distance), `geminiRequest.ts`/`prompts.ts` (the only Gemini call sites — `prompts.ts` also builds the patient-context message the model sees each session), `patientContext.ts`/`completePatientContext.ts`, `ensurePractitionerAndSchedule.ts`, `timezones.ts`.
- Bots follow Medplum's `BotEvent` handler signature (`handler(medplum, event)`) so they work both as Medplum-hosted bots (`npm run build:bots` deploys them) and as functions invoked directly by `api/execute.ts` in the Vercel-hosted path. Gemini access is passed in via `event.secrets.GEMINI_API_KEY` — only bots listed in `GEMINI_ACTIONS` (`api/execute.ts`) receive it.

### Frontend

- `src/App.tsx` is the single route table. Unauthenticated users only see `LandingPage`; everything else requires a Medplum profile (the shared demo session).
- Patient-facing concierge flow: `PatientPickerPage` → `PatientHistoryPage` → `BookingConfirmationPage` (`src/pages/agent/**`). `PatientHistoryPage` hosts the chat (`BookingChat.tsx` + `bookingChatModel.ts`) directly — search, refinement, option selection, and confirmation all happen in place, driven by `bookingAgentModel.ts` (state machine) + `bookingAgentController.ts` (effects: calls `executeAction` for booking, then navigates to the confirmation page). Keep model transitions and side effects in these two files rather than in the page components.
- Doctor desk (NPI-scoped, non-patient view): `src/pages/desk/**` — `DoctorLookupPage`, `DoctorQueuePage`, `PatientAgentChatPage`.
- Legacy provider-oriented routes (`My Schedule`, `My Appointments`) are preserved only as redirects (`operatorMode.tsx` → `LEGACY_PROVIDER_PATHS`) since a demo visitor is never an authenticated practitioner.
- Generic FHIR resource browsing (`SearchPage`, `ResourcePage`, `PatientPage`) comes from the underlying Medplum Hello World scaffold — safe to reuse for admin/debug UI.

### Data

- `data/core/` — required seed data (agent config, appointment service types, generated `example-bots.json` — gitignored, regenerated by `build:bots`).
- `data/example/` (per README) — optional demo/test-only data, not required for the app to function.
- Synthetic providers come from NPPES lookups or are seeded; `AGENT_OVERVIEW.md` and `2d9a129`/`32ab63a` history cover synthetic NPI identifier handling if you touch provider matching.

## Testing conventions

- Vitest with `globals: true` — no need to import `describe`/`test`/`expect`. React component tests use `@vitejs/plugin-react`.
- Tests live beside implementation as `*.test.ts(x)`, one per module — follow that colocation for new code.
- `vitest.config.js` excludes `medplum/` and `medplum-scheduling-demo/` — gitignored reference clones kept at repo root for source fact-checking, not part of this project. Don't add tests there and don't treat their presence as part of the app.
- ESLint config extends `@medplum/eslint-config`; several stylistic rules are relaxed project-wide (see `eslint.config.mjs`) — don't re-enable them piecemeal in new code.
