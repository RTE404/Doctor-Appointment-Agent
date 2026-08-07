# Doctor Appointment Agent Remaining Tasks Completion Design

**Date:** 2026-08-07

## Objective

Complete Tasks 32 through 37 of the Medplum-native implementation plan, finish the operational portion of Task 26 where the configured target permits it, and leave the current `main` branch with reproducible build, lint, test, seed, deployment, and end-to-end evidence.

## Scope

The implementation retains the architecture and behavior already defined by `docs/superpowers/plans/2026-08-04-medplum-native-implementation.md`:

- Task 32: patient-facing booking confirmation with appointment time and copyable doctor NPI.
- Task 33: doctor-desk NPI entry as a display filter, not authentication.
- Task 34: doctor queue with one row per Appointment and summaries joined by `Communication.about`.
- Task 35: record-grounded doctor chat with the existing booking-relationship and non-diagnostic safeguards.
- Task 36: full 983-bundle seed run against the configured Medplum project.
- Task 37: manual verification of patient, doctor, scheduling-conflict, cancellation, rescheduling, and availability-blocking flows.
- Task 26 completion: deploy and execute all seven Bots if the target project has Bots enabled and the deployment credential has project-admin capability.

Existing user work in `src/pages/agent/BookingConfirmationPage.tsx` is preserved and treated as the starting point for Task 32.

## Implementation Approach

### Frontend

Add the missing patient-confirmation and doctor-desk components using the established Mantine and Medplum React patterns. Keep FHIR reads and Bot calls inside page components, while presentation components receive explicit typed props. Preserve one queue entry per Appointment and use the appointment reference in each pre-visit `Communication.about` field for the summary join.

### Error and Loading States

Every asynchronous page must distinguish loading, empty, success, and error states. Missing route parameters, missing practitioners, missing NPIs, and failed FHIR/Bot requests must produce visible user-facing errors rather than indefinite loaders or console-only failures. Submission controls remain disabled while requests are active to prevent duplicates.

### Testing

Use test-driven development for new behavior: add a focused failing test, confirm the expected failure, implement the minimum behavior, and rerun it to green. Add component or extracted-function tests where they verify meaningful state, mapping, joining, navigation, and error handling. Existing regression tests remain in scope.

### Repository Health

Restore a reproducible verification baseline:

- Supply an ESLint 9-compatible flat configuration aligned with the existing TypeScript and React setup.
- Make the full-corpus specialty test reliable without weakening its completeness assertion.
- Ensure TypeScript compilation, Bot builds, Vite production build, lint, and the full Vitest suite succeed together.

### Live Operations

Run the full seed with the existing checked-in CLI and sanitized output. Run Bot build/deployment only with the existing environment variable names; never print secret values. Verify that all seven Bots have runnable project memberships and can execute under their own identities.

If the Medplum target rejects Bot creation or deployment because of project configuration or privileges, record the exact sanitized response and the specific administrator action required. Do not treat fallback-created Bots without ProjectMembership as a successful deployment.

### End-to-End Evidence

Exercise both route trees against the configured target where available. Verify persisted FHIR resources and scheduling outcomes, including double-booking rejection, native cancellation Slot cleanup, safe rescheduling, doctor-scoped blocking, AI refusal behavior, and persisted chat Communications. Record each check as pass, fail, or externally blocked with supporting evidence.

## Completion Criteria

The work is complete only when:

1. Tasks 32 through 35 are implemented, tested, and committed.
2. Lint, TypeScript, Bot build, Vite build, and all automated tests pass.
3. The full seed and Bot deployment either succeed with verified resources or have a precise external-administration blocker documented.
4. Task 37 checks have recorded outcomes, with no unreported failures.
5. `git status` contains no accidental generated files or unrelated modifications.

## Explicit Non-Goals

- No new triage, diagnosis, treatment, or clinical-advice functionality.
- No replacement backend or datastore outside Medplum.
- No conversion of the doctor NPI filter into authentication or authorization.
- No unrelated refactoring of the fork or vendored Medplum reference checkout.
