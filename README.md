<h1 align="center">Doctor Appointment Agent</h1>
<p align="center">A synthetic patient-booking and doctor-desk POC built on Medplum.</p>
<p align="center">
<a href="https://github.com/medplum/medplum-hello-world/blob/main/LICENSE.txt">
    <img src="https://img.shields.io/badge/license-Apache-blue.svg" />
  </a>
</p>

> [!IMPORTANT]
> A signed-in Medplum account is a **demo operator**, not a doctor. Doctors are discovered from NPPES or synthetic
> patient history and represented as separate FHIR `Practitioner` resources. The Doctor Desk's NPI field only filters
> demo data; it does not establish provider identity or authorization.

This example app demonstrates the following:

- How to build a patient-booking workflow on Medplum that integrates patient and practitioner data.
- Creating [`Slots`](/docs/api/fhir/resources/slot) to manage the provider availability.
- Managing the [`Appointment`](/docs/api/fhir/resources/appointment) lifecycle: Creating, rescheduling, and canceling appointments.
- Creating an [`Encounter`](/docs/api/fhir/resources/encounter) after an appointment is completed.
- Using [Medplum React Components](https://storybook.medplum.com/?path=/docs/medplum-introduction--docs) to build a scheduling app.

## Patient Appointment Concierge

The patient-facing agent accepts a natural-language complaint and scheduling preferences, finds currently bookable
appointments in the next seven days, and books one only after explicit confirmation. It does not diagnose, recommend
treatment, or assess urgency.

Example request:

> I have had pain in my throat and constant coughing for the past two days. Find me a nearby doctor. I prefer mornings
> and someone I've seen before.

The agent supports exactly three request-scoped scheduling preferences, in this priority order:

1. Preferred time of day: morning, afternoon, or evening.
2. A matching doctor the patient has previously seen.
3. Proximity to the patient's recorded address.

Earlier availability is the deterministic final tie-breaker. Preferences are soft ranking signals and are not saved as
long-term patient preferences.

Routing follows a narrow scheduling policy:

- Use an explicitly named specialty or referral.
- Use a configured mapping for a clear complaint.
- Ask one clarification for an ambiguous complaint.
- Use General Practice when no specialty preference or clear specialist request exists.

The agent exposes two server-side actions:

- `agent-find-bookable-options` uses Gemini only to interpret the complaint and extract structured routing and
  preferences. Deterministic code validates the specialty, searches patient history and NPPES, checks Medplum
  availability, and returns the best slot from each of up to three distinct providers.
- `agent-book-appointment` revalidates the selected provider, schedule, specialty, intake summary, and slot before using
  Medplum's authoritative booking operation. The action is callable only after the patient selects an option and passes
  the explicit confirmation gate. If the slot was taken, it is removed instead of being reported as booked.

After a successful booking, the confirmation page reads the booked Appointment, Slot, Schedule, Practitioner, and
PractitionerRole from Medplum and shows the doctor, specialty, schedule-local date and time with timezone, booking
status, appointment ID, and NPI.

### Verification status

The complete synthetic workflow has been exercised live: complaint intake, three distinct provider results, preference
ranking, option selection, explicit confirmation, Medplum booking, and final booking details. The current verification
gates pass with 216 tests, a successful production TypeScript/Vite build, and a clean ESLint run.

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
- Patient agent for selecting a patient, entering a natural-language request, comparing ranked slots from distinct
  providers, confirming one option, and viewing the complete booking confirmation.
- Doctor Desk for filtering booked appointments by a doctor's NPI.
- Appointment details page to view and manage the appointment lifecycle. Legacy `My Schedule` and `My Appointments`
  routes redirect to the patient agent because the signed-in account is not a practitioner.

### Getting Started

If you haven't already done so, follow the instructions in [this tutorial](https://www.medplum.com/docs/tutorials/register) to register a Medplum project to store your data.

[Fork](https://github.com/medplum/medplum-scheduling-demo/fork) and clone the repo to your local machine.

If you want to change any environment variables from the defaults, copy the `.env.defaults` file to `.env`

```bash
cp .env.defaults .env
```

And make the changes you need.

Next, install the dependencies.

```bash
npm install
```

Then, build the bots

> [!WARNING]
> Bots are not on by default for Medplum projects, make sure they are enabled before proceeding.

```bash
npm run build:bots
```

Then, run the app

```bash
npm run dev
```

This app should run on `http://localhost:3000/`

### Uploading sample data

Click `Upload Core ValueSets` in the app navigation menu and then click the upload button.
Click `Upload Example Bots` in the app navigation menu and then click the upload button.
[Optional] Click `Upload Example Data` in the app navigation menu and then click the upload button.

### About Medplum

[Medplum](https://www.medplum.com/) is an open-source, API-first EHR. Medplum makes it easy to build healthcare apps quickly with less code.

Medplum supports self-hosting and provides a [hosted service](https://app.medplum.com/). Medplum Hello World uses the hosted service as a backend.

- Read our [documentation](https://www.medplum.com/docs)
- Browse our [react component library](https://storybook.medplum.com/)
- Join our [Discord](https://discord.gg/medplum)
