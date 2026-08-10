import type { BotEvent, MedplumClient } from '@medplum/core';
import type { Bundle, Patient, Resource } from '@medplum/fhirtypes';
import { describe, expect, test, vi } from 'vitest';
import { __setGeminiCallerForTests, handler, type ChatInput } from './agent-patient-chat';

describe('agent-patient-chat complete patient grounding', () => {
  test('sends complete demographics and an additional FHIR resource type to Gemini after relationship verification', async () => {
    const patient: Patient = {
      resourceType: 'Patient',
      id: 'patient-1',
      name: [{ given: ['Asha'], family: 'Rao' }],
      gender: 'female',
      birthDate: '1990-05-20',
      address: [{ city: 'Boston', state: 'MA', country: 'US' }],
    };
    const everythingBundle: Bundle = {
      resourceType: 'Bundle',
      type: 'searchset',
      entry: [
        { resource: patient },
        {
          resource: {
            resourceType: 'Observation',
            id: 'observation-1',
            status: 'final',
            code: { text: 'Body height' },
            subject: { reference: 'Patient/patient-1' },
            valueQuantity: { value: 170, unit: 'cm' },
          },
        },
      ],
    };
    const created: Resource[] = [];
    const medplum = {
      fhirUrl: (...path: string[]) => new URL(`/fhir/R4/${path.join('/')}`, 'https://api.example.test'),
      get: vi.fn(async () => everythingBundle),
      readResource: vi.fn(async () => patient),
      searchResources: vi.fn(async (resourceType: string) =>
        resourceType === 'Practitioner'
          ? [
              {
                resourceType: 'Practitioner',
                id: 'practitioner-1',
                identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' }],
              },
            ]
          : []
      ),
      searchOne: vi.fn(async (resourceType: string) => {
        if (resourceType === 'Appointment') {
          return { resourceType: 'Appointment', id: 'appointment-1', status: 'booked', participant: [] };
        }
        if (resourceType === 'Device') {
          return { resourceType: 'Device', id: 'device-1' };
        }
        return undefined;
      }),
      createResource: vi.fn(async (resource: Resource) => {
        const createdResource = { ...resource, id: `created-${created.length + 1}` } as Resource;
        created.push(createdResource);
        return createdResource;
      }),
    } as unknown as MedplumClient;
    let capturedUserPrompt = '';
    __setGeminiCallerForTests(async (_apiKey, _systemPrompt, userPrompt) => {
      capturedUserPrompt = userPrompt;
      return 'The record lists Asha Rao, female, living in Boston.';
    });

    const event: BotEvent<ChatInput> = {
      bot: { reference: 'Bot/123' },
      input: {
        npi: '1234567890',
        patientId: 'patient-1',
        question: 'What is the patient name, gender, and location?',
      },
      contentType: 'application/json',
      secrets: { GEMINI_API_KEY: { name: 'GEMINI_API_KEY', valueString: 'test-key' } },
    };

    const result = await handler(medplum, event);

    expect(result.answer).toBe('The record lists Asha Rao, female, living in Boston.');
    expect(capturedUserPrompt).toContain('"Asha"');
    expect(capturedUserPrompt).toContain('"family": "Rao"');
    expect(capturedUserPrompt).toContain('"gender": "female"');
    expect(capturedUserPrompt).toContain('"city": "Boston"');
    expect(capturedUserPrompt).toContain('"Observation"');
    expect(capturedUserPrompt).toContain('"value": 170');
    expect(capturedUserPrompt).not.toContain('test-key');
    expect(created).toHaveLength(2);
  });
});
