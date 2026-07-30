# Doctor Appointment Agent — Low-Level Design

Function-by-function design for every module in `Doctor_Appointment_Agent_Backend.md`.
Each entry: signature, purpose, inputs/outputs, step-by-step logic, and errors
raised. Types referenced (`PatientHistory`, `Doctor`, `SlotView`, etc.) live in
`app/models/` per the Backend doc; field-level shapes are in the Data Model
doc.

---

## `core/medplum_client.py`

### `MedplumClient.__init__(base_url, client_id, client_secret)`
Stores config; does not authenticate until first request (lazy token fetch).

### `MedplumClient._get_token() -> str`
- **Logic:** if a cached token exists and isn't expired, return it. Otherwise
  `POST {base_url}/oauth2/token` with client-credentials grant, cache the
  returned token + expiry, return it.
- **Errors:** `MedplumAuthError` if the token endpoint rejects the
  credentials.

### `MedplumClient.read(resource_type: str, id: str) -> dict`
- `GET {base_url}/fhir/R4/{resource_type}/{id}` with bearer token.
- Returns the parsed FHIR resource as a dict, or raises
  `MedplumNotFoundError` on 404.

### `MedplumClient.search(resource_type: str, params: dict) -> list[dict]`
- `GET {base_url}/fhir/R4/{resource_type}?{params}`.
- Returns the list of resources in the returned Bundle's `entry[].resource`
  (empty list if the Bundle has no entries — not an error).

### `MedplumClient.create(resource: dict) -> dict`
- `POST {base_url}/fhir/R4/{resource['resourceType']}` with the resource body.
- Returns the created resource (including its assigned `id`).

### `MedplumClient.execute_operation(resource_type: str, id: str | None, operation: str, body: dict) -> dict`
- `POST {base_url}/fhir/R4/{resource_type}[/{id}]/${operation}` (e.g.
  `Appointment/$find`, `Appointment/$hold`, `Appointment/$confirm`).
- Returns the operation's response body.
- **Errors:** raises `MedplumOperationError` on any non-2xx response,
  carrying the status code so callers (`scheduling/`) can distinguish "slot
  unavailable" (409/422 from Medplum) from a genuine failure.

---

## `patients/service.py`

### `list_demo_patients() -> list[PatientSummary]`
- **Purpose:** FR-1 — populate the patient picker.
- **Inputs:** none.
- **Logic:**
  1. `medplum_client.search("Patient", {"_count": 20})` (demo project is
     small; no pagination needed for a POC).
  2. Map each resource to `PatientSummary{id, display_name, birth_date}`.
- **Output:** `list[PatientSummary]`, possibly empty (not an error state —
  UI shows "no demo patients configured").

### `get_patient_history(patient_id: str) -> PatientHistory`
- **Purpose:** FR-2.
- **Inputs:** `patient_id`.
- **Logic:**
  1. `medplum_client.read("Patient", patient_id)` — raises
     `PatientNotFoundError` (wrapping `MedplumNotFoundError`) if missing.
  2. In parallel (async gather): `search("Condition", {"subject": patient_id})`,
     `search("MedicationRequest", {"subject": patient_id})`,
     `search("AllergyIntolerance", {"patient": patient_id})`,
     `search("Encounter", {"subject": patient_id, "_include":
     "Encounter:practitioner", "_include": "Encounter:service-provider"})`.
  3. For each Encounter, resolve its `participant[].individual`
     (Practitioner) and `serviceProvider` (Organization) from the included
     resources in the same Bundle (avoids N+1 reads).
  4. Build `previous_practitioners`: dedup list of
     `{practitioner_id, name, specialty}` derived from
     `Practitioner.qualification[].code` across all resolved encounters.
  5. Assemble and return `PatientHistory{patient, conditions, medications,
     allergies, encounters, previous_practitioners}`.
- **Errors:** `PatientNotFoundError` (→ 404 at the API layer).

### `find_previous_practitioner_by_specialty(patient_id: str, specialty: str) -> Practitioner | None`
- **Purpose:** FR-5.
- **Inputs:** `patient_id`, `specialty` (normalized string from `intent/`).
- **Logic:**
  1. Call `get_patient_history(patient_id)`.
  2. Normalize `specialty` (lowercase, strip) and compare against each
     `previous_practitioners[].specialty` the same way.
  3. Return the first match, or `None`.
- **Output:** `Practitioner | None`. `None` is a normal result, not an error
  — the caller (`api/doctors_router.py`) falls through to `directory.
  search_doctors` when this returns `None` (FR-6).

---

## `intent/service.py`

### `extract_intent(request_text: str) -> Intent`
- **Purpose:** FR-3, FR-4.
- **Inputs:** `request_text` (raw user string, 1–2 sentences).
- **Logic:**
  1. Build the prompt from `prompts.py`'s template, instructing the model to
     return structured output matching `{specialty: str, reason: str,
     urgency: "routine"|"urgent"}`.
  2. Call the LLM provider with structured/JSON-mode output.
  3. Validate the response against the `Intent` pydantic model.
  4. If the model indicates low confidence (e.g. an explicit
     `specialty: null` or a confidence field below a fixed threshold defined
     in `prompts.py`), raise `IntentExtractionError` rather than guessing.
- **Output:** `Intent{specialty, reason, urgency}`.
- **Errors:** `IntentExtractionError` (→ the API layer returns a
  "please clarify your request" response, per FR-4's acceptance criteria —
  never silently defaults to a specialty).

---

## `directory/service.py`

### `search_doctors(specialty: str, location: str, limit: int = 10) -> list[Doctor]`
- **Purpose:** FR-6.
- **Inputs:** `specialty` (from `Intent`), `location` (from the patient's
  address, read off the `Patient` resource), `limit`.
- **Logic:**
  1. Map `specialty` to an NPPES taxonomy description (a small static
     lookup table in this module — NPPES taxonomies are a fixed, known set).
  2. `GET {NPPES_BASE_URL}` with `taxonomy_description`, `city`/`state` (or
     `postal_code`) parsed from `location`, `limit`.
  3. Filter out results where `NPI status != "A"` (active).
  4. Map each result to `Doctor{npi, first_name, last_name, specialty,
     address, phone}`.
- **Output:** `list[Doctor]`, possibly empty — the API layer treats zero
  results as a normal "no doctors found" response (Design doc §7), not an
  error.
- **Errors:** none domain-specific; network/5xx errors from NPPES propagate
  as a generic upstream error.

### `get_doctor_by_npi(npi: str) -> Doctor | None`
- **Purpose:** used by `scheduling.ensure_practitioner` to fetch full doctor
  details before mirroring into Medplum.
- **Logic:** `GET {NPPES_BASE_URL}?number={npi}`; map the single result the
  same way as `search_doctors`, or return `None` if NPPES has no record for
  that NPI.

---

## `scheduling/service.py`

### `ensure_practitioner(doctor: Doctor) -> str`
- **Purpose:** Design doc §5 — lazy `Practitioner` creation, idempotent per
  NPI.
- **Inputs:** `Doctor` (from `directory/`).
- **Logic:**
  1. `medplum_client.search("Practitioner", {"identifier":
     f"http://hl7.org/fhir/sid/us-npi|{doctor.npi}"})`.
  2. If a result exists, return its `id`.
  3. Otherwise build a `Practitioner` resource from `doctor` (identifier,
     name, telecom, address, `qualification[].code` = specialty) and
     `medplum_client.create(...)`.
  4. Return the new resource's `id`.
- **Output:** Medplum `Practitioner.id` (string).
- **Idempotency:** step 1's identifier search is what guarantees "never
  recreate" — concurrent first-time calls for the same NPI are a known,
  accepted, low-probability race for a single-user POC (not guarded further).

### `ensure_schedule(practitioner_id: str, npi: str) -> str`
- **Purpose:** Design doc §5 — lazy `Schedule` creation with an NPI-seeded
  recurring template.
- **Inputs:** `practitioner_id` (Medplum id), `npi` (seed source).
- **Logic:**
  1. `medplum_client.search("Schedule", {"actor": f"Practitioner/{practitioner_id}"})`.
  2. If found, return its `id`.
  3. Otherwise call `template.generate_weekly_template(npi)` →
     `{working_days, start_hour, end_hour, lunch_start, lunch_end}`
     (see `template.py` below).
  4. Build a `Schedule` resource with `actor = Practitioner/{practitioner_id}`
     and the `SchedulingParameters` extension populated from the template.
  5. `medplum_client.create(...)`; return the new `id`.
- **Output:** Medplum `Schedule.id`.

### `get_available_slots(npi: str, date_from: date, date_to: date) -> list[SlotView]`
- **Purpose:** FR-8.
- **Inputs:** `npi`, date range (defaults to "next 14 days" if unspecified,
  chosen in the API layer, not here).
- **Logic:**
  1. `directory.get_doctor_by_npi(npi)` — raise `DoctorNotFoundError` if
     NPPES has no such NPI (guards against a client passing a bogus NPI).
  2. `practitioner_id = ensure_practitioner(doctor)`.
  3. `schedule_id = ensure_schedule(practitioner_id, npi)`.
  4. `medplum_client.execute_operation("Appointment", None, "find",
     {"schedule": schedule_id, "start": date_from, "end": date_to,
     "duration_minutes": 30})`.
  5. Map each returned candidate time block to `SlotView{schedule_id,
     start_time, end_time}`.
- **Output:** `list[SlotView]` — empty list is valid (e.g. doctor fully
  booked in range; not expected in practice since slots start open, but not
  treated as an error either way).

### `hold_slot(schedule_id: str, start_time: datetime, end_time: datetime, patient_id: str) -> HeldAppointment`
- **Purpose:** first half of FR-9/FR-10.
- **Logic:**
  1. `medplum_client.execute_operation("Appointment", None, "hold",
     {"schedule": schedule_id, "start": start_time, "end": end_time,
     "patient": f"Patient/{patient_id}"})`.
  2. On success, return `HeldAppointment{appointment_id, status="pending"}`.
  3. On a conflict response from Medplum (slot no longer available),
     raise `SlotUnavailableError`.
- **Errors:** `SlotUnavailableError` (→ `409` at the API layer, FR-10).

### `confirm_appointment(appointment_id: str) -> ConfirmedAppointment`
- **Purpose:** second half of FR-9.
- **Logic:** `medplum_client.execute_operation("Appointment",
  appointment_id, "confirm", {})`; map the response to
  `ConfirmedAppointment{appointment_id, status="booked", start_time,
  end_time, practitioner_name, patient_id}`.
- **Errors:** propagates `MedplumOperationError` if confirm fails after a
  successful hold (treated as a genuine failure, not a 409 — the hold
  already proved the slot was available).

---

## `scheduling/template.py`

### `generate_weekly_template(npi: str) -> WeeklyTemplate`
- **Purpose:** deterministic, NPI-seeded schedule variety (Design doc §5).
- **Inputs:** `npi` (string of digits).
- **Logic:**
  1. `seed = int(npi)`; `rng = random.Random(seed)`.
  2. `working_days = rng.choice([["Mon","Tue","Wed","Thu","Fri"], ["Tue","Wed","Thu","Fri","Sat"], ...])`
     (a small fixed set of plausible patterns, not fully random days).
  3. `start_hour = rng.choice([8, 9])`, `end_hour = rng.choice([16, 17, 18])`.
  4. `lunch_start = rng.choice([12, 12.5, 13])`, `lunch_end = lunch_start + 1`.
  5. Return `WeeklyTemplate{working_days, start_hour, end_hour, lunch_start,
     lunch_end}`.
- **Determinism guarantee:** same `npi` → same `rng` sequence → same
  template, every time, on any machine (standard library `random.Random`
  with an explicit seed is deterministic across runs).

---

## `booking/service.py`

### `book_appointment(patient_id: str, npi: str, slot: SlotView) -> BookingResult`
- **Purpose:** FR-9, FR-10 — the orchestration `api/appointments_router.py`
  calls directly.
- **Inputs:** `patient_id`, `npi`, `slot` (as returned by `get_available_slots`,
  round-tripped from the UI).
- **Logic:**
  1. `held = scheduling.hold_slot(slot.schedule_id, slot.start_time,
     slot.end_time, patient_id)` — lets `SlotUnavailableError` propagate
     unchanged (caller maps it to `409`).
  2. `confirmed = scheduling.confirm_appointment(held.appointment_id)`.
  3. Return `BookingResult{status="confirmed", appointment=confirmed}`.
- **Output:** `BookingResult`.
- **Errors:** `SlotUnavailableError` only (step 1); anything past that point
  is a genuine upstream failure, not a business-logic conflict.

---

## `api/*_router.py`

Thin FastAPI routers — request/response shaping only, no logic beyond
mapping domain exceptions to HTTP responses:

| Router | Endpoint | Calls | Exception → status mapping |
|---|---|---|---|
| `patients_router.py` | `GET /patients` | `patients.list_demo_patients` | — |
| `patients_router.py` | `GET /patients/{id}/history` | `patients.get_patient_history` | `PatientNotFoundError` → 404 |
| `requests_router.py` | `POST /requests` | `intent.extract_intent` | `IntentExtractionError` → 422 with a "please clarify" message |
| `doctors_router.py` | `GET /doctors` | `patients.find_previous_practitioner_by_specialty` then, if `None`, `directory.search_doctors` | empty list is `200 OK`, not an error |
| `doctors_router.py` | `GET /doctors/{npi}/slots` | `scheduling.get_available_slots` | `DoctorNotFoundError` → 404 |
| `appointments_router.py` | `POST /appointments` | `booking.book_appointment` | `SlotUnavailableError` → 409 |
