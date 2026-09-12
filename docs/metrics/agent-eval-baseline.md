# Agent Evaluation Baseline

**Status:** Deterministic baseline complete; model and live-integration baselines not run.

## What was evaluated

- Evaluated commit: `99251b3`
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

## Model-in-the-loop status

The model evaluator is implemented and unit-tested with controlled tool responses. Exactly 40 routing/clarification scenarios are eligible, and the command defaults to three repetitions, producing 120 model observations when run:

```powershell
npm run eval:agent:model
```

This command was not executed in this implementation session because it makes paid external Gemini requests and requires explicit authorization. No model-quality percentage is claimed yet.

## Live Medplum smoke status

The eight-scenario live-smoke executor is implemented and fail-closed. It requires the complete browser and worker demo credential set plus the Gemini key, accepts only exact reviewed synthetic scenarios, tags created activity resources with a run-specific tag, and deletes only the resources it tracked and verified as tagged.

```powershell
npm run eval:agent:smoke
```

The real smoke was not executed because it can authenticate to external services and create/delete remote synthetic resources; that requires separate explicit authorization. No live-integration pass is claimed.

## Repository verification

The completed local implementation passed:

- Focused evaluation suite: 58 tests across 9 files.
- Full Vitest suite: 385 tests across 62 files.
- API Node ESM compiler check.
- ESLint over src and api.
- TypeScript plus Vite production build: 6,848 modules transformed in 51.01 seconds.
- Generated-report privacy scan for forbidden keys, credentials, identifiers, prompts, and representative private markers.

The build still reports the pre-existing 1,058.31 kB main JavaScript chunk (321.74 kB gzip). Reducing that payload is Phase 3 work and is not claimed as part of this evaluation phase.

## What these numbers do and do not mean

These results prove deterministic orchestration and safety behavior for the versioned synthetic fixtures at commit `99251b3`. They do not prove real-world clinical accuracy, production reliability, Gemini language quality, or live Medplum availability. The model and live-smoke layers are deliberately reported separately so deterministic success cannot conceal an external or model-dependent failure.

Resume-safe wording is therefore limited to: built a 120-scenario synthetic agent evaluation suite with a repeatable 120/120 deterministic pass, 95/95 grounded-option checks, and zero confirmation-gate or unauthorized-booking violations in the defined fixture scope.
