# Real Doctor Appointment Data — Research Report

## Big Question

Is there an API, dataset, or endpoint through which we can pull **real** doctor
appointment slots (not just directory/provider info) for **arbitrary** real
doctors — free or paid?

**Answer: No.** No option found is simultaneously (a) real live availability,
(b) works for arbitrary/any doctor, and (c) free and open. Every candidate
trades off at least one of these. This confirms and extends the conclusion
already reached in `Doctor_Appointment_Agent_Context.md` (Practo / NPPES /
generic FHIR / commercial platforms / scraping all rejected) — the same wall
exists industry-wide, including for platforms not originally considered.

---

## Method

A multi-source web research pass (deep-research workflow: 6 search angles, 21
sources fetched, 75 claims extracted, 25 adversarially triple-verified) was
run, then several candidates (Zocdoc, SuperSaaS, TIMIFY) were manually
re-verified against their live docs and pricing pages in follow-up. Note: the
workflow's automated synthesis step returned malformed placeholder output on
this run; the findings below were hand-assembled from the raw verified claims
and sources rather than trusted from that broken summary.

---

## Candidate Summary

| Candidate | Real slots? | Access model | Free or paid? | Verdict for this project |
|---|---|---|---|---|
| **Zocdoc Patient Booking API** | Yes — confirmed, real timeslots via `GET /v1/provider_locations/availability` | Gated: developer account + partner-program approval; production also requires "a live provider customer" | Sandbox likely free once approved; production pricing undisclosed/negotiated per partner | Only covers doctors already on Zocdoc's network — see deep dive below |
| **ModMed (EMA) FHIR Appointments/Slots API** | Yes — FHIR R4, full READ/SEARCH/CREATE/UPDATE on Appointment + Slot search | Gated: OAuth2 with vendor-issued credentials, formal partner/vendor onboarding | Not disclosed; implies certification/partnership process | Only covers practices running ModMed's EMA system |
| **SuperSaaS Availability API** | Yes, but only for schedules on SuperSaaS | Self-serve API key, no approval gate | **Free tier includes API access** (≤50 appts/mo, ads); paid $9–$48/mo removes caps | See deep dive below — usable as infrastructure, not as a doctor-data source |
| **TIMIFY** | Yes, but only for clinics on TIMIFY | Self-serve account, but... | Free "Classic" plan has **no API access at all**; API only on custom-priced Enterprise Plus | Dead end for a no-budget POC |
| **Kyruus** | Yes, but only within its Epic-integrated deployments | Sold only to health systems/hospitals/health plans, not third-party developers | No public pricing; enterprise-only | Not accessible to an independent project |
| **Epic (Showroom / formerly App Orchard)** | Yes, ~450 FHIR R4 endpoints incl. Schedule/Slot | Production requires sponsorship from a customer health system + formal approval + compliance monitoring | "Connection Hub" listing tier is $500/yr, but real integration work reportedly runs ~$300K over 6–18 months | Not viable for a POC |
| **Cronofy** | **No** — calendar-sync infrastructure (Google/Outlook/iCloud), not appointment inventory. Its "EHR integration" marketing claim was checked directly and found unsubstantiated (no named EHR vendor, no technical detail) | N/A | Paid, tiered (API + Scheduler pricing) | Not a data source at all |
| **Schedula** (iehr.ai) | FHIR-native scheduling software an org deploys itself (SMART on FHIR/OAuth2) | Gated, per-deployment | Not disclosed | Same category as Epic/Kyruus — not third-party accessible |
| **FHIR base resources** (`Schedule`/`Slot`/`Appointment`) | No — this is a data *schema*, not hosted data | Free/open standard (HL7, CC0) | Free (the spec itself) | Only matters if a specific EHR exposes it live |
| **Argonaut Scheduling IG** (2018, FHIR R3/STU3) | No — vendor-agnostic spec Epic/Cerner/Meditech loosely base their own APIs on | Free to read; each vendor's actual endpoint is separately gated | Free (the spec) | Same practical limits as Epic above |
| **SMART Scheduling Links** | Read-only discovery only, and only where a publisher exists | Free, open GitHub spec; real-world coverage historically vaccine/testing-site heavy, general-appointment support is early-stage (being extended by Zocdoc/Optum/Defacto Health as of an Oct 2025 HL7 Connectathon) | Free/open spec | Discussed with the user; not currently being pursued for this project |
| **NHS e-Referral Service (A015)** | Yes, real slots | Deprecated endpoint; gated to authorized NHS clinical staff only; only returns slots post-referral | N/A (UK-only, not public) | Not applicable (UK, not public) |
| GitHub `doctor-appointment-api` demo repo | No — confirmed pure mock/demo (fake doctors, in-memory data) | Public, MIT license | Free | Irrelevant — a toy reference implementation, not a real data source |

---

## Deep Dive: Zocdoc

Zocdoc is the strongest *technical* candidate — it is the only option confirmed
to expose genuinely real, live timeslots with a documented booking flow. The
full flow:

1. `GET /v1/reference/npi` — returns the list of active provider NPIs
   **already in Zocdoc's own directory** (not a universal/open NPI lookup).
2. `GET /v1/providers` (by NPI) or `GET /v1/provider_locations` (by ZIP/specialty)
   — resolves an NPI into Zocdoc's internal `provider_location_id` (format
   `pr_..._...|lo_..._...`) and available `visit_reason_id`s.
3. `GET /v1/provider_locations/availability` — returns real open `start_time`
   slots for that provider_location_id.
4. `POST /v1/appointments` — books a specific slot; requires the IDs from
   steps 1–3 plus full patient PII (name, DOB, phone, email, address,
   insurance), since it creates a real transactional booking.

**Two hard gates, independent of each other:**
- **Authentication** — `Authorization: Bearer <token>` must be a real token
  issued after applying for and being approved into Zocdoc's partner program.
  Sample code from their docs contains no working credential; without a valid
  token the server returns 401 before even reading the payload.
- **Data coverage** — `provider_location_id` is a Zocdoc-internal ID, not
  derived from or equal to an NPI. Step 1's endpoint is explicitly scoped to
  NPIs "within your Zocdoc directory." Feeding in an arbitrary NPPES doctor
  who hasn't onboarded to Zocdoc returns nothing — there is no
  `provider_location_id` to resolve, valid token or not.

**Conclusion:** Zocdoc only ever covers the subset of doctors who are already
Zocdoc partners. It cannot answer "any arbitrary NPPES doctor's real
availability."

---

## Deep Dive: SuperSaaS & TIMIFY

Neither is a doctor directory or aggregator. Both are generic
appointment-scheduling SaaS that any business — salons, tutors, gyms, medical
practices — signs up for and runs its own calendar on. There is no
marketplace/search across all customer schedules; you only ever get data for
a schedule you (or a partner) control.

**SuperSaaS**
- Free tier is real and self-serve: up to 50 appointments/month, ads shown on
  the public booking page, and — importantly — **the free tier includes API
  access** via your own API key (no partnership approval needed).
- `Availability API` (`/api/free`) returns real free/open slots for a
  schedule, filterable by date, duration, resource. Does not work for
  "Service"-type schedules.
- Full CRUD (create/list/cancel bookings) via API key, HTTP Basic Auth, or
  MD5 checksum.
- Paid tiers ($9–$48/mo) just remove the appointment cap and ads.

**TIMIFY**
- Has a genuine free "Classic" plan (2–3 calendars) — but verified directly
  against TIMIFY's current pricing page: **the free plan has zero API
  access.** API ("Developer Platform") access is gated to the **Enterprise
  Plus** tier, which is custom-priced (contact sales), not self-serve at any
  price point disclosed. Effectively a dead end for a no-budget POC.

**Is there a use case?**
Not as a source of real third-party doctors' availability — the same
limitation as every commercial platform researched: a specific doctor must
already be using the platform, and there is no directory to discover which
real doctors that is. Reaching an actual independent clinic and asking for
API-key access would be a one-off partnership, not a scalable path to
arbitrary NPPES doctors.

Where it *is* useful: **as infrastructure, not as a data source.** SuperSaaS's
free, self-serve tier provides a real, live, hosted scheduling API — real
HTTP round-trips, real concurrency/double-booking handling, real slot state —
that could stand in for a hand-rolled synthetic-slot generator. The doctors
populated into it would still be fictional demo entries, but the booking
mechanics would be handled by production scheduling infrastructure rather
than hand-rolled code. **Update, post-Medplum-native rebuild**: this
recommendation is now moot — Medplum's own native scheduling operations
(`$find`/`$hold`/`$confirm`) already provide exactly this property (real,
atomic, conflict-checked booking mechanics) for the app's synthetic doctors,
so there's no longer a gap for SuperSaaS to fill. It does not solve "pull
real doctors' real appointments" either way — that remains unsolved by
every option researched.

---

## Overall Recommendation

No change to the project's core design decision: there is still no free,
universal, real-time source of appointment availability for arbitrary real
(NPPES-sourced) doctors. The synthetic, NPI-seeded, lazily-generated
scheduling approach already documented in `Doctor_Appointment_Agent_Context.md`
remains the right default for this POC — now implemented on Medplum's
native `Schedule`/`Slot`/`Appointment` operations rather than a
self-hosted service, which happens to also deliver the "real scheduling
mechanics" property that used to be SuperSaaS's main selling point (see the
update above).

If real *data* (not just real mechanics, which Medplum already provides)
is wanted later, in order of practicality:
1. **A one-off partnership with a specific willing clinic** already on
   SuperSaaS, TIMIFY, or Zocdoc, to pull that one clinic's real availability —
   not scalable, but genuinely real.
2. **Zocdoc's partner program**, if the project ever has budget and a real
   provider customer to sponsor production access — the strongest platform
   technically, but the most gated.

TIMIFY, Kyruus, Epic, and Cronofy are not realistic options for this project
at its current stage (no budget for enterprise sponsorship, no health-system
backing).
