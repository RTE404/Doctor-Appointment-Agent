<h1 align="center">Doctor Appointment Agent</h1>
<p align="center">A synthetic patient-booking and doctor-desk POC built on Medplum.</p>
<p align="center">
<a href="https://github.com/medplum/medplum-hello-world/blob/main/LICENSE.txt">
    <img src="https://img.shields.io/badge/license-Apache-blue.svg" />
  </a>
</p>

> [!IMPORTANT]
> Visitors enter one shared demo code; they do not need Medplum accounts. Everyone uses the same read-only browser
> ClientApplication and therefore shares the same synthetic data and browser audit identity. Mutations run through a
> separate server-only worker ClientApplication. Doctors are separate FHIR
> `Practitioner` resources discovered from NPPES or synthetic patient history. This setup is for synthetic demo data
> only, never real patient data.

This example app demonstrates the following:

- How to build a patient-booking workflow on Medplum that integrates patient and practitioner data.
- Creating [`Slots`](/docs/api/fhir/resources/slot) to manage the provider availability.
- Managing the [`Appointment`](/docs/api/fhir/resources/appointment) lifecycle: Creating, rescheduling, and canceling appointments.
- Creating an [`Encounter`](/docs/api/fhir/resources/encounter) after an appointment is completed.
- Using [Medplum React Components](https://storybook.medplum.com/?path=/docs/medplum-introduction--docs) to build a scheduling app.

## Patient Appointment Concierge

The patient-facing agent is a real chat: the patient describes what they need in plain language, the agent asks
clarifying questions when it needs to, searches for currently bookable appointments, and proposes options — and books
one only after explicit confirmation. It does not diagnose, recommend treatment, or assess urgency.

Example request:

> I have had pain in my throat and constant coughing for the past two days. Find me a nearby doctor. I prefer mornings
> and someone I've seen before.

Behind the chat, Gemini runs a model-directed tool-calling loop: it decides which tools to call and when (search the
patient's previous doctors, search NPPES for other providers, check real Medplum availability), when it has enough
information, and when it needs to ask the patient something instead. Deterministic code still controls everything
safety-critical — specialty validation, grounding every proposed pick against a real availability result the tools
actually returned, a distinct-provider cap of 8, and the entire booking path.

If none of the proposed options are a good fit, the patient isn't stuck: the chat input stays open after options are
shown, so they can reply with what they'd like different ("something in the afternoon instead", "not Dr. Lin, someone
else") and the agent picks the search back up — reusing what it already found rather than starting over — until it
proposes a new set of options.

The agent weighs three request-scoped scheduling preferences, in this priority order, when it explains and picks
options: preferred time of day (morning/afternoon/evening), a doctor the patient has previously seen, and proximity to
the patient's recorded address, with earlier availability as the final tie-breaker. These aren't just prompt guidance
— the same priority order is enforced deterministically as a ranking floor whenever the model's own picks don't
already satisfy the distinct-provider cap. Preferences are soft, request-scoped signals, not saved as long-term
patient preferences.

Routing follows a narrow scheduling policy:

- Use an explicitly named specialty or referral.
- Use a configured mapping for a clear complaint.
- Ask one clarification for an ambiguous complaint.
- Use General Practice when no specialty preference or clear specialist request exists.

The agent exposes two server-side actions:

- `agent-booking-chat` interprets each chat message with Gemini and runs the tool-calling loop described above.
  Deterministic code validates the specialty, searches patient history and NPPES, checks Medplum availability, and
  grounds and caps whatever the model proposes at up to 8 distinct providers before returning it to the patient.
- `agent-book-appointment` revalidates the selected provider, schedule, specialty, intake summary, and slot before using
  Medplum's authoritative booking operation. The action is callable only after the patient selects an option and passes
  the explicit confirmation gate. If the slot was taken, it is removed instead of being reported as booked.

After a successful booking, the confirmation page reads the booked Appointment, Slot, Schedule, Practitioner, and
PractitionerRole from Medplum and shows the doctor, specialty, schedule-local date and time with timezone, booking
status, appointment ID, and NPI.

### Verification status

The complete synthetic workflow has been exercised live: multi-turn chat intake, grounded provider/slot search, up to
8 distinct provider results, conversational refinement, explicit confirmation, Medplum booking, and final booking
details. Every change runs the full automated test suite, ESLint, and a production TypeScript/Vite build.

### Code Organization

This repo is organized into two main directories: `src` and `data`.

The `src` directory contains the entire app, including `pages` and `components` directories. In addition, it contains a `bots` directory which has [Medplum Bots](/packages/docs/docs/bots/index.md) for use. The bots in the `example` directory are intended to be modified or extended by users, while those in `core` can be used to handle core workflows without modification.

The `data` directory contains data that can be uploaded for use in the demo. The `example` directory contains data that is meant to be used for testing and learning, while the `core` directory contains resources, terminologies, and more that are necessary to use the demo.

### UI and components

- Patients page listing all the patients in the system.
- Patients chart page with 3 panels:
  - Clinical Chart
  - Details (including Appointments and Encounters)
  - Actions (with a button to create a new appointment)
- Patient agent for selecting a patient, describing a request in chat, comparing proposed slots from distinct
  providers, refining the search conversationally if none of them fit, confirming one option, and viewing the
  complete booking confirmation.
- Doctor Desk for filtering booked appointments by a doctor's NPI.
- Appointment details page to view and manage the appointment lifecycle. Legacy `My Schedule` and `My Appointments`
  routes redirect to the patient agent because a demo visitor is not a practitioner.

### Getting Started

Create and seed a Medplum project as described by the existing project setup. In that project, create two dedicated
Medplum `ClientApplication` resources; do not use personal account credentials:

- A browser application with an explicit read-only AccessPolicy. It may read/search the FHIR resources displayed by
  the app, but it must not have create, update, delete, or operation permissions.
- A server worker application with only the FHIR permissions and operations required by booking, intake, chat,
  rescheduling, cancellation, encounter completion, and tagged cleanup. Its token is never sent to the browser.

[Fork](https://github.com/medplum/medplum-scheduling-demo/fork) and clone the repo to your local machine.

Configure these Vercel environment variables:

- `MEDPLUM_BASE_URL`: normally `https://api.medplum.com`
- `MEDPLUM_PROJECT_ID`: the seeded demo project's ID
- `DEMO_ACCESS_CODE`: the shared code given to demo visitors
- `DEMO_MEDPLUM_CLIENT_ID`: the read-only browser ClientApplication ID
- `DEMO_MEDPLUM_CLIENT_SECRET`: the browser ClientApplication secret, used only by `/api/demo-session`
- `DEMO_WORKER_CLIENT_ID`: the server-only worker ClientApplication ID
- `DEMO_WORKER_CLIENT_SECRET`: the server-only worker secret
- `GEMINI_API_KEY`: used by the booking chat and patient-chat actions
- `CRON_SECRET`: a random value of at least 16 characters used by Vercel Cron

`DEMO_ACCESS_CODE`, both ClientApplication secrets, `GEMINI_API_KEY`, and `CRON_SECRET` must never be committed or
exposed to browser code. There is intentionally no rate limiter, so use a non-trivial shared code and rotate it if it
is distributed beyond the intended demo audience.

Administrative seed and direct Bot-deploy tools use `SEED_MEDPLUM_CLIENT_ID` and `SEED_MEDPLUM_CLIENT_SECRET`. Keep
those credentials local to the administrator; the public app does not use them.

For local work without Vercel integration, copy `.env.defaults` to `.env` and fill in local-only values:

```bash
cp .env.defaults .env
```

And make the changes you need.

Next, install the dependencies.

```bash
npm install
```

Then, build the bots if the Medplum-hosted Bot deployment is part of your setup:

> [!WARNING]
> Bots are not on by default for Medplum projects, make sure they are enabled before proceeding.

```bash
npm run build:bots
```

To run the complete app locally, including its `/api` functions, link the repository to Vercel and use:

```bash
npx vercel dev
```

This app should run on `http://localhost:3000/`

### Shared session behavior

- The code exchange returns only a short-lived token for the read-only browser ClientApplication. Both
  ClientApplication secrets and the worker token stay on the server.
- Browser writes are denied by Medplum. The app sends only allowlisted actions to `/api/execute`, which re-reads and
  validates trusted FHIR resources before the server-only worker performs a mutation.
- The browser keeps the token in the current tab's `sessionStorage`. Reloading the tab works; closing it ends that local session.
- Signing out or closing the tab does not delete booked appointments. Data cleanup is handled by the daily reset.

### Daily demo reset

Vercel calls `/api/reset-demo` daily using `CRON_SECRET`. The configured schedule is `30 20 * * *`, which is 02:00
IST. Vercel Hobby may invoke a once-daily cron at any point within that hour, so the practical window is approximately
01:30-02:29 IST.

The reset cancels and deletes only Appointments, Communications, and Encounters carrying the app's `demo-generated` FHIR tag.
Seeded Patients, clinical history, NPPES Practitioners, Schedules, and untagged resources are preserved. Core data
upload is intentionally not exposed in the public demo navigation; seed it as an administrative setup step instead.

### About Medplum

[Medplum](https://www.medplum.com/) is an open-source, API-first EHR. Medplum makes it easy to build healthcare apps quickly with less code.

Medplum supports self-hosting and provides a [hosted service](https://app.medplum.com/). Medplum Hello World uses the hosted service as a backend.

- Read our [documentation](https://www.medplum.com/docs)
- Browse our [react component library](https://storybook.medplum.com/)
- Join our [Discord](https://discord.gg/medplum)
