# Agentic Booking Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed `agent-intake` → `agent-find-bookable-options` search chain with a single model-directed
tool-calling bot (`agent-booking-chat`), driven through a persisted, resumable session and a new chat-style patient
UI, while leaving `agent-book-appointment` and its booking-confirmation gate completely unchanged.

**Architecture:** One new bot (`agent-booking-chat.ts`) runs a bounded Gemini tool-calling loop over three read-only
tools (`search_previous_physician`, `search_nppes`, `check_availability` — thin wrappers over existing `lib/`
functions) plus two control tools (`ask_clarifying_question`, `propose_options`). The full message transcript
persists in a `Communication` resource between turns. `propose_options` is the only place a result reaches the
patient, and it is deterministically validated: every pick must be grounded in a real `check_availability` result
from the same session, and the distinct-provider/8-option cap is enforced (falling back to the existing
`rankBookableOptions` if the model's picks don't already satisfy it) before the pre-visit summary `Communication`
(read by `agent-book-appointment`) is written.

**Tech Stack:** TypeScript, Medplum SDK (`@medplum/core`, `@medplum/fhirtypes`, `@medplum/mock` for tests), Vitest,
React 19 + Mantine (frontend), Gemini via the OpenAI-compatible `chat/completions` endpoint with `tools`/function
calling.

## Global Constraints

- Model: `gemini-3.5-flash-lite` (matches `agent-intake.ts`/`agent-patient-chat.ts`, not the unused
  `lib/geminiRequest.ts` helper, which targets a different, dead-code model string — do not use that helper).
- `MAX_TOOL_LOOP_STEPS = 8` — hard cap on Gemini round-trips within one `/api/execute` call.
- `MAX_BOOKABLE_OPTIONS = 8` — hard cap on distinct-provider options `propose_options` can return (raised from 3 per
  explicit product decision; see `docs/superpowers/specs/2026-08-13-agentic-booking-chat-design.md`).
- `agent-book-appointment.ts` must not change. Every new resource shape must satisfy its existing authorization
  checks unmodified.
- `DoctorResultsPage.tsx` / `SlotPickerPage.tsx` / `BookingContext` are a separate, currently-disconnected manual
  flow. Do not touch them.
- All imports between `src/bots/**` files use explicit `.js` extensions (ESM), matching every existing file in that
  tree — follow this exactly in new files.
- Every new/modified file must pass `npm run lint` and the project's existing `tsconfig.json` strict settings
  (`noUnusedLocals`, `noImplicitReturns`, etc.).

---

### Task 1: Spike — verify Gemini tool-calling support

**Files:**
- Create (temporary, not committed): `tools/spike-gemini-tool-calling.ts`

**Interfaces:** None — this task produces no code any later task imports. Its only deliverable is a go/no-go
confirmation that the request/response shapes assumed by Tasks 6–7 are real.

- [ ] **Step 1: Write the spike script**

```ts
// tools/spike-gemini-tool-calling.ts — TEMPORARY, delete after running (see Step 3)
import 'dotenv/config';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error('Set GEMINI_API_KEY in .env before running this spike');
}

const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'gemini-3.5-flash-lite',
    temperature: 0,
    messages: [
      { role: 'system', content: 'You are a test harness. Always call the check_weather tool for any user message.' },
      { role: 'user', content: 'What is the weather in Boston?' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'check_weather',
          description: 'Look up the weather for a city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ],
  }),
});

const body = await response.json();
console.log('status:', response.status);
console.log(JSON.stringify(body, null, 2));

const message = body.choices?.[0]?.message;
const toolCalls = message?.tool_calls;
if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
  throw new Error('No tool_calls in response — Gemini tool calling assumption FAILED, escalate before continuing this plan');
}
console.log('tool_calls[0].function.name:', toolCalls[0].function.name);
console.log('tool_calls[0].function.arguments:', toolCalls[0].function.arguments);
console.log('PASS: tool calling works as assumed');
```

- [ ] **Step 2: Run it**

Run: `npx tsx tools/spike-gemini-tool-calling.ts`

Expected: exits with `PASS: tool calling works as assumed`, and printed JSON shows
`message.tool_calls: [{ id: "...", type: "function", function: { name: "check_weather", arguments: "{\"city\":\"Boston\"}" } }]`.
If this does not match (e.g. no `tool_calls` field, or a differently-shaped field), **stop and report** — Tasks 6–7's
request/response types are built on this shape and need to be revisited before continuing.

- [ ] **Step 3: Delete the spike script**

```bash
rm tools/spike-gemini-tool-calling.ts
```

Do not commit it — it exists only to validate an assumption before building on it.

---

### Task 2: Export `findPreviousPhysician` for reuse

**Files:**
- Modify: `src/bots/agent/agent-find-doctors.ts:50`
- Test: `src/bots/agent/agent-find-doctors.test.ts`

**Interfaces:**
- Produces: `export async function findPreviousPhysician(medplum: MedplumClient, patientId: string, specialtyCode: string): Promise<FoundCandidate | undefined>` — consumed by Task 5's `search_previous_physician` tool.

- [ ] **Step 1: Write the failing test**

Add to `src/bots/agent/agent-find-doctors.test.ts` (colocate near the top, after imports):

```ts
import { findPreviousPhysician } from './agent-find-doctors';

test('exports findPreviousPhysician for reuse by the booking chat tools', () => {
  expect(typeof findPreviousPhysician).toBe('function');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/bots/agent/agent-find-doctors.test.ts -t "exports findPreviousPhysician"`
Expected: FAIL — `findPreviousPhysician` is not exported (TypeScript import error / `undefined`).

- [ ] **Step 3: Export the function**

In `src/bots/agent/agent-find-doctors.ts`, change:

```ts
async function findPreviousPhysician(
```

to:

```ts
export async function findPreviousPhysician(
```

No other code in the file changes — this is a visibility change only.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/bots/agent/agent-find-doctors.test.ts`
Expected: PASS, including all pre-existing tests in the file (unchanged behavior).

- [ ] **Step 5: Commit**

```bash
git add src/bots/agent/agent-find-doctors.ts src/bots/agent/agent-find-doctors.test.ts
git commit -m "refactor: export findPreviousPhysician for reuse by the booking chat loop"
```

---

### Task 3: Booking-chat prompts

**Files:**
- Modify: `src/bots/agent/lib/prompts.ts`
- Test: `src/bots/agent/lib/prompts.test.ts`

**Interfaces:**
- Consumes: `PatientClinicalContext` from `./patientContext.js` (existing).
- Produces: `BOOKING_CHAT_SYSTEM_PROMPT: string`, `buildPatientContextMessage(context: PatientClinicalContext): string` — consumed by Task 7 (`agent-booking-chat.ts`).

- [ ] **Step 1: Write the failing test**

Add to `src/bots/agent/lib/prompts.test.ts`, inside a new `describe` block:

```ts
import { BOOKING_CHAT_SYSTEM_PROMPT, buildPatientContextMessage } from './prompts';

describe('booking chat prompts', () => {
  test('system prompt instructs the model to never diagnose and to ground every pick in tool results', () => {
    const prompt = BOOKING_CHAT_SYSTEM_PROMPT.toLowerCase();
    expect(prompt).toContain('never diagnose');
    expect(prompt).toContain('does not triage');
    expect(prompt).toContain('check_availability');
    expect(prompt).toContain('propose_options');
    expect(prompt).toContain('ask_clarifying_question');
  });

  test('buildPatientContextMessage summarizes conditions, medications, and allergies', () => {
    const message = buildPatientContextMessage({
      patient: { resourceType: 'Patient' },
      conditions: [{ resourceType: 'Condition', code: { text: 'Asthma' } }],
      medications: [{ resourceType: 'MedicationRequest', status: 'active', intent: 'order', medicationCodeableConcept: { text: 'Albuterol' } }],
      allergies: [{ resourceType: 'AllergyIntolerance', code: { text: 'Penicillin' } }],
      encounters: [],
    });

    expect(message).toContain('Asthma');
    expect(message).toContain('Albuterol');
    expect(message).toContain('Penicillin');
  });

  test('buildPatientContextMessage reports "none recorded" for empty history', () => {
    const message = buildPatientContextMessage({
      patient: { resourceType: 'Patient' },
      conditions: [],
      medications: [],
      allergies: [],
      encounters: [],
    });

    expect(message).toContain('none recorded');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/bots/agent/lib/prompts.test.ts -t "booking chat prompts"`
Expected: FAIL — `BOOKING_CHAT_SYSTEM_PROMPT` and `buildPatientContextMessage` are not exported.

- [ ] **Step 3: Implement**

Add to `src/bots/agent/lib/prompts.ts` (after the existing `CHAT_SYSTEM_PROMPT`/`buildChatUserPrompt` block, before
`DEFAULT_CHAT_USER_PROMPT_BYTE_LIMIT`):

```ts
export const BOOKING_CHAT_SYSTEM_PROMPT = `You are a scheduling assistant that helps a patient find and book a
real appointment. You have five tools: search_previous_physician, search_nppes, check_availability,
ask_clarifying_question, and propose_options.

Use an explicitly named specialty or referral when the patient gives one. Otherwise map a clear complaint to one
supported scheduling specialty. Use General Practice when the patient gives no specialty preference and no clear
specialist request. If the complaint is genuinely ambiguous, call ask_clarifying_question instead of guessing.

Investigate before proposing: call search_previous_physician and/or search_nppes to find candidate providers, then
call check_availability for specific candidates (by NPI) to find real bookable times. You must never state that a
provider or time exists unless you learned it from a check_availability result in this conversation — you cannot
invent, assume, or estimate an appointment.

When you have enough grounded candidates, call propose_options with your final specialty, a short plain-English
reason for the visit, a 2-3 sentence pre-visit summary a doctor could read before seeing this patient, and your
picks (each referencing an npi/start/end exactly as returned by a prior check_availability call), each with a short
reasoning explaining why you picked it (e.g. matches a stated time preference, is a doctor the patient has seen
before, or is the earliest available). Prefer distinct providers.

You must never diagnose, speculate about a specific condition, suggest a treatment, or classify urgency/triage in
any way — this system books a single, undifferentiated visit type; it does not triage. Relay and summarize only
what is asked.`;

export function buildPatientContextMessage(context: PatientClinicalContext): string {
  const conditions = context.conditions.map((c) => c.code?.text).filter(Boolean).join(', ') || 'none recorded';
  const medications = context.medications.map((m) => m.medicationCodeableConcept?.text).filter(Boolean).join(', ') || 'none recorded';
  const allergies = context.allergies.map((a) => a.code?.text).filter(Boolean).join(', ') || 'none recorded';
  return `Patient history:
- Conditions: ${conditions}
- Medications: ${medications}
- Allergies: ${allergies}`;
}
```

Add `import type { PatientClinicalContext } from './patientContext.js';` to the top of `prompts.ts` if not already
present (it is — the file already imports this type for the existing intake prompt builder).

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/bots/agent/lib/prompts.test.ts`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/bots/agent/lib/prompts.ts src/bots/agent/lib/prompts.test.ts
git commit -m "feat: add booking chat system prompt and patient context summary builder"
```

---

### Task 4: Session persistence (`bookingSession.ts`)

**Files:**
- Create: `src/bots/agent/lib/bookingSession.ts`
- Test: `src/bots/agent/lib/bookingSession.test.ts`

**Interfaces:**
- Produces:
  - `type BookingChatMessage = { role: 'system' | 'user'; content: string } | { role: 'assistant'; content: string | null; tool_calls?: BookingToolCall[] } | { role: 'tool'; tool_call_id: string; content: string }`
  - `interface BookingToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }`
  - `interface BookingSession { communication: Communication; transcript: BookingChatMessage[] }`
  - `async function createBookingSession(medplum: MedplumClient, patientId: string, initialTranscript: BookingChatMessage[]): Promise<BookingSession>`
  - `async function loadBookingSession(medplum: MedplumClient, sessionId: string, patientId: string): Promise<BookingSession>` — throws `Error('Booking chat session not found for this patient')` if missing, wrong patient, or `status !== 'in-progress'`.
  - `async function persistBookingSession(medplum: MedplumClient, session: BookingSession, status: 'in-progress' | 'completed' | 'stopped'): Promise<void>`
- Consumed by: Task 7 (`agent-booking-chat.ts`).

- [ ] **Step 1: Write the failing tests**

Create `src/bots/agent/lib/bookingSession.test.ts`:

```ts
import { beforeAll, describe, expect, test } from 'vitest';
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type { Bundle, SearchParameter } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { createBookingSession, loadBookingSession, persistBookingSession } from './bookingSession';
import type { BookingChatMessage } from './bookingSession';

beforeAll(() => {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-medplum.json') as Bundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
  }
});

async function seedAgentDevice(medplum: MockClient): Promise<void> {
  await medplum.createResource({
    resourceType: 'Device',
    identifier: [{ system: 'http://example.com/agent-config', value: 'ai-appointment-agent' }],
  });
}

describe('createBookingSession', () => {
  test('creates an in-progress, tagged Communication carrying the initial transcript', async () => {
    const medplum = new MockClient();
    await seedAgentDevice(medplum);
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    const initialTranscript: BookingChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];

    const session = await createBookingSession(medplum, patient.id as string, initialTranscript);

    expect(session.communication.status).toBe('in-progress');
    expect(session.communication.subject).toStrictEqual({ reference: `Patient/${patient.id}` });
    expect(session.communication.category?.[0]?.coding?.[0]).toStrictEqual({
      system: 'http://example.com/agent-communication-category',
      code: 'ai-booking-session',
    });
    expect(session.communication.meta?.tag).toContainEqual({ code: 'ai-generated' });
    expect(session.transcript).toStrictEqual(initialTranscript);
  });

  test('throws when the agent Device is not configured', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient' });

    await expect(createBookingSession(medplum, patient.id as string, [])).rejects.toThrow(
      'ai-appointment-agent Device is not configured'
    );
  });
});

describe('loadBookingSession', () => {
  test('round-trips a persisted transcript', async () => {
    const medplum = new MockClient();
    await seedAgentDevice(medplum);
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    const created = await createBookingSession(medplum, patient.id as string, [{ role: 'user', content: 'first' }]);
    await persistBookingSession(
      medplum,
      { ...created, transcript: [...created.transcript, { role: 'assistant', content: 'reply' }] },
      'in-progress'
    );

    const loaded = await loadBookingSession(medplum, created.communication.id as string, patient.id as string);

    expect(loaded.transcript).toStrictEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
    ]);
  });

  test('rejects a session id belonging to a different patient', async () => {
    const medplum = new MockClient();
    await seedAgentDevice(medplum);
    const patientA = await medplum.createResource({ resourceType: 'Patient' });
    const patientB = await medplum.createResource({ resourceType: 'Patient' });
    const session = await createBookingSession(medplum, patientA.id as string, []);

    await expect(loadBookingSession(medplum, session.communication.id as string, patientB.id as string)).rejects.toThrow(
      'Booking chat session not found for this patient'
    );
  });

  test('rejects a session that is no longer in-progress', async () => {
    const medplum = new MockClient();
    await seedAgentDevice(medplum);
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    const session = await createBookingSession(medplum, patient.id as string, []);
    await persistBookingSession(medplum, session, 'completed');

    await expect(loadBookingSession(medplum, session.communication.id as string, patient.id as string)).rejects.toThrow(
      'Booking chat session not found for this patient'
    );
  });
});

describe('persistBookingSession', () => {
  test('updates status without dropping subject, category, or sender', async () => {
    const medplum = new MockClient();
    await seedAgentDevice(medplum);
    const patient = await medplum.createResource({ resourceType: 'Patient' });
    const session = await createBookingSession(medplum, patient.id as string, []);

    await persistBookingSession(medplum, session, 'completed');

    const updated = await medplum.readResource('Communication', session.communication.id as string);
    expect(updated.status).toBe('completed');
    expect(updated.subject).toStrictEqual({ reference: `Patient/${patient.id}` });
    expect(updated.category).toStrictEqual(session.communication.category);
    expect(updated.sender).toStrictEqual(session.communication.sender);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/bots/agent/lib/bookingSession.test.ts`
Expected: FAIL — module `./bookingSession` does not exist.

- [ ] **Step 3: Implement**

Create `src/bots/agent/lib/bookingSession.ts`:

```ts
// src/bots/agent/lib/bookingSession.ts
import type { MedplumClient } from '@medplum/core';
import type { Communication } from '@medplum/fhirtypes';

export interface BookingToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type BookingChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: BookingToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface BookingSession {
  communication: Communication;
  transcript: BookingChatMessage[];
}

const CATEGORY_SYSTEM = 'http://example.com/agent-communication-category';
const SESSION_CATEGORY_CODE = 'ai-booking-session';

async function resolveAgentDeviceReference(medplum: MedplumClient): Promise<string> {
  const agentDevice = await medplum.searchOne('Device', {
    identifier: 'http://example.com/agent-config|ai-appointment-agent',
  });
  if (!agentDevice?.id) {
    throw new Error('The ai-appointment-agent Device is not configured');
  }
  return `Device/${agentDevice.id}`;
}

export async function createBookingSession(
  medplum: MedplumClient,
  patientId: string,
  initialTranscript: BookingChatMessage[]
): Promise<BookingSession> {
  const senderReference = await resolveAgentDeviceReference(medplum);
  const communication = await medplum.createResource<Communication>({
    resourceType: 'Communication',
    status: 'in-progress',
    category: [{ coding: [{ system: CATEGORY_SYSTEM, code: SESSION_CATEGORY_CODE }] }],
    subject: { reference: `Patient/${patientId}` },
    sender: { reference: senderReference },
    payload: [{ contentString: JSON.stringify(initialTranscript) }],
    meta: { tag: [{ code: 'ai-generated' }] },
  });
  return { communication, transcript: initialTranscript };
}

export async function loadBookingSession(
  medplum: MedplumClient,
  sessionId: string,
  patientId: string
): Promise<BookingSession> {
  let communication: Communication;
  try {
    communication = await medplum.readResource('Communication', sessionId);
  } catch {
    throw new Error('Booking chat session not found for this patient');
  }
  if (
    communication.subject?.reference !== `Patient/${patientId}` ||
    communication.status !== 'in-progress' ||
    communication.category?.[0]?.coding?.[0]?.code !== SESSION_CATEGORY_CODE
  ) {
    throw new Error('Booking chat session not found for this patient');
  }
  const transcript = JSON.parse(communication.payload?.[0]?.contentString ?? '[]') as BookingChatMessage[];
  return { communication, transcript };
}

export async function persistBookingSession(
  medplum: MedplumClient,
  session: BookingSession,
  status: 'in-progress' | 'completed' | 'stopped'
): Promise<void> {
  await medplum.updateResource<Communication>({
    ...session.communication,
    status,
    payload: [{ contentString: JSON.stringify(session.transcript) }],
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/bots/agent/lib/bookingSession.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bots/agent/lib/bookingSession.ts src/bots/agent/lib/bookingSession.test.ts
git commit -m "feat: add persisted booking chat session storage"
```

---

### Task 5: Booking chat tools (`bookingChatTools.ts`)

**Files:**
- Create: `src/bots/agent/lib/bookingChatTools.ts`
- Test: `src/bots/agent/lib/bookingChatTools.test.ts`

**Interfaces:**
- Consumes: `findPreviousPhysician` (Task 2), `SPECIALTY_TABLE` from `../../../config/specialties.js`, `patientCoords`/`rankCandidates` from `./geo.js`/`./ranking.js`, `searchNppesDoctors` from `./nppes.js`, `ensurePractitionerAndSchedule` from `./ensurePractitionerAndSchedule.js`, `timezoneForState` from `./timezones.js`, `BookableOption` from `./bookableOptions.js`.
- Produces:
  - `const BOOKING_CHAT_TOOL_SCHEMAS: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[]`
  - `async function searchPreviousPhysicianTool(medplum: MedplumClient, patientId: string, specialtyCode: string): Promise<FoundCandidate | null>`
  - `async function searchNppesTool(medplum: MedplumClient, patient: Patient, specialtyCode: string): Promise<FoundCandidate[]>`
  - `async function checkAvailabilityTool(medplum: MedplumClient, args: { npi: string; startOffsetDays?: number; windowDays?: number; previousDoctor?: boolean; distanceMiles?: number }): Promise<BookableOption[]>`
  - `function __setBookingChatToolsNowForTests(fn: () => Date): void` (test seam)
- Consumed by: Task 7 (`agent-booking-chat.ts`).

- [ ] **Step 1: Write the failing tests**

Create `src/bots/agent/lib/bookingChatTools.test.ts`:

```ts
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import type { MedplumClient } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type { Appointment, Bundle, Patient, Schedule, SearchParameter } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import {
  BOOKING_CHAT_TOOL_SCHEMAS,
  __setBookingChatToolsNowForTests,
  checkAvailabilityTool,
  searchNppesTool,
  searchPreviousPhysicianTool,
} from './bookingChatTools';
import { __setNppesSearcherForTests } from '../agent-find-doctors';

beforeAll(() => {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-medplum.json') as Bundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
  }
});

describe('BOOKING_CHAT_TOOL_SCHEMAS', () => {
  test('declares all five tools with function-calling shape', () => {
    const names = BOOKING_CHAT_TOOL_SCHEMAS.map((t) => t.function.name);
    expect(names).toStrictEqual([
      'search_previous_physician',
      'search_nppes',
      'check_availability',
      'ask_clarifying_question',
      'propose_options',
    ]);
    for (const tool of BOOKING_CHAT_TOOL_SCHEMAS) {
      expect(tool.type).toBe('function');
      expect(tool.function.parameters).toHaveProperty('type', 'object');
    }
  });
});

describe('searchPreviousPhysicianTool', () => {
  test('returns null when there is no matching previous physician', async () => {
    const medplum = new MockClient();
    const patient = await medplum.createResource({ resourceType: 'Patient' });

    const result = await searchPreviousPhysicianTool(medplum, patient.id as string, '208D00000X');

    expect(result).toBeNull();
  });
});

describe('searchNppesTool', () => {
  test('returns up to 15 ranked NPPES candidates', async () => {
    __setNppesSearcherForTests(async () =>
      Array.from({ length: 20 }, (_, i) => ({
        npi: `100000000${i}`,
        firstName: `First${i}`,
        lastName: `Last${i}`,
        nuccCode: '208D00000X',
        nuccDisplay: 'General Practice Physician',
        address: {},
      }))
    );
    const medplum = new MockClient();
    const patient: Patient = { resourceType: 'Patient', address: [{ city: 'Boston', state: 'Massachusetts' }] };

    const result = await searchNppesTool(medplum, patient, '208D00000X');

    expect(result).toHaveLength(15);
    expect(result.every((c) => c.source === 'nppes')).toBe(true);
  });
});

describe('checkAvailabilityTool', () => {
  test('returns grounded BookableOptions using the schedule timezone and derives the doctor name from the ensured Practitioner', async () => {
    __setBookingChatToolsNowForTests(() => new Date('2026-08-13T12:00:00.000Z'));
    const medplum = {
      searchOne: vi.fn(async (resourceType: string) => {
        if (resourceType === 'HealthcareService') return { resourceType, id: 'service-1' };
        if (resourceType === 'Practitioner') return { resourceType, id: 'practitioner-1' };
        if (resourceType === 'PractitionerRole') return { resourceType, id: 'role-1' };
        if (resourceType === 'Schedule') return { resourceType, id: 'schedule-1' };
        return undefined;
      }),
      createResourceIfNoneExist: vi.fn(async (resource: unknown) => ({ ...(resource as object), id: 'schedule-1' })),
      readResource: vi.fn(async (resourceType: string, id: string) => {
        if (resourceType === 'Practitioner') {
          return { resourceType, id, name: [{ given: ['Jane'], family: 'Doe' }] };
        }
        if (resourceType === 'Schedule') {
          const schedule: Schedule = {
            resourceType: 'Schedule',
            id,
            actor: [{ reference: 'Practitioner/practitioner-1' }],
            extension: [
              {
                url: 'https://medplum.com/fhir/StructureDefinition/SchedulingParameters',
                extension: [
                  { url: 'service', valueReference: { reference: 'HealthcareService/service-1' } },
                  { url: 'timezone', valueCode: 'America/New_York' },
                ],
              },
            ],
          };
          return schedule;
        }
        throw new Error(`unexpected read ${resourceType}`);
      }),
      fhirUrl: (...segments: string[]) => new URL(`https://example.test/fhir/R4/${segments.join('/')}`),
      get: vi.fn(async (url: URL) => {
        const start = url.searchParams.get('start');
        const appointment: Appointment = {
          resourceType: 'Appointment',
          status: 'proposed',
          start: start as string,
          end: new Date(Date.parse(start as string) + 30 * 60 * 1000).toISOString(),
          participant: [],
        };
        return { resourceType: 'Bundle', type: 'searchset', entry: [{ resource: appointment }] };
      }),
    } as unknown as MedplumClient;

    const result = await checkAvailabilityTool(medplum, { npi: '1000000001', previousDoctor: true, distanceMiles: 3.5 });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      npi: '1000000001',
      doctorName: 'Dr. Jane Doe',
      timeZone: 'America/New_York',
      previousDoctor: true,
      distanceMiles: 3.5,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/bots/agent/lib/bookingChatTools.test.ts`
Expected: FAIL — module `./bookingChatTools` does not exist.

- [ ] **Step 3: Implement**

Create `src/bots/agent/lib/bookingChatTools.ts`:

```ts
// src/bots/agent/lib/bookingChatTools.ts
import type { MedplumClient } from '@medplum/core';
import type { Appointment, Bundle, Patient, Schedule } from '@medplum/fhirtypes';
import { SPECIALTY_TABLE } from '../../../config/specialties.js';
import { findPreviousPhysician } from '../agent-find-doctors.js';
import type { FoundCandidate } from '../agent-find-doctors.js';
import { ensurePractitionerAndSchedule } from './ensurePractitionerAndSchedule.js';
import { patientCoords } from './geo.js';
import { searchNppesDoctors } from './nppes.js';
import { rankCandidates } from './ranking.js';
import { timezoneForState } from './timezones.js';
import type { BookableOption } from './bookableOptions.js';

const NPPES_SEARCH_LIMIT = 15;

let nowProvider: () => Date = () => new Date();

/** Test-only seam. */
export function __setBookingChatToolsNowForTests(fn: () => Date): void {
  nowProvider = fn;
}

export const BOOKING_CHAT_TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'search_previous_physician',
      description: "Find a physician the patient has previously seen who matches the given specialty.",
      parameters: {
        type: 'object',
        properties: { specialtyCode: { type: 'string', description: 'NUCC provider taxonomy code' } },
        required: ['specialtyCode'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_nppes',
      description: 'Search the NPPES public registry for doctors matching a specialty near the patient.',
      parameters: {
        type: 'object',
        properties: { specialtyCode: { type: 'string', description: 'NUCC provider taxonomy code' } },
        required: ['specialtyCode'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'check_availability',
      description: 'Check real bookable appointment times for one provider by NPI.',
      parameters: {
        type: 'object',
        properties: {
          npi: { type: 'string' },
          startOffsetDays: { type: 'integer', minimum: 0, description: 'Days from now to start the search window. Default 0.' },
          windowDays: { type: 'integer', minimum: 1, maximum: 14, description: 'Length of the search window in days. Default 7.' },
          previousDoctor: { type: 'boolean', description: 'Set true if this NPI was returned by search_previous_physician.' },
          distanceMiles: { type: 'number', description: 'Distance in miles, if known from a prior search_nppes result.' },
        },
        required: ['npi'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'ask_clarifying_question',
      description: 'Ask the patient a clarifying question before continuing.',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'propose_options',
      description: 'Finalize the search with up to 8 grounded, distinct-provider options.',
      parameters: {
        type: 'object',
        properties: {
          specialty: { type: 'string', description: 'One label from the supported specialty list' },
          reason: { type: 'string' },
          summary: { type: 'string' },
          picks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                npi: { type: 'string' },
                start: { type: 'string' },
                end: { type: 'string' },
                reasoning: { type: 'string' },
              },
              required: ['npi', 'start', 'end', 'reasoning'],
            },
          },
        },
        required: ['specialty', 'reason', 'summary', 'picks'],
      },
    },
  },
];

export async function searchPreviousPhysicianTool(
  medplum: MedplumClient,
  patientId: string,
  specialtyCode: string
): Promise<FoundCandidate | null> {
  const found = await findPreviousPhysician(medplum, patientId, specialtyCode);
  return found ?? null;
}

export async function searchNppesTool(medplum: MedplumClient, patient: Patient, specialtyCode: string): Promise<FoundCandidate[]> {
  const specialtyDef = SPECIALTY_TABLE.find((s) => s.nuccCode === specialtyCode);
  if (!specialtyDef) {
    return [];
  }
  const nppesResults = await searchNppesDoctors(
    specialtyDef.nppesTaxonomyDescription,
    patient.address?.[0]?.city ?? '',
    patient.address?.[0]?.state ?? '',
    specialtyCode,
    NPPES_SEARCH_LIMIT
  );
  const ranked = rankCandidates(patientCoords(patient), nppesResults);
  return ranked.slice(0, NPPES_SEARCH_LIMIT).map((c) => ({ ...c, source: 'nppes' as const, npi: c.npi }));
}

function scheduleTimeZone(schedule: Schedule, healthcareServiceId: string, fallbackState: string | undefined): string {
  const schedulingParameters = schedule.extension?.find(
    (extension) =>
      extension.url === 'https://medplum.com/fhir/StructureDefinition/SchedulingParameters' &&
      extension.extension?.some(
        (parameter) =>
          parameter.url === 'service' &&
          parameter.valueReference?.reference === `HealthcareService/${healthcareServiceId}`
      )
  );
  return (
    schedulingParameters?.extension?.find((parameter) => parameter.url === 'timezone')?.valueCode ??
    timezoneForState(fallbackState)
  );
}

export async function checkAvailabilityTool(
  medplum: MedplumClient,
  args: { npi: string; startOffsetDays?: number; windowDays?: number; previousDoctor?: boolean; distanceMiles?: number }
): Promise<BookableOption[]> {
  const ensured = await ensurePractitionerAndSchedule(medplum, args.npi);
  const [practitioner, schedule] = await Promise.all([
    medplum.readResource('Practitioner', ensured.practitionerId),
    medplum.readResource('Schedule', ensured.scheduleId),
  ]);
  const doctorName = `Dr. ${practitioner.name?.[0]?.given?.[0] ?? ''} ${practitioner.name?.[0]?.family ?? ''}`.trim();
  const timeZone = scheduleTimeZone(schedule, ensured.healthcareServiceId, undefined);

  const start = new Date(nowProvider().getTime() + (args.startOffsetDays ?? 0) * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + (args.windowDays ?? 7) * 24 * 60 * 60 * 1000);
  const url = medplum.fhirUrl('Appointment', '$find');
  url.searchParams.set('service-type-reference', `HealthcareService/${ensured.healthcareServiceId}`);
  url.searchParams.set('schedule', `Schedule/${ensured.scheduleId}`);
  url.searchParams.set('start', start.toISOString());
  url.searchParams.set('end', end.toISOString());
  url.searchParams.set('_count', '100');
  const bundle = await medplum.get<Bundle<Appointment>>(url);

  return (bundle.entry ?? []).flatMap(({ resource }) => {
    if (resource?.resourceType !== 'Appointment' || !resource.start || !resource.end) {
      return [];
    }
    return [
      {
        id: `${args.npi}|${resource.start}|${resource.end}`,
        npi: args.npi,
        practitionerId: ensured.practitionerId,
        scheduleId: ensured.scheduleId,
        doctorName,
        start: resource.start,
        end: resource.end,
        timeZone,
        previousDoctor: args.previousDoctor ?? false,
        distanceMiles: args.distanceMiles,
      },
    ];
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/bots/agent/lib/bookingChatTools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bots/agent/lib/bookingChatTools.ts src/bots/agent/lib/bookingChatTools.test.ts
git commit -m "feat: add booking chat tool schemas and thin tool wrappers"
```

---

### Task 6: `propose_options` grounding, validation, and cap (`proposeOptions.ts`)

**Files:**
- Create: `src/bots/agent/lib/proposeOptions.ts`
- Test: `src/bots/agent/lib/proposeOptions.test.ts`

**Interfaces:**
- Consumes: `normalizeLlmSpecialty` from `../../../config/specialties.js`, `rankBookableOptions`/`BookableOption` from `./bookableOptions.js`, `BookingChatMessage` from `./bookingSession.js`.
- Produces:
  - `const MAX_BOOKABLE_OPTIONS = 8`
  - `interface ProposeOptionsArgs { specialty: string; reason: string; summary: string; picks: { npi: string; start: string; end: string; reasoning: string }[] }`
  - `type ProposeOptionsResult = { ok: true; specialtyCode: string; reason: string; summary: string; options: BookableOption[] } | { ok: false; errorForModel: string }`
  - `function collectGroundedOptions(transcript: BookingChatMessage[]): BookableOption[]` — scans `tool` messages produced by `check_availability` (see Task 7's message envelope) for the full grounded pool.
  - `function resolveProposedOptions(transcript: BookingChatMessage[], args: ProposeOptionsArgs): ProposeOptionsResult`
- Consumed by: Task 7 (`agent-booking-chat.ts`), which additionally writes the summary `Communication` once `ok: true`.

- [ ] **Step 1: Write the failing tests**

Create `src/bots/agent/lib/proposeOptions.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import type { BookingChatMessage } from './bookingSession';
import { MAX_BOOKABLE_OPTIONS, collectGroundedOptions, resolveProposedOptions } from './proposeOptions';
import type { BookableOption } from './bookableOptions';

function option(npi: string, start: string): BookableOption {
  return {
    id: `${npi}|${start}`,
    npi,
    practitionerId: `practitioner-${npi}`,
    scheduleId: `schedule-${npi}`,
    doctorName: `Dr. ${npi}`,
    start,
    end: new Date(Date.parse(start) + 30 * 60 * 1000).toISOString(),
    timeZone: 'America/New_York',
    previousDoctor: false,
  };
}

function toolResultMessage(tool: string, result: unknown): BookingChatMessage {
  return { role: 'tool', tool_call_id: 'call-1', content: JSON.stringify({ tool, result }) };
}

describe('collectGroundedOptions', () => {
  test('collects only check_availability results, ignoring other tool results', () => {
    const transcript: BookingChatMessage[] = [
      toolResultMessage('search_nppes', [{ npi: '1', firstName: 'A' }]),
      toolResultMessage('check_availability', [option('1', '2026-08-14T13:00:00.000Z')]),
      toolResultMessage('check_availability', [option('2', '2026-08-14T14:00:00.000Z')]),
    ];

    const pool = collectGroundedOptions(transcript);

    expect(pool.map((o) => o.npi)).toStrictEqual(['1', '2']);
  });
});

describe('resolveProposedOptions', () => {
  const grounded = [option('1', '2026-08-14T13:00:00.000Z'), option('2', '2026-08-14T14:00:00.000Z')];
  const transcript: BookingChatMessage[] = [toolResultMessage('check_availability', grounded)];

  test('rejects an unrecognized specialty', () => {
    const result = resolveProposedOptions(transcript, {
      specialty: 'quantum flux specialist',
      reason: 'r',
      summary: 's',
      picks: [{ npi: '1', start: grounded[0].start, end: grounded[0].end, reasoning: 'why' }],
    });

    expect(result).toStrictEqual({ ok: false, errorForModel: expect.stringContaining('not a supported specialty') });
  });

  test('drops ungrounded picks and fails if nothing groundable remains', () => {
    const result = resolveProposedOptions(transcript, {
      specialty: 'General Practice',
      reason: 'r',
      summary: 's',
      picks: [{ npi: 'not-real', start: '2026-08-14T13:00:00.000Z', end: '2026-08-14T13:30:00.000Z', reasoning: 'why' }],
    });

    expect(result).toStrictEqual({ ok: false, errorForModel: expect.stringContaining('not grounded') });
  });

  test('accepts the model picks in the model order when they satisfy the distinct-provider cap', () => {
    const result = resolveProposedOptions(transcript, {
      specialty: 'General Practice',
      reason: 'r',
      summary: 's',
      picks: [
        { npi: '2', start: grounded[1].start, end: grounded[1].end, reasoning: 'earlier for this doctor' },
        { npi: '1', start: grounded[0].start, end: grounded[0].end, reasoning: 'previously seen' },
      ],
    });

    if (!result.ok) throw new Error('expected ok');
    expect(result.specialtyCode).toBe('208D00000X');
    expect(result.options.map((o) => o.npi)).toStrictEqual(['2', '1']);
  });

  test('falls back to rankBookableOptions when picks exceed the distinct-provider cap', () => {
    const manyGrounded = Array.from({ length: 10 }, (_, i) => option(String(i + 1), `2026-08-14T${13 + i}:00:00.000Z`));
    const bigTranscript: BookingChatMessage[] = [toolResultMessage('check_availability', manyGrounded)];
    const duplicatePicks = manyGrounded.map((o) => ({ npi: '1', start: o.start, end: o.end, reasoning: 'dup' }));

    const result = resolveProposedOptions(bigTranscript, {
      specialty: 'General Practice',
      reason: 'r',
      summary: 's',
      picks: duplicatePicks,
    });

    if (!result.ok) throw new Error('expected ok');
    expect(result.options.length).toBeLessThanOrEqual(MAX_BOOKABLE_OPTIONS);
    expect(new Set(result.options.map((o) => o.npi)).size).toBe(result.options.length);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/bots/agent/lib/proposeOptions.test.ts`
Expected: FAIL — module `./proposeOptions` does not exist.

- [ ] **Step 3: Implement**

Create `src/bots/agent/lib/proposeOptions.ts`:

```ts
// src/bots/agent/lib/proposeOptions.ts
import { normalizeLlmSpecialty } from '../../../config/specialties.js';
import { rankBookableOptions } from './bookableOptions.js';
import type { BookableOption } from './bookableOptions.js';
import type { BookingChatMessage } from './bookingSession.js';

export const MAX_BOOKABLE_OPTIONS = 8;

const NEUTRAL_PREFERENCES = { preferPreviousDoctor: false, preferNearby: false };

export interface ProposeOptionsArgs {
  specialty: string;
  reason: string;
  summary: string;
  picks: { npi: string; start: string; end: string; reasoning: string }[];
}

export type ProposeOptionsResult =
  | { ok: true; specialtyCode: string; reason: string; summary: string; options: BookableOption[] }
  | { ok: false; errorForModel: string };

export function collectGroundedOptions(transcript: BookingChatMessage[]): BookableOption[] {
  const pool: BookableOption[] = [];
  for (const message of transcript) {
    if (message.role !== 'tool') continue;
    let parsed: { tool?: string; result?: unknown };
    try {
      parsed = JSON.parse(message.content) as { tool?: string; result?: unknown };
    } catch {
      continue;
    }
    if (parsed.tool === 'check_availability' && Array.isArray(parsed.result)) {
      pool.push(...(parsed.result as BookableOption[]));
    }
  }
  return pool;
}

function distinctByProvider(options: BookableOption[], limit: number): BookableOption[] {
  const seen = new Set<string>();
  const result: BookableOption[] = [];
  for (const option of options) {
    if (seen.has(option.npi)) continue;
    seen.add(option.npi);
    result.push(option);
    if (result.length === limit) break;
  }
  return result;
}

export function resolveProposedOptions(transcript: BookingChatMessage[], args: ProposeOptionsArgs): ProposeOptionsResult {
  const specialtyDef = normalizeLlmSpecialty(args.specialty);
  if (!specialtyDef) {
    return { ok: false, errorForModel: `"${args.specialty}" is not a supported specialty. Choose one from the supported list or call ask_clarifying_question.` };
  }

  const groundedPool = collectGroundedOptions(transcript);
  const groundedByKey = new Map(groundedPool.map((option) => [`${option.npi}|${option.start}|${option.end}`, option]));

  const groundedPicks = args.picks
    .map((pick) => groundedByKey.get(`${pick.npi}|${pick.start}|${pick.end}`))
    .filter((option): option is BookableOption => Boolean(option));

  if (groundedPicks.length === 0) {
    return { ok: false, errorForModel: 'None of the proposed picks are grounded in a prior check_availability result. Call check_availability again before proposing.' };
  }

  const distinctPicks = distinctByProvider(groundedPicks, MAX_BOOKABLE_OPTIONS);
  const options =
    distinctPicks.length === groundedPicks.length
      ? distinctPicks
      : rankBookableOptions(groundedPool, NEUTRAL_PREFERENCES, MAX_BOOKABLE_OPTIONS);

  return { ok: true, specialtyCode: specialtyDef.nuccCode, reason: args.reason, summary: args.summary, options };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/bots/agent/lib/proposeOptions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bots/agent/lib/proposeOptions.ts src/bots/agent/lib/proposeOptions.test.ts
git commit -m "feat: ground, validate, and cap model-proposed booking options"
```

---

### Task 7: The loop bot (`agent-booking-chat.ts`)

**Files:**
- Create: `src/bots/agent/agent-booking-chat.ts`
- Test: `src/bots/agent/agent-booking-chat.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–6, plus `loadPatientClinicalContext` from `./lib/patientContext.js`.
- Produces:
  - `type BookingChatInput = { patientId: string; message: string; sessionId?: string }`
  - `type BookingChatResult = { kind: 'question'; sessionId: string; reply: string } | { kind: 'options'; sessionId: string; options: BookableOption[]; summaryCommunicationId: string } | { kind: 'error'; sessionId: string; reply: string }`
  - `async function handler(medplum: MedplumClient, event: BotEvent<BookingChatInput>): Promise<BookingChatResult>`
  - `function __setGeminiToolCallerForTests(fn: GeminiToolCaller): void` (test seam)
- Consumed by: Task 8 (`api/execute.ts`), Task 13 (frontend).

- [ ] **Step 1: Write the failing tests**

Create `src/bots/agent/agent-booking-chat.test.ts`:

```ts
import { beforeAll, describe, expect, test } from 'vitest';
import { indexSearchParameterBundle, indexStructureDefinitionBundle } from '@medplum/core';
import { readJson, SEARCH_PARAMETER_BUNDLE_FILES } from '@medplum/definitions';
import type { Bundle, SearchParameter } from '@medplum/fhirtypes';
import { MockClient } from '@medplum/mock';
import { __setGeminiToolCallerForTests, handler } from './agent-booking-chat';
import type { BookingChatInput } from './agent-booking-chat';

beforeAll(() => {
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-types.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-resources.json') as Bundle);
  indexStructureDefinitionBundle(readJson('fhir/r4/profiles-medplum.json') as Bundle);
  for (const filename of SEARCH_PARAMETER_BUNDLE_FILES) {
    indexSearchParameterBundle(readJson(filename) as Bundle<SearchParameter>);
  }
});

async function seedFixtures(medplum: MockClient): Promise<{ patientId: string }> {
  await medplum.createResource({
    resourceType: 'Device',
    identifier: [{ system: 'http://example.com/agent-config', value: 'ai-appointment-agent' }],
  });
  await medplum.createResource({ resourceType: 'HealthcareService', name: 'Office Visit', active: true });
  const patient = await medplum.createResource({ resourceType: 'Patient' });
  return { patientId: patient.id as string };
}

function event(input: BookingChatInput) {
  return {
    bot: { identifier: { system: 'http://example.com', value: 'agent-booking-chat' } },
    contentType: 'application/json',
    input,
    secrets: { GEMINI_API_KEY: { name: 'GEMINI_API_KEY', valueString: 'test-key' } },
  };
}

function toolCallResponse(id: string, name: string, args: Record<string, unknown>) {
  return {
    message: {
      role: 'assistant' as const,
      content: null,
      tool_calls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }],
    },
  };
}

describe('agent-booking-chat handler', () => {
  test('starts a new session and returns a clarifying question, persisted for resume', async () => {
    const medplum = new MockClient();
    const { patientId } = await seedFixtures(medplum);
    __setGeminiToolCallerForTests(async () =>
      toolCallResponse('call-1', 'ask_clarifying_question', { question: 'Which body part hurts?' })
    );

    const result = await handler(medplum, event({ patientId, message: 'I have pain' }));

    expect(result).toMatchObject({ kind: 'question', reply: 'Which body part hurts?' });
    if (result.kind !== 'question') throw new Error('expected question');
    const communication = await medplum.readResource('Communication', result.sessionId);
    expect(communication.status).toBe('in-progress');
  });

  test('resumes an existing session and appends the new patient message to the persisted transcript', async () => {
    const medplum = new MockClient();
    const { patientId } = await seedFixtures(medplum);
    __setGeminiToolCallerForTests(async () =>
      toolCallResponse('call-1', 'ask_clarifying_question', { question: 'first question' })
    );
    const first = await handler(medplum, event({ patientId, message: 'I have pain' }));
    if (first.kind !== 'question') throw new Error('expected question');

    __setGeminiToolCallerForTests(async (transcript) => {
      expect(transcript.some((m) => m.role === 'user' && m.content === 'my jaw')).toBe(true);
      return toolCallResponse('call-2', 'ask_clarifying_question', { question: 'second question' });
    });
    const second = await handler(medplum, event({ patientId, message: 'my jaw', sessionId: first.sessionId }));

    expect(second).toMatchObject({ kind: 'question', reply: 'second question', sessionId: first.sessionId });
  });

  test('rejects a stopped step-cap session and never leaks that state to a mismatched patient', async () => {
    const medplum = new MockClient();
    const { patientId } = await seedFixtures(medplum);
    const otherPatient = await medplum.createResource({ resourceType: 'Patient' });
    __setGeminiToolCallerForTests(async () =>
      toolCallResponse('call-1', 'ask_clarifying_question', { question: 'q' })
    );
    const first = await handler(medplum, event({ patientId, message: 'hi' }));
    if (first.kind !== 'question') throw new Error('expected question');

    await expect(
      handler(medplum, event({ patientId: otherPatient.id as string, message: 'hi', sessionId: first.sessionId }))
    ).rejects.toThrow('Booking chat session not found for this patient');
  });

  test('stops after the step cap and marks the session stopped', async () => {
    const medplum = new MockClient();
    const { patientId } = await seedFixtures(medplum);
    let calls = 0;
    __setGeminiToolCallerForTests(async () => {
      calls += 1;
      return toolCallResponse(`call-${calls}`, 'search_previous_physician', { specialtyCode: '208D00000X' });
    });

    const result = await handler(medplum, event({ patientId, message: 'anything' }));

    expect(result.kind).toBe('error');
    expect(calls).toBe(8);
    const communication = await medplum.readResource('Communication', result.sessionId);
    expect(communication.status).toBe('stopped');
  });

  test('propose_options success returns grounded options and a summary Communication id, and completes the session', async () => {
    const medplum = new MockClient();
    const { patientId } = await seedFixtures(medplum);
    const availability = [
      {
        id: '1000000001|2026-08-14T13:00:00.000Z|2026-08-14T13:30:00.000Z',
        npi: '1000000001',
        practitionerId: 'practitioner-1',
        scheduleId: 'schedule-1',
        doctorName: 'Dr. Test',
        start: '2026-08-14T13:00:00.000Z',
        end: '2026-08-14T13:30:00.000Z',
        timeZone: 'America/New_York',
        previousDoctor: false,
      },
    ];
    let call = 0;
    __setGeminiToolCallerForTests(async () => {
      call += 1;
      if (call === 1) {
        return {
          message: {
            role: 'assistant' as const,
            content: null,
            tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'check_availability', arguments: JSON.stringify({ npi: '1000000001' }) } }],
          },
        };
      }
      return {
        message: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: 'call-2',
              type: 'function' as const,
              function: {
                name: 'propose_options',
                arguments: JSON.stringify({
                  specialty: 'General Practice',
                  reason: 'Routine visit',
                  summary: 'Patient requests a routine visit.',
                  picks: [{ npi: '1000000001', start: availability[0].start, end: availability[0].end, reasoning: 'earliest' }],
                }),
              },
            },
          ],
        },
      };
    });

    // Stub the underlying tool executors indirectly via a fake $find response.
    const originalGet = medplum.get.bind(medplum);
    medplum.get = (async (url: string | URL, options?: unknown) => {
      const asUrl = typeof url === 'string' ? new URL(url) : url;
      if (asUrl.pathname.includes('$find')) {
        return {
          resourceType: 'Bundle',
          type: 'searchset',
          entry: [
            {
              resource: {
                resourceType: 'Appointment',
                status: 'proposed',
                start: availability[0].start,
                end: availability[0].end,
                participant: [],
              },
            },
          ],
        };
      }
      return originalGet(url as never, options as never);
    }) as typeof medplum.get;

    const result = await handler(medplum, event({ patientId, message: 'Find me a doctor' }));

    expect(result.kind).toBe('options');
    if (result.kind !== 'options') throw new Error('expected options');
    expect(result.options).toHaveLength(1);
    expect(result.options[0].npi).toBe('1000000001');
    const summary = await medplum.readResource('Communication', result.summaryCommunicationId);
    expect(summary.status).toBe('preparation');
    expect(summary.topic?.coding?.[0]).toMatchObject({ code: '208D00000X' });
    const session = await medplum.readResource('Communication', result.sessionId);
    expect(session.status).toBe('completed');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/bots/agent/agent-booking-chat.test.ts`
Expected: FAIL — module `./agent-booking-chat` does not exist.

- [ ] **Step 3: Implement**

Create `src/bots/agent/agent-booking-chat.ts`:

```ts
// src/bots/agent/agent-booking-chat.ts
import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Communication } from '@medplum/fhirtypes';
import { BOOKING_CHAT_SYSTEM_PROMPT, buildPatientContextMessage } from './lib/prompts.js';
import { loadPatientClinicalContext } from './lib/patientContext.js';
import {
  BOOKING_CHAT_TOOL_SCHEMAS,
  checkAvailabilityTool,
  searchNppesTool,
  searchPreviousPhysicianTool,
} from './lib/bookingChatTools.js';
import { createBookingSession, loadBookingSession, persistBookingSession } from './lib/bookingSession.js';
import type { BookingChatMessage, BookingSession, BookingToolCall } from './lib/bookingSession.js';
import { resolveProposedOptions } from './lib/proposeOptions.js';
import type { ProposeOptionsArgs } from './lib/proposeOptions.js';
import type { BookableOption } from './lib/bookableOptions.js';

export type BookingChatInput = { patientId: string; message: string; sessionId?: string };

export type BookingChatResult =
  | { kind: 'question'; sessionId: string; reply: string }
  | { kind: 'options'; sessionId: string; options: BookableOption[]; summaryCommunicationId: string }
  | { kind: 'error'; sessionId: string; reply: string };

export const MAX_TOOL_LOOP_STEPS = 8;

interface GeminiToolResponse {
  message: { role: 'assistant'; content: string | null; tool_calls?: BookingToolCall[] };
}

type GeminiToolCaller = (transcript: BookingChatMessage[], apiKey: string) => Promise<GeminiToolResponse>;

let geminiToolCaller: GeminiToolCaller = callGeminiWithTools;

/** Test-only seam. */
export function __setGeminiToolCallerForTests(fn: GeminiToolCaller): void {
  geminiToolCaller = fn;
}

async function callGeminiWithTools(transcript: BookingChatMessage[], apiKey: string): Promise<GeminiToolResponse> {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-3.5-flash-lite',
      temperature: 0,
      messages: transcript,
      tools: BOOKING_CHAT_TOOL_SCHEMAS,
    }),
  });
  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status}`);
  }
  const body = await response.json();
  return { message: body.choices[0].message };
}

function toolResultMessage(callId: string, toolName: string, result: unknown): BookingChatMessage {
  return { role: 'tool', tool_call_id: callId, content: JSON.stringify({ tool: toolName, result }) };
}

async function writeSummaryCommunication(
  medplum: MedplumClient,
  patientId: string,
  resolved: Extract<ReturnType<typeof resolveProposedOptions>, { ok: true }>
): Promise<string> {
  const agentDevice = await medplum.searchOne('Device', {
    identifier: 'http://example.com/agent-config|ai-appointment-agent',
  });
  if (!agentDevice?.id) {
    throw new Error('The ai-appointment-agent Device is not configured');
  }
  const communication: Communication = await medplum.createResource({
    resourceType: 'Communication',
    status: 'preparation',
    category: [{ coding: [{ system: 'http://example.com/agent-communication-category', code: 'ai-previsit-summary' }] }],
    reasonCode: [{ text: resolved.reason }],
    note: [{ text: resolved.reason }],
    topic: { coding: [{ system: 'http://nucc.org/provider-taxonomy', code: resolved.specialtyCode }] },
    subject: { reference: `Patient/${patientId}` },
    sender: { reference: `Device/${agentDevice.id}` },
    payload: [{ contentString: resolved.summary }],
    meta: { tag: [{ code: 'ai-generated' }] },
  });
  return communication.id as string;
}

async function executeReadOnlyTool(medplum: MedplumClient, patientId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_previous_physician':
      return searchPreviousPhysicianTool(medplum, patientId, args.specialtyCode as string);
    case 'search_nppes': {
      const patient = await medplum.readResource('Patient', patientId);
      return searchNppesTool(medplum, patient, args.specialtyCode as string);
    }
    case 'check_availability':
      return checkAvailabilityTool(medplum, args as { npi: string; startOffsetDays?: number; windowDays?: number; previousDoctor?: boolean; distanceMiles?: number });
    default:
      throw new Error(`Unknown booking chat tool: ${name}`);
  }
}

export async function handler(medplum: MedplumClient, event: BotEvent<BookingChatInput>): Promise<BookingChatResult> {
  const { patientId, message, sessionId } = event.input;
  const apiKey = event.secrets['GEMINI_API_KEY']?.valueString as string;

  let session: BookingSession;
  if (sessionId) {
    session = await loadBookingSession(medplum, sessionId, patientId);
    session = { ...session, transcript: [...session.transcript, { role: 'user', content: message }] };
  } else {
    const context = await loadPatientClinicalContext(medplum, patientId);
    const initialTranscript: BookingChatMessage[] = [
      { role: 'system', content: BOOKING_CHAT_SYSTEM_PROMPT },
      { role: 'system', content: buildPatientContextMessage(context) },
      { role: 'user', content: message },
    ];
    session = await createBookingSession(medplum, patientId, initialTranscript);
  }

  for (let step = 0; step < MAX_TOOL_LOOP_STEPS; step++) {
    const response = await geminiToolCaller(session.transcript, apiKey);
    const toolCalls = response.message.tool_calls ?? [];

    if (toolCalls.length === 0) {
      session = { ...session, transcript: [...session.transcript, { role: 'assistant', content: response.message.content }] };
      await persistBookingSession(medplum, session, 'in-progress');
      return { kind: 'question', sessionId: session.communication.id as string, reply: response.message.content ?? '' };
    }

    session = { ...session, transcript: [...session.transcript, { role: 'assistant', content: response.message.content, tool_calls: toolCalls }] };

    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>;

      if (call.function.name === 'ask_clarifying_question') {
        session = { ...session, transcript: appendSkippedRemainder(session.transcript, toolCalls, i, call, 'ok') };
        await persistBookingSession(medplum, session, 'in-progress');
        return { kind: 'question', sessionId: session.communication.id as string, reply: args.question as string };
      }

      if (call.function.name === 'propose_options') {
        const resolved = resolveProposedOptions(session.transcript, args as unknown as ProposeOptionsArgs);
        if (!resolved.ok) {
          session = { ...session, transcript: [...session.transcript, toolResultMessage(call.id, 'propose_options', { error: resolved.errorForModel })] };
          continue;
        }
        const summaryCommunicationId = await writeSummaryCommunication(medplum, patientId, resolved);
        session = { ...session, transcript: appendSkippedRemainder(session.transcript, toolCalls, i, call, { ok: true }) };
        await persistBookingSession(medplum, session, 'completed');
        return { kind: 'options', sessionId: session.communication.id as string, options: resolved.options, summaryCommunicationId };
      }

      const output = await executeReadOnlyTool(medplum, patientId, call.function.name, args);
      session = { ...session, transcript: [...session.transcript, toolResultMessage(call.id, call.function.name, output)] };
    }
  }

  await persistBookingSession(medplum, session, 'stopped');
  return { kind: 'error', sessionId: session.communication.id as string, reply: "I wasn't able to find a good match — let's start again." };
}

function appendSkippedRemainder(
  transcript: BookingChatMessage[],
  toolCalls: BookingToolCall[],
  handledIndex: number,
  handledCall: BookingToolCall,
  handledResult: unknown
): BookingChatMessage[] {
  const messages = [...transcript, toolResultMessage(handledCall.id, handledCall.function.name, handledResult)];
  for (let j = handledIndex + 1; j < toolCalls.length; j++) {
    messages.push(toolResultMessage(toolCalls[j].id, toolCalls[j].function.name, { skipped: true }));
  }
  return messages;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/bots/agent/agent-booking-chat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bots/agent/agent-booking-chat.ts src/bots/agent/agent-booking-chat.test.ts
git commit -m "feat: add agent-booking-chat tool-calling loop bot"
```

---

### Task 8: Wire `agent-booking-chat` into the API and bot deploy list

**Files:**
- Modify: `api/execute.ts`
- Modify: `api/execute.test.ts`
- Modify: `src/scripts/deploy-bots.ts`
- Test: `api/execute.test.ts` (existing suite, extended)

**Interfaces:**
- Consumes: `handler`, `BookingChatInput` from `../src/bots/agent/agent-booking-chat.js`.
- Produces: `'agent-booking-chat'` added to `ALLOWED_ACTIONS`/`HANDLERS`/`GEMINI_ACTIONS` (additive — `agent-intake` and `agent-find-bookable-options` are NOT removed yet; that happens in Task 14 once the frontend no longer calls them).

- [ ] **Step 1: Write the failing test**

Add to `api/execute.test.ts` (near the existing `'allows the patient concierge discovery action'` test):

```ts
test('allows the booking chat action', () => {
  expect(ALLOWED_ACTIONS).toContain('agent-booking-chat');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run api/execute.test.ts -t "allows the booking chat action"`
Expected: FAIL — `'agent-booking-chat'` is not in `ALLOWED_ACTIONS`.

- [ ] **Step 3: Implement**

In `api/execute.ts`, add near the other agent imports:

```ts
import { handler as agentBookingChatHandler } from '../src/bots/agent/agent-booking-chat.js';
import type { BookingChatInput } from '../src/bots/agent/agent-booking-chat.js';
```

Add `'agent-booking-chat'` to the `ALLOWED_ACTIONS` array (after `'agent-patient-chat'`):

```ts
export const ALLOWED_ACTIONS = [
  'cancel-appointment',
  'complete-appointment',
  'reschedule-appointment',
  'agent-intake',
  'agent-find-doctors',
  'agent-find-bookable-options',
  'agent-ensure-doctor',
  'agent-book-appointment',
  'agent-patient-chat',
  'agent-booking-chat',
] as const;
```

Add to `GEMINI_ACTIONS`:

```ts
const GEMINI_ACTIONS = new Set<ActionName>(['agent-intake', 'agent-find-bookable-options', 'agent-patient-chat', 'agent-booking-chat']);
```

Add to `HANDLERS`:

```ts
  'agent-booking-chat': (medplum, event) => agentBookingChatHandler(medplum, event as BotEvent<BookingChatInput>),
```

In `src/scripts/deploy-bots.ts`, add to the `Bots` array (after the `agent-patient-chat` entry):

```ts
  {
    src: 'src/bots/agent/agent-booking-chat.ts',
    dist: 'dist/bots/agent/agent-booking-chat.js',
  },
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run api/execute.test.ts`
Expected: PASS, including the pre-existing `test.each(ALLOWED_ACTIONS)('dispatches the allowlisted %s action', ...)` parameterized test, which now also covers `agent-booking-chat` automatically.

- [ ] **Step 5: Commit**

```bash
git add api/execute.ts api/execute.test.ts src/scripts/deploy-bots.ts
git commit -m "feat: wire agent-booking-chat into the execute API and bot deploy list"
```

---

### Task 9: Frontend turn model (`bookingChatModel.ts`)

**Files:**
- Create: `src/components/agent/bookingChatModel.ts`
- Test: `src/components/agent/bookingChatModel.test.ts`

**Interfaces:**
- Consumes: `BookableOption` from `../../bots/agent/lib/bookableOptions.js`.
- Produces: `type BookingChatTurn = { kind: 'patient'; text: string } | { kind: 'agent-question'; text: string } | { kind: 'agent-options'; options: BookableOption[] }`, `function prepareBookingMessage(value: string): string | undefined`.
- Consumed by: Task 10 (`BookingChat.tsx`), Task 13 (`PatientHistoryPage.tsx`).

- [ ] **Step 1: Write the failing test**

Create `src/components/agent/bookingChatModel.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { prepareBookingMessage } from './bookingChatModel';

describe('booking chat message boundary', () => {
  test('trims a non-empty message', () => {
    expect(prepareBookingMessage('  I have a headache  ')).toBe('I have a headache');
  });

  test('rejects a whitespace-only message', () => {
    expect(prepareBookingMessage('   ')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/components/agent/bookingChatModel.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/components/agent/bookingChatModel.ts`:

```ts
// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { BookableOption } from '../../bots/agent/lib/bookableOptions';

export type BookingChatTurn =
  | { kind: 'patient'; text: string }
  | { kind: 'agent-question'; text: string }
  | { kind: 'agent-options'; options: BookableOption[] };

export function prepareBookingMessage(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/components/agent/bookingChatModel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/agent/bookingChatModel.ts src/components/agent/bookingChatModel.test.ts
git commit -m "feat: add booking chat turn model"
```

---

### Task 10: Frontend chat component (`BookingChat.tsx`)

**Files:**
- Create: `src/components/agent/BookingChat.tsx`

**Interfaces:**
- Consumes: `BookingChatTurn`, `prepareBookingMessage` from `./bookingChatModel.js` (Task 9); `BookableOptionCard` from `./BookableOptionCard.js` (existing).
- Produces: `function BookingChat(props: { turns: BookingChatTurn[]; onSend: (message: string) => Promise<void>; sending: boolean; onSelectOption: (option: BookableOption) => void }): JSX.Element`
- Consumed by: Task 13 (`PatientHistoryPage.tsx`). No dedicated component test — matches this codebase's existing convention (`AgentChat.tsx` has no direct render test either; only its model file is unit-tested).

- [ ] **Step 1: Implement**

Create `src/components/agent/BookingChat.tsx`, closely mirroring `src/components/desk/AgentChat.tsx`'s structure:

```tsx
// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Button, Group, Loader, Paper, Stack, Text, Textarea } from '@mantine/core';
import type { JSX } from 'react';
import { useState } from 'react';
import { BookableOptionCard } from './BookableOptionCard';
import { prepareBookingMessage } from './bookingChatModel';
import type { BookingChatTurn } from './bookingChatModel';
import type { BookableOption } from '../../bots/agent/lib/bookableOptions';

interface BookingChatProps {
  turns: BookingChatTurn[];
  onSend: (message: string) => Promise<void>;
  sending: boolean;
  onSelectOption: (option: BookableOption) => void;
}

export function BookingChat({ turns, onSend, sending, onSelectOption }: BookingChatProps): JSX.Element {
  const [message, setMessage] = useState('');

  async function submit(): Promise<void> {
    const prepared = prepareBookingMessage(message);
    if (!prepared || sending) {
      return;
    }
    await onSend(prepared);
    setMessage('');
  }

  function send(): void {
    submit().catch(console.error);
  }

  const lastTurn = turns[turns.length - 1];
  const optionsShown = lastTurn?.kind === 'agent-options';

  return (
    <Stack>
      <Alert color="blue" title="Scheduling assistant">
        This assistant only helps find and book a visit. It does not diagnose, recommend treatment, or assess
        urgency — if this is a medical emergency, call 911 or go to the nearest emergency room.
      </Alert>
      <Stack>
        {turns.map((turn, index) => {
          if (turn.kind === 'patient') {
            return (
              <Paper key={index} withBorder p="sm">
                <Text fw={600}>You: {turn.text}</Text>
              </Paper>
            );
          }
          if (turn.kind === 'agent-question') {
            return (
              <Paper key={index} withBorder p="sm">
                <Text>{turn.text}</Text>
              </Paper>
            );
          }
          return (
            <Stack key={index}>
              <Text>Here are the best available options:</Text>
              {turn.options.map((option, optionIndex) => (
                <BookableOptionCard
                  key={option.id}
                  option={option}
                  number={optionIndex + 1}
                  disabled={sending}
                  onSelect={() => onSelectOption(option)}
                />
              ))}
              <Text>Which option would you like to book?</Text>
            </Stack>
          );
        })}
        {sending && <Loader size="sm" />}
      </Stack>
      {!optionsShown && (
        <Group align="flex-end">
          <Textarea
            style={{ flex: 1 }}
            label="What brings you in today?"
            placeholder="e.g. My chest hurts when I run"
            value={message}
            onChange={(event) => setMessage(event.currentTarget.value)}
            disabled={sending}
            minRows={2}
            maxRows={3}
          />
          <Button disabled={!prepareBookingMessage(message) || sending} loading={sending} onClick={send}>
            Send
          </Button>
        </Group>
      )}
    </Stack>
  );
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: no new errors from this file (it will still fail overall if `BookableOptionCard`'s import path or props are wrong — fix any mismatch against the existing `src/components/agent/BookableOptionCard.tsx` export before proceeding).

- [ ] **Step 3: Commit**

```bash
git add src/components/agent/BookingChat.tsx
git commit -m "feat: add BookingChat component"
```

---

### Task 11: Trim `bookingAgentModel.ts` to post-options phases and raise the option cap to 8

**Files:**
- Modify: `src/pages/agent/bookingAgentModel.ts`
- Modify: `src/pages/agent/bookingAgentModel.test.ts`

**Interfaces:**
- Produces (replacing the current exports): `type BookingAgentPhase = 'showing-options' | 'confirming' | 'booking'`, `interface BookingAgentState { phase: BookingAgentPhase; options: BookableOption[]; selectedOption?: BookableOption; summaryCommunicationId?: string; slotTaken: boolean }`, `function optionsReceived(result: { options: BookableOption[]; summaryCommunicationId: string }): BookingAgentState`, `optionSelected`, `bookingStarted`, `slotTaken` (signatures unchanged from today, just operating on the trimmed state shape).
- Removes: `initialBookingAgentState`, `searchStarted`, `clarificationRequested`, `BookingAgentPhase`'s `'collecting' | 'searching' | 'clarifying' | 'error'` members, the `complaintText`/`clarificationCount` fields.
- Consumed by: Task 12 (`bookingAgentController.ts`), Task 13 (`PatientHistoryPage.tsx`).

- [ ] **Step 1: Rewrite the test file first (red)**

Replace the full contents of `src/pages/agent/bookingAgentModel.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import type { BookableOption } from '../../bots/agent/lib/bookableOptions';
import { bookingStarted, optionSelected, optionsReceived, slotTaken } from './bookingAgentModel';

function option(id: string): BookableOption {
  return {
    id,
    npi: `npi-${id}`,
    practitionerId: `practitioner-${id}`,
    scheduleId: `schedule-${id}`,
    doctorName: `Dr. ${id}`,
    start: '2026-08-12T13:00:00.000Z',
    end: '2026-08-12T13:30:00.000Z',
    timeZone: 'America/New_York',
    previousDoctor: id === 'one',
    distanceMiles: 2,
  };
}

describe('bookingAgentModel', () => {
  test('stores at most eight grounded options and the authoritative summary id', () => {
    const nineOptions = Array.from({ length: 9 }, (_, i) => option(String(i + 1)));
    const received = optionsReceived({ options: nineOptions, summaryCommunicationId: 'summary-1' });

    expect(received.phase).toBe('showing-options');
    expect(received.options).toHaveLength(8);
    expect(received.summaryCommunicationId).toBe('summary-1');
  });

  test('selecting an option enters confirmation with that exact option', () => {
    const selected = option('two');
    const state = optionSelected(optionsReceived({ options: [option('one'), selected], summaryCommunicationId: 'summary-1' }), selected);

    expect(state.phase).toBe('confirming');
    expect(state.selectedOption).toBe(selected);
  });

  test('booking can only start from a complete confirmation state', () => {
    const showingOptions = optionsReceived({ options: [option('one')], summaryCommunicationId: 'summary-1' });
    expect(() => bookingStarted(showingOptions)).toThrow('Booking confirmation is not pending');

    const complete = optionSelected(showingOptions, option('one'));
    expect(bookingStarted(complete).phase).toBe('booking');
  });

  test('slot taken removes only the selected option and returns to the remaining results', () => {
    const selected = option('two');
    const confirming = optionSelected(
      optionsReceived({ options: [option('one'), selected, option('three')], summaryCommunicationId: 'summary-1' }),
      selected
    );

    const recovered = slotTaken(bookingStarted(confirming));

    expect(recovered.phase).toBe('showing-options');
    expect(recovered.options.map(({ id }) => id)).toEqual(['one', 'three']);
    expect(recovered.selectedOption).toBeUndefined();
    expect(recovered.slotTaken).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/pages/agent/bookingAgentModel.test.ts`
Expected: FAIL — `optionsReceived`'s current signature takes `(state, result)` and slices to 3, and `clarificationRequested`/`searchStarted`/`initialBookingAgentState` are imported by nothing now but the old file still exports the old shape, causing type/behavior mismatches.

- [ ] **Step 3: Rewrite `bookingAgentModel.ts`**

Replace the full contents of `src/pages/agent/bookingAgentModel.ts`:

```ts
import type { BookableOption } from '../../bots/agent/lib/bookableOptions.js';
import { MAX_BOOKABLE_OPTIONS } from '../../bots/agent/lib/proposeOptions.js';

export type BookingAgentPhase = 'showing-options' | 'confirming' | 'booking';

export interface BookingAgentState {
  phase: BookingAgentPhase;
  options: BookableOption[];
  selectedOption?: BookableOption;
  summaryCommunicationId?: string;
  slotTaken: boolean;
}

export interface BookingInProgressState extends BookingAgentState {
  phase: 'booking';
  selectedOption: BookableOption;
  summaryCommunicationId: string;
}

export function optionsReceived(result: { options: BookableOption[]; summaryCommunicationId: string }): BookingAgentState {
  return {
    phase: 'showing-options',
    options: result.options.slice(0, MAX_BOOKABLE_OPTIONS),
    selectedOption: undefined,
    summaryCommunicationId: result.summaryCommunicationId,
    slotTaken: false,
  };
}

export function optionSelected(state: BookingAgentState, option: BookableOption): BookingAgentState {
  return { ...state, phase: 'confirming', selectedOption: option, slotTaken: false };
}

export function bookingStarted(state: BookingAgentState): BookingInProgressState {
  if (state.phase !== 'confirming' || !state.selectedOption || !state.summaryCommunicationId) {
    throw new Error('Booking confirmation is not pending');
  }
  return {
    ...state,
    phase: 'booking',
    selectedOption: state.selectedOption,
    summaryCommunicationId: state.summaryCommunicationId,
  };
}

export function slotTaken(state: BookingAgentState): BookingAgentState {
  return {
    ...state,
    phase: 'showing-options',
    options: state.options.filter((option) => option.id !== state.selectedOption?.id),
    selectedOption: undefined,
    slotTaken: true,
  };
}
```

Note: `MAX_BOOKABLE_OPTIONS` is exported from `src/bots/agent/lib/proposeOptions.ts` (Task 6) — reused here rather than
redefined, so the frontend cap and the backend cap can never drift apart.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/pages/agent/bookingAgentModel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/agent/bookingAgentModel.ts src/pages/agent/bookingAgentModel.test.ts
git commit -m "refactor: trim booking agent state to post-options phases and raise option cap to 8"
```

---

### Task 12: Remove `searchForBookableOptions` from `bookingAgentController.ts`

**Files:**
- Modify: `src/pages/agent/bookingAgentController.ts`
- Modify: `src/pages/agent/bookingAgentController.test.ts`

**Interfaces:**
- Removes: `searchForBookableOptions`, `SearchDependencies`.
- Keeps unchanged: `confirmSelectedOption`, `BookingDependencies` — these still operate on the (now-trimmed) `BookingAgentState`/`BookingInProgressState` from Task 11.

- [ ] **Step 1: Rewrite the test file first (red)**

Replace the full contents of `src/pages/agent/bookingAgentController.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';
import type { BookableOption } from '../../bots/agent/lib/bookableOptions';
import { confirmSelectedOption } from './bookingAgentController';
import { optionSelected, optionsReceived } from './bookingAgentModel';

function option(id: string): BookableOption {
  return {
    id,
    npi: `npi-${id}`,
    practitionerId: `practitioner-${id}`,
    scheduleId: `schedule-${id}`,
    doctorName: `Dr. ${id}`,
    start: '2026-08-12T13:00:00.000Z',
    end: '2026-08-12T13:30:00.000Z',
    timeZone: 'America/New_York',
    previousDoctor: true,
    distanceMiles: 2,
  };
}

function confirmingState(): ReturnType<typeof optionSelected> {
  const selected = option('one');
  return optionSelected(optionsReceived({ options: [selected, option('two')], summaryCommunicationId: 'summary-1' }), selected);
}

describe('bookingAgentController', () => {
  test('selection alone never books; confirmation books once with the exact grounded payload and navigates', async () => {
    const state = confirmingState();
    const book = vi.fn(async () => ({
      ok: true as const,
      appointment: { resourceType: 'Appointment' as const, id: 'appointment-1', status: 'booked' as const, participant: [] },
    }));
    const navigate = vi.fn();
    const onBookingStarted = vi.fn();

    expect(book).not.toHaveBeenCalled();
    const result = await confirmSelectedOption(state, 'patient-1', { book, navigate, onBookingStarted });

    expect(onBookingStarted).toHaveBeenCalledWith(expect.objectContaining({ phase: 'booking' }));
    expect(book).toHaveBeenCalledTimes(1);
    expect(book).toHaveBeenCalledWith({
      patientId: 'patient-1',
      practitionerId: 'practitioner-one',
      scheduleId: 'schedule-one',
      start: '2026-08-12T13:00:00.000Z',
      end: '2026-08-12T13:30:00.000Z',
      summaryCommunicationId: 'summary-1',
    });
    expect(navigate).toHaveBeenCalledWith('/agent/patient-1/confirmed/appointment-1');
    expect(result.phase).toBe('booking');
  });

  test('slot taken removes the selected option and does not navigate', async () => {
    const navigate = vi.fn();
    const result = await confirmSelectedOption(confirmingState(), 'patient-1', {
      book: async () => ({ ok: false, reason: 'slot_taken' }),
      navigate,
    });

    expect(result.phase).toBe('showing-options');
    expect(result.options.map(({ id }) => id)).toEqual(['two']);
    expect(result.slotTaken).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });

  test('rejects booking before confirmation without calling the booking action', async () => {
    const book = vi.fn();
    const showingOptions = optionsReceived({ options: [option('one')], summaryCommunicationId: 'summary-1' });

    await expect(confirmSelectedOption(showingOptions, 'patient-1', { book, navigate: vi.fn() })).rejects.toThrow(
      'Booking confirmation is not pending'
    );
    expect(book).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/pages/agent/bookingAgentController.test.ts`
Expected: FAIL — the current file still imports/exports `searchForBookableOptions`, and `confirmSelectedOption`'s behavior needs re-verifying against the trimmed state (it should already pass unchanged once Task 11 lands, but this confirms it after this file's own edit).

- [ ] **Step 3: Rewrite `bookingAgentController.ts`**

Replace the full contents of `src/pages/agent/bookingAgentController.ts`:

```ts
import type { BookInput, BookResult } from '../../bots/agent/agent-book-appointment.js';
import { bookingStarted, slotTaken } from './bookingAgentModel.js';
import type { BookingAgentState, BookingInProgressState } from './bookingAgentModel.js';

interface BookingDependencies {
  book: (input: BookInput) => Promise<BookResult>;
  navigate: (path: string) => void | Promise<void>;
  onBookingStarted?: (state: BookingInProgressState) => void;
}

export async function confirmSelectedOption(
  state: BookingAgentState,
  patientId: string,
  dependencies: BookingDependencies
): Promise<BookingAgentState> {
  const bookingState = bookingStarted(state);
  dependencies.onBookingStarted?.(bookingState);
  const selectedOption = bookingState.selectedOption;
  const result = await dependencies.book({
    patientId,
    practitionerId: selectedOption.practitionerId,
    scheduleId: selectedOption.scheduleId,
    start: selectedOption.start,
    end: selectedOption.end,
    summaryCommunicationId: bookingState.summaryCommunicationId,
  });

  if (!result.ok) {
    return slotTaken(bookingState);
  }
  if (!result.appointment.id) {
    throw new Error('The booking response did not include an appointment id.');
  }
  await dependencies.navigate(`/agent/${patientId}/confirmed/${result.appointment.id}`);
  return bookingState;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/pages/agent/bookingAgentController.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/agent/bookingAgentController.ts src/pages/agent/bookingAgentController.test.ts
git commit -m "refactor: remove searchForBookableOptions now that the booking chat drives search"
```

---

### Task 13: Wire `BookingChat` into `PatientHistoryPage.tsx`

**Files:**
- Modify: `src/pages/agent/PatientHistoryPage.tsx`
- Modify: `src/pages/agent/PatientHistoryPage.contract.test.ts`

**Interfaces:**
- Consumes: `BookingChat` (Task 10), `BookingChatTurn` (Task 9), `BookingChatInput`/`BookingChatResult` (Task 7), `optionsReceived` (Task 11), `confirmSelectedOption` (Task 12, unchanged).

- [ ] **Step 1: Rewrite the contract test first (red)**

Replace the full contents of `src/pages/agent/PatientHistoryPage.contract.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

async function patientHistorySource(): Promise<string> {
  return readFile(new URL('./PatientHistoryPage.tsx', import.meta.url), 'utf8');
}

describe('PatientHistoryPage concierge contract', () => {
  test('renders the approved response and confirmation copy without routing internals', async () => {
    const source = await patientHistorySource();

    expect(source).toContain('This appointment has not been booked yet. Do you confirm the booking?');
    expect(source).not.toContain('routed your request');
    expect(source).not.toContain('ranked the results');
    expect(source).not.toContain('Based on the configured scheduling rules');
  });

  test('wires the chat and the two approved actions through the tested controller', async () => {
    const source = await patientHistorySource();

    expect(source.match(/'agent-booking-chat'/g)).toHaveLength(1);
    expect(source.match(/'agent-book-appointment'/g)).toHaveLength(1);
    expect(source).toContain('confirmSelectedOption(agentState');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/pages/agent/PatientHistoryPage.contract.test.ts`
Expected: FAIL — `PatientHistoryPage.tsx` still references `'agent-find-bookable-options'`, `ComplaintForm`, and the old copy.

- [ ] **Step 3: Rewrite `PatientHistoryPage.tsx`**

Replace the full contents of `src/pages/agent/PatientHistoryPage.tsx`:

```tsx
// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Button, Card, Stack, Text, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { Document, PatientSummary, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { BookInput, BookResult } from '../../bots/agent/agent-book-appointment';
import type { BookingChatInput, BookingChatResult } from '../../bots/agent/agent-booking-chat';
import type { BookableOption } from '../../bots/agent/lib/bookableOptions';
import { BookableOptionDetails } from '../../components/agent/BookableOptionCard';
import { BookingChat } from '../../components/agent/BookingChat';
import type { BookingChatTurn } from '../../components/agent/bookingChatModel';
import { EncounterHistoryList } from '../../components/agent/EncounterHistoryList';
import { executeAction } from '../../api/executeAction';
import { confirmSelectedOption } from './bookingAgentController';
import { optionSelected, optionsReceived } from './bookingAgentModel';
import type { BookingAgentState, BookingInProgressState } from './bookingAgentModel';

export function PatientHistoryPage(): JSX.Element {
  const { patientId } = useParams();
  const medplum = useMedplum();
  const navigate = useNavigate();
  const [turns, setTurns] = useState<BookingChatTurn[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [agentState, setAgentState] = useState<BookingAgentState>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  async function handleSend(message: string): Promise<void> {
    setSending(true);
    setError(undefined);
    setTurns((previous) => [...previous, { kind: 'patient', text: message }]);
    try {
      const input: BookingChatInput = { patientId: patientId as string, message, sessionId };
      const result = await executeAction<BookingChatInput, BookingChatResult>(medplum, 'agent-booking-chat', input);
      setSessionId(result.sessionId);
      if (result.kind === 'question' || result.kind === 'error') {
        setTurns((previous) => [...previous, { kind: 'agent-question', text: result.reply }]);
      } else {
        setTurns((previous) => [...previous, { kind: 'agent-options', options: result.options }]);
        setAgentState(optionsReceived({ options: result.options, summaryCommunicationId: result.summaryCommunicationId }));
      }
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setSending(false);
    }
  }

  function handleSelectOption(option: BookableOption): void {
    if (!agentState) return;
    setAgentState(optionSelected(agentState, option));
  }

  async function handleBookingConfirmation(): Promise<void> {
    if (!agentState) return;
    let bookingState: BookingInProgressState | undefined;
    try {
      setError(undefined);
      const nextState = await confirmSelectedOption(agentState, patientId as string, {
        book: (input) => executeAction<BookInput, BookResult>(medplum, 'agent-book-appointment', input),
        navigate: (path) => navigate(path),
        onBookingStarted: (state) => {
          bookingState = state;
          setAgentState(state);
        },
      });
      setAgentState(nextState);
    } catch (err) {
      setError(normalizeErrorString(err));
      if (bookingState) {
        setAgentState({ ...bookingState, phase: 'confirming' });
      }
    }
  }

  const selectedOption = agentState?.selectedOption;

  return (
    <Document width={800}>
      <Stack>
        <Title order={1}>Patient History</Title>
        <PatientSummary patient={{ reference: `Patient/${patientId}` }} />
        <EncounterHistoryList patientId={patientId as string} />
        {error && <Alert color="red">{error}</Alert>}
        {agentState?.slotTaken && (
          <Alert color="yellow">That appointment was just taken. Please choose one of the remaining options.</Alert>
        )}
        {(agentState?.phase === 'confirming' || agentState?.phase === 'booking') && selectedOption && (
          <Card withBorder>
            <Stack>
              <BookableOptionDetails option={selectedOption} />
              <Text>This appointment has not been booked yet. Do you confirm the booking?</Text>
              <Button loading={agentState.phase === 'booking'} onClick={handleBookingConfirmation}>
                Confirm booking
              </Button>
            </Stack>
          </Card>
        )}
        {agentState?.phase !== 'confirming' && agentState?.phase !== 'booking' && (
          <BookingChat turns={turns} onSend={handleSend} sending={sending} onSelectOption={handleSelectOption} />
        )}
      </Stack>
    </Document>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/pages/agent/PatientHistoryPage.contract.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: no errors. Fix any import/prop mismatches surfaced between `BookingChat.tsx` (Task 10) and this page (e.g. exact `BookableOptionDetails` export name from `BookableOptionCard.tsx` — confirm it matches before proceeding).

- [ ] **Step 6: Commit**

```bash
git add src/pages/agent/PatientHistoryPage.tsx src/pages/agent/PatientHistoryPage.contract.test.ts
git commit -m "feat: wire BookingChat into PatientHistoryPage, replacing the single-shot complaint form"
```

---

### Task 14: Remove the replaced bots, form, and prompts; final regression pass

**Files:**
- Delete: `src/bots/agent/agent-intake.ts`, `src/bots/agent/agent-intake.test.ts`
- Delete: `src/bots/agent/agent-find-bookable-options.ts`, `src/bots/agent/agent-find-bookable-options.test.ts`
- Delete: `src/components/agent/ComplaintForm.tsx`
- Modify: `api/execute.ts`, `api/execute.test.ts`
- Modify: `src/scripts/deploy-bots.ts`
- Modify: `src/bots/agent/lib/prompts.ts`, `src/bots/agent/lib/prompts.test.ts`
- Modify: `src/bots/agent/lib/schedulingPreferences.ts` usage check (delete if now unused — see Step 4)

- [ ] **Step 1: Preserve any pre-existing uncommitted edits on the two intake files, then delete**

Before touching these two files, check whether either already has uncommitted changes from outside this plan:

```bash
git status --short src/bots/agent/agent-intake.ts src/bots/agent/agent-intake.test.ts
```

If that prints anything, those are pre-existing edits unrelated to this plan. Commit them as-is first, in their own
commit, so nothing is lost when the files are deleted next:

```bash
git add src/bots/agent/agent-intake.ts src/bots/agent/agent-intake.test.ts
git commit -m "chore: snapshot pre-existing agent-intake edits before removal"
```

If `git status --short` printed nothing, skip straight to deleting. Either way, now delete:

```bash
git rm src/bots/agent/agent-intake.ts src/bots/agent/agent-intake.test.ts
git rm src/bots/agent/agent-find-bookable-options.ts src/bots/agent/agent-find-bookable-options.test.ts
git rm src/components/agent/ComplaintForm.tsx
```

- [ ] **Step 2: Remove their wiring from `api/execute.ts`**

Remove the `agentIntakeHandler`/`IntakeInput` and `agentFindBookableOptionsHandler`/`FindBookableOptionsInput` imports.
Remove `'agent-intake'` and `'agent-find-bookable-options'` from `ALLOWED_ACTIONS`, `GEMINI_ACTIONS`, and `HANDLERS`.

- [ ] **Step 3: Update `api/execute.test.ts`**

Replace every occurrence of the literal `'agent-intake'` with `'agent-booking-chat'` throughout the file (it was always
used only as a generic example action name to exercise the dispatch framework — auth, content-type, error handling —
never agent-intake's real business logic, so this is a safe mechanical substitution). Then fix the two assertions that
enumerate actions by name:

```ts
// was: expect(ALLOWED_ACTIONS).toContain('agent-find-bookable-options');
expect(ALLOWED_ACTIONS).toContain('agent-booking-chat');
```

```ts
// was: test.each(['agent-intake', 'agent-find-bookable-options', 'agent-patient-chat'] as const)(...)
test.each(['agent-booking-chat', 'agent-patient-chat'] as const)(
```

(That second `test.each` — the "passes GEMINI_API_KEY only to %s" test — is the one place `'agent-intake'` should not
simply become `'agent-booking-chat'` via the blanket substitution above, since it needs the corrected two-item list, not
a duplicate. Do this edit explicitly after the blanket substitution.)

- [ ] **Step 4: Remove now-dead prompt and preference-normalization code**

In `src/bots/agent/lib/prompts.ts`, delete `INTAKE_SYSTEM_PROMPT` and `buildIntakeUserPrompt` (their only caller,
`agent-intake.ts`, no longer exists). In `src/bots/agent/lib/prompts.test.ts`, delete the two tests
`'intake prompt instructs the model to never diagnose'` and
`'intake prompt limits routing and scheduling preferences to the approved contract'` (lines ~198–213), and remove
`INTAKE_SYSTEM_PROMPT` from that file's imports.

Run: `grep -rn "normalizeSchedulingPreferences" src api tools --include=*.ts` — confirm it now has zero non-test
references (its only caller, `agent-intake.ts`, is deleted). If confirmed unused, delete
`normalizeSchedulingPreferences` from `src/bots/agent/lib/schedulingPreferences.ts` and its corresponding test(s) from
`src/bots/agent/lib/schedulingPreferences.test.ts`, keeping `timeOfDayAt` (still used by `bookableOptions.ts`) and its
tests intact.

- [ ] **Step 5: Remove their entry from `src/scripts/deploy-bots.ts`**

Remove the `agent-intake` entry from the `Bots` array (the `agent-booking-chat` entry added in Task 8 replaces it;
`agent-find-bookable-options` was never in this list, so there is nothing to remove for it there).

- [ ] **Step 6: Run the full verification suite**

Run each of these and confirm every one is clean before proceeding:

```bash
npx tsc --noEmit
npm run lint
npx vitest run
npm run build
```

Expected: zero TypeScript errors, zero ESLint errors, all tests pass, and the production build succeeds. If any test
still references a deleted export (e.g. a stray import of `agent-intake` or `ComplaintForm` left over anywhere), fix
that file before moving on — do not skip or `.skip()` a failing test.

- [ ] **Step 7: Manual smoke test**

Run: `npm run dev:full`, open `http://localhost:3000/agent/:patientId` for a seeded patient, and walk through: send an
ambiguous complaint (confirm a clarifying question appears as a chat turn), answer it, confirm options render as
`BookableOptionCard`s, select one, confirm booking, and confirm the booking-confirmation page renders correctly. This
exercises the real Gemini call end-to-end — the one path the earlier automated tests necessarily mock.

- [ ] **Step 8: Commit**

This repo may have unrelated pre-existing uncommitted changes from outside this plan (check with `git status --short`
first). Do not use `git add -A` here — stage only this task's own files by exact path:

```bash
git add api/execute.ts api/execute.test.ts src/scripts/deploy-bots.ts \
  src/bots/agent/lib/prompts.ts src/bots/agent/lib/prompts.test.ts
# Only if Step 4 also removed normalizeSchedulingPreferences:
git add src/bots/agent/lib/schedulingPreferences.ts src/bots/agent/lib/schedulingPreferences.test.ts
git commit -m "refactor: remove agent-intake and agent-find-bookable-options, now replaced by agent-booking-chat"
```

(The deletions from Step 1 are already staged from `git rm` and will be included automatically.)

---

## Self-Review Notes

- **Spec coverage:** Task 1 covers the design's flagged risk (tool-calling support). Tasks 4–7 cover ideas 1–3
  (loop, multi-turn clarification, replanning-via-reentry). Task 6 covers idea 4 (model-driven selection with a
  deterministic floor) and the raised 8-option cap. Tasks 9–10, 13 cover the doctor-desk-style chat UI requirement.
  Task 4 covers the persisted, full-context-resent-every-turn session requirement. Task 14 covers the design's
  "removed/deprecated code" section and closes the loop with a full regression pass.
- **Type consistency:** `BookingChatResult`'s `options` variant carries `summaryCommunicationId` (needed by
  `optionsReceived` and ultimately `agent-book-appointment`'s `BookInput`) — this was a gap in the original design
  doc's type sketch, corrected here and threaded consistently through Tasks 7, 11, and 13.
  `MAX_BOOKABLE_OPTIONS` is defined once (Task 6, `proposeOptions.ts`) and imported by the frontend (Task 11) rather
  than redefined, so the two layers cannot drift apart.
- **No placeholders:** every task's code steps are complete, runnable file contents or exact diffs — none of them
  say "add error handling" or "similar to Task N" without the actual code.
