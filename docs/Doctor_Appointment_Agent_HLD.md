# Doctor Appointment Agent — High-Level Design (HLD)

This sits above `Doctor_Appointment_Agent_Design.md` (which covers module
responsibilities, the API surface, scheduling specifics, error handling, and
testing) — this document covers the system-level view: context, architecture,
primary flow, external interfaces, and what's explicitly out of scope for a
POC. Full requirements/scope live in `Doctor_Appointment_Agent_Context.md`.

## 1. Purpose & Scope

Demonstrate an AI agent that turns a patient's brief natural-language
appointment request into a booked appointment, by combining real patient
history (Medplum), real doctor discovery (NPPES), and synthetic-but-realistic
scheduling (Medplum-native, see Design doc §5). Non-goals unchanged from the
context doc: no diagnosis, no clinical decision support, no cancellations/
waitlists/reminders/recurrence.

## 2. System Context

```mermaid
flowchart LR
    User((Patient/User))
    App[Doctor Appointment Agent]
    Medplum[(Medplum\nFHIR platform)]
    NPPES[NPPES\nDoctor Registry]
    LLMProvider[LLM Provider]

    User -->|uses| App
    App -->|patient history,\nscheduling data| Medplum
    App -->|doctor discovery| NPPES
    App -->|specialty/intent\nextraction| LLMProvider
```

The application itself owns no clinical or scheduling datastore — Medplum is
the system of record for both (see Design doc §2, §5). NPPES and the LLM
provider are read-only external dependencies.

## 3. High-Level Architecture

```mermaid
flowchart TB
    subgraph Client
        UI[Streamlit UI]
    end
    subgraph Backend [FastAPI backend]
        API[api/ routers]
        PAT[patients/]
        INT[intent/]
        DIR[directory/]
        SCH[scheduling/]
        BOOK[booking/]
    end
    MED[(Medplum)]
    NPPES[NPPES API]
    LLM[LLM Provider]

    UI --> API
    API --> PAT --> MED
    API --> INT --> LLM
    API --> DIR --> NPPES
    API --> SCH --> MED
    API --> BOOK --> MED
```

Single FastAPI service, no microservices — see Design doc §3 for why, and for
each module's exact responsibility.

## 4. Primary Flow (Sequence)

Covers the full 12-step workflow from the context doc, end to end:

```mermaid
sequenceDiagram
    actor U as User
    participant UI as Streamlit UI
    participant API as FastAPI
    participant LLM as LLM Provider
    participant MED as Medplum
    participant NPPES as NPPES

    U->>UI: Select demo patient
    UI->>API: GET /patients/{id}/history
    API->>MED: fetch Patient, Condition, MedicationRequest,\nAllergyIntolerance, Encounter(+Practitioner/Org)
    MED-->>API: history bundle
    API-->>UI: patient history

    U->>UI: Enter 1-2 sentence appointment request
    UI->>API: POST /requests {patient_id, text}
    API->>LLM: extract specialty/reason
    LLM-->>API: {specialty, reason}
    API-->>UI: extracted specialty

    UI->>API: GET /doctors?specialty=&near=
    alt previous physician of this specialty exists
        API-->>UI: previous physician option(s) + "search new"
    else no previous match
        API->>NPPES: search by specialty + location
        NPPES-->>API: candidate doctors
        API-->>UI: doctor list
    end

    U->>UI: Pick a doctor
    UI->>API: GET /doctors/{npi}/slots
    API->>MED: (lazily create Practitioner/Schedule if new) + $find
    MED-->>API: open slots
    API-->>UI: available slots

    U->>UI: Pick a slot, confirm
    UI->>API: POST /appointments {patient_id, npi, slot}
    API->>MED: $hold
    alt slot still available
        API->>MED: $confirm
        MED-->>API: booked Appointment
        API-->>UI: confirmation
    else slot taken concurrently
        MED-->>API: hold rejected
        API-->>UI: 409, re-fetch slots
    end
```

## 5. External Interfaces & Dependencies

| System | Direction | What we use it for | Auth |
|---|---|---|---|
| Medplum | Read/write | Patient history (Patient, Condition, MedicationRequest, AllergyIntolerance, Encounter, Practitioner, Organization); scheduling (Schedule, Slot, Appointment via `$find`/`$hold`/`$confirm`) | Medplum project credentials (client credentials / API key, per Medplum's auth model) |
| NPPES | Read-only | Doctor discovery by specialty/location when no previous physician fits | Public API, no auth required |
| LLM Provider | Read-only (stateless call) | One structured-output call per request: NL text → `{specialty, reason, urgency}` | API key |

No other external systems. Confirmed in `Real_Appointment_Data_Research.md`
that no real appointment-availability feed is being integrated.

## 6. Data Entities (at a glance)

Full field-level shape lives in the Design doc / eventual LLD; this is just
the entity inventory and where each lives:

- **In Medplum (clinical):** `Patient`, `Condition`, `MedicationRequest`,
  `AllergyIntolerance`, `Encounter`
- **In Medplum (scheduling, Medplum-native per Design §5):** `Practitioner`
  (mirrored from NPPES), `Organization`, `Schedule`, `Slot`, `Appointment`
- **Not persisted anywhere:** NPPES search results for doctors not yet booked
  against (only mirrored into Medplum lazily, on first scheduling request)

## 7. Deployment View

```mermaid
flowchart LR
    subgraph Docker Compose
        UI[ui: Streamlit]
        API[api: FastAPI]
    end
    MED[(Medplum project\nmanaged or self-hosted)]
    NPPES[NPPES API]
    LLM[LLM Provider API]

    UI --> API
    API --> MED
    API --> NPPES
    API --> LLM
```

Two containers only. Medplum, NPPES, and the LLM provider are external
services, not part of this app's compose file.

## 8. Assumptions & Constraints

- Single local user at a time; the app is a demo, not a multi-tenant service.
- English-only natural-language requests.
- US doctors only (NPPES is a US national registry).
- No authentication/session layer beyond what's needed to demo the workflow —
  access control for real patient data is Medplum's responsibility, not
  something this app builds on top.
- No SLAs, load targets, or scaling design — explicitly out of scope for a
  POC (see §9).

## 9. Non-Functional Considerations (explicitly out of scope for this POC)

- **Scalability/multi-tenancy** — not designed; single-user demo only.
- **Performance targets** — none set; correctness of the flow matters more
  than latency for a POC.
- **Security/compliance hardening** — relies entirely on Medplum's own
  compliance posture (HITRUST-certified per `Real_Appointment_Data_Research.md`
  discussion); this app adds no additional access-control layer.
- **Observability** (logging/metrics/tracing) — not designed; manual
  walkthrough is the verification method per Design doc §8.

## 10. Out of Scope

Unchanged from the context doc: diagnosis, adaptive questionnaires, clinical
decision support, medication recommendations, cancellations, waitlists,
reminders, recurring appointments.

## 11. Related Documents

- `Doctor_Appointment_Agent_Context.md` — requirements, scope, original data-source research
- `Doctor_Appointment_Agent_Design.md` — module responsibilities, API surface, scheduling design, error handling, testing
- `Real_Appointment_Data_Research.md` — research behind the decision to use synthetic scheduling
