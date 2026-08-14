# Patient Appointment Concierge

## Agent definition

The agent is a patient-facing appointment concierge, not a diagnostic or general medical assistant.

It's a real chat: the patient describes what they need in plain language, the agent asks clarifying questions when it
needs to, investigates real availability, and proposes up to 8 grounded options — then books one only after explicit
confirmation.

## Architecture

```text
Patient (chat UI)
    |
    v
React UI + BookingChat + bookingAgentModel (selection/confirm state machine)
    |
    v
Authenticated /api/execute boundary
    |
    v
agent-booking-chat
    |- Patient context loaded once per session: name, address, phone,
    |  conditions, medications, allergies, past encounters
    |- Gemini runs a model-directed tool-calling loop (search, check
    |  availability, ask a question, or propose options — see below)
    |- Deterministic code grounds every proposed pick, caps at 8 distinct
    |  providers, and falls back to a preference-aware ranking if the
    |  model's own picks need correcting
    |
    v
Patient sees up to 8 options, or another clarifying question
    |
    +--> Doesn't like the options? Keep chatting — same session, same
    |    search history, no restart — until new options are proposed.
    |
    v
Patient selects one option
    |
    v
Explicit confirmation screen
    |
    v
agent-book-appointment
    |- Revalidate every resource from scratch
    |- Recheck slot availability
    `- Medplum $book
    |
    v
Appointment confirmation page
```

It is a fixed orchestrator, not an open-ended autonomous agent. Gemini decides which tools to call, when to ask the
patient something, and what to propose — it cannot independently choose to book, invent a provider, or exceed what
deterministic code allows.

## Its two callable actions

### 1. Booking chat

`agent-booking-chat`

Input:

- Patient ID
- The patient's next chat message
- A session ID (omitted on the first message of a search)

Functions:

- On the first message of a session: loads the patient's full context (see "Context" below) and starts a
  server-persisted transcript.
- Runs a bounded tool-calling loop (Gemini decides the order and how many steps):
  - `search_previous_physician` — find a doctor of the needed specialty the patient has already seen.
  - `search_nppes` — search NPPES near the patient's address on file (never asks the patient for it).
  - `check_availability` — real Medplum `$find` availability for one provider by NPI, only for an NPI a search
    already returned in this session.
  - `ask_clarifying_question` — pause the loop and ask the patient something.
  - `propose_options` — finalize up to 8 grounded, distinct-provider options, with the model's own reasoning per
    pick and the scheduling preferences it inferred (used only as a fallback signal, see "Preferences" below).
- Grounds, dedupes, and caps whatever the model proposes before it ever reaches the patient — it can never invent a
  provider or a time.
- The session stays resumable after options are proposed. If the patient doesn't like them, they can keep typing —
  the next message resumes the same transcript (reusing everything already searched) instead of starting over.

### 2. Book appointment

`agent-book-appointment`

Input:

- Patient ID
- Selected practitioner
- Selected schedule
- Exact start and end time
- Intake-summary reference

Functions:

- Re-reads authoritative FHIR resources.
- Confirms the practitioner matches the routed specialty.
- Confirms the schedule belongs to that practitioner.
- Confirms the schedule supports the required visit service.
- Re-runs availability for the exact slot.
- Books through Medplum's authoritative `$book` operation.
- Links the pre-visit summary to the appointment.
- Returns the booked Appointment.

Selecting an option never books it. Only clicking **Confirm booking** invokes this tool.

## Routing policy

The routing order is:

1. Explicitly named specialty or referral: use it.
2. Clear complaint with a supported mapping: map it to that specialty.
3. Ambiguous complaint: ask one clarification.
4. No clear specialist request: use General Practice.

The patient cannot revise a completed routing decision in this version. A routing-correction workflow was intentionally deferred.

## Preferences

Exactly three request-scoped preferences are supported, in this priority order:

1. Time of day: morning, afternoon, or evening.
2. A doctor previously seen by the patient.
3. Nearby provider.

Earlier availability is the final deterministic tie-breaker.

**The model makes the real selection every time.** It reasons over these preferences directly when it picks and
explains options in `propose_options` — that's the primary path, not a suggestion it can ignore. Deterministic
ranking by this same priority order only runs as a fallback, to correct two specific failure modes: the model's picks
weren't distinct providers, or it under-proposed relative to what the pool could fill. When that fallback fires, it
uses the preferences the model itself reported inferring from the patient — it never overrides a valid set of picks
the model already made.

These are soft preferences. If no perfect match exists, the agent can still return the best currently available
alternatives.

## Memory

The agent has two forms of working context:

- **Session memory**: the full tool-calling transcript (messages, tool calls, tool results) for one booking search,
  persisted server-side as a FHIR `Communication` (`ai-booking-session`). Resumable across turns, including after
  options are shown, for the life of one search.
- **Patient context**: loaded once at the start of a session — name, address, phone, conditions, medications,
  allergies, and past-encounter history (date, practitioner, specialty, organization). The model never has to ask the
  patient for anything already in this context; in particular it never asks for the patient's zip code or city, since
  `search_nppes` already searches near the address on file automatically.

It does not currently have:

- Long-term preference memory across separate booking searches
- Neo4j or a separate Brain memory service
- Patient-editable preference profiles
- Cross-session conversational memory

Preferences are not permanently saved. The pre-visit summary and successfully booked Appointment are persisted as FHIR resources.

## AI versus deterministic code

Gemini performs only the non-deterministic tasks:

- Decide which tools to call, in what order, and when it has enough information.
- Understand the complaint and route it to a specialty.
- Decide when to ask the patient a clarifying question, and what to ask.
- Select and explain up to 8 final options from the candidates it actually gathered.
- Infer the patient's scheduling preferences, for the deterministic fallback to use if needed.
- Write a short reason for the visit and a brief pre-visit summary.

Deterministic code controls:

- Supported-specialty validation
- Exact NUCC taxonomy matching
- Previous-doctor lookup
- Provider deduplication
- Availability search windows and time-zone handling
- Grounding every proposed pick against a real tool result from that session
- Distinct-provider / eight-option cap enforcement, with a preference-aware ranking fallback
- Session persistence and resumability
- Confirmation state
- Booking authorization
- Slot revalidation
- Appointment creation
- Confirmation-page details

Gemini does not book appointments and does not receive booking authority.

## Safety boundaries

The agent does not:

- Diagnose a condition
- Recommend treatment
- Assess severity or urgency
- Perform triage
- Change medication
- Invent providers or appointment times
- Ask for information already available in the patient's context (e.g. address)
- Book without confirmation
- Report a booking until Medplum confirms it

If the selected slot was taken, the agent removes that option and asks the patient to choose from the remaining options.

The API also requires an authenticated Medplum session, verifies the configured project, and accepts only allowlisted server actions.

## What the patient sees

The patient chats with the agent directly — a disclaimer banner states it only helps find and book a visit. As the
agent works, it may ask clarifying questions or, once it has enough, present up to 8 cards from distinct providers.
Each card shows:

- Doctor
- Date
- Local appointment time
- Whether they have seen the doctor before
- Approximate distance, when available

The chat input stays available even after options are shown — the patient can pick a card, or describe what they'd
like different and keep going. After selecting a card, the patient sees:

> This appointment has not been booked yet. Do you confirm the booking?

After successful booking, the confirmation page at `/agent/:patientId/confirmed/:appointmentId` shows:

- Doctor
- Specialty
- Date
- Time and timezone
- Booking status
- Appointment ID
- Provider NPI

## Current scope exclusions

This specific concierge does not yet provide standalone tools for:

- Show all my appointments
- Appointment-status lookup outside the completed booking
- Cancellation
- Rescheduling
- Routing correction
- Preference editing
- Long-term memory

`DoctorResultsPage`/`SlotPickerPage` (`/agent/:patientId/doctors`, `/agent/:patientId/doctors/:npi/slots`) still exist
as routes but are a separate, manual `BookingContext`-driven flow, currently disconnected from the chat — nothing in
the concierge above links to them.

Those capabilities can be separate future tools. The agent delivered today is deliberately focused on discovery,
preference-aware ranking, explicit confirmation, and booking.

The primary implementation is documented in `README.md`, with orchestration in `src/bots/agent/agent-booking-chat.ts`
and the authoritative booking boundary in `src/bots/agent/agent-book-appointment.ts`.
