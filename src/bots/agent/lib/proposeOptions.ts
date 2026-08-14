// src/bots/agent/lib/proposeOptions.ts
import { normalizeLlmSpecialty } from '../../../config/specialties.js';
import { rankBookableOptions } from './bookableOptions.js';
import type { BookableOption } from './bookableOptions.js';
import type { BookingChatMessage } from './bookingSession.js';
import type { SchedulingPreferences, TimeOfDay } from './schedulingPreferences.js';

export const MAX_BOOKABLE_OPTIONS = 8;

export interface ProposeOptionsArgs {
  specialty: string;
  reason: string;
  summary: string;
  // Reported by the model, reflecting what it inferred from the patient —
  // used ONLY by the deterministic fallback below, never to override the
  // model's own picks. The model makes the real selection every time; this
  // is purely a floor for the cases where its picks need automatic correction.
  preferences?: { timeOfDay?: TimeOfDay; preferPreviousDoctor?: boolean; preferNearby?: boolean };
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
    return { ok: false, errorForModel: 'The proposed picks are not grounded in any prior check_availability result. Call check_availability again before proposing.' };
  }

  const distinctPicks = distinctByProvider(groundedPicks, MAX_BOOKABLE_OPTIONS);
  // The deterministic floor takes over in two cases (design doc, §"propose_options
  // validation and grounding"): the model proposed several slots for the same
  // provider (deduplication dropped something), OR it under-proposed — fewer
  // distinct providers than the pool could actually fill up to the cap.
  const availableProviderCount = new Set(groundedPool.map((option) => option.npi)).size;
  const fillableCount = Math.min(MAX_BOOKABLE_OPTIONS, availableProviderCount);
  const modelPicksSatisfyTheCap = distinctPicks.length === groundedPicks.length && distinctPicks.length >= fillableCount;
  const fallbackPreferences: SchedulingPreferences = {
    timeOfDay: args.preferences?.timeOfDay,
    preferPreviousDoctor: args.preferences?.preferPreviousDoctor ?? false,
    preferNearby: args.preferences?.preferNearby ?? false,
  };
  const options = modelPicksSatisfyTheCap
    ? distinctPicks
    : rankBookableOptions(groundedPool, fallbackPreferences, MAX_BOOKABLE_OPTIONS);

  return { ok: true, specialtyCode: specialtyDef.nuccCode, reason: args.reason, summary: args.summary, options };
}
