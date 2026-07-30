# Doctor Appointment Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Doctor Appointment Agent POC end to end — a FastAPI backend (Medplum for all data, NPPES for doctor discovery, one LLM call for intent extraction) plus a minimal Streamlit UI, per the specs already written in `docs/`.

**Architecture:** Single FastAPI service organized into independent modules (`patients/`, `intent/`, `directory/`, `scheduling/`, `booking/`, `api/`) all built on a shared `MedplumClient`; a one-time import script populates Medplum from the Synthea/Kaggle FHIR dataset with specialty enrichment; a Streamlit script calls the API over HTTP.

**Tech Stack:** Python, FastAPI, Streamlit, httpx, pydantic / pydantic-settings, the `openai` Python client pointed at Google Gemini's free-tier OpenAI-compatible endpoint (no paid API usage), pytest / pytest-asyncio.

## Global Constraints

(Copied verbatim from the specs in `docs/` — every task below implicitly includes these.)

- Backend: Python + FastAPI. Frontend: Streamlit, minimal, no React/Next (Design doc §2).
- **Medplum is the only datastore** — no separate application database, for either patient data or scheduling (Design doc §2, §5).
- Doctor discovery for new doctors: NPPES API, live lookup (Design doc §2).
- AI surface is one structured-output LLM call per request for specialty/intent extraction — no open-ended agent loop (Design doc §2). Uses Google Gemini's genuinely-free API tier (no credit card, via `aistudio.google.com`) through its OpenAI-compatible endpoint, so no paid API usage is required anywhere in this project.
- Slot granularity: 30 minutes (Data Model doc, `Slot`).
- Doctor's NPI is used as a deterministic seed for weekly schedule-template generation (Design doc §5).
- **No fake pre-booked/historical slots** — schedules start fully open; only real booking actions ever create an `Appointment` (Design doc §5).
- Booking is atomic via Medplum's `$hold` → `$confirm` — no custom transaction/locking code (Design doc §5).
- Testing is intentionally trimmed: a manual walkthrough checklist plus two targeted smoke tests (LLM sanity check, double-booking rejection) — not a full unit/integration/e2e pyramid (Design doc §8). Per-module unit tests below are still written (they're cheap and each task needs its own test cycle), but no additional test tiers beyond what's specified are added.
- Patient/clinical data comes from a pre-existing Synthea-generated FHIR bundle dataset (983 patient bundles, `fhir/` folder, sourced via Kaggle) imported into Medplum ahead of runtime — the app never generates patient data itself (Data Model doc).
- Two doctor pools: **previous physicians** (from the imported dataset, specialty enriched at import time via `Disease_Description.csv`) and **new doctors** (NPPES, real specialty) — downstream code treats both uniformly once `qualification[].code` is populated (Data Model doc, "Two Doctor Pools").
- Non-goals: no diagnosis, no clinical decision support, no medication recommendations, no cancellations/waitlists/reminders/recurring appointments (Context doc, Design doc §1).
- Single local user at a time; no auth/session layer beyond what's needed to demo the flow (HLD §8).

---

## Task 1: Project Scaffolding & Configuration

**Files:**
- Create: `requirements.txt`
- Create: `.env.example`
- Create: `app/__init__.py`
- Create: `app/config.py`
- Create: `pytest.ini`
- Test: `tests/test_config.py`

**Interfaces:**
- Produces: `Settings` (pydantic `BaseSettings` subclass) with fields `medplum_base_url: str`, `medplum_client_id: str`, `medplum_client_secret: str`, `nppes_base_url: str = "https://npiregistry.cms.hhs.gov/api/"`, `llm_api_key: str`, `llm_base_url: str = "https://generativelanguage.googleapis.com/v1beta/openai/"`, `llm_model: str = "gemini-2.5-flash-lite"`, `app_port: int = 8000`; and `get_settings() -> Settings` (an `lru_cache`d factory — **not** a module-level singleton, so importing `app.config` never fails due to missing env vars).

- [ ] **Step 1: Write `requirements.txt`**

```
fastapi==0.115.0
uvicorn[standard]==0.30.6
pydantic==2.9.2
pydantic-settings==2.5.2
httpx==0.27.2
openai==1.51.0
streamlit==1.38.0
pytest==8.3.3
pytest-asyncio==0.24.0
```

- [ ] **Step 2: Write `.env.example`**

```
MEDPLUM_BASE_URL=https://api.medplum.com
MEDPLUM_CLIENT_ID=
MEDPLUM_CLIENT_SECRET=
NPPES_BASE_URL=https://npiregistry.cms.hhs.gov/api/
# Free tier via Google AI Studio (aistudio.google.com) — no credit card required.
# Get LLM_API_KEY there; the OpenAI-compatible endpoint below lets us keep using
# the `openai` Python client unchanged.
LLM_API_KEY=
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
LLM_MODEL=gemini-2.5-flash-lite
APP_PORT=8000
```

- [ ] **Step 3: Write `pytest.ini`**

```ini
[pytest]
asyncio_mode = auto
```

- [ ] **Step 4: Write the failing test**

```python
# tests/test_config.py
from app.config import Settings

def test_settings_loads_from_env(monkeypatch):
    monkeypatch.setenv("MEDPLUM_BASE_URL", "https://api.medplum.example")
    monkeypatch.setenv("MEDPLUM_CLIENT_ID", "id123")
    monkeypatch.setenv("MEDPLUM_CLIENT_SECRET", "secret123")
    monkeypatch.setenv("LLM_API_KEY", "key123")
    settings = Settings()
    assert settings.medplum_base_url == "https://api.medplum.example"
    assert settings.nppes_base_url == "https://npiregistry.cms.hhs.gov/api/"
    assert settings.llm_base_url == "https://generativelanguage.googleapis.com/v1beta/openai/"
    assert settings.app_port == 8000

def test_get_settings_is_cached(monkeypatch):
    monkeypatch.setenv("MEDPLUM_BASE_URL", "https://api.medplum.example")
    monkeypatch.setenv("MEDPLUM_CLIENT_ID", "id123")
    monkeypatch.setenv("MEDPLUM_CLIENT_SECRET", "secret123")
    monkeypatch.setenv("LLM_API_KEY", "key123")
    from app.config import get_settings
    assert get_settings() is get_settings()
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pip install -r requirements.txt && pytest tests/test_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.config'` (or import error — `app/config.py` doesn't exist yet)

- [ ] **Step 6: Write `app/__init__.py` (empty) and `app/config.py`**

```python
# app/config.py
from functools import lru_cache
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    medplum_base_url: str
    medplum_client_id: str
    medplum_client_secret: str
    nppes_base_url: str = "https://npiregistry.cms.hhs.gov/api/"
    llm_api_key: str
    llm_base_url: str = "https://generativelanguage.googleapis.com/v1beta/openai/"
    llm_model: str = "gemini-2.5-flash-lite"
    app_port: int = 8000

    class Config:
        env_file = ".env"

@lru_cache
def get_settings() -> Settings:
    return Settings()
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pytest tests/test_config.py -v`
Expected: PASS (2 passed)

- [ ] **Step 8: Commit**

```bash
git init
git add requirements.txt .env.example pytest.ini app/__init__.py app/config.py tests/test_config.py
git commit -m "chore: scaffold project, add settings"
```

---

## Task 2: Domain Models

**Files:**
- Create: `app/models/__init__.py`
- Create: `app/models/patient.py`
- Create: `app/models/intent.py`
- Create: `app/models/doctor.py`
- Create: `app/models/scheduling.py`
- Test: `tests/models/test_models.py`

**Interfaces:**
- Consumes: nothing (pure data classes).
- Produces: `PatientSummary`, `ConditionSummary`, `MedicationSummary`, `AllergySummary`, `PractitionerSummary`, `EncounterSummary`, `PatientHistory` (`app/models/patient.py`); `Intent` (`app/models/intent.py`); `DoctorAddress`, `Doctor` (`app/models/doctor.py`); `SlotView`, `HeldAppointment`, `ConfirmedAppointment`, `BookingResult` (`app/models/scheduling.py`). Every later task imports from these exact modules/names.

- [ ] **Step 1: Write the failing test**

```python
# tests/models/test_models.py
from app.models.patient import PatientSummary, PatientHistory
from app.models.intent import Intent
from app.models.doctor import Doctor, DoctorAddress
from app.models.scheduling import SlotView, HeldAppointment, ConfirmedAppointment, BookingResult

def test_patient_summary_roundtrip():
    p = PatientSummary(id="p1", display_name="John Doe", birth_date="1980-01-01")
    assert p.model_dump()["display_name"] == "John Doe"

def test_intent_requires_literal_urgency():
    intent = Intent(specialty="Cardiology", reason="chest pain", urgency="urgent")
    assert intent.urgency == "urgent"

def test_doctor_model():
    d = Doctor(
        npi="1234567890", first_name="Jane", last_name="Smith", specialty="Cardiology",
        address=DoctorAddress(line="1 Main St", city="Boston", state="MA", postal_code="02101"),
    )
    assert d.address.city == "Boston"

def test_booking_result_wraps_confirmed_appointment():
    confirmed = ConfirmedAppointment(
        appointment_id="a1", status="booked", start_time="2026-08-01T09:00:00",
        end_time="2026-08-01T09:30:00", practitioner_name="Dr. Smith", patient_id="p1",
    )
    result = BookingResult(status="confirmed", appointment=confirmed)
    assert result.appointment.appointment_id == "a1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/models/test_models.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.models'`

- [ ] **Step 3: Write `app/models/__init__.py` (empty) and the four model files**

```python
# app/models/patient.py
from datetime import date
from pydantic import BaseModel

class PatientSummary(BaseModel):
    id: str
    display_name: str
    birth_date: date | None = None

class PractitionerSummary(BaseModel):
    id: str
    name: str
    specialty: str | None = None

class ConditionSummary(BaseModel):
    id: str
    text: str

class MedicationSummary(BaseModel):
    id: str
    text: str

class AllergySummary(BaseModel):
    id: str
    text: str

class EncounterSummary(BaseModel):
    id: str
    reason: str | None = None
    period_start: str | None = None
    practitioner: PractitionerSummary | None = None
    organization_name: str | None = None

class PatientHistory(BaseModel):
    patient: PatientSummary
    conditions: list[ConditionSummary]
    medications: list[MedicationSummary]
    allergies: list[AllergySummary]
    encounters: list[EncounterSummary]
    previous_practitioners: list[PractitionerSummary]
```

```python
# app/models/intent.py
from typing import Literal
from pydantic import BaseModel

class Intent(BaseModel):
    specialty: str
    reason: str
    urgency: Literal["routine", "urgent"]
```

```python
# app/models/doctor.py
from pydantic import BaseModel

class DoctorAddress(BaseModel):
    line: str
    city: str
    state: str
    postal_code: str

class Doctor(BaseModel):
    npi: str
    first_name: str
    last_name: str
    specialty: str
    address: DoctorAddress
    phone: str | None = None
```

```python
# app/models/scheduling.py
from datetime import datetime
from pydantic import BaseModel

class SlotView(BaseModel):
    schedule_id: str
    start_time: datetime
    end_time: datetime

class HeldAppointment(BaseModel):
    appointment_id: str
    status: str

class ConfirmedAppointment(BaseModel):
    appointment_id: str
    status: str
    start_time: datetime
    end_time: datetime
    practitioner_name: str
    patient_id: str

class BookingResult(BaseModel):
    status: str
    appointment: ConfirmedAppointment
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/models/test_models.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add app/models/ tests/models/
git commit -m "feat: add domain models"
```

---

## Task 3: Core Exceptions

**Files:**
- Create: `app/core/__init__.py`
- Create: `app/core/exceptions.py`
- Test: `tests/core/test_exceptions.py`

**Interfaces:**
- Produces: `AppError` (base), `MedplumAuthError`, `MedplumNotFoundError`, `MedplumOperationError(message, status_code)`, `PatientNotFoundError`, `DoctorNotFoundError`, `IntentExtractionError`, `SlotUnavailableError` — all in `app/core/exceptions.py`. Every later task that raises/catches a domain error imports from here.

- [ ] **Step 1: Write the failing test**

```python
# tests/core/test_exceptions.py
from app.core.exceptions import AppError, MedplumOperationError, PatientNotFoundError

def test_domain_errors_inherit_from_app_error():
    assert issubclass(PatientNotFoundError, AppError)

def test_medplum_operation_error_carries_status_code():
    err = MedplumOperationError("conflict", status_code=409)
    assert err.status_code == 409
    assert str(err) == "conflict"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/core/test_exceptions.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.core'`

- [ ] **Step 3: Write `app/core/__init__.py` (empty) and `app/core/exceptions.py`**

```python
# app/core/exceptions.py
class AppError(Exception):
    """Base class for all domain errors in this app."""

class MedplumAuthError(AppError):
    pass

class MedplumNotFoundError(AppError):
    pass

class MedplumOperationError(AppError):
    def __init__(self, message: str, status_code: int):
        super().__init__(message)
        self.status_code = status_code

class PatientNotFoundError(AppError):
    pass

class DoctorNotFoundError(AppError):
    pass

class IntentExtractionError(AppError):
    pass

class SlotUnavailableError(AppError):
    pass
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/core/test_exceptions.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add app/core/__init__.py app/core/exceptions.py tests/core/test_exceptions.py
git commit -m "feat: add domain exceptions"
```

---

## Task 4: Medplum Client

**Files:**
- Create: `app/core/medplum_client.py`
- Test: `tests/core/test_medplum_client.py`

**Interfaces:**
- Consumes: `MedplumAuthError`, `MedplumNotFoundError`, `MedplumOperationError` (Task 3).
- Produces: `MedplumClient(base_url, client_id, client_secret, http_client=None)` with async methods `read(resource_type, resource_id) -> dict`, `search(resource_type, params) -> list[dict]`, `create(resource) -> dict`, `execute_operation(resource_type, resource_id, operation, body) -> dict`, `submit_bundle(bundle) -> dict`. Every module touching Medplum (Tasks 5, 6, 10, 11, 12, 13) depends on this exact interface.

- [ ] **Step 1: Write the failing tests**

```python
# tests/core/test_medplum_client.py
import httpx
import pytest
from app.core.medplum_client import MedplumClient
from app.core.exceptions import MedplumNotFoundError, MedplumOperationError

def _handler_factory(fhir_responses):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/oauth2/token"):
            return httpx.Response(200, json={"access_token": "test-token", "expires_in": 3600})
        for method, path, response in fhir_responses:
            if request.method == method and request.url.path == path:
                return response
        return httpx.Response(404, json={"error": "not mocked", "path": request.url.path})
    return handler

def _make_client(responses):
    transport = httpx.MockTransport(_handler_factory(responses))
    http_client = httpx.AsyncClient(transport=transport)
    return MedplumClient("https://medplum.test", "id", "secret", http_client=http_client)

async def test_read_returns_resource():
    client = _make_client([("GET", "/fhir/R4/Patient/123", httpx.Response(200, json={"resourceType": "Patient", "id": "123"}))])
    result = await client.read("Patient", "123")
    assert result == {"resourceType": "Patient", "id": "123"}

async def test_read_missing_raises_not_found():
    client = _make_client([("GET", "/fhir/R4/Patient/999", httpx.Response(404, json={"error": "not found"}))])
    with pytest.raises(MedplumNotFoundError):
        await client.read("Patient", "999")

async def test_search_returns_bundle_entries():
    bundle = {"resourceType": "Bundle", "entry": [{"resource": {"resourceType": "Condition", "id": "c1"}}]}
    client = _make_client([("GET", "/fhir/R4/Condition", httpx.Response(200, json=bundle))])
    result = await client.search("Condition", {"subject": "Patient/123"})
    assert result == [{"resourceType": "Condition", "id": "c1"}]

async def test_search_empty_bundle_returns_empty_list():
    client = _make_client([("GET", "/fhir/R4/Condition", httpx.Response(200, json={"resourceType": "Bundle"}))])
    result = await client.search("Condition", {})
    assert result == []

async def test_create_returns_created_resource():
    client = _make_client([("POST", "/fhir/R4/Practitioner", httpx.Response(201, json={"resourceType": "Practitioner", "id": "new-1"}))])
    result = await client.create({"resourceType": "Practitioner", "name": []})
    assert result["id"] == "new-1"

async def test_execute_operation_raises_on_error():
    client = _make_client([("POST", "/fhir/R4/Appointment/$hold", httpx.Response(409, text="conflict"))])
    with pytest.raises(MedplumOperationError) as exc_info:
        await client.execute_operation("Appointment", None, "hold", {})
    assert exc_info.value.status_code == 409

async def test_submit_bundle_posts_to_base_fhir_url():
    client = _make_client([("POST", "/fhir/R4", httpx.Response(200, json={"resourceType": "Bundle", "type": "transaction-response"}))])
    result = await client.submit_bundle({"resourceType": "Bundle", "type": "transaction", "entry": []})
    assert result["type"] == "transaction-response"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/core/test_medplum_client.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.core.medplum_client'`

- [ ] **Step 3: Write `app/core/medplum_client.py`**

```python
# app/core/medplum_client.py
import time
import httpx
from app.core.exceptions import MedplumAuthError, MedplumNotFoundError, MedplumOperationError

class MedplumClient:
    def __init__(self, base_url: str, client_id: str, client_secret: str, http_client: httpx.AsyncClient | None = None):
        self._base_url = base_url.rstrip("/")
        self._client_id = client_id
        self._client_secret = client_secret
        self._http = http_client or httpx.AsyncClient()
        self._token: str | None = None
        self._token_expiry: float = 0.0

    async def _get_token(self) -> str:
        if self._token and time.time() < self._token_expiry:
            return self._token
        response = await self._http.post(
            f"{self._base_url}/oauth2/token",
            data={
                "grant_type": "client_credentials",
                "client_id": self._client_id,
                "client_secret": self._client_secret,
            },
        )
        if response.status_code != 200:
            raise MedplumAuthError(f"Medplum auth failed: {response.status_code}")
        body = response.json()
        self._token = body["access_token"]
        self._token_expiry = time.time() + body.get("expires_in", 3600) - 30
        return self._token

    async def _headers(self) -> dict:
        token = await self._get_token()
        return {"Authorization": f"Bearer {token}"}

    async def read(self, resource_type: str, resource_id: str) -> dict:
        headers = await self._headers()
        response = await self._http.get(f"{self._base_url}/fhir/R4/{resource_type}/{resource_id}", headers=headers)
        if response.status_code == 404:
            raise MedplumNotFoundError(f"{resource_type}/{resource_id} not found")
        response.raise_for_status()
        return response.json()

    async def search(self, resource_type: str, params: dict) -> list[dict]:
        headers = await self._headers()
        response = await self._http.get(f"{self._base_url}/fhir/R4/{resource_type}", params=params, headers=headers)
        response.raise_for_status()
        bundle = response.json()
        return [entry["resource"] for entry in bundle.get("entry", [])]

    async def create(self, resource: dict) -> dict:
        headers = await self._headers()
        resource_type = resource["resourceType"]
        response = await self._http.post(f"{self._base_url}/fhir/R4/{resource_type}", json=resource, headers=headers)
        response.raise_for_status()
        return response.json()

    async def execute_operation(self, resource_type: str, resource_id: str | None, operation: str, body: dict) -> dict:
        headers = await self._headers()
        path = f"{self._base_url}/fhir/R4/{resource_type}"
        if resource_id:
            path += f"/{resource_id}"
        path += f"/${operation}"
        response = await self._http.post(path, json=body, headers=headers)
        if response.status_code >= 400:
            raise MedplumOperationError(f"{operation} failed: {response.status_code} {response.text}", status_code=response.status_code)
        return response.json()

    async def submit_bundle(self, bundle: dict) -> dict:
        headers = await self._headers()
        response = await self._http.post(f"{self._base_url}/fhir/R4", json=bundle, headers=headers)
        if response.status_code >= 400:
            raise MedplumOperationError(f"Bundle submission failed: {response.status_code} {response.text}", status_code=response.status_code)
        return response.json()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/core/test_medplum_client.py -v`
Expected: PASS (7 passed)

- [ ] **Step 5: Commit**

```bash
git add app/core/medplum_client.py tests/core/test_medplum_client.py
git commit -m "feat: add Medplum FHIR REST client"
```

---

## Task 5: Data Import & Specialty Enrichment Script

**Files:**
- Create: `scripts/__init__.py`
- Create: `scripts/specialty_mapping.py`
- Create: `scripts/import_synthea_data.py`
- Test: `tests/scripts/test_specialty_mapping.py`
- Test: `tests/scripts/test_import_synthea_data.py`

**Interfaces:**
- Consumes: `MedplumClient` (Task 4), `Disease_Description.csv` (project root, 41 rows, `Disease,Description` columns), `fhir/*.json` (project root, 983 Synthea transaction bundles).
- Produces: `resolve_specialty(reason_texts: list[str]) -> str` and `DISEASE_TO_SPECIALTY: dict[str, str]` (`scripts/specialty_mapping.py`); `collect_practitioner_reason_texts(file_paths: list[str]) -> dict[str, list[str]]` and `enrich_practitioners(bundle: dict, specialties_by_practitioner: dict[str, str]) -> dict` (`scripts/import_synthea_data.py`) — pure functions, independently testable without hitting the real dataset or Medplum.

- [ ] **Step 1: Write the failing tests for `specialty_mapping.py`**

```python
# tests/scripts/test_specialty_mapping.py
from scripts.specialty_mapping import resolve_specialty, DEFAULT_SPECIALTY, DISEASE_TO_SPECIALTY

def test_disease_to_specialty_loaded_from_csv():
    # sanity check the CSV loaded and row-count validation passed
    assert DISEASE_TO_SPECIALTY["heart attack"] == "Cardiology"
    assert DISEASE_TO_SPECIALTY["migraine"] == "Neurology"

def test_resolve_specialty_majority_vote():
    assert resolve_specialty(["Heart attack", "Heart attack", "Migraine"]) == "Cardiology"

def test_resolve_specialty_unknown_text_falls_back_to_default():
    assert resolve_specialty(["Some Unmapped Condition"]) == DEFAULT_SPECIALTY

def test_resolve_specialty_empty_list_falls_back_to_default():
    assert resolve_specialty([]) == DEFAULT_SPECIALTY

def test_resolve_specialty_is_case_and_whitespace_insensitive():
    assert resolve_specialty(["  HEART   ATTACK  "]) == "Cardiology"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/scripts/test_specialty_mapping.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'scripts.specialty_mapping'`

- [ ] **Step 3: Write `scripts/__init__.py` (empty) and `scripts/specialty_mapping.py`**

```python
# scripts/specialty_mapping.py
import csv
import os
import re

DISEASE_DESCRIPTION_CSV = os.path.join(os.path.dirname(__file__), "..", "Disease_Description.csv")

# Specialty for each disease, in the same row order as Disease_Description.csv.
# Hand-categorized for this POC — see Data Model doc's "Specialty enrichment"
# section for the full rationale and the disease list this must match.
SPECIALTIES_IN_FILE_ORDER = [
    "Allergy and Immunology",   # Drug Reaction
    "Infectious Disease",       # Malaria
    "Allergy and Immunology",   # Allergy
    "Endocrinology",            # Hypothyroidism
    "Dermatology",               # Psoriasis
    "Gastroenterology",          # GERD
    "Gastroenterology",          # Chronic cholestasis
    "Gastroenterology",          # hepatitis A
    "Orthopedics",                # Osteoarthristis
    "Otolaryngology (ENT)",        # (vertigo) Paroymsal  Positional Vertigo
    "Endocrinology",                # Hypoglycemia
    "Dermatology",                   # Acne
    "Endocrinology",                  # Diabetes
    "Dermatology",                     # Impetigo
    "Cardiology",                       # Hypertension
    "Gastroenterology",                  # Peptic ulcer diseae
    "General Surgery",                    # Dimorphic hemorrhoids(piles)
    "General Practice",                    # Common Cold
    "Infectious Disease",                   # Chicken pox
    "Orthopedics",                           # Cervical spondylosis
    "Endocrinology",                          # Hyperthyroidism
    "Urology",                                 # Urinary tract infection
    "Vascular Surgery",                         # Varicose veins
    "Infectious Disease",                        # AIDS
    "Neurology",                                  # Paralysis (brain hemorrhage)
    "Infectious Disease",                          # Typhoid
    "Gastroenterology",                             # Hepatitis B
    "Dermatology",                                   # Fungal infection
    "Gastroenterology",                               # Hepatitis C
    "Neurology",                                       # Migraine
    "Pulmonology",                                      # Bronchial Asthma
    "Gastroenterology",                                  # Alcoholic hepatitis
    "Gastroenterology",                                   # Jaundice
    "Gastroenterology",                                    # Hepatitis E
    "Infectious Disease",                                   # Dengue
    "Gastroenterology",                                      # Hepatitis D
    "Cardiology",                                             # Heart attack
    "Pulmonology",                                             # Pneumonia
    "Rheumatology",                                             # Arthritis
    "Gastroenterology",                                          # Gastroenteritis
    "Pulmonology",                                                # Tuberculosis
]

DEFAULT_SPECIALTY = "General Practice"

def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()

def _load_disease_to_specialty() -> dict[str, str]:
    with open(DISEASE_DESCRIPTION_CSV, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        diseases = [row["Disease"] for row in reader]
    if len(diseases) != len(SPECIALTIES_IN_FILE_ORDER):
        raise ValueError(
            f"Disease_Description.csv has {len(diseases)} rows but "
            f"SPECIALTIES_IN_FILE_ORDER has {len(SPECIALTIES_IN_FILE_ORDER)} entries — "
            "update SPECIALTIES_IN_FILE_ORDER to match the file."
        )
    return {_normalize(d): s for d, s in zip(diseases, SPECIALTIES_IN_FILE_ORDER)}

DISEASE_TO_SPECIALTY = _load_disease_to_specialty()

def resolve_specialty(reason_texts: list[str]) -> str:
    if not reason_texts:
        return DEFAULT_SPECIALTY
    candidates = [DISEASE_TO_SPECIALTY.get(_normalize(text)) for text in reason_texts]
    candidates = [c for c in candidates if c]
    if not candidates:
        return DEFAULT_SPECIALTY
    return max(set(candidates), key=candidates.count)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/scripts/test_specialty_mapping.py -v`
Expected: PASS (5 passed). If it fails with the row-count `ValueError`, re-count `Disease_Description.csv`'s rows and adjust `SPECIALTIES_IN_FILE_ORDER` to match exactly — do not reorder the CSV.

- [ ] **Step 5: Write the failing tests for `import_synthea_data.py`**

```python
# tests/scripts/test_import_synthea_data.py
import json
from scripts.import_synthea_data import collect_practitioner_reason_texts, enrich_practitioners

FIXTURE = {
    "resourceType": "Bundle",
    "type": "transaction",
    "entry": [
        {"resource": {"resourceType": "Practitioner", "id": "prac-1", "name": [{"family": "Smith", "given": ["Jane"]}]}},
        {"resource": {
            "resourceType": "Encounter", "id": "enc-1",
            "type": [{"text": "Heart attack"}],
            "participant": [{"individual": {"reference": "urn:uuid:prac-1"}}],
        }},
    ],
}

def test_collect_practitioner_reason_texts(tmp_path):
    fixture_path = tmp_path / "fixture.json"
    fixture_path.write_text(json.dumps(FIXTURE))
    result = collect_practitioner_reason_texts([str(fixture_path)])
    assert result == {"prac-1": ["Heart attack"]}

def test_enrich_practitioners_injects_qualification():
    bundle = json.loads(json.dumps(FIXTURE))  # deep copy
    enriched = enrich_practitioners(bundle, {"prac-1": "Cardiology"})
    prac_entry = next(e["resource"] for e in enriched["entry"] if e["resource"]["resourceType"] == "Practitioner")
    assert prac_entry["qualification"][0]["code"]["text"] == "Cardiology"

def test_enrich_practitioners_leaves_unmapped_practitioner_untouched():
    bundle = json.loads(json.dumps(FIXTURE))
    enriched = enrich_practitioners(bundle, {})
    prac_entry = next(e["resource"] for e in enriched["entry"] if e["resource"]["resourceType"] == "Practitioner")
    assert "qualification" not in prac_entry
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pytest tests/scripts/test_import_synthea_data.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'scripts.import_synthea_data'`

- [ ] **Step 7: Write `scripts/import_synthea_data.py`**

```python
# scripts/import_synthea_data.py
import asyncio
import glob
import json
import os
from app.config import get_settings
from app.core.medplum_client import MedplumClient
from scripts.specialty_mapping import resolve_specialty

FHIR_DIR = os.path.join(os.path.dirname(__file__), "..", "fhir")

def collect_practitioner_reason_texts(file_paths: list[str]) -> dict[str, list[str]]:
    reason_texts_by_practitioner: dict[str, list[str]] = {}
    for path in file_paths:
        with open(path, "r", encoding="utf-8") as f:
            bundle = json.load(f)
        encounters = [e["resource"] for e in bundle.get("entry", []) if e["resource"]["resourceType"] == "Encounter"]
        for enc in encounters:
            participants = enc.get("participant", [])
            if not participants:
                continue
            ref = participants[0].get("individual", {}).get("reference", "")
            prac_id = ref.split(":")[-1] if ref else None
            if not prac_id:
                continue
            texts = [t.get("text") for t in enc.get("type", []) if t.get("text")]
            reason_texts_by_practitioner.setdefault(prac_id, []).extend(texts)
    return reason_texts_by_practitioner

def enrich_practitioners(bundle: dict, specialties_by_practitioner: dict[str, str]) -> dict:
    for entry in bundle.get("entry", []):
        resource = entry["resource"]
        if resource["resourceType"] != "Practitioner":
            continue
        specialty = specialties_by_practitioner.get(resource["id"])
        if specialty:
            resource["qualification"] = [{"code": {"text": specialty}}]
    return bundle

async def run_import():
    file_paths = sorted(glob.glob(os.path.join(FHIR_DIR, "*.json")))
    print(f"Found {len(file_paths)} bundles")

    reason_texts_by_practitioner = collect_practitioner_reason_texts(file_paths)
    specialties_by_practitioner = {
        prac_id: resolve_specialty(texts) for prac_id, texts in reason_texts_by_practitioner.items()
    }
    print(f"Resolved specialties for {len(specialties_by_practitioner)} practitioners")

    settings = get_settings()
    client = MedplumClient(settings.medplum_base_url, settings.medplum_client_id, settings.medplum_client_secret)

    for path in file_paths:
        with open(path, "r", encoding="utf-8") as f:
            bundle = json.load(f)
        bundle = enrich_practitioners(bundle, specialties_by_practitioner)
        await client.submit_bundle(bundle)
        print(f"Imported {os.path.basename(path)}")

if __name__ == "__main__":
    asyncio.run(run_import())
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pytest tests/scripts/test_import_synthea_data.py -v`
Expected: PASS (3 passed)

- [ ] **Step 9: Commit**

```bash
git add scripts/ tests/scripts/
git commit -m "feat: add Synthea import script with specialty enrichment"
```

> **Note before actually running this against real Medplum:** `run_import()` hits the live `fhir/*.json` dataset (983 files) and a real Medplum project — don't run it as part of the automated test suite. Run it once, manually, after Task 4 is committed and real Medplum credentials are configured in `.env`.

---

## Task 6: Patients Service

**Files:**
- Create: `app/patients/__init__.py`
- Create: `app/patients/service.py`
- Test: `tests/patients/test_service.py`

**Interfaces:**
- Consumes: `MedplumClient` (Task 4), `MedplumNotFoundError`, `PatientNotFoundError` (Task 3), `PatientSummary`, `PatientHistory`, `PractitionerSummary`, `ConditionSummary`, `MedicationSummary`, `AllergySummary`, `EncounterSummary` (Task 2).
- Produces: `list_demo_patients(client) -> list[PatientSummary]`, `get_patient_history(client, patient_id) -> PatientHistory`, `find_previous_practitioner_by_specialty(client, patient_id, specialty) -> PractitionerSummary | None`. Consumed by Task 12 (`api/patients_router.py`, `api/doctors_router.py`).

- [ ] **Step 1: Write the failing tests**

```python
# tests/patients/test_service.py
import pytest
from unittest.mock import AsyncMock
from app.patients.service import list_demo_patients, get_patient_history, find_previous_practitioner_by_specialty
from app.core.exceptions import PatientNotFoundError, MedplumNotFoundError

def _patient_resource():
    return {"id": "p1", "name": [{"given": ["John"], "family": "Doe"}], "birthDate": "1980-01-01"}

def _encounter_bundle_entries():
    return [
        {"resourceType": "Encounter", "id": "enc-1",
         "type": [{"text": "Heart attack"}],
         "period": {"start": "2020-01-01T09:00:00"},
         "participant": [{"individual": {"reference": "Practitioner/prac-1"}}],
         "serviceProvider": {"reference": "Organization/org-1"}},
        {"resourceType": "Practitioner", "id": "prac-1",
         "name": [{"given": ["Jane"], "family": "Smith"}],
         "qualification": [{"code": {"text": "Cardiology"}}]},
        {"resourceType": "Organization", "id": "org-1", "name": "City Hospital"},
    ]

async def test_list_demo_patients_maps_names():
    client = AsyncMock()
    client.search.return_value = [_patient_resource()]
    result = await list_demo_patients(client)
    assert result[0].display_name == "John Doe"

async def test_get_patient_history_raises_when_patient_missing():
    client = AsyncMock()
    client.read.side_effect = MedplumNotFoundError("not found")
    with pytest.raises(PatientNotFoundError):
        await get_patient_history(client, "missing-id")

async def test_get_patient_history_resolves_encounter_practitioner_and_org():
    client = AsyncMock()
    client.read.return_value = _patient_resource()
    client.search.side_effect = [
        [],  # Condition
        [],  # MedicationRequest
        [],  # AllergyIntolerance
        _encounter_bundle_entries(),  # Encounter (+_include Practitioner/Organization)
    ]
    history = await get_patient_history(client, "p1")
    assert history.encounters[0].organization_name == "City Hospital"
    assert history.encounters[0].practitioner.name == "Jane Smith"
    assert history.previous_practitioners[0].specialty == "Cardiology"

async def test_find_previous_practitioner_by_specialty_matches_case_insensitive():
    client = AsyncMock()
    client.read.return_value = _patient_resource()
    client.search.side_effect = [[], [], [], _encounter_bundle_entries()]
    result = await find_previous_practitioner_by_specialty(client, "p1", "cardiology")
    assert result.name == "Jane Smith"

async def test_find_previous_practitioner_by_specialty_returns_none_when_no_match():
    client = AsyncMock()
    client.read.return_value = _patient_resource()
    client.search.side_effect = [[], [], [], _encounter_bundle_entries()]
    result = await find_previous_practitioner_by_specialty(client, "p1", "dermatology")
    assert result is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/patients/test_service.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.patients'`

- [ ] **Step 3: Write `app/patients/__init__.py` (empty) and `app/patients/service.py`**

```python
# app/patients/service.py
import asyncio
from app.core.medplum_client import MedplumClient
from app.core.exceptions import MedplumNotFoundError, PatientNotFoundError
from app.models.patient import (
    PatientSummary, PatientHistory, ConditionSummary, MedicationSummary,
    AllergySummary, EncounterSummary, PractitionerSummary,
)

async def list_demo_patients(client: MedplumClient) -> list[PatientSummary]:
    resources = await client.search("Patient", {"_count": 20})
    return [_to_patient_summary(r) for r in resources]

def _to_patient_summary(resource: dict) -> PatientSummary:
    name = resource.get("name", [{}])[0]
    display = " ".join(name.get("given", []) + [name.get("family", "")]).strip()
    return PatientSummary(id=resource["id"], display_name=display or resource["id"], birth_date=resource.get("birthDate"))

def _to_practitioner_summary(resource: dict) -> PractitionerSummary:
    name = resource.get("name", [{}])[0]
    display = " ".join(name.get("given", []) + [name.get("family", "")]).strip()
    qualifications = resource.get("qualification", [])
    specialty = qualifications[0]["code"]["text"] if qualifications else None
    return PractitionerSummary(id=resource["id"], name=display or resource["id"], specialty=specialty)

async def get_patient_history(client: MedplumClient, patient_id: str) -> PatientHistory:
    try:
        patient_resource = await client.read("Patient", patient_id)
    except MedplumNotFoundError as exc:
        raise PatientNotFoundError(f"Patient {patient_id} not found") from exc

    conditions, medications, allergies, encounter_entries = await asyncio.gather(
        client.search("Condition", {"subject": patient_id}),
        client.search("MedicationRequest", {"subject": patient_id}),
        client.search("AllergyIntolerance", {"patient": patient_id}),
        client.search("Encounter", {
            "subject": patient_id,
            "_include": ["Encounter:practitioner", "Encounter:service-provider"],
        }),
    )

    encounters_raw = [r for r in encounter_entries if r["resourceType"] == "Encounter"]
    practitioners_by_id = {r["id"]: r for r in encounter_entries if r["resourceType"] == "Practitioner"}
    organizations_by_id = {r["id"]: r for r in encounter_entries if r["resourceType"] == "Organization"}

    encounters: list[EncounterSummary] = []
    previous_practitioners: dict[str, PractitionerSummary] = {}

    for enc in encounters_raw:
        practitioner_summary = None
        participants = enc.get("participant", [])
        if participants:
            ref = participants[0].get("individual", {}).get("reference", "")
            prac_id = ref.split("/")[-1] if ref else None
            prac_resource = practitioners_by_id.get(prac_id)
            if prac_resource:
                practitioner_summary = _to_practitioner_summary(prac_resource)
                previous_practitioners[practitioner_summary.id] = practitioner_summary

        org_ref = enc.get("serviceProvider", {}).get("reference", "")
        org_id = org_ref.split("/")[-1] if org_ref else None
        org_resource = organizations_by_id.get(org_id)

        encounters.append(EncounterSummary(
            id=enc["id"],
            reason=enc.get("type", [{}])[0].get("text"),
            period_start=enc.get("period", {}).get("start"),
            practitioner=practitioner_summary,
            organization_name=org_resource.get("name") if org_resource else None,
        ))

    return PatientHistory(
        patient=_to_patient_summary(patient_resource),
        conditions=[ConditionSummary(id=c["id"], text=c.get("code", {}).get("text", "")) for c in conditions],
        medications=[MedicationSummary(id=m["id"], text=m.get("medicationCodeableConcept", {}).get("text", "")) for m in medications],
        allergies=[AllergySummary(id=a["id"], text=a.get("code", {}).get("text", "")) for a in allergies],
        encounters=encounters,
        previous_practitioners=list(previous_practitioners.values()),
    )

async def find_previous_practitioner_by_specialty(
    client: MedplumClient, patient_id: str, specialty: str
) -> PractitionerSummary | None:
    history = await get_patient_history(client, patient_id)
    normalized = specialty.strip().lower()
    for prac in history.previous_practitioners:
        if prac.specialty and prac.specialty.strip().lower() == normalized:
            return prac
    return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/patients/test_service.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add app/patients/ tests/patients/
git commit -m "feat: add patients service (history, previous-physician matching)"
```

---

## Task 7: Intent Service (LLM)

**Files:**
- Create: `app/intent/__init__.py`
- Create: `app/intent/prompts.py`
- Create: `app/intent/service.py`
- Test: `tests/intent/test_service.py`

**Interfaces:**
- Consumes: `Intent` (Task 2), `IntentExtractionError` (Task 3).
- Produces: `extract_intent(llm_client, model, request_text) -> Intent`. Consumed by Task 12 (`api/requests_router.py`) and Task 13 (LLM sanity smoke test).

- [ ] **Step 1: Write the failing tests**

```python
# tests/intent/test_service.py
import pytest
from unittest.mock import AsyncMock, MagicMock
from app.intent.service import extract_intent
from app.core.exceptions import IntentExtractionError

def _make_mock_client(content: str):
    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.choices = [MagicMock(message=MagicMock(content=content))]
    mock_client.chat.completions.create = AsyncMock(return_value=mock_response)
    return mock_client

async def test_extract_intent_returns_structured_result():
    client = _make_mock_client('{"specialty": "Cardiology", "reason": "chest pain", "urgency": "urgent"}')
    result = await extract_intent(client, "test-model", "I've had chest pains for two days")
    assert result.specialty == "Cardiology"
    assert result.urgency == "urgent"

async def test_extract_intent_raises_on_null_specialty():
    client = _make_mock_client('{"specialty": null, "reason": "unclear", "urgency": "routine"}')
    with pytest.raises(IntentExtractionError):
        await extract_intent(client, "test-model", "I don't feel great")

async def test_extract_intent_raises_on_invalid_json():
    client = _make_mock_client("not json at all")
    with pytest.raises(IntentExtractionError):
        await extract_intent(client, "test-model", "something")

async def test_extract_intent_raises_on_shape_mismatch():
    client = _make_mock_client('{"specialty": "Cardiology", "reason": "chest pain", "urgency": "immediately"}')
    with pytest.raises(IntentExtractionError):
        await extract_intent(client, "test-model", "chest pain right now")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/intent/test_service.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.intent'`

- [ ] **Step 3: Write `app/intent/__init__.py` (empty), `app/intent/prompts.py`, `app/intent/service.py`**

```python
# app/intent/prompts.py
SYSTEM_PROMPT = """You are a medical appointment intent classifier.
Given a patient's 1-2 sentence appointment request, return ONLY a JSON object
with exactly these keys:
- "specialty": the medical specialty needed (e.g. "Cardiology", "Dermatology", "General Practice"), or null if you cannot confidently determine one
- "reason": a short phrase summarizing why they need an appointment
- "urgency": either "routine" or "urgent"
Do not include any text other than the JSON object."""
```

```python
# app/intent/service.py
import json
from app.core.exceptions import IntentExtractionError
from app.models.intent import Intent
from app.intent.prompts import SYSTEM_PROMPT

async def extract_intent(llm_client, model: str, request_text: str) -> Intent:
    response = await llm_client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": request_text},
        ],
        response_format={"type": "json_object"},
        temperature=0,
    )
    raw = response.choices[0].message.content
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise IntentExtractionError(f"LLM returned invalid JSON: {raw}") from exc

    if not data.get("specialty"):
        raise IntentExtractionError(f"Could not confidently determine a specialty for: {request_text}")

    try:
        return Intent(**data)
    except Exception as exc:
        raise IntentExtractionError(f"LLM response did not match expected shape: {data}") from exc
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/intent/test_service.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add app/intent/ tests/intent/
git commit -m "feat: add intent extraction service"
```

---

## Task 8: Directory Service (NPPES)

**Files:**
- Create: `app/directory/__init__.py`
- Create: `app/directory/service.py`
- Test: `tests/directory/test_service.py`

**Interfaces:**
- Consumes: `Doctor`, `DoctorAddress` (Task 2).
- Produces: `search_doctors(http_client, base_url, specialty, city, state, limit=10) -> list[Doctor]`, `get_doctor_by_npi(http_client, base_url, npi) -> Doctor | None`, `SPECIALTY_TO_TAXONOMY: dict[str, str]`. Consumed by Task 10 (`scheduling/service.py`) and Task 12 (`api/doctors_router.py`).

- [ ] **Step 1: Write the failing tests**

```python
# tests/directory/test_service.py
import httpx
import pytest
from app.directory.service import search_doctors, get_doctor_by_npi

NPPES_SEARCH_RESPONSE = {
    "results": [
        {
            "number": "1234567890",
            "basic": {"first_name": "Jane", "last_name": "Smith", "status": "A"},
            "addresses": [{"address_purpose": "LOCATION", "address_1": "1 Main St", "city": "Boston", "state": "MA", "postal_code": "02101", "telephone_number": "5551234567"}],
            "taxonomies": [{"primary": True, "desc": "Cardiovascular Disease"}],
        }
    ]
}

NPPES_EMPTY_RESPONSE = {"results": []}

def _handler_factory(response_body):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=response_body)
    return handler

async def test_search_doctors_maps_nppes_results():
    transport = httpx.MockTransport(_handler_factory(NPPES_SEARCH_RESPONSE))
    http_client = httpx.AsyncClient(transport=transport)
    result = await search_doctors(http_client, "https://nppes.test", "Cardiology", "Boston", "MA")
    assert result[0].npi == "1234567890"
    assert result[0].address.city == "Boston"

async def test_get_doctor_by_npi_returns_none_when_not_found():
    transport = httpx.MockTransport(_handler_factory(NPPES_EMPTY_RESPONSE))
    http_client = httpx.AsyncClient(transport=transport)
    result = await get_doctor_by_npi(http_client, "https://nppes.test", "0000000000")
    assert result is None

async def test_get_doctor_by_npi_returns_doctor_with_taxonomy_specialty():
    transport = httpx.MockTransport(_handler_factory(NPPES_SEARCH_RESPONSE))
    http_client = httpx.AsyncClient(transport=transport)
    result = await get_doctor_by_npi(http_client, "https://nppes.test", "1234567890")
    assert result.specialty == "Cardiovascular Disease"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/directory/test_service.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.directory'`

- [ ] **Step 3: Write `app/directory/__init__.py` (empty) and `app/directory/service.py`**

```python
# app/directory/service.py
import httpx
from app.models.doctor import Doctor, DoctorAddress

SPECIALTY_TO_TAXONOMY = {
    "cardiology": "Cardiovascular Disease",
    "dermatology": "Dermatology",
    "endocrinology": "Endocrinology, Diabetes & Metabolism",
    "orthopedics": "Orthopaedic Surgery",
    "general practice": "Family Medicine",
    "neurology": "Neurology",
    "gastroenterology": "Gastroenterology",
    "psychiatry": "Psychiatry",
    "pediatrics": "Pediatrics",
    "pulmonology": "Pulmonary Disease",
    "rheumatology": "Rheumatology",
    "urology": "Urology",
    "vascular surgery": "Vascular Surgery",
    "general surgery": "General Surgery",
    "allergy and immunology": "Allergy & Immunology",
    "otolaryngology (ent)": "Otolaryngology",
    "infectious disease": "Infectious Disease",
}

async def search_doctors(
    http_client: httpx.AsyncClient, base_url: str, specialty: str, city: str, state: str, limit: int = 10
) -> list[Doctor]:
    taxonomy = SPECIALTY_TO_TAXONOMY.get(specialty.strip().lower(), specialty)
    response = await http_client.get(base_url, params={
        "taxonomy_description": taxonomy, "city": city, "state": state, "limit": limit, "version": "2.1",
    })
    response.raise_for_status()
    body = response.json()
    doctors = []
    for result in body.get("results", []):
        doctor = _to_doctor(result, specialty)
        if doctor:
            doctors.append(doctor)
    return doctors[:limit]

async def get_doctor_by_npi(http_client: httpx.AsyncClient, base_url: str, npi: str) -> Doctor | None:
    response = await http_client.get(base_url, params={"number": npi, "version": "2.1"})
    response.raise_for_status()
    results = response.json().get("results", [])
    if not results:
        return None
    return _to_doctor(results[0], specialty=None)

def _to_doctor(result: dict, specialty: str | None) -> Doctor | None:
    basic = result.get("basic", {})
    addresses = result.get("addresses", [])
    practice_address = next((a for a in addresses if a.get("address_purpose") == "LOCATION"), addresses[0] if addresses else None)
    if not practice_address:
        return None
    return Doctor(
        npi=result["number"],
        first_name=basic.get("first_name", ""),
        last_name=basic.get("last_name", ""),
        specialty=specialty or _first_taxonomy(result),
        address=DoctorAddress(
            line=practice_address.get("address_1", ""),
            city=practice_address.get("city", ""),
            state=practice_address.get("state", ""),
            postal_code=practice_address.get("postal_code", ""),
        ),
        phone=practice_address.get("telephone_number"),
    )

def _first_taxonomy(result: dict) -> str:
    taxonomies = result.get("taxonomies", [])
    primary = next((t for t in taxonomies if t.get("primary")), taxonomies[0] if taxonomies else None)
    return primary.get("desc", "Unknown") if primary else "Unknown"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/directory/test_service.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add app/directory/ tests/directory/
git commit -m "feat: add NPPES directory service"
```

---

## Task 9: Scheduling Template (NPI-Seeded Weekly Availability)

**Files:**
- Create: `app/scheduling/__init__.py`
- Create: `app/scheduling/template.py`
- Test: `tests/scheduling/test_template.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `WeeklyTemplate` (dataclass: `working_days: list[str]`, `start_hour: int`, `end_hour: int`, `lunch_start: float`, `lunch_end: float`), `generate_weekly_template(npi: str) -> WeeklyTemplate`. Consumed by Task 10 (`scheduling/service.py`).

- [ ] **Step 1: Write the failing tests**

```python
# tests/scheduling/test_template.py
from app.scheduling.template import generate_weekly_template

def test_same_npi_produces_same_template():
    t1 = generate_weekly_template("1234567890")
    t2 = generate_weekly_template("1234567890")
    assert t1 == t2

def test_different_npis_can_produce_different_templates():
    t1 = generate_weekly_template("1234567890")
    t2 = generate_weekly_template("9876543210")
    assert (t1.working_days, t1.start_hour, t1.end_hour) != (t2.working_days, t2.start_hour, t2.end_hour)

def test_lunch_break_is_one_hour_after_start():
    t = generate_weekly_template("1234567890")
    assert t.lunch_end == t.lunch_start + 1.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/scheduling/test_template.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.scheduling'`

- [ ] **Step 3: Write `app/scheduling/__init__.py` (empty) and `app/scheduling/template.py`**

```python
# app/scheduling/template.py
import random
from dataclasses import dataclass

@dataclass
class WeeklyTemplate:
    working_days: list[str]
    start_hour: int
    end_hour: int
    lunch_start: float
    lunch_end: float

DAY_PATTERNS = [
    ["Mon", "Tue", "Wed", "Thu", "Fri"],
    ["Tue", "Wed", "Thu", "Fri", "Sat"],
    ["Mon", "Tue", "Wed", "Fri", "Sat"],
    ["Mon", "Wed", "Thu", "Fri", "Sat"],
]

def generate_weekly_template(npi: str) -> WeeklyTemplate:
    rng = random.Random(int(npi))
    working_days = rng.choice(DAY_PATTERNS)
    start_hour = rng.choice([8, 9])
    end_hour = rng.choice([16, 17, 18])
    lunch_start = rng.choice([12.0, 12.5, 13.0])
    return WeeklyTemplate(
        working_days=working_days, start_hour=start_hour, end_hour=end_hour,
        lunch_start=lunch_start, lunch_end=lunch_start + 1.0,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/scheduling/test_template.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add app/scheduling/__init__.py app/scheduling/template.py tests/scheduling/test_template.py
git commit -m "feat: add NPI-seeded weekly schedule template generator"
```

---

## Task 10: Scheduling Service (Medplum-Native $find/$hold/$confirm)

**Files:**
- Create: `app/scheduling/service.py`
- Test: `tests/scheduling/test_service.py`

**Interfaces:**
- Consumes: `MedplumClient` (Task 4), `MedplumOperationError`, `DoctorNotFoundError`, `SlotUnavailableError` (Task 3), `Doctor` (Task 2), `SlotView`, `HeldAppointment`, `ConfirmedAppointment` (Task 2), `generate_weekly_template` (Task 9), `get_doctor_by_npi` (Task 8).
- Produces: `ensure_practitioner(client, doctor) -> str`, `ensure_schedule(client, practitioner_id, npi) -> str`, `get_available_slots(client, nppes_http_client, nppes_base_url, npi, date_from, date_to) -> list[SlotView]`, `hold_slot(client, schedule_id, start_time, end_time, patient_id) -> HeldAppointment`, `confirm_appointment(client, appointment_id) -> ConfirmedAppointment`. Consumed by Task 11 (`booking/service.py`) and Task 12 (`api/doctors_router.py`).

> **Before running against real Medplum:** the `Schedule` extension URL used below (`https://medplum.com/fhir/StructureDefinition/scheduling-parameters`) follows Medplum's documented pattern for custom scheduling extensions, but wasn't re-verified against a live Medplum instance in this plan — check it against `medplum.com/docs/scheduling` (or the actual resource Medplum returns after creating a test `Schedule` via their UI) before wiring this up to a real project, and adjust the extension shape in Step 3 if it differs.

- [ ] **Step 1: Write the failing tests**

```python
# tests/scheduling/test_service.py
import pytest
from datetime import date
from unittest.mock import AsyncMock
from app.scheduling.service import ensure_practitioner, ensure_schedule, get_available_slots, hold_slot, confirm_appointment
from app.models.doctor import Doctor, DoctorAddress
from app.core.exceptions import DoctorNotFoundError, SlotUnavailableError, MedplumOperationError

def _sample_doctor():
    return Doctor(
        npi="1234567890", first_name="Jane", last_name="Smith", specialty="Cardiology",
        address=DoctorAddress(line="1 Main St", city="Boston", state="MA", postal_code="02101"),
        phone="5551234567",
    )

async def test_ensure_practitioner_returns_existing_id_if_found():
    client = AsyncMock()
    client.search.return_value = [{"id": "existing-prac-1"}]
    result = await ensure_practitioner(client, _sample_doctor())
    assert result == "existing-prac-1"
    client.create.assert_not_called()

async def test_ensure_practitioner_creates_when_not_found():
    client = AsyncMock()
    client.search.return_value = []
    client.create.return_value = {"id": "new-prac-1"}
    result = await ensure_practitioner(client, _sample_doctor())
    assert result == "new-prac-1"
    created_resource = client.create.call_args[0][0]
    assert created_resource["identifier"][0]["value"] == "1234567890"

async def test_ensure_schedule_returns_existing_id_if_found():
    client = AsyncMock()
    client.search.return_value = [{"id": "existing-sched-1"}]
    result = await ensure_schedule(client, "prac-1", "1234567890")
    assert result == "existing-sched-1"
    client.create.assert_not_called()

async def test_ensure_schedule_creates_with_npi_seeded_template():
    client = AsyncMock()
    client.search.return_value = []
    client.create.return_value = {"id": "new-sched-1"}
    result = await ensure_schedule(client, "prac-1", "1234567890")
    assert result == "new-sched-1"
    created_resource = client.create.call_args[0][0]
    assert created_resource["actor"][0]["reference"] == "Practitioner/prac-1"

async def test_get_available_slots_raises_when_doctor_not_in_nppes(monkeypatch):
    client = AsyncMock()
    nppes_client = AsyncMock()
    monkeypatch.setattr("app.scheduling.service.get_doctor_by_npi", AsyncMock(return_value=None))
    with pytest.raises(DoctorNotFoundError):
        await get_available_slots(client, nppes_client, "https://nppes.test", "0000000000", date(2026, 8, 1), date(2026, 8, 15))

async def test_hold_slot_raises_slot_unavailable_on_conflict():
    client = AsyncMock()
    client.execute_operation.side_effect = MedplumOperationError("conflict", status_code=409)
    with pytest.raises(SlotUnavailableError):
        await hold_slot(client, "sched-1", "2026-08-01T09:00:00", "2026-08-01T09:30:00", "patient-1")

async def test_confirm_appointment_returns_confirmed_result():
    client = AsyncMock()
    client.execute_operation.return_value = {
        "id": "appt-1", "start": "2026-08-01T09:00:00", "end": "2026-08-01T09:30:00",
        "participant": [
            {"actor": {"reference": "Patient/patient-1"}},
            {"actor": {"reference": "Practitioner/prac-1", "display": "Dr. Jane Smith"}},
        ],
    }
    result = await confirm_appointment(client, "appt-1")
    assert result.status == "booked"
    assert result.practitioner_name == "Dr. Jane Smith"
    assert result.patient_id == "patient-1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/scheduling/test_service.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.scheduling.service'`

- [ ] **Step 3: Write `app/scheduling/service.py`**

```python
# app/scheduling/service.py
from datetime import date
from app.core.medplum_client import MedplumClient
from app.core.exceptions import DoctorNotFoundError, SlotUnavailableError, MedplumOperationError
from app.models.doctor import Doctor
from app.models.scheduling import SlotView, HeldAppointment, ConfirmedAppointment
from app.scheduling.template import generate_weekly_template
from app.directory.service import get_doctor_by_npi

NPI_SYSTEM = "http://hl7.org/fhir/sid/us-npi"

async def ensure_practitioner(client: MedplumClient, doctor: Doctor) -> str:
    existing = await client.search("Practitioner", {"identifier": f"{NPI_SYSTEM}|{doctor.npi}"})
    if existing:
        return existing[0]["id"]

    resource = {
        "resourceType": "Practitioner",
        "identifier": [{"system": NPI_SYSTEM, "value": doctor.npi}],
        "active": True,
        "name": [{"family": doctor.last_name, "given": [doctor.first_name]}],
        "telecom": [{"system": "phone", "value": doctor.phone}] if doctor.phone else [],
        "address": [{
            "line": [doctor.address.line], "city": doctor.address.city,
            "state": doctor.address.state, "postalCode": doctor.address.postal_code,
        }],
        "qualification": [{"code": {"text": doctor.specialty}}],
    }
    created = await client.create(resource)
    return created["id"]

async def ensure_schedule(client: MedplumClient, practitioner_id: str, npi: str) -> str:
    existing = await client.search("Schedule", {"actor": f"Practitioner/{practitioner_id}"})
    if existing:
        return existing[0]["id"]

    template = generate_weekly_template(npi)
    resource = {
        "resourceType": "Schedule",
        "actor": [{"reference": f"Practitioner/{practitioner_id}"}],
        "extension": [{
            "url": "https://medplum.com/fhir/StructureDefinition/scheduling-parameters",
            "extension": [
                {"url": "availableTime", "valueString": day} for day in template.working_days
            ] + [
                {"url": "startHour", "valueInteger": template.start_hour},
                {"url": "endHour", "valueInteger": template.end_hour},
                {"url": "lunchStart", "valueDecimal": template.lunch_start},
                {"url": "lunchEnd", "valueDecimal": template.lunch_end},
            ],
        }],
    }
    created = await client.create(resource)
    return created["id"]

async def get_available_slots(
    client: MedplumClient, nppes_http_client, nppes_base_url: str, npi: str, date_from: date, date_to: date,
) -> list[SlotView]:
    doctor = await get_doctor_by_npi(nppes_http_client, nppes_base_url, npi)
    if doctor is None:
        raise DoctorNotFoundError(f"No NPPES record for NPI {npi}")

    practitioner_id = await ensure_practitioner(client, doctor)
    schedule_id = await ensure_schedule(client, practitioner_id, npi)

    result = await client.execute_operation("Appointment", None, "find", {
        "schedule": schedule_id, "start": date_from.isoformat(), "end": date_to.isoformat(), "durationMinutes": 30,
    })
    return [
        SlotView(schedule_id=schedule_id, start_time=slot["start"], end_time=slot["end"])
        for slot in result.get("slots", [])
    ]

async def hold_slot(client: MedplumClient, schedule_id: str, start_time, end_time, patient_id: str) -> HeldAppointment:
    try:
        result = await client.execute_operation("Appointment", None, "hold", {
            "schedule": schedule_id,
            "start": start_time.isoformat() if hasattr(start_time, "isoformat") else start_time,
            "end": end_time.isoformat() if hasattr(end_time, "isoformat") else end_time,
            "patient": f"Patient/{patient_id}",
        })
    except MedplumOperationError as exc:
        if exc.status_code in (409, 422):
            raise SlotUnavailableError(f"Slot {start_time}-{end_time} no longer available") from exc
        raise
    return HeldAppointment(appointment_id=result["id"], status="pending")

async def confirm_appointment(client: MedplumClient, appointment_id: str) -> ConfirmedAppointment:
    result = await client.execute_operation("Appointment", appointment_id, "confirm", {})
    participants = result.get("participant", [])
    practitioner_name = next(
        (p.get("actor", {}).get("display", "Unknown") for p in participants if p.get("actor", {}).get("reference", "").startswith("Practitioner/")),
        "Unknown",
    )
    patient_ref = next((p.get("actor", {}).get("reference", "") for p in participants if p.get("actor", {}).get("reference", "").startswith("Patient/")), "")
    return ConfirmedAppointment(
        appointment_id=result["id"], status="booked", start_time=result["start"], end_time=result["end"],
        practitioner_name=practitioner_name, patient_id=patient_ref.split("/")[-1] if patient_ref else "",
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/scheduling/test_service.py -v`
Expected: PASS (7 passed)

- [ ] **Step 5: Commit**

```bash
git add app/scheduling/service.py tests/scheduling/test_service.py
git commit -m "feat: add Medplum-native scheduling service ($find/$hold/$confirm)"
```

---

## Task 11: Booking Service

**Files:**
- Create: `app/booking/__init__.py`
- Create: `app/booking/service.py`
- Test: `tests/booking/test_service.py`

**Interfaces:**
- Consumes: `hold_slot`, `confirm_appointment` (Task 10), `SlotUnavailableError` (Task 3), `SlotView`, `BookingResult` (Task 2).
- Produces: `book_appointment(client, patient_id, slot: SlotView) -> BookingResult`. Consumed by Task 12 (`api/appointments_router.py`). Note: simplified vs. the earlier LLD sketch's `book_appointment(patient_id, npi, slot)` — `npi` is dropped since `slot.schedule_id` is already sufficient for `hold_slot`/`confirm_appointment`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/booking/test_service.py
import pytest
from unittest.mock import AsyncMock
from app.booking.service import book_appointment
from app.models.scheduling import SlotView
from app.core.exceptions import SlotUnavailableError, MedplumOperationError

def _sample_slot():
    return SlotView(schedule_id="sched-1", start_time="2026-08-01T09:00:00", end_time="2026-08-01T09:30:00")

async def test_book_appointment_success():
    client = AsyncMock()
    client.execute_operation.side_effect = [
        {"id": "appt-1"},
        {"id": "appt-1", "start": "2026-08-01T09:00:00", "end": "2026-08-01T09:30:00", "participant": []},
    ]
    result = await book_appointment(client, "patient-1", _sample_slot())
    assert result.status == "confirmed"
    assert result.appointment.appointment_id == "appt-1"

async def test_book_appointment_raises_slot_unavailable_on_conflict():
    client = AsyncMock()
    client.execute_operation.side_effect = MedplumOperationError("conflict", status_code=409)
    with pytest.raises(SlotUnavailableError):
        await book_appointment(client, "patient-1", _sample_slot())

async def test_second_booking_of_same_slot_is_rejected():
    client = AsyncMock()
    client.execute_operation.side_effect = [
        {"id": "appt-1"},
        {"id": "appt-1", "start": "2026-08-01T09:00:00", "end": "2026-08-01T09:30:00", "participant": []},
        MedplumOperationError("conflict", status_code=409),
    ]
    first = await book_appointment(client, "patient-1", _sample_slot())
    assert first.status == "confirmed"
    with pytest.raises(SlotUnavailableError):
        await book_appointment(client, "patient-2", _sample_slot())
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/booking/test_service.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.booking'`

- [ ] **Step 3: Write `app/booking/__init__.py` (empty) and `app/booking/service.py`**

```python
# app/booking/service.py
from app.core.medplum_client import MedplumClient
from app.models.scheduling import SlotView, BookingResult
from app.scheduling.service import hold_slot, confirm_appointment

async def book_appointment(client: MedplumClient, patient_id: str, slot: SlotView) -> BookingResult:
    held = await hold_slot(client, slot.schedule_id, slot.start_time, slot.end_time, patient_id)
    confirmed = await confirm_appointment(client, held.appointment_id)
    return BookingResult(status="confirmed", appointment=confirmed)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/booking/test_service.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add app/booking/ tests/booking/
git commit -m "feat: add booking service (hold + confirm orchestration)"
```

---

## Task 12: API Routers & App Wiring

**Files:**
- Create: `app/core/dependencies.py`
- Create: `app/api/__init__.py`
- Create: `app/api/patients_router.py`
- Create: `app/api/requests_router.py`
- Create: `app/api/doctors_router.py`
- Create: `app/api/appointments_router.py`
- Create: `app/main.py`
- Test: `tests/api/test_routers.py`

**Interfaces:**
- Consumes: every service function from Tasks 6, 7, 8, 10, 11; every exception from Task 3; `get_settings` (Task 1).
- Produces: a running FastAPI `app` (importable as `app.main:app`) exposing `GET /health`, `GET /patients`, `GET /patients/{id}/history`, `POST /requests`, `GET /doctors`, `GET /doctors/{npi}/slots`, `POST /appointments`. `get_medplum_client`, `get_nppes_http_client`, `get_llm_client` (`app/core/dependencies.py`) are overridden in tests via `app.dependency_overrides`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/api/test_routers.py
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock
from app.main import app
from app.core.dependencies import get_medplum_client
from app.core.exceptions import PatientNotFoundError

def test_health_check():
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}

def test_get_patients_returns_list():
    mock_medplum = AsyncMock()
    mock_medplum.search.return_value = [{"id": "p1", "name": [{"given": ["John"], "family": "Doe"}], "birthDate": "1980-01-01"}]
    app.dependency_overrides[get_medplum_client] = lambda: mock_medplum
    client = TestClient(app)
    response = client.get("/patients")
    assert response.status_code == 200
    assert response.json()[0]["display_name"] == "John Doe"
    app.dependency_overrides.clear()

def test_get_patient_history_404_for_unknown_patient():
    mock_medplum = AsyncMock()
    mock_medplum.read.side_effect = PatientNotFoundError("not found")
    app.dependency_overrides[get_medplum_client] = lambda: mock_medplum
    client = TestClient(app)
    response = client.get("/patients/unknown-id/history")
    assert response.status_code == 404
    app.dependency_overrides.clear()

def test_book_appointment_returns_409_on_conflict():
    from app.core.exceptions import MedplumOperationError
    mock_medplum = AsyncMock()
    mock_medplum.execute_operation.side_effect = MedplumOperationError("conflict", status_code=409)
    app.dependency_overrides[get_medplum_client] = lambda: mock_medplum
    client = TestClient(app)
    response = client.post("/appointments", json={
        "schedule_id": "sched-1", "start_time": "2026-08-01T09:00:00",
        "end_time": "2026-08-01T09:30:00", "patient_id": "patient-1",
    })
    assert response.status_code == 409
    app.dependency_overrides.clear()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/api/test_routers.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.api'` (or `app.main`)

- [ ] **Step 3: Write `app/core/dependencies.py`**

```python
# app/core/dependencies.py
import httpx
from openai import AsyncOpenAI
from app.config import get_settings
from app.core.medplum_client import MedplumClient

_medplum_client: MedplumClient | None = None
_nppes_http_client: httpx.AsyncClient | None = None
_llm_client: AsyncOpenAI | None = None

def get_medplum_client() -> MedplumClient:
    global _medplum_client
    if _medplum_client is None:
        settings = get_settings()
        _medplum_client = MedplumClient(settings.medplum_base_url, settings.medplum_client_id, settings.medplum_client_secret)
    return _medplum_client

def get_nppes_http_client() -> httpx.AsyncClient:
    global _nppes_http_client
    if _nppes_http_client is None:
        _nppes_http_client = httpx.AsyncClient()
    return _nppes_http_client

def get_llm_client() -> AsyncOpenAI:
    global _llm_client
    if _llm_client is None:
        settings = get_settings()
        # Gemini's free tier via its OpenAI-compatible endpoint — see .env.example.
        _llm_client = AsyncOpenAI(api_key=settings.llm_api_key, base_url=settings.llm_base_url)
    return _llm_client
```

- [ ] **Step 4: Write the four routers**

```python
# app/api/patients_router.py
from fastapi import APIRouter, Depends, HTTPException
from app.core.dependencies import get_medplum_client
from app.core.medplum_client import MedplumClient
from app.core.exceptions import PatientNotFoundError
from app.models.patient import PatientSummary, PatientHistory
from app.patients.service import list_demo_patients, get_patient_history

router = APIRouter()

@router.get("/patients", response_model=list[PatientSummary])
async def get_patients(client: MedplumClient = Depends(get_medplum_client)):
    return await list_demo_patients(client)

@router.get("/patients/{patient_id}/history", response_model=PatientHistory)
async def get_history(patient_id: str, client: MedplumClient = Depends(get_medplum_client)):
    try:
        return await get_patient_history(client, patient_id)
    except PatientNotFoundError:
        raise HTTPException(status_code=404, detail=f"Patient {patient_id} not found")
```

```python
# app/api/requests_router.py
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from openai import AsyncOpenAI
from app.config import get_settings, Settings
from app.core.dependencies import get_llm_client
from app.core.exceptions import IntentExtractionError
from app.models.intent import Intent
from app.intent.service import extract_intent

router = APIRouter()

class RequestPayload(BaseModel):
    patient_id: str
    text: str

@router.post("/requests", response_model=Intent)
async def create_request(
    payload: RequestPayload,
    llm_client: AsyncOpenAI = Depends(get_llm_client),
    settings: Settings = Depends(get_settings),
):
    try:
        return await extract_intent(llm_client, settings.llm_model, payload.text)
    except IntentExtractionError:
        raise HTTPException(status_code=422, detail="Could not determine specialty — please clarify your request")
```

```python
# app/api/doctors_router.py
from datetime import date, timedelta
import httpx
from fastapi import APIRouter, Depends, HTTPException
from app.core.dependencies import get_medplum_client, get_nppes_http_client
from app.core.medplum_client import MedplumClient
from app.core.exceptions import DoctorNotFoundError
from app.config import get_settings, Settings
from app.models.scheduling import SlotView
from app.patients.service import find_previous_practitioner_by_specialty
from app.directory.service import search_doctors
from app.scheduling.service import get_available_slots

router = APIRouter()

@router.get("/doctors")
async def get_doctors(
    specialty: str, patient_id: str, city: str, state: str,
    client: MedplumClient = Depends(get_medplum_client),
    nppes_http_client: httpx.AsyncClient = Depends(get_nppes_http_client),
    settings: Settings = Depends(get_settings),
):
    previous = await find_previous_practitioner_by_specialty(client, patient_id, specialty)
    new_doctors = await search_doctors(nppes_http_client, settings.nppes_base_url, specialty, city, state)
    return {"previous_physician": previous, "new_doctors": new_doctors}

@router.get("/doctors/{npi}/slots", response_model=list[SlotView])
async def get_slots(
    npi: str,
    client: MedplumClient = Depends(get_medplum_client),
    nppes_http_client: httpx.AsyncClient = Depends(get_nppes_http_client),
    settings: Settings = Depends(get_settings),
):
    try:
        return await get_available_slots(
            client, nppes_http_client, settings.nppes_base_url, npi, date.today(), date.today() + timedelta(days=14),
        )
    except DoctorNotFoundError:
        raise HTTPException(status_code=404, detail=f"No doctor found for NPI {npi}")
```

```python
# app/api/appointments_router.py
from fastapi import APIRouter, Depends, HTTPException
from app.core.dependencies import get_medplum_client
from app.core.medplum_client import MedplumClient
from app.core.exceptions import SlotUnavailableError
from app.models.scheduling import SlotView, BookingResult
from app.booking.service import book_appointment

router = APIRouter()

class BookingRequest(SlotView):
    patient_id: str

@router.post("/appointments", response_model=BookingResult)
async def create_appointment(payload: BookingRequest, client: MedplumClient = Depends(get_medplum_client)):
    slot = SlotView(schedule_id=payload.schedule_id, start_time=payload.start_time, end_time=payload.end_time)
    try:
        return await book_appointment(client, payload.patient_id, slot)
    except SlotUnavailableError:
        raise HTTPException(status_code=409, detail="This slot is no longer available")
```

- [ ] **Step 5: Write `app/api/__init__.py` (empty) and `app/main.py`**

```python
# app/main.py
from fastapi import FastAPI
from app.api import patients_router, requests_router, doctors_router, appointments_router

app = FastAPI(title="Doctor Appointment Agent")
app.include_router(patients_router.router)
app.include_router(requests_router.router)
app.include_router(doctors_router.router)
app.include_router(appointments_router.router)

@app.get("/health")
async def health():
    return {"status": "ok"}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pytest tests/api/test_routers.py -v`
Expected: PASS (4 passed)

- [ ] **Step 7: Commit**

```bash
git add app/core/dependencies.py app/api/ app/main.py tests/api/
git commit -m "feat: wire up FastAPI routers and app entrypoint"
```

---

## Task 13: Smoke Tests (Design doc §8)

**Files:**
- Create: `tests/smoke/__init__.py`
- Create: `tests/smoke/test_intent_sanity.py`
- Create: `tests/smoke/test_booking_conflict.py`

**Interfaces:**
- Consumes: `extract_intent` (Task 7), the running `app` + `get_medplum_client` (Task 12). These are the two smoke tests called out by name in Design doc §8 — distinct from the per-module unit tests already written, run against the **real** LLM (test 1) and the **full wired app** (test 2) respectively.

- [ ] **Step 1: Write the LLM sanity smoke test (real LLM call, not mocked)**

```python
# tests/smoke/test_intent_sanity.py
import pytest
from openai import AsyncOpenAI
from app.config import get_settings
from app.intent.service import extract_intent

EXAMPLES = [
    ("I've had chest pain and shortness of breath for two days", "cardiology"),
    ("I have a persistent skin rash that won't go away", "dermatology"),
    ("I need a general checkup, nothing specific", "general practice"),
]

@pytest.mark.parametrize("request_text,expected_specialty", EXAMPLES)
async def test_llm_extracts_plausible_specialty(request_text, expected_specialty):
    settings = get_settings()
    client = AsyncOpenAI(api_key=settings.llm_api_key, base_url=settings.llm_base_url)
    result = await extract_intent(client, settings.llm_model, request_text)
    assert result.specialty.strip().lower() == expected_specialty
```

- [ ] **Step 2: Write the booking-conflict smoke test (full app, mocked Medplum)**

```python
# tests/smoke/test_booking_conflict.py
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock
from app.main import app
from app.core.dependencies import get_medplum_client
from app.core.exceptions import MedplumOperationError

def test_second_booking_of_same_slot_is_rejected_end_to_end():
    mock_medplum = AsyncMock()
    mock_medplum.execute_operation.side_effect = [
        {"id": "appt-1"},
        {"id": "appt-1", "start": "2026-08-01T09:00:00", "end": "2026-08-01T09:30:00", "participant": []},
        MedplumOperationError("conflict", status_code=409),
    ]
    app.dependency_overrides[get_medplum_client] = lambda: mock_medplum
    client = TestClient(app)
    payload = {"schedule_id": "sched-1", "start_time": "2026-08-01T09:00:00", "end_time": "2026-08-01T09:30:00", "patient_id": "patient-1"}
    first = client.post("/appointments", json=payload)
    assert first.status_code == 200
    second = client.post("/appointments", json={**payload, "patient_id": "patient-2"})
    assert second.status_code == 409
    app.dependency_overrides.clear()
```

- [ ] **Step 3: Run both smoke tests**

Run: `pytest tests/smoke/ -v` (requires a real, free Gemini API key from `aistudio.google.com` set as `LLM_API_KEY` in `.env`, plus real `MEDPLUM_*` env vars)
Expected: PASS (4 passed). If `test_llm_extracts_plausible_specialty` fails on a specific example, that's a real signal about prompt quality (Task 7's `SYSTEM_PROMPT`), not a test bug — adjust the prompt, don't loosen the assertion.

- [ ] **Step 4: Commit**

```bash
git add tests/smoke/
git commit -m "test: add LLM sanity and booking-conflict smoke tests"
```

---

## Task 14: Streamlit UI

**Files:**
- Create: `ui/app.py`
- Modify: `requirements.txt` (already includes `streamlit`, `requests` needs adding)

**Interfaces:**
- Consumes: the full API surface from Task 12, over HTTP (`requests`, synchronous — matches Streamlit's per-script-rerun execution model).
- Produces: a runnable `streamlit run ui/app.py` demo covering FR-1 through FR-10.

This task deviates from the TDD step pattern used elsewhere: per Design doc §8, UI verification for this POC is the **manual walkthrough checklist**, not automated component tests — Streamlit apps aren't meaningfully unit-testable without a disproportionate amount of scaffolding for a POC that already decided against that tier of testing. The "test" step here is the manual walkthrough itself.

- [ ] **Step 1: Add `requests` to `requirements.txt`**

```
requests==2.32.3
```

- [ ] **Step 2: Write `ui/app.py`**

```python
# ui/app.py
import requests
import streamlit as st

API_BASE = "http://localhost:8000"

st.title("Doctor Appointment Agent")

patients = requests.get(f"{API_BASE}/patients").json()
patient_options = {p["display_name"]: p["id"] for p in patients}
selected_name = st.selectbox("Select a patient", list(patient_options.keys()))
patient_id = patient_options[selected_name]

history = requests.get(f"{API_BASE}/patients/{patient_id}/history").json()
st.subheader("Patient History")
st.json(history)

request_text = st.text_area("Describe your appointment request")
if st.button("Submit request") and request_text:
    intent_response = requests.post(f"{API_BASE}/requests", json={"patient_id": patient_id, "text": request_text})
    if intent_response.status_code == 200:
        st.session_state["intent"] = intent_response.json()
    else:
        st.error(intent_response.json().get("detail", "Could not understand the request — please rephrase."))

if "intent" in st.session_state:
    intent = st.session_state["intent"]
    st.write(f"Detected specialty: **{intent['specialty']}**")

    doctors_response = requests.get(f"{API_BASE}/doctors", params={
        "specialty": intent["specialty"], "patient_id": patient_id, "city": "Boston", "state": "MA",
    }).json()

    options = []
    if doctors_response.get("previous_physician"):
        prev = doctors_response["previous_physician"]
        options.append((f"(Previous) Dr. {prev['name']}", prev["id"], None))
    for doc in doctors_response.get("new_doctors", []):
        options.append((f"Dr. {doc['first_name']} {doc['last_name']} ({doc['specialty']})", doc["npi"], doc))

    if options:
        labels = [o[0] for o in options]
        choice = st.selectbox("Choose a doctor", labels)
        chosen = options[labels.index(choice)]
        npi = chosen[1]

        if npi:
            slots = requests.get(f"{API_BASE}/doctors/{npi}/slots").json()
            slot_labels = [f"{s['start_time']} - {s['end_time']}" for s in slots]
            if slot_labels:
                slot_choice = st.selectbox("Choose a slot", slot_labels)
                chosen_slot = slots[slot_labels.index(slot_choice)]
                if st.button("Confirm booking"):
                    booking_response = requests.post(f"{API_BASE}/appointments", json={**chosen_slot, "patient_id": patient_id})
                    if booking_response.status_code == 200:
                        st.success("Appointment confirmed!")
                        st.json(booking_response.json())
                    else:
                        st.error(booking_response.json().get("detail", "Booking failed — please pick another slot."))
            else:
                st.info("No available slots for this doctor.")
    else:
        st.info("No doctors found.")
```

- [ ] **Step 3: Manual walkthrough (per Specs doc FR-1 through FR-10)**

Run: `uvicorn app.main:app --reload` in one terminal, `streamlit run ui/app.py` in another. Walk through, in order:
1. Select a demo patient (FR-1) → history renders below (FR-2).
2. Enter a request like "I've had chest pain for two days" → submit → detected specialty appears (FR-3, FR-4).
3. Confirm either a previous-physician option appears (for a patient/specialty pair known to match, FR-5) or the search falls through to NPPES results (FR-6, FR-7).
4. Pick a doctor → slots render (FR-8).
5. Pick a slot → confirm → success message + booking details appear (FR-9).
6. Re-run the booking request for the same slot (e.g. via `curl` or a second browser tab) and confirm it's rejected (FR-10).

- [ ] **Step 4: Commit**

```bash
git add ui/app.py requirements.txt
git commit -m "feat: add minimal Streamlit UI"
```

---

## Self-Review Notes

- **Spec coverage:** FR-1/FR-2 → Tasks 6, 12. FR-3/FR-4 → Tasks 7, 12. FR-5/FR-7 → Tasks 6, 12 (`find_previous_practitioner_by_specialty` + always-included `new_doctors` search). FR-6 → Tasks 8, 12. FR-8 → Tasks 9, 10, 12. FR-9/FR-10 → Tasks 11, 12, 13. Data import/enrichment (Data Model doc) → Task 5. All covered.
- **Type consistency:** verified `MedplumClient`'s five methods, all model names/fields, and all service function signatures are used identically across every task that consumes them (cross-checked `Doctor`, `SlotView`, `HeldAppointment`, `ConfirmedAppointment`, `BookingResult`, and all exception names).
- **Known deviation flagged inline:** Task 11's `book_appointment` drops the `npi` parameter from the earlier LLD sketch as unnecessary; Task 10's Medplum `Schedule` extension URL is flagged for verification against live Medplum docs before real use; Task 5's import script is explicitly excluded from the automated test suite (hits real data/Medplum) and run manually once.

---

Plan complete and saved to `docs/superpowers/plans/2026-07-30-doctor-appointment-agent-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
