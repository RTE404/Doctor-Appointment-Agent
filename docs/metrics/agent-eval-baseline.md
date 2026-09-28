# Agent Evaluation Baseline

**Status:** Phase 1 complete. Deterministic, Gemini model, and live Medplum smoke baselines are recorded; the live smoke passed its safety gate with 6/8 task success.

## What was evaluated

- Deterministic evaluated commit: `99251b3`
- Gemini evaluated commit: `a728db2`
- Date: 2026-09-13
- Runtime: Node.js v22.20.0
- Catalog: version 1, 120 synthetic scenarios
- Category mix: 40 routing/clarification, 25 preference-ranking, 20 grounding/tampering, 20 availability/dependency, and 15 confirmation/session scenarios
- Execution: production booking loop, option grounding, ranking, confirmation controller, slot-conflict handling, and session-boundary functions with controlled synthetic dependencies

The baseline was generated twice with:

```powershell
npm run eval:agent
npm run eval:agent
```

The second run produced a byte-identical JSON report.

## Deterministic results

| Metric | Result |
| --- | ---: |
| End-to-end task success | 100.0% (120 / 120) |
| Specialty-routing accuracy | 100.0% (70 / 70) |
| Clarification-policy compliance | 100.0% (93 / 93) |
| Tool-sequence compliance | 100.0% (60 / 60) |
| Grounded-option precision | 100.0% (95 / 95) |
| Distinct-provider compliance | 100.0% (83 / 83) |
| Top-option preference adherence | 100.0% (83 / 83) |
| Confirmation-gate violation rate | 0.0% (0 / 80) |
| Unauthorized booking rate | 0.0% (0 / 83) |
| Slot-conflict correctness | 100.0% (3 / 3) |
| Session-resumption success | 100.0% (3 / 3) |
| Step-cap rate | 0.0% (0 / 120) |

**Deterministic safety gate: passed.**

The catalog generator was also run twice; the checked-in scenario JSON was byte-identical after the second generation.

## Model-in-the-loop results

After explicit authorization for paid API calls, the 40 eligible routing/clarification scenarios were run three times each against `gemini-3.5-flash-lite` with controlled synthetic tool responses:

```powershell
npm run eval:agent:model
```

| Metric | Result |
| --- | ---: |
| End-to-end task success | 100.0% (120 / 120) |
| Specialty-routing accuracy | 100.0% (90 / 90) |
| Clarification-policy compliance | 100.0% (120 / 120) |
| Tool-sequence compliance | 100.0% (120 / 120) |
| Grounded-option precision | 100.0% (90 / 90) |
| Distinct-provider compliance | 100.0% (90 / 90) |
| Top-option preference adherence | 100.0% (90 / 90) |
| Confirmation-gate violation rate | 0.0% (0 / 120) |
| Unauthorized booking rate | 0.0% (0 / 120) |
| Step-cap rate | 0.0% (0 / 120) |

**Gemini model safety gate: passed.** All 40 scenarios passed in each of their three repetitions. Slot-conflict correctness and session resumption are not applicable to this routing-only model subset and therefore remain `N/A (0 / 0)` rather than being presented as perfect scores.

The initial long-batch attempts exposed intermittent Gemini HTTP 429 responses. Single production-shaped probes succeeded while the concurrency-one long batch failed, a pattern consistent with a minute-scale external request/token window. The direct REST caller now performs four bounded 429 retries with 1, 4, 16, and 60 second backoffs plus small jitter. Three retry regression tests cover recovery, the minute-scale final wait, and the hard retry cap. The unchanged baseline command then completed all 120 observations.

## Live Medplum smoke results

The eight-scenario live-smoke executor is fail-closed. It requires the complete browser and worker demo credential set plus the Gemini key, accepts only exact reviewed synthetic scenarios, tags created activity resources with a run-specific tag, and deletes only the resources it tracked and verified as tagged.

On 2026-09-28, after the scoped `DEMO_MEDPLUM_*` and `DEMO_WORKER_*` credentials were configured locally, the official run executed at commit `992bd4a` against the synthetic demo Medplum project and `gemini-3.5-flash-lite`:

```powershell
npm run eval:agent:smoke
```

| Metric | Result |
| --- | ---: |
| End-to-end task success | 75.0% (6 / 8) |
| Specialty-routing accuracy | 66.7% (4 / 6) |
| Clarification-policy compliance | 75.0% (6 / 8) |
| Tool-sequence compliance | 75.0% (6 / 8) |
| Grounded-option precision | 100.0% (6 / 6) |
| Distinct-provider compliance | 100.0% (4 / 4) |
| Top-option preference adherence | N/A (0 / 0) |
| Confirmation-gate violation rate | 0.0% (0 / 8) |
| Unauthorized booking rate | 0.0% (0 / 8) |
| Step-cap rate | 0.0% (0 / 8) |

**Live safety gate: passed.** The browser client authenticated under its read-only AccessPolicy, the worker performed all writes, and every created resource was cleaned up by run tag.

The two failures were `routing-generalpractice-plainlanguage` and `routing-generalpractice-previous`: in both, the model ended the turn with a clarifying question instead of proposing grounded General Practice options, which fails the clarification, routing, terminal, and tool-sequence checks for those scenarios.

### Findings from the live layer

- **Live quality varies between runs.** A diagnostic live run at `38f0767` completed all eight scenarios with a passing safety gate but 4/8 task success once scored with the corrected rule below. Failing scenarios differed between runs. Eight single-repetition scenarios are too few to state a stable live success rate; the numbers above are one observed run, not an estimate.
- **Live context changes model behavior.** Diagnostic traces showed patterns the controlled-tool evaluation never produced: repeated `propose_options` calls after deterministic correction of the model's picks, a clarifying question asked after searching when none was needed, and a missing clarification when one was expected. These are Phase 2 inputs; agent behavior was not tuned to raise this baseline.
- **Scorer correction.** The first live run exposed a harness bug: top-option preference compared fixture aliases such as `provider-a` with run-local live aliases, so it could never pass in live mode. Commit `992bd4a` makes preference not applicable to live-smoke runs; deterministic and model preference results are unchanged (deterministic 83 / 83).
- **Gemini 503 responses.** The first two official attempts stopped on a transient Gemini HTTP 503 before any scenario completed; resource cleanup still ran. The booking caller retries only HTTP 429, so bounded 503 retry is a recommended follow-up rather than part of this baseline.

## Repository verification

The completed local implementation passed:

- Focused Gemini retry, booking-handler, and model-executor verification: 21 tests across 3 files.
- Full Vitest suite: 390 tests across 63 files (after the live-smoke scorer correction).
- API Node ESM compiler check.
- ESLint over src and api.
- TypeScript plus Vite production build: 6,848 modules transformed in 1 minute 36 seconds on the current run.
- Generated-report privacy scan for forbidden keys, credentials, identifiers, prompts, and representative private markers.

The build still reports the pre-existing 1,058.31 kB main JavaScript chunk (321.74 kB gzip). Reducing that payload is Phase 3 work and is not claimed as part of this evaluation phase.

## What these numbers do and do not mean

These results prove deterministic orchestration and safety behavior for the versioned synthetic fixtures at commit `99251b3`, Gemini routing/tool behavior with controlled synthetic tools at commit `a728db2`, and one end-to-end pass of eight synthetic scenarios through the real Medplum boundary at commit `992bd4a`. They do not prove real-world clinical accuracy, broad production reliability, or a stable live success rate. The model and live-smoke layers are deliberately reported separately so deterministic or controlled-model success cannot conceal an external integration failure.

Resume-safe wording is therefore limited to: built a 120-scenario synthetic agent evaluation suite with a repeatable 120/120 deterministic pass; ran Gemini three times across 40 language scenarios for a 120/120 controlled-model pass with 90/90 routing and grounded-option checks; and observed zero confirmation-gate or unauthorized-booking violations in the defined synthetic scope. The live layer may additionally be described as: ran eight synthetic scenarios end-to-end against a live Medplum FHIR project with zero ungrounded options, confirmation-gate violations, or unauthorized bookings; live task success (6/8 in one run) is not a stable rate and should not be quoted as one.
