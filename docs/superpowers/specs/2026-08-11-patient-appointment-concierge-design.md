# Patient Appointment Concierge Design

## Objective

Deliver one patient-facing appointment agent that accepts a natural-language complaint and scheduling preferences, returns the three best currently bookable doctor-and-time options from distinct providers in the next seven days, and books one option only after explicit confirmation.

The implementation must reuse the repository's existing intake, specialty normalization, NPPES search, previous-doctor lookup, practitioner/schedule provisioning, Medplum `Appointment/$find`, and authoritative `Appointment/$book` code. It must not introduce a general autonomous tool loop or a new persistence service.

## Scope

The agent exposes exactly two capabilities:

1. `find_bookable_options`: interpret the request, route it to a supported scheduling specialty, extract the three supported preferences, search doctors and availability, and return the best slot for each of up to three distinct providers.
2. `book_appointment`: reuse the existing `agent-book-appointment` action to revalidate and book one selected option after a separate confirmation step.

Out of scope: appointment-status lookup, booking cancellation or rescheduling, patient-side specialty revision after routing, persistent learned preferences, cross-session chat memory, diagnosis, treatment advice, urgency assessment, Neo4j, and a separate Brain/memory service.

## Patient Interaction

Example input:

> I have had pain in my throat and constant coughing for the past two days. Find me a nearby doctor. I prefer mornings and someone I've seen before.

The patient-facing result begins directly with `Here are the best available options:`. It does not expose the inferred specialty, the configured routing rule, the seven-day default, or the full ranking algorithm. Each option represents a distinct provider and shows that provider's best-ranked slot, doctor name, date, time, previous/new-doctor status, and distance when known. The final line is `Which option would you like to book?`

After the patient selects an option, the agent repeats the exact doctor, date, time, and distance when known, states that it has not booked yet, and asks for confirmation. Only an explicit confirmation control can call `book_appointment`. On success, the booking-confirmation page shows the doctor, specialty, schedule-local date and time with timezone, booked status, appointment ID, and NPI.

## Routing

The existing Gemini intake call proposes one specialty, reason, and pre-visit summary. Its output is normalized against `SPECIALTY_TABLE`; unsupported output cannot reach doctor search.

Routing behavior is:

- Explicit specialty or referral: use it.
- Complaint with a clear configured mapping: use the mapping.
- Ambiguous complaint: ask one clarification.
- No specialty preference: use `General Practice`.

The clarification allowance is stored in page state. If the second intake attempt is still ambiguous, the agent stops with an unable-to-match message. Patient-side specialty correction or revision is not included.

## Preferences and Ranking

Exactly three request-scoped preferences are extracted:

- `timeOfDay`: `morning`, `afternoon`, or `evening`.
- `preferPreviousDoctor`: whether a matching doctor from patient history is preferred.
- `preferNearby`: whether shorter distance is preferred.

Preferences are soft ranking signals, not filters. The deterministic lexicographic order is:

1. Preferred time-of-day match.
2. Previous matching doctor.
3. Shorter known distance.
4. Earlier slot start.

Unresolvable distance sorts after known distance only when proximity was requested. The tool returns at most three options. The search window starts now and ends seven days later; it is not silently expanded.

## Architecture

The browser owns a small deterministic state machine: collecting request, loading options, showing options, awaiting confirmation, booking, and error. Gemini is called only through the existing server-side intake boundary. It interprets the complaint and proposes structured routing and preferences. Server-side code validates every enum and specialty.

`agent-find-bookable-options` composes existing functions. It calls intake, calls doctor discovery, provisions schedules for a small bounded candidate set, calls Medplum `Appointment/$find`, flattens the proposed appointments into bookable options, and sorts them with a pure ranking function. It returns the authoritative intake `Communication` id required by booking.

The existing `agent-book-appointment` remains the only booking writer. It re-reads the Patient, Practitioner, Schedule, PractitionerRole, HealthcareService, and intake Communication, reruns `$find`, validates the fresh proposal, calls `$book`, and returns either a booked Appointment or `slot_taken`.

## Memory

Temporary page state contains the complaint, clarification count, extracted preferences, normalized intent, returned options, selected option, summary Communication id, and confirmation state. This state may be lost on refresh; that is acceptable for this POC.

Persistent facts remain in Medplum: Patient address, Encounter history, Practitioner and Schedule resources, intake Communication, and booked Appointment. Previous-doctor preference is evaluated from fresh Encounter data, not model memory. Preferences are not saved for later sessions.

## Deterministic and Non-Deterministic Boundaries

Non-deterministic responsibilities are limited to interpreting the complaint, proposing a supported specialty, extracting preference intent, composing the pre-visit summary, and generating short conversational copy when needed.

Deterministic responsibilities include patient binding, schema and enum validation, specialty allowlisting, the one-clarification limit, the seven-day window, time-of-day bucketing, doctor and appointment queries, schedule provisioning, availability lookup, ranking, option selection state, the explicit confirmation gate, booking revalidation, booking, and final appointment facts.

The model may interpret and phrase. It may not invent doctors or slots, choose the ranking order, bypass confirmation, or write an Appointment.

## Failure Behavior

- Unsupported specialty after one clarification: stop and show an unable-to-match message.
- No doctors or no slots in seven days: show that no appointments were found; do not expand constraints automatically.
- Individual candidate provisioning or availability failure: omit that candidate and continue; fail the action only when every bounded candidate fails.
- Selected slot taken during booking: remove that option and return to the remaining results; do not repeat intake or create a duplicate summary.
- Authentication, configuration, Gemini, or Medplum failure: use the existing generic action error boundary and never expose secrets or raw upstream errors.

## Verification

Tests must prove preference parsing and validation, general-care fallback, one-clarification behavior, exact seven-day lookup, deterministic ranking priority, three-option cap, grounded patient copy, explicit confirmation before booking, `slot_taken` refresh, API action registration, and preservation of the existing booking validation tests.

Final gates are TypeScript, ESLint, focused Vitest files, full Vitest, and production build.
