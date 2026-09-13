# Agent Evaluation Baseline

**Status:** Deterministic and Gemini model baselines complete; live Medplum smoke blocked by missing scoped demo credentials.

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

## Live Medplum smoke status

The eight-scenario live-smoke executor is implemented and fail-closed. It requires the complete browser and worker demo credential set plus the Gemini key, accepts only exact reviewed synthetic scenarios, tags created activity resources with a run-specific tag, and deletes only the resources it tracked and verified as tagged.

```powershell
npm run eval:agent:smoke
```

The command was invoked after explicit authorization. It stopped before login or any remote request with:

```text
live smoke not run: missing required local configuration
```

`DEMO_MEDPLUM_CLIENT_ID`, `DEMO_MEDPLUM_CLIENT_SECRET`, `DEMO_WORKER_CLIENT_ID`, and `DEMO_WORKER_CLIENT_SECRET` were absent. Broader credentials were not substituted. No remote resource was created, no cleanup was required, and no live-integration pass is claimed.

## Repository verification

The completed local implementation passed:

- Focused Gemini retry, booking-handler, and model-executor verification: 21 tests across 3 files.
- Full Vitest suite: 388 tests across 63 files.
- API Node ESM compiler check.
- ESLint over src and api.
- TypeScript plus Vite production build: 6,848 modules transformed in 1 minute 36 seconds on the current run.
- Generated-report privacy scan for forbidden keys, credentials, identifiers, prompts, and representative private markers.

The build still reports the pre-existing 1,058.31 kB main JavaScript chunk (321.74 kB gzip). Reducing that payload is Phase 3 work and is not claimed as part of this evaluation phase.

## What these numbers do and do not mean

These results prove deterministic orchestration and safety behavior for the versioned synthetic fixtures at commit `99251b3` and Gemini routing/tool behavior with controlled synthetic tools at commit `a728db2`. They do not prove real-world clinical accuracy, broad production reliability, or live Medplum availability. The model and live-smoke layers are deliberately reported separately so deterministic or controlled-model success cannot conceal an external integration failure.

Resume-safe wording is therefore limited to: built a 120-scenario synthetic agent evaluation suite with a repeatable 120/120 deterministic pass; ran Gemini three times across 40 language scenarios for a 120/120 controlled-model pass with 90/90 routing and grounded-option checks; and observed zero confirmation-gate or unauthorized-booking violations in the defined synthetic scope. A live Medplum result is not part of this claim.
