// src/bots/agent/lib/patientContext.ts
import type { MedplumClient } from '@medplum/core';
import type {
  AllergyIntolerance,
  Condition,
  Encounter,
  MedicationRequest,
  Organization,
  Patient,
  Practitioner,
  PractitionerRole,
} from '@medplum/fhirtypes';

export interface EncounterSummary {
  date: string;
  practitionerName: string;
  specialty: string;
  organizationName: string;
}

export interface PatientClinicalContext {
  patient: Patient;
  conditions: Condition[];
  medications: MedicationRequest[];
  allergies: AllergyIntolerance[];
  encounters: Encounter[];
  encounterSummaries: EncounterSummary[];
}

/**
 * The standardized "read everything relevant about this patient" query used
 * by agent-booking-chat to ground its scheduling context.
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
    medplum.searchResources('Encounter', { subject: `Patient/${patientId}`, _count: '50', _sort: '-date' }),
  ]);
  const encounterSummaries = await loadEncounterSummaries(medplum, [...encounters]);

  return {
    patient,
    conditions: [...conditions],
    medications: [...medications],
    allergies: [...allergies],
    encounters: [...encounters],
    encounterSummaries,
  };
}

/**
 * Resolves each encounter's practitioner name, specialty, and organization
 * name for prompt-friendly display. Batch-fetches the referenced
 * Practitioner/Organization/PractitionerRole resources directly by id rather
 * than relying on `_include` — deliberately, since specialty isn't on
 * Practitioner and needs its own PractitionerRole lookup regardless, and a
 * direct `_id` search is what MockClient (used throughout this project's
 * tests) actually implements.
 */
async function loadEncounterSummaries(medplum: MedplumClient, encounters: Encounter[]): Promise<EncounterSummary[]> {
  const practitionerIds = [
    ...new Set(encounters.map((e) => e.participant?.[0]?.individual?.reference?.split('/')[1]).filter((id): id is string => !!id)),
  ];
  const organizationIds = [
    ...new Set(encounters.map((e) => e.serviceProvider?.reference?.split('/')[1]).filter((id): id is string => !!id)),
  ];

  const [fetchedPractitioners, fetchedOrganizations, roles] = await Promise.all([
    practitionerIds.length ? medplum.searchResources('Practitioner', { _id: practitionerIds.join(',') }) : Promise.resolve([]),
    organizationIds.length ? medplum.searchResources('Organization', { _id: organizationIds.join(',') }) : Promise.resolve([]),
    practitionerIds.length
      ? medplum.searchResources('PractitionerRole', { practitioner: practitionerIds.map((id) => `Practitioner/${id}`).join(',') })
      : Promise.resolve([]),
  ]);
  const practitioners = new Map<string, Practitioner>(fetchedPractitioners.map((p) => [p.id as string, p]));
  const organizations = new Map<string, Organization>(fetchedOrganizations.map((o) => [o.id as string, o]));
  const specialtyByPractitionerId = new Map(
    (roles as PractitionerRole[]).map((r) => [
      r.practitioner?.reference?.split('/')[1],
      r.specialty?.[0]?.coding?.[0]?.display ?? r.specialty?.[0]?.coding?.[0]?.code,
    ])
  );

  return encounters.map((encounter) => {
    const practitionerId = encounter.participant?.[0]?.individual?.reference?.split('/')[1];
    const organizationId = encounter.serviceProvider?.reference?.split('/')[1];
    const practitioner = practitionerId ? practitioners.get(practitionerId) : undefined;
    return {
      date: encounter.period?.start?.slice(0, 10) || 'Unknown date',
      practitionerName: practitioner
        ? `Dr. ${practitioner.name?.[0]?.given?.join(' ') ?? ''} ${practitioner.name?.[0]?.family ?? ''}`.trim()
        : 'Unknown',
      specialty: (practitionerId && specialtyByPractitionerId.get(practitionerId)) || 'Unknown specialty',
      organizationName: (organizationId && organizations.get(organizationId)?.name) || 'Unknown organization',
    };
  });
}
