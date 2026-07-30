# Doctor Appointment Agent POC - Context & Design Decisions

## Goal

Build an AI-powered **Doctor Appointment Agent** that demonstrates: -
Retrieval of patient history from Medplum (FHIR) - AI understanding of a
brief appointment request - Reuse of previous care history when
appropriate - Discovery of new doctors through NPPES - Appointment
booking using a synthetic scheduling service

The POC is **not** a diagnosis or medical reasoning system.

------------------------------------------------------------------------

# Scope

Included: - Demo patients - Patient history - Brief natural language
request - Specialty identification - Previous physician lookup - New
doctor discovery - Appointment booking

Excluded: - Diagnosis - Adaptive questionnaires - Clinical decision
support - Medication recommendations - Cancellations - Waitlists -
Reminders - Recurring appointments

------------------------------------------------------------------------

# Data Sources

## Medplum

Source of truth for patient information.

Resources used: - Patient - Condition - MedicationRequest -
AllergyIntolerance - Encounter - Practitioner - Organization

The uploaded Synthea dataset confirms that encounters reference
practitioners and organizations, allowing reconstruction of previous
physician history.

------------------------------------------------------------------------

## NPPES

Used only for discovering new doctors.

Provides: - NPI - Name - Specialty - Address - Contact details

Does NOT provide: - Working hours - Appointment slots - Calendars -
Availability

------------------------------------------------------------------------

## Scheduling Service

Owned entirely by the application.

Stores: - Doctor schedules - Appointment slots - Bookings

Schedules are linked to NPPES doctors using the NPI.

------------------------------------------------------------------------

# User Workflow

1.  Select demo patient.
2.  Load patient history from Medplum.
3.  User enters a 1-2 sentence appointment request.
4.  AI determines the appointment type/specialty.
5.  AI checks previous encounter history.
6.  If a relevant previous physician exists:
    -   Offer booking with that physician.
    -   Or allow searching for a new physician.
7.  If searching for a new physician:
    -   Query NPPES.
8.  User selects a doctor.
9.  Scheduling service retrieves or creates the doctor's schedule.
10. Display available slots.
11. User books a slot.
12. Appointment confirmation.

------------------------------------------------------------------------

# Current Architecture

Patient History ↓ Medplum (FHIR) ↓ AI Agent ↓ Previous Encounter Lookup
↓ If previous physician? ├── Yes → Offer previous physician └── No →
Search NPPES ↓ Select Doctor ↓ Scheduling Service ↓ Available Slots ↓
Appointment Booking

------------------------------------------------------------------------

# Scheduling Design

The scheduling service owns: - Weekly schedules - Appointment slots -
Appointment records

## Lazy Generation

When a doctor is selected:

-   If a schedule exists:
    -   Return it.
-   Otherwise:
    -   Generate a synthetic schedule.
    -   Generate approximately 30 days of slots.
    -   Persist everything in PostgreSQL.
    -   Return the slots.

Schedules are generated only once per doctor.

------------------------------------------------------------------------

# Synthetic Schedule Strategy

Instead of random individual slots:

1.  Generate a weekly template.
2.  Generate 30-minute slots.
3.  Apply lunch breaks and off days.
4.  Randomly mark some slots as booked/unavailable.
5.  Persist permanently.

Use the doctor's NPI as the random seed so schedules are deterministic
and reproducible.

------------------------------------------------------------------------

# Big Design Question: Real Appointment Slots

## Objective

Can the application display real appointment availability for real
doctors?

## Research Summary

### Practo

Pros: - Real appointment slots internally.

Cons: - No public API. - Commercial partner access only. - Terms
prohibit using Practo data to build competing databases.

Result: **Not suitable.**

------------------------------------------------------------------------

### NPPES

Pros: - Real doctor directory.

Cons: - No scheduling information.

Result: **Cannot provide appointment availability.**

------------------------------------------------------------------------

### FHIR Scheduling APIs

FHIR defines: - Schedule - Slot - Appointment

However these are standards implemented by individual healthcare
providers (Epic, Cerner, Athena, etc.). There is no nationwide endpoint
that maps arbitrary NPIs to live availability.

Result: **Not usable as a universal scheduling source.**

------------------------------------------------------------------------

### Commercial Scheduling Platforms

Examples: - NexHealth - Athena - DrChrono - Eka Care

These expose real appointment slots only for practices integrated with
their platform and generally require provider authorization.

Result: **Not compatible with arbitrary NPPES doctors.**

------------------------------------------------------------------------

### Web Scraping

Possible but rejected because of: - Legal concerns - Terms of Service -
Fragility - Anti-bot protections

Result: **Rejected.**

------------------------------------------------------------------------