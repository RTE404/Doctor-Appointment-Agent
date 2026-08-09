// src/bots/agent/agent-ensure-doctor.ts
import type { BotEvent, MedplumClient } from '@medplum/core';
import { ensurePractitionerAndSchedule } from './lib/ensurePractitionerAndSchedule.js';
import type { DoctorCandidate } from './lib/ranking.js';

export type EnsureDoctorInput = { npi: string; candidate?: DoctorCandidate };
export type EnsureDoctorResult = { practitionerId: string; scheduleId: string; healthcareServiceId: string };

export async function handler(medplum: MedplumClient, event: BotEvent<EnsureDoctorInput>): Promise<EnsureDoctorResult> {
  const { npi, candidate } = event.input;
  return ensurePractitionerAndSchedule(medplum, npi, candidate);
}
