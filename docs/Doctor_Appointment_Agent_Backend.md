# Doctor Appointment Agent — Backend Structure

Concrete project layout for the FastAPI backend described in the Design doc
and HLD. No code yet exists — this is the structure to scaffold against.

## Repository Layout

```
app/
  main.py                 # FastAPI app creation, router registration, startup config load
  config.py                # env-driven settings (pydantic BaseSettings)
  core/
    medplum_client.py       # shared FHIR REST client (auth, base request/response, retries)
    exceptions.py           # domain exceptions (see below) + FastAPI exception handlers
  models/
    patient.py              # PatientSummary, PatientHistory, Encounter-derived types
    intent.py                # Intent (specialty, reason, urgency)
    doctor.py                 # Doctor (NPPES-normalized shape)
    scheduling.py            # SlotView, HeldAppointment, ConfirmedAppointment, BookingResult
  patients/
    service.py               # list_demo_patients, get_patient_history, find_previous_practitioner_by_specialty
  intent/
    service.py                # extract_intent
    prompts.py                # prompt template + structured-output schema for the LLM call
  directory/
    service.py                 # search_doctors, get_doctor_by_npi
  scheduling/
    service.py                  # ensure_practitioner, ensure_schedule, get_available_slots, hold_slot, confirm_appointment
    template.py                  # NPI-seeded weekly-availability template generation
  booking/
    service.py                    # book_appointment
  api/
    patients_router.py             # GET /patients, GET /patients/{id}/history
    requests_router.py              # POST /requests
    doctors_router.py                 # GET /doctors, GET /doctors/{npi}/slots
    appointments_router.py             # POST /appointments
tests/
  smoke/
    test_intent_sanity.py           # LLM sanity smoke test (Design doc §8)
    test_booking_conflict.py         # double-booking rejection smoke test (Design doc §8)
```

`ui/` (Streamlit) is a separate top-level directory/service, out of scope for
this backend doc.

## Configuration (env vars)

| Variable | Purpose |
|---|---|
| `MEDPLUM_BASE_URL` | Medplum FHIR base URL (managed cloud project or self-hosted instance) |
| `MEDPLUM_CLIENT_ID` / `MEDPLUM_CLIENT_SECRET` | OAuth2 client-credentials auth against Medplum |
| `NPPES_BASE_URL` | NPPES registry API base URL (public, no auth) |
| `LLM_API_KEY` | Credential for the LLM provider used by `intent/` |
| `LLM_MODEL` | Model identifier for the intent-extraction call |
| `APP_PORT` | Port FastAPI listens on |

Loaded once at startup via `config.py` (pydantic `BaseSettings`), injected
into `core/medplum_client.py` and `intent/service.py` — no module reads
environment variables directly.

## Core Dependencies

- `fastapi`, `uvicorn` — web framework/server
- `pydantic` — request/response/domain models (already used by FastAPI)
- `httpx` — HTTP client for Medplum's FHIR REST API and NPPES (async-friendly,
  matches the async-for-I/O rationale in the Design doc's tech stack table).
  Medplum is accessed as a generic FHIR REST server (OAuth2 client-credentials
  + standard `GET`/`POST` on FHIR resource and operation endpoints) — no
  Medplum-specific Python SDK is assumed here.
- LLM provider's official Python client (whichever provider is chosen)

## Shared Building Blocks

- **`core/medplum_client.py`**: one client class wrapping token acquisition/
  refresh (OAuth2 client-credentials) and generic FHIR verbs — `read(type,
  id)`, `search(type, params)`, `create(resource)`, `execute_operation(type,
  id, operation, body)` (used for `$find`/`$hold`/`$confirm`). Every module
  that touches Medplum (`patients/`, `scheduling/`) depends on this, not on
  raw `httpx` calls.
- **`core/exceptions.py`**: domain exceptions —
  `PatientNotFoundError`, `IntentExtractionError`, `NoDoctorsFoundError`,
  `SlotUnavailableError` — each mapped to an HTTP status via a FastAPI
  exception handler registered in `main.py` (404, 422, 200-with-empty-list,
  409 respectively — see Design doc §7 for the error-handling rationale
  behind each).

## Module Dependency Direction

```
api/  →  patients/, intent/, directory/, scheduling/, booking/
booking/  →  scheduling/
patients/, scheduling/  →  core/medplum_client.py
directory/  →  httpx (NPPES directly; no shared client needed, no auth)
intent/  →  LLM provider client
```

No module below `api/` depends on another sibling module — `scheduling/`
does not import `patients/`, `intent/` does not import anything Medplum- or
NPPES-related. This mirrors the "usable/testable independently" property
called out in the Design doc §3.
