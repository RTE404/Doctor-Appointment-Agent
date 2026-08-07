// src/bots/agent/lib/patientContext.ts
import type { MedplumClient } from '@medplum/core';
import type { AllergyIntolerance, Condition, Encounter, MedicationRequest, Patient } from '@medplum/fhirtypes';

export interface PatientClinicalContext {
  patient: Patient;
  conditions: Condition[];
  medications: MedicationRequest[];
  allergies: AllergyIntolerance[];
  encounters: Encounter[];
}

/**
 * The one standardized "read everything relevant about this patient" query,
 * shared by agent-intake and agent-patient-chat so both bots ground
 * themselves against the same depth of data.
 */
export async function loadPatientClinicalContext(
  medplum: MedplumClient,
  patientId: string
): Promise<PatientClinicalContext> {
  const [patient, conditions, medications, allergies, encounters] = await Promise.all([
    medplum.readResource('Patient', patientId),
    medplum.searchResources('Condition', { subject: `Patient/${patientId}`, _count: '50', _sort: '-recorded-date' }),
    medplum.searchResources('MedicationRequest', { subject: `Patient/${patientId}`, _count: '50', _sort: '-authoredon' }),
    medplum.searchResources('AllergyIntolerance', { patient: `Patient/${patientId}`, _count: '50' }),
    medplum.searchResources('Encounter', {
      subject: `Patient/${patientId}`,
      _include: 'Encounter:practitioner',
      _count: '50',
      _sort: '-date',
    }),
  ]);

  return {
    patient,
    conditions: [...conditions],
    medications: [...medications],
    allergies: [...allergies],
    encounters: [...encounters],
  };
}
