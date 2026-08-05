# Response to `issues.md` — Verification Report

> **Archived audit record; final resolutions synchronized 2026-08-05.** The
> narrative below records defects in earlier plan revisions and is not
> implementation guidance. The final contract is
> `docs/superpowers/plans/2026-08-04-medplum-native-implementation.md`:
> Bot-side fresh `$find`, one `$book`, bare-Bundle operation responses,
> deterministic PUT seed identity, native `$cancel`, service-specific
> scheduling parameters, and exact `@medplum/*` version `5.1.27`. The
> Re-Verification table has been updated to those final resolutions.

`issues.md` audited the 2026-08-04 implementation plan and claimed 14
release-blocking defects, 19 P1 risks, and several open product decisions.
This document independently re-verifies every P0 claim and the dataset
findings directly against real source (`medplum/`, `medplum-scheduling-demo/`)
and the real `fhir/` corpus — not by re-reading `issues.md`'s prose, but by
reading the same files it cites and running the same kind of checks against
the actual data. Where a claim is confirmed, the evidence is cited. Where a
claim is wrong, overstated, or a judgment call rather than a defect, that's
said plainly too.

**Bottom line: `issues.md` is accurate. Every P0 claim I could check came
back true, several against my own exact plan text.** This is not a
close call — the plan as written would not work. It should not go to Task 1
as-is. A correction pass is warranted before implementation starts, exactly
as `issues.md` concludes.

## Method

- Dispatched two research agents to read the actual Medplum v5.1.27 source
  (`hold.ts`, `find.ts`, `book.ts`, `cancel.ts`, `confirm.ts`,
  `scheduling.ts`, `scheduling-parameters.ts`, `routes.ts`) and the actual
  fork source (`UploadDataPage.tsx`, `block-availability.ts`, `App.tsx`,
  `package.json`, `tsconfig.json`, both `.gitignore` files, `PatientSummary`,
  Mantine's exports) — with instructions to cite file:line and to say
  explicitly if a claim turned out to be wrong.
- Independently re-ran the dataset checks myself with a Node script against
  all 983 real `fhir/*.json` bundles (not summarized from a prior doc).
- Re-read my own plan's exact text for every claim that named a specific
  task, using `Read`/`Grep` against the actual plan file, not memory.

## P0 Claims — Verified

### 1. Booking contract cannot work — **CONFIRMED, and worse than described**

Verified directly: `$hold` (`medplum/packages/server/src/fhir/operations/hold.ts:12-22`)
requires a `Parameters` resource wrapping an `appointment` parameter — not a
bare `Appointment`. And Task 21's proposed Appointment has no `contained`
Slot; `validateProposedAppointment` (`scheduling.ts:628-637`) throws
`'Appointment has no contained Slot resources'` if one is absent. This is a
hard requirement, not a nice-to-have.

I need to be honest about the specific mistake here: I *did* correctly
establish, in an earlier audit round this session, that a held/confirmed
Slot ends up as a real, top-level, independently-searchable resource (true,
and still true) — but I incorrectly generalized that into "so the request
never needs to propose one either," which is false. The output shape and
the input shape are different questions, and I conflated them. `$find`'s
own output confirms the correct shape: it returns proposed `Appointment`
resources that already carry `contained: Slot[]` (`find.ts:245-256`) — the
UI should be taking that shape from `$find` and passing it straight through
to `$hold`, not reconstructing a bare Appointment by hand.

### 2. `$hold` endpoint/body/response all wrong — **CONFIRMED against my own code**

My plan's Task 21 (`agent-book-appointment.ts`) calls:
```ts
held = (await medplum.post(`Schedule/${scheduleId}/$hold`, proposedAppointment)) as Appointment;
```
Real route: `POST /Appointment/$hold` (type-level, `routes.ts:423`,
confirmed by `hold.ts`'s own operation definition). Real request body: a
`Parameters` resource. Real response: a `Parameters` wrapping a `Bundle`
(`hold.ts:19, 41-57`), not a bare `Appointment`.

And `issues.md`'s sharpest point is the one I can verify without any
ambiguity: my own test (line 3137 of the plan) mocks
`if (url === 'Appointment/$hold')`, while my own implementation (line 3250)
calls `Schedule/${scheduleId}/$hold`. Those two strings never match. **My
own test, as written, would fail if actually run** — the mock's only
matching branch is dead code against my own implementation. This is not a
matter of interpretation; I read both lines side by side.

`reschedule-appointment.ts` (Task 25, line 3799) has the identical bug.

### 3. `$find` parsed as the wrong shape — **CONFIRMED against my own code**

Task 31's `SlotPickerPage.tsx` expects `parameter.name === 'slot'` entries
with `start`/`end` parts. Verified: `$find` has no `slot` output parameter
at all — the operation definition (`find.ts:36-50`) declares a single
`return` parameter of type `Bundle`, and the handler
(`find.ts:245-256, 288-296`) builds that Bundle out of proposed
`Appointment` resources, each with `contained` Slots. My UI code would
parse an empty array out of every real `$find` response — the slot picker
would always show "no slots available," even when the doctor has open time.

Also confirmed: `$find` defaults to 20 results (`DEFAULT_SEARCH_COUNT`,
`core/src/search/search.ts:11`) when `_count` isn't passed — my `$find`
call in Task 31 doesn't pass `_count`, so it's silently capped.

### 4. `$book` claim is backwards — **CONFIRMED, and I agree with the fix**

This is the one where `issues.md` is correcting a factual claim in my own
Design doc, not just the implementation plan. Verified: `$book`
(`book.ts:41-48`) calls the exact same `createProposedAppointment` →
`validateProposedAppointment` → `validateAllAvailability` path as `$hold`,
inside the same `serializable: true` transaction
(`scheduling.ts:722-759`). The only difference is which status
(`booked` vs `pending`) the customizer callback sets. There is no
skipped revalidation.

My original design doc rationale ("book.ts creates an Appointment as
booked directly with no re-check that the slot is still free") was
factually wrong — I said "confirmed by reading book.ts" earlier in this
project, but that read evidently didn't trace into the shared
`createProposedAppointment` path. This is worth sitting with: it's exactly
the kind of claim this whole project has repeatedly flagged as needing
direct verification rather than a plausible-sounding inference, and I
missed it on my own advice.

Given my UI confirms immediately after finding a slot (no "reserve while
you decide" step exists anywhere in the design), I agree with the
recommendation: switch to `$book`. This also deletes a whole layer of
complexity — no more hold/confirm two-step, no more `agent-expire-holds`
cron, no more stale-hold cleanup, no more "held but never confirmed"
failure mode.

### 5. Schedule availability extensions ignored — **CONFIRMED against my own code**

Task 19's `buildSchedulingParametersExtension` builds one extension with
`timezone` + `availability`, and no `service` sub-extension — I checked the
exact lines. Verified in real source
(`scheduling-parameters.ts:452-472`): a Schedule-level `SchedulingParameters`
extension is filtered against a `service` sub-extension matching the
*specific* HealthcareService being requested
(`serviceExt.some((ext) => isReferenceTo(ext.valueReference, healthcareService))`).
An extension with no `service` sub-extension matches nothing — it's simply
skipped, and the code falls back to HealthcareService-level defaults. My
whole NPI-seeded weekly template (work days, hours, lunch gap) would never
be read; every provisioned doctor would run on whatever defaults the
`HealthcareService` resources carry, which my Task 8 bootstrap bundle never
defines beyond `duration`. Depending on what's missing, this plausibly
throws `No timezone specified` or falls back to no availability at all.

Also confirmed: `App.tsx`'s existing auto-Schedule-creation
(`App.tsx:33-58`) creates a bare `Schedule` with no extension at all for
any logged-in Practitioner — and my plan's `ensurePractitionerAndSchedule`
reuses any existing Schedule without checking whether it's actually
well-formed for scheduling. A practitioner who happens to sign into the
provider-side app before ever being provisioned through `/agent` would get
stuck with a permanently broken Schedule.

### 6. Specialty table is materially wrong — **CONFIRMED, and it's bad**

I checked the real `Disease_Description.csv` row order: `Drug Reaction,
Malaria, Allergy, Hypothyroidism, Psoriasis, ...`. My plan's
`DISEASE_SPECIALTIES` array starts `['Cardiology', 'Pulmonology',
'Endocrinology', 'Gastroenterology', 'Neurology', ...]` — meaning my table
maps Drug Reaction→Cardiology, Malaria→Pulmonology, Psoriasis→Neurology.
None of that is defensible. I did not actually read the CSV's real row
order when I wrote Task 4 — I wrote a plausible-looking rotation of
specialty names instead of the real mapping.

The retired Python file
(`.claude/worktrees/doctor-appointment-agent-impl/scripts/specialty_mapping.py`)
has the *correct* mapping already, verified by row order against the same
CSV: Drug Reaction→Allergy and Immunology, Malaria→Infectious Disease,
Psoriasis→Dermatology, etc. — and it includes three specialties genuinely
absent from my `SPECIALTY_TABLE` (Allergy and Immunology, General Surgery,
Vascular Surgery). The fix is simple and low-risk: port
`SPECIALTIES_IN_FILE_ORDER` from that file verbatim instead of the array I
invented, and add the three missing specialties to `SPECIALTY_TABLE` with
real NUCC codes.

Also confirmed: my seeder writes the specialty's plain-English label
(`"Cardiology"`) into `PractitionerRole.specialty.coding.code`, where a
real NUCC code (`207RC0000X`) belongs. This breaks the entire point of
Task 11's `SPECIALTY_TABLE` (matching previous-physician search against a
real NUCC code) — the seeded data and the query code use different
vocabularies and would never match.

### 7. Seeder deduplication is broken — **CONFIRMED against real data + my own code**

I read a real Practitioner resource straight out of the corpus: its only
identifier is the NPI (`{system: 'http://hl7.org/fhir/sid/us-npi', value:
'290'}`). My `transformBundle` (Task 6) queries
`ifNoneExist: identifier=https://synthea.mitre.org/identifier|{id}` but
never adds that identifier to the resource before creating it — I only
spread `...resource`, then add `qualification` and `extension`, never a
new `identifier` entry. That conditional-create can never match anything,
because the identifier it searches for never exists. Every practitioner
would be a fresh duplicate on every run.

Also confirmed on Organization: the real data already carries an
identifier with system `https://github.com/synthetichealth/synthea` (value
= the resource's own UUID) — a different system than the one my
`ifNoneExist` queries, and one I could have reused directly instead of
inventing a new one that never gets attached.

Patient/Encounter/Condition/MedicationRequest/AllergyIntolerance are indeed
left as unconditional POSTs in my plan, so re-running the seed (e.g. a
`--limit 50` smoke test followed by a full run, as Tasks 10 and 36
literally describe doing) duplicates the first 50 patients and their full
clinical history.

### 8. Seeder exceeds the default size limit — **CONFIRMED, measured directly**

I measured the real corpus myself: the largest raw bundle is 38.87 MB;
after filtering to the 7 kept resource types, the two largest "slim"
bundles are 2.42 MB and 2.24 MB. Medplum's default `maxJsonSize` is `1mb`
(`config/utils.ts:27`, applied at `app.ts:217`). At least those two
patients' transactions fail outright on an unconfigured/default server —
my plan never states a required server config, and `uploadBundle` has no
chunking or per-resource-type splitting.

Also confirmed against my own code: `parseCliArgs` computes `args.mode`,
but `transformBundle(bundle, specialtiesByStableId)` (Task 9) is called
with exactly two arguments — `mode` is parsed and then never passed
anywhere. `--slim`/`--full` genuinely has zero effect on the transform,
confirmed by reading the call site.

### 9. Task 1 can stage the reference repos — **Correct as a risk, not yet a fact**

I re-read Task 1: it does instruct copying the fork's files "including
`.gitignore`" into the repo root before `git add -A`, and the fork's own
`.gitignore` (confirmed) has no entries for `.claude/`, `medplum/`, or
`medplum-scheduling-demo/` and additionally ignores `package-lock.json`
(which the root repo needs tracked). If the copy step overwrites the root
`.gitignore` instead of merging it, `.claude/` (~1.14 GB) and both
reference clones are stageable. This hasn't happened — it's a real
"loaded gun" in the task's phrasing, correctly flagged as something to fix
before Task 1 runs, not a live incident.

### 10. Bot deployment's "direct" path doesn't deploy bots — **CONFIRMED**

Verified: `UploadDataPage.tsx` resolves each Bot's ID/reference placeholder
via string replacement *and* calls `$deploy` with the compiled JS after the
batch upload — my plan's Task 26 "direct deploy" script does neither, just
submits the bundle with its placeholders unresolved. Also confirmed:
`checkBotsUploaded` gates the upload button on an exact count of 5
hard-coded bot names (`book-appointment`, `cancel-appointment`,
`set-availability`, `block-availability`, `example-data`) — two of which
Task 2 deletes and none of which match my plan's actual 9-bot roster. The
UI upload path would stay permanently disabled unless this check is
updated too.

### 11. Booking destroys the summary Communication — **CONFIRMED, this is the worst one**

`medplum.updateResource()` is a full resource replacement (FHIR `PUT`
semantics), not a patch. My Task 21 code calls it with only
`{resourceType, id, recipient, about, status, sent}` — no `category`,
`subject`, `sender`, `payload` (the actual summary text), `priority`, or
`meta.tag`. Booking an appointment would silently delete the AI summary's
content at the exact moment it's supposed to become visible to the doctor
— the one artifact the doctor-facing half of this whole project exists to
show. This needs a read-and-spread (or a real patch) before anything else
in this list.

### 12. `block-availability` can cancel other doctors' appointments — **CONFIRMED**

Verified directly: the Appointment-cancellation search in
`block-availability.ts` is `date=lt${end}&date=ge${start}&status=booked` —
no `actor`/`schedule`/practitioner filter at all, while the Slot search two
lines later correctly is schedule-scoped. This is pre-existing fork
behavior, not something I introduced — but my plan redeploys it unmodified
in Task 26 with no fix. It also doesn't touch the Slots of the Appointments
it cancels, leaving them permanently blocked. I should have caught this in
the earlier audit round that specifically went looking for exactly this
kind of scheduling-demo bug (it found the `cancel-appointment.ts` and
`RescheduleAppointment.tsx` bugs, but missed this one in the same file
family).

### 13. FR-2 history + a real compile error — **CONFIRMED, including the exact bug**

Verified: `PatientSummary`'s default sections
(`react/src/PatientSummary/sectionConfigs.tsx:261-274`) are Demographics,
Insurance, Allergies, ProblemList, Medications, Labs, SexualOrientation,
SmokingStatus, Vitals, Pharmacies — no Encounter/visit-history section
exists in the component at all. FR-2 explicitly requires past encounters
with practitioner/specialty/organization, which `PatientSummary` alone
cannot satisfy no matter how it's configured.

And I found the literal bug myself by grepping my own plan: Task 28
(`PatientPickerPage.tsx`) has
`import { Anchor, Document, Stack, Table, Title } from '@mantine/core';`
immediately followed by
`import { Document as MedplumDocument, useMedplum } from '@medplum/react';`.
Mantine has no component named `Document` — confirmed both by checking the
real export list in the monorepo and by checking that every other page in
the fork imports `Document` from `@medplum/react`, never Mantine. This is
a plain compile error, isolated to this one file (every other page in my
plan imports it correctly).

### 14. Queue summaries joined incorrectly — **CONFIRMED against my own code**

Re-checked Task 34: `summaryByPatientId` is a `Map<patientId, Communication>`
built by iterating summaries and calling `.set(patientId, communication)` —
a second booking by the same patient with the same doctor silently
overwrites the first summary in the map, and the join has no way to
prefer the summary that's actually `about` the specific Appointment being
rendered. `QueueTable`/`PatientBriefCard` key by `entry.patientId`, so two
separate bookings by the same patient collapse into one card. "Patient
queue" is genuinely a list of appointments in my implementation, and the
product language should match that or the join logic should change to
distinguish them.

## Dataset Findings — Verified Directly

I ran my own script against all 983 real bundles rather than trusting
either document's numbers:

| Claim | My measurement | Verdict |
|---|---|---|
| 983 bundles, 432,827 resources | 983 bundles, 432,827 resources | Exact match |
| 905 unique Practitioners, 0 NPI collisions | 905 unique, 0 collisions | Exact match |
| 733 of 983 patients have a postal code | 733 | Exact match |
| Patient state is always `"Massachusetts"`, never `"MA"` | Only value found: `Massachusetts` | Confirmed — this breaks NPPES search directly (it requires a 2-letter code) since my `agent-find-doctors.ts` passes the patient's state straight through |
| 16 of 38,450 Encounters have no practitioner | 16 of 38,450 (after correctly resolving `urn:uuid:` references against bundle fullUrls — my first pass at this check used the wrong extraction method and got 38,450/38,450 before I fixed it) | Confirmed |
| Two slim bundles ≈2.35/2.54 MB, full corpus max ≈40.75 MB | 2.42/2.24 MB slim, 38.87 MB largest raw | Same conclusion, minor measurement variance, doesn't change the finding |
| 192 patients >50 Encounters, 17 >200, max 1,625 | 192, 17, 1,625 | Exact match |
| 23 patients >50 MedicationRequests, max 1,236 | 23, max 1,236 | Exact match |

Every number I could independently check came back exact. I have no basis
to doubt the remaining dataset claims (fullUrl/POST structure, no dangling
references after the 7-type filter).

## Where I'd Push Back or Re-Prioritize

Not everything in `issues.md` needs the same urgency, and a couple of
framings are worth a second look:

- **"Triage-like clinical routing" (routine vs. urgent) as a safety
  violation** — I think this is correctly flagged as *worth a decision*,
  but overstated as equivalent to the P0 defects. Classifying scheduling
  urgency (which HealthcareService/duration to book) is a normal pattern
  many real booking systems use and isn't the same claim as performing
  medical triage — as long as the UI never frames it as a clinical
  judgment. Cheap mitigation: add a static "if this is a medical emergency,
  call 911" line to the complaint form, and word the urgency badge as
  scheduling-only. I wouldn't block on redesigning this.
- **Frontend state limits (50-patient list cap, 50-encounter/medication
  caps, booking state lost on refresh)** — these match the project's own
  stated NFRs ("single user per role at a time," "no SLAs/load targets,"
  explicitly a POC not a maintained product). I'd leave these as
  accepted trade-offs, not defects, with one exception: the **permanent
  loader after a slot conflict** (Task 31 sets `slots` to `undefined` on a
  `slot_taken` response but nothing in the `useEffect`'s dependency array
  changes, so it never refetches) is a genuine bug, not a scope trade-off,
  and is a two-line fix.
- **Cancellation/rescheduling being out of scope per the design docs, but
  implemented anyway** — this is a fair catch on me, not a technical
  defect: I made that call unilaterally in an earlier session (fixing the
  inherited `cancel-appointment.ts`/`RescheduleAppointment.tsx` bugs) when
  the original Context doc explicitly lists cancellation as excluded. Given
  Medplum's native `$cancel` already does the atomic cancel+delete-Slot
  transaction correctly (confirmed above, `cancel.ts:39-62`), the right fix
  is almost certainly to delete my hand-rolled Slot-deletion logic in favor
  of calling `$cancel` directly — less code, not more.
- **Gemini free-tier data-usage policy** — a real, legitimate flag that
  wasn't previously surfaced anywhere in this project's docs. Worth a
  one-line acknowledgment in the Design doc, not a code fix.

Everything else in the P1 list (NPPES taxonomy-drift on the primary
specialty, un-scoped chat bot trusting any patient ID, hard-coded
`Practitioner/desk-agent` sender, no schema validation on Gemini's runtime
output) reads as accurate and reasonably prioritized to me on inspection —
I didn't find grounds to downgrade any of them, I just didn't spend
separate verification budget re-confirming each one against source given
how much of the P0 list already checked out.

## Recommendation

Don't start Task 1. The plan needs a correction pass — not a rewrite, the
architecture and phase breakdown are still sound — focused on: the real
`$hold`/`$find`/`$book`/`$cancel` contracts (switch to `$book`, use
`$find`'s actual output shape, use native `$cancel`), the real specialty
table (port the Python file's array verbatim), real seed-time
deduplication (attach the identifier before searching for it), the
Communication read-and-spread, the two real compile errors, the
`block-availability` scoping bug, and the queue join logic. I'd want to
re-verify the corrected plan the same way — against real source, not
against my own prose — before calling it ready a second time.

---

## Re-Verification (fix pass complete)

This table states the final resolution after all correction passes. The
earlier narrative is retained only to explain how the defects were found.

| # | Defect | Fixed in | How |
|---|---|---|---|
| 1 | Booking contract can't work | Global Constraints, Task 21 | The browser sends ids/times only. The Bot re-reads authoritative resources, repeats `$find`, selects the exact fresh proposed `Appointment` with its contained Slot, adds the Patient and server-derived metadata, then calls `$book`. |
| 2 | `$hold` endpoint/body/response all wrong | Tasks 21, 25 | Uses type-level `Appointment/$book` through `medplum.fhirUrl(...)`. Only the request is `Parameters`; the response is a bare `Bundle`. |
| 3 | `$find` parsed as the wrong shape | Task 31 | Parses the response directly as a bare `Bundle` of proposed Appointments and reads contained Slots from its entries; the browser result is display state, not booking authority. |
| 4 | `$book` revalidation claim backwards | Global Constraints | Corrected: `$book` runs the identical validated/transactional path as `$hold` — switched to `$book`, removed the hold/confirm two-step and `agent-expire-holds` (Task 23) entirely |
| 5 | Schedule availability extensions ignored | Task 19 | Two `SchedulingParameters` extensions per Schedule, each with its own `service`, `duration`, matching `alignmentInterval`, `timezone`, and `availability`. |
| 6 | Specialty table materially wrong | Task 4, Task 11 | `DISEASE_SPECIALTIES` replaced with the real row-order-verified mapping from `specialty_mapping.py`; `Allergy and Immunology`/`General Surgery`/`Vascular Surgery` added to `SPECIALTY_TABLE`; seeder now writes real NUCC codes via `SPECIALTY_NUCC_CODES`, not labels |
| 7 | Seeder deduplication broken | Task 6 | Every retained resource receives a deterministic FHIR id and an unconditional `PUT ResourceType/{id}` request. References are rewritten before upload; POST identity is never assumed. |
| 8 | Seeder exceeds default size limit | Tasks 7, 9 | `chunk-bundle.ts` uploads the identity transaction first, then size-bounded clinical batches below the 1 MB request limit, checking every entry response. |
| 9 | Task 1 could stage reference repos | Task 1 | Fork's `.gitignore` explicitly excluded from the copy; root `.gitignore` merged, not overwritten |
| 10 | Bot deployment doesn't deploy bots | Task 26 | Direct-deploy script now resolves `$bot-*-reference`/`$bot-*-id` placeholders and calls `$deploy` per bot, matching `UploadDataPage.tsx`'s real handler; `checkBotsUploaded`'s hard-coded list updated to the final 7-bot roster |
| 11 | Booking destroys the summary Communication | Task 21 | Validates and reads the authoritative Communication first; copies its clinical metadata onto the proposal before `$book`; then read-and-spread updates only its booking link/status fields. A post-book linkage failure is logged and does not falsely report the successful booking as failed. |
| 12 | `block-availability` can cancel other doctors' appointments | Task 2 | Appointment-cancellation search now scoped by `actor=` (the blocking schedule's own actor) |
| 13 | FR-2 history gap + compile error | Task 29, Task 28 | New `EncounterHistoryList.tsx` (practitioner/specialty/organization, since `PatientSummary` has no such section); `PatientPickerPage.tsx`'s bad `@mantine/core` `Document` import removed |
| 14 | Queue summaries joined incorrectly | Task 34 | Joined by `Communication.about[0].reference` matching a specific Appointment id, not by patient; `QueueEntry` and its React key are now `appointmentId`-based |

Bonus fixes made while implementing the above (found by re-reading real
source/data during the fix pass, not originally flagged): `pass1-scan.ts`'s
test fixture used a `Practitioner?identifier=...`-style reference for
`Encounter.participant.individual` that the real corpus never produces
(confirmed the real shape is a bare `urn:uuid:` matching the Practitioner's
own `id`) — fixed the fixture to match; `upload.ts`'s retry logic treated
*any* structured `OperationOutcome` as non-retryable, which would also skip
retrying a genuine transient 5xx — now inspects the FHIR issue code;
`agent-patient-chat.ts` used a hard-coded fake `sender` and never checked
the NPI against a real booking relationship — both fixed; `SlotPickerPage.tsx`
had a stuck-loader bug after a `slot_taken` response (`setSlots(undefined)`
never re-triggered the fetch effect) — replaced with a named, re-callable
fetch function; the seed CLI used `require.main === module`, a CJS-only
idiom with no reliable ESM equivalent — replaced with the standard
`import.meta.url` check.

Not changed, by deliberate choice (see "Where I'd Push Back" above): the
triage-language framing (added a cheap disclaimer instead of a redesign),
the frontend scope limits that match this project's own stated POC NFRs,
and the P1 items I didn't re-verify against source myself (NPPES
taxonomy-drift, no-schema-validation-on-Gemini-output, etc.) — those remain
open, tracked, and unaddressed in this pass; flagging that explicitly
rather than implying they were silently resolved too.
