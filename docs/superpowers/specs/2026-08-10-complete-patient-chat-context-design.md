# Complete Patient Chat Context

## Problem

Patient chat loads the selected `Patient` and four clinical collections, but its
prompt discards the `Patient` resource and reduces the clinical collections to a
few display strings. Gemini therefore receives medication names but not the
patient's name, birth date, gender, address, identifiers, contact details, or
many other recorded FHIR fields. The system prompt correctly tells Gemini not to
guess, so it reports those omitted facts as not recorded.

The current loader also limits each collection to 50 results. Expanding only the
prompt would therefore still silently omit records for patients with larger
histories and would continue to ignore additional FHIR resource types uploaded
by a full seed.

## Goals

- Give patient chat the complete information stored for the selected patient,
  including direct identifiers, demographics, contact details, address and
  geolocation data, and clinical history.
- Include every resource returned by Medplum's patient-compartment operation,
  rather than maintaining a fixed list of supported clinical types.
- Follow every result page so no record is silently dropped by a search limit.
- Make common demographic facts reliable and easy for the model to find while
  retaining the complete underlying FHIR JSON.
- Preserve the existing booking-relationship check, read-only behavior, clinical
  interpretation refusal, and selected-patient boundary.

## Non-goals

- Giving Gemini general Medplum search or write tools.
- Allowing the model to choose a different patient or access another patient's
  compartment.
- Diagnosing, interpreting, recommending treatment, triaging, or inferring facts
  absent from the record.
- Changing the intake agent's deliberately smaller clinical-history prompt.
- Changing the seed process or fabricating resources that were never uploaded.

## Design

### Complete patient-compartment loader

Patient chat will use a dedicated complete-context loader. After the existing
NPI-to-patient booking relationship is verified, the loader will call the FHIR
R4 instance operation:

`Patient/{patientId}/$everything`

It will follow every `Bundle.link` entry whose relation is `next`, combine all
entries, and deduplicate resources by `resourceType/id`. The focal `Patient`
must be present; if the operation omits it, the loader will read it directly and
add it. Resources without IDs will be retained using a deterministic serialized
identity so valid contained or operation-produced data is not discarded.

The operation is bound to the already verified `patientId`. Neither the doctor's
question nor Gemini output can alter the resource path or query another patient.
The returned context is an ordered collection of complete FHIR resources, so a
default slim seed exposes all of its patient data and a full seed can expose
additional types such as observations, procedures, diagnostic reports,
immunizations, and care plans without another code change.

### Prompt representation

The chat prompt will contain two complementary sections:

1. A deterministic demographic index derived from the focal `Patient`, covering
   all names, identifiers, birth date, computed age when a complete birth date is
   available, gender, deceased and multiple-birth values, marital status,
   telecom, addresses, geolocation extensions, communication preferences,
   contacts, general practitioners, managing organization, links, and other
   extensions.
2. A complete JSON snapshot of every resource returned by the patient
   compartment, grouped by resource type and ordered deterministically.

The index makes common questions such as name, age, gender, and location
reliable. The complete JSON remains the source of truth for fields not promoted
into the index. Age is a transparent deterministic derivation from a full
`birthDate` and the current UTC date; it is not guessed for partial or absent
dates.

No resource or field will be silently truncated. If Medplum pagination fails or
the complete prompt cannot be constructed, the action will fail with a generic
temporary-unavailability response through the existing API boundary instead of
asking Gemini to answer from a partial record.

### Model instructions and privacy boundary

The system prompt will explicitly state that the supplied snapshot contains the
complete available record for exactly one patient and that all answers must be
direct record lookup. Existing refusal language for diagnosis, interpretation,
treatment, medication changes, prognosis, and other clinical advice remains
unchanged.

The approved scope includes direct identifiers and contact information. For this
synthetic Synthea POC, that full selected-patient context is sent to Gemini for
each patient-chat question. API keys, access tokens, environment variables, and
application secrets are never part of the FHIR snapshot or prompt.

### Existing behavior retained

- The entered NPI must resolve to a Practitioner that has an Appointment with
  the selected patient before any patient context is loaded.
- The model receives no FHIR credentials and no callable tools.
- Questions and answers continue to be stored as threaded `Communication`
  resources with their existing sender and AI-generated provenance rules.
- The interpretation-language output guard remains defense in depth.

## Error Handling

- Missing Practitioner and missing booking relationship errors retain their
  current behavior.
- A missing focal Patient, invalid `$everything` response, failed pagination, or
  repeated pagination URL fails the request; partial context is never sent.
- Duplicate resources across pages are collapsed deterministically.
- Missing individual patient fields remain absent and Gemini must say they are
  not recorded rather than inventing a value.
- A birth date that is missing or less precise than a full calendar date does
  not produce an exact age.

## Testing

Tests will be written before implementation and must demonstrate:

1. The prompt includes the patient's names, identifiers, complete birth date,
   computed age, gender, telecom, address, geolocation, contacts, practitioner,
   organization, and extensions.
2. The prompt retains full condition, medication, allergy, and encounter
   resources rather than only their display labels.
3. Additional resource types returned by `$everything` are included without
   hard-coded prompt changes.
4. Every pagination page is consumed, duplicate resources are removed, and a
   pagination cycle fails closed.
5. No resource from a different patient is requested or introduced by the
   doctor's question.
6. Missing or partial birth dates do not create a fabricated exact age.
7. Existing booking-relationship, Gemini-model, threaded-communication, and
   clinical-refusal tests remain green.

Focused tests will be followed by the full TypeScript, lint, Vitest, and
production-build gates.
