// src/bots/agent/lib/prompts.test.ts
import type {
  AllergyIntolerance,
  Condition,
  Encounter,
  MedicationRequest,
  Observation,
  Organization,
  Patient,
  Practitioner,
} from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { SPECIALTY_TABLE, normalizeLlmSpecialty } from '../../../config/specialties';
import { BOOKING_CHAT_SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT, buildChatUserPrompt, buildPatientContextMessage, containsInterpretationLanguage } from './prompts';

describe('buildChatUserPrompt', () => {
  test('includes complete demographics, a hand-checked age, and full resources of every type', () => {
    const patient: Patient = {
      resourceType: 'Patient',
      id: 'patient-1',
      active: true,
      identifier: [{ system: 'http://example.com/mrn', value: 'MRN-1001' }],
      name: [{ use: 'official', given: ['Asha', 'Mira'], family: 'Rao' }],
      telecom: [
        { system: 'phone', value: '+1-617-555-0100', use: 'mobile' },
        { system: 'email', value: 'asha@example.test' },
      ],
      gender: 'female',
      birthDate: '1990-05-20',
      address: [
        {
          line: ['10 Main Street'],
          city: 'Boston',
          state: 'MA',
          postalCode: '02108',
          country: 'US',
          extension: [
            {
              url: 'http://hl7.org/fhir/StructureDefinition/geolocation',
              extension: [
                { url: 'latitude', valueDecimal: 42.3601 },
                { url: 'longitude', valueDecimal: -71.0589 },
              ],
            },
          ],
        },
      ],
      maritalStatus: { text: 'Married' },
      communication: [{ language: { text: 'English' }, preferred: true }],
      contact: [{ relationship: [{ text: 'Emergency contact' }], name: { text: 'Ravi Rao' } }],
      generalPractitioner: [{ reference: 'Practitioner/practitioner-1', display: 'Dr. Lin' }],
      managingOrganization: { reference: 'Organization/organization-1', display: 'Central Clinic' },
      extension: [{ url: 'http://example.com/fhir/patient-note', valueString: 'Synthetic patient' }],
    };
    const condition: Condition = {
      resourceType: 'Condition',
      id: 'condition-1',
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
      subject: { reference: 'Patient/patient-1' },
      code: { coding: [{ system: 'http://snomed.info/sct', code: '195967001', display: 'Asthma' }], text: 'Asthma' },
      onsetDateTime: '2008-03-04',
    };
    const medication: MedicationRequest = {
      resourceType: 'MedicationRequest',
      id: 'medication-1',
      status: 'active',
      intent: 'order',
      subject: { reference: 'Patient/patient-1' },
      medicationCodeableConcept: {
        coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: '435', display: 'Albuterol' }],
        text: 'Albuterol',
      },
      dosageInstruction: [{ text: 'Two puffs as needed' }],
    };
    const allergy: AllergyIntolerance = {
      resourceType: 'AllergyIntolerance',
      id: 'allergy-1',
      patient: { reference: 'Patient/patient-1' },
      clinicalStatus: {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }],
      },
      code: { text: 'Peanuts' },
      reaction: [{ manifestation: [{ text: 'Hives' }] }],
    };
    const encounter: Encounter = {
      resourceType: 'Encounter',
      id: 'encounter-1',
      status: 'finished',
      class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
      subject: { reference: 'Patient/patient-1' },
      type: [{ text: 'Office visit' }],
      period: { start: '2026-06-01T09:00:00Z', end: '2026-06-01T09:30:00Z' },
      participant: [{ individual: { reference: 'Practitioner/practitioner-1', display: 'Dr. Lin' } }],
      serviceProvider: { reference: 'Organization/organization-1', display: 'Central Clinic' },
    };
    const practitioner: Practitioner = {
      resourceType: 'Practitioner',
      id: 'practitioner-1',
      identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }],
      name: [{ text: 'Dr. Mei Lin' }],
      telecom: [{ system: 'phone', value: '+1-617-555-0199', use: 'work' }],
      qualification: [{ code: { text: 'Internal Medicine' } }],
    };
    const organization: Organization = {
      resourceType: 'Organization',
      id: 'organization-1',
      name: 'Central Clinic',
      telecom: [{ system: 'phone', value: '+1-617-555-0111', use: 'work' }],
      address: [{ line: ['20 Clinic Way'], city: 'Boston', state: 'MA', postalCode: '02108' }],
    };
    const observation: Observation = {
      resourceType: 'Observation',
      id: 'observation-1',
      status: 'final',
      code: { text: 'Body height' },
      subject: { reference: 'Patient/patient-1' },
      effectiveDateTime: '2026-07-01',
      valueQuantity: { value: 170, unit: 'cm', system: 'http://unitsofmeasure.org', code: 'cm' },
    };

    const prompt = buildChatUserPrompt(
      { patient, resources: [observation, organization, encounter, patient, allergy, practitioner, medication, condition] },
      'What is her complete recorded profile?',
      new Date('2026-08-10T00:00:00.000Z')
    );

    expect(prompt).toContain('"patientReference": "Patient/patient-1"');
    expect(prompt).toContain('"ageYears": 36');
    expect(prompt).toContain('"value": "MRN-1001"');
    expect(prompt).toContain('"value": "+1-617-555-0100"');
    expect(prompt).toContain('"value": "asha@example.test"');
    expect(prompt).toContain('"gender": "female"');
    expect(prompt).toContain('"city": "Boston"');
    expect(prompt).toContain('"valueDecimal": 42.3601');
    expect(prompt).toContain('"text": "Ravi Rao"');
    expect(prompt).toContain('"display": "Dr. Lin"');
    expect(prompt).toContain('"display": "Central Clinic"');
    expect(prompt).toContain('"onsetDateTime": "2008-03-04"');
    expect(prompt).toContain('"text": "Two puffs as needed"');
    expect(prompt).toContain('"text": "Hives"');
    expect(prompt).toContain('"start": "2026-06-01T09:00:00Z"');
    expect(prompt).toContain('"text": "Dr. Mei Lin"');
    expect(prompt).toContain('"text": "Internal Medicine"');
    expect(prompt).toContain('"20 Clinic Way"');
    expect(prompt).toContain('"Observation"');
    expect(prompt).toContain('"value": 170');
    expect(prompt).toContain('Doctor\'s question: "What is her complete recorded profile?"');
  });

  test('does not fabricate an exact age from a partial FHIR birth date', () => {
    const patient: Patient = { resourceType: 'Patient', id: 'patient-1', birthDate: '1990' };

    const prompt = buildChatUserPrompt(
      { patient, resources: [patient] },
      'How old is the patient?',
      new Date('2026-08-10T00:00:00.000Z')
    );

    expect(prompt).toContain('"birthDate": "1990"');
    expect(prompt).toContain('"ageYears": null');
  });

  test('rejects an over-budget final prompt instead of returning truncated patient data', () => {
    const patient: Patient = { resourceType: 'Patient', id: 'patient-1', name: [{ text: 'Sensitive Patient' }] };
    let thrown: unknown;

    try {
      buildChatUserPrompt(
        { patient, resources: [patient] },
        'Sensitive question marker',
        new Date('2026-08-10T00:00:00.000Z'),
        64
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Complete patient chat prompt exceeded the byte limit');
    expect((thrown as Error).message).not.toContain('Sensitive Patient');
    expect((thrown as Error).message).not.toContain('Sensitive question marker');
  });

  test('measures the final prompt budget in UTF-8 bytes rather than string code units', () => {
    const patient: Patient = { resourceType: 'Patient', id: 'patient-1' };

    expect(() =>
      buildChatUserPrompt(
        { patient, resources: [patient] },
        'é',
        new Date('2026-08-10T00:00:00.000Z'),
        664
      )
    ).toThrow('Complete patient chat prompt exceeded the byte limit');
  });
});

describe('system prompts', () => {

  test('chat prompt binds direct lookup to one selected record and requires the exact broad refusal', () => {
    expect(CHAT_SYSTEM_PROMPT.toLowerCase()).toContain('never diagnose');
    expect(CHAT_SYSTEM_PROMPT.toLowerCase()).toContain('interpret findings');
    expect(CHAT_SYSTEM_PROMPT.toLowerCase()).toContain('suggest treatment or medication changes');
    expect(CHAT_SYSTEM_PROMPT.toLowerCase()).toContain('give a prognosis');
    expect(CHAT_SYSTEM_PROMPT.toLowerCase()).toContain('any other form of clinical advice');
    expect(CHAT_SYSTEM_PROMPT).toContain('complete available record for exactly one selected patient');
    expect(CHAT_SYSTEM_PROMPT).toContain('direct record lookup only');
    expect(CHAT_SYSTEM_PROMPT).toContain(
      'If asked for any of that, respond exactly with:\n' +
        '"I can only relay information from the patient\'s record \u2014 for clinical interpretation, please consult the record directly."'
    );
    expect(CHAT_SYSTEM_PROMPT.toLowerCase()).toContain('not recorded');
  });
});

describe('containsInterpretationLanguage', () => {
  test('flags common interpretation-flavored phrases', () => {
    expect(containsInterpretationLanguage('You should see a specialist soon.')).toBe(true);
    expect(containsInterpretationLanguage('I recommend increasing the dosage.')).toBe(true);
    expect(containsInterpretationLanguage('This likely has a viral cause.')).toBe(true);
  });

  test('does not flag a plain factual relay', () => {
    expect(containsInterpretationLanguage('The record shows a prescription for Albuterol, filled on 2026-01-05.')).toBe(false);
  });
});

describe('booking chat prompts', () => {
  test('system prompt instructs the model to never diagnose and to ground every pick in tool results', () => {
    const prompt = BOOKING_CHAT_SYSTEM_PROMPT.toLowerCase();
    expect(prompt).toContain('never diagnose');
    expect(prompt).toContain('does not triage');
    expect(prompt).toContain('check_availability');
    expect(prompt).toContain('propose_options');
    expect(prompt).toContain('ask_clarifying_question');
  });

  test('system prompt grounds the specialty vocabulary: every supported label and its exact NUCC code', () => {
    // The search tools require an exact NUCC code and propose_options requires
    // a label normalizeLlmSpecialty accepts. Without the table in the prompt
    // the model has to recall both from training data, and a wrong code makes
    // search_nppes fail with no usable signal.
    for (const specialty of SPECIALTY_TABLE) {
      expect(BOOKING_CHAT_SYSTEM_PROMPT).toContain(specialty.label);
      expect(BOOKING_CHAT_SYSTEM_PROMPT).toContain(specialty.nuccCode);
    }
  });

  test('every label listed in the system prompt round-trips through normalizeLlmSpecialty', () => {
    // Guards the two-vocabulary trap: propose_options takes labels, the search
    // tools take codes, and the prompt must never advertise a label the
    // validator would reject.
    for (const specialty of SPECIALTY_TABLE) {
      expect(normalizeLlmSpecialty(specialty.label)?.nuccCode).toBe(specialty.nuccCode);
    }
  });

  test('buildPatientContextMessage summarizes conditions, medications, and allergies', () => {
    const message = buildPatientContextMessage({
      patient: { resourceType: 'Patient' },
      conditions: [{ resourceType: 'Condition', subject: { reference: 'Patient/test' }, code: { text: 'Asthma' } }],
      medications: [{ resourceType: 'MedicationRequest', status: 'active', intent: 'order', subject: { reference: 'Patient/test' }, medicationCodeableConcept: { text: 'Albuterol' } }],
      allergies: [{ resourceType: 'AllergyIntolerance', patient: { reference: 'Patient/test' }, code: { text: 'Penicillin' } }],
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
