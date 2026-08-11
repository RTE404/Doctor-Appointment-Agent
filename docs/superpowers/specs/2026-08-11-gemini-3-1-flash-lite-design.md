# Gemini 3.1 Flash-Lite Migration

## Problem

Both production Gemini call sites currently send `gemini-2.5-flash-lite` to
Google's OpenAI-compatible chat-completions endpoint. Production returns HTTP
404 at that boundary. The user has selected the stable
`gemini-3.1-flash-lite` model for the replacement.

The two call sites also force `temperature: 0`. Google's Gemini 3 guidance
recommends keeping the default temperature because lower values can degrade
Gemini 3 behavior. The user approved removing that field as part of the model
migration.

## Goals

- Use the stable `gemini-3.1-flash-lite` model for intake and patient chat.
- Omit the explicit `temperature` field from both requests.
- Keep the intake request's JSON-object response format.
- Prevent the two call sites from drifting to different model settings.
- Preserve the current endpoint, prompts, authentication, error handling,
  response parsing, Medplum reads and writes, and user-facing behavior.

## Non-goals

- Changing the Gemini API key or any Vercel environment variable.
- Migrating away from Google's OpenAI-compatible endpoint.
- Changing prompts, thinking configuration, response parsing, retry behavior,
  timeouts, or clinical boundaries.
- Refactoring all Gemini networking or introducing a new SDK.
- Removing the existing safe production failure classifier.

## Design

Create a small shared Gemini request-body builder under
`src/bots/agent/lib/`. It owns the stable model identifier and constructs the
common chat-completions payload from the system and user prompts. It includes
the model and messages, omits sampling parameters, and adds
`response_format: { type: 'json_object' }` only when requested by intake.

`agent-intake.ts` and `agent-patient-chat.ts` will keep their existing fetch,
authorization header, status handling, and response parsing. Each will replace
its duplicated inline body with the shared builder. This centralizes the model
configuration without expanding the change into a networking refactor.

## Error Handling

No error behavior changes. A non-success response from Gemini continues to
throw `Gemini request failed: <status>`, and the Vercel execution boundary
continues to emit only the safe classified status while returning the existing
generic temporary-unavailability response to the user.

## Testing

Tests will be written before production code and will verify that the shared
builder:

1. Uses `gemini-3.1-flash-lite`.
2. Does not include `temperature`, `top_p`, or `top_k`.
3. Preserves the system and user messages.
4. Includes JSON-object response formatting for intake.
5. Omits response formatting for patient chat.

After the focused red-green cycle, verification will run the complete Vitest
suite, TypeScript checking, lint for changed files, the production build, and
Git diff checks. The resulting commit will be pushed to `main`; Vercel readiness
will be confirmed before the user retries Find a Doctor.
