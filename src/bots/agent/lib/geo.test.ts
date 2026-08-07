// src/bots/agent/lib/geo.test.ts
import { describe, expect, test } from 'vitest';
import { haversineMiles, patientCoords, zip3Centroid } from './geo';
import type { Patient } from '@medplum/fhirtypes';

describe('haversineMiles', () => {
  test('distance between the same point is zero', () => {
    expect(haversineMiles({ lat: 40.7128, lng: -74.006 }, { lat: 40.7128, lng: -74.006 })).toBeCloseTo(0, 5);
  });

  test('NYC to LA is roughly 2445 miles', () => {
    const nyc = { lat: 40.7128, lng: -74.006 };
    const la = { lat: 34.0522, lng: -118.2437 };
    expect(haversineMiles(nyc, la)).toBeGreaterThan(2400);
    expect(haversineMiles(nyc, la)).toBeLessThan(2500);
  });
});

describe('patientCoords', () => {
  test('extracts lat/lng from the geolocation extension', () => {
    const patient: Patient = {
      resourceType: 'Patient',
      address: [
        {
          extension: [
            {
              url: 'http://hl7.org/fhir/StructureDefinition/geolocation',
              extension: [
                { url: 'latitude', valueDecimal: 42.35 },
                { url: 'longitude', valueDecimal: -71.06 },
              ],
            },
          ],
        },
      ],
    };
    expect(patientCoords(patient)).toStrictEqual({ lat: 42.35, lng: -71.06 });
  });

  test('returns undefined when the extension is absent', () => {
    expect(patientCoords({ resourceType: 'Patient' })).toBeUndefined();
  });
});

describe('zip3Centroid', () => {
  test('returns undefined for an unrecognized prefix', () => {
    expect(zip3Centroid('000')).toBeUndefined();
  });

  test('returns a coordinate for a real prefix', () => {
    // '100' is Manhattan, NY — must be present in the generated table
    expect(zip3Centroid('10001')).toBeDefined();
  });
});
