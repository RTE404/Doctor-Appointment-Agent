// src/bots/agent/lib/geo.ts
import type { Patient } from '@medplum/fhirtypes';
import { ZIP3_CENTROIDS } from '../../../data/zip3-centroids';

const EARTH_RADIUS_MILES = 3958.8;
const GEOLOCATION_EXT_URL = 'http://hl7.org/fhir/StructureDefinition/geolocation';

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Standard Haversine formula. Pure function, no I/O. */
export function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

/**
 * Extracts a patient's coordinates from the geolocation extension — no zip
 * lookup needed, confirmed present on every Synthea-seeded patient. Returns
 * undefined if absent (a real-world patient with no geolocation extension);
 * caller falls back to zip3Centroid in that case.
 */
export function patientCoords(patient: Patient): { lat: number; lng: number } | undefined {
  const geoExt = patient.address?.[0]?.extension?.find((e) => e.url === GEOLOCATION_EXT_URL);
  const lat = geoExt?.extension?.find((e) => e.url === 'latitude')?.valueDecimal;
  const lng = geoExt?.extension?.find((e) => e.url === 'longitude')?.valueDecimal;
  if (lat === undefined || lng === undefined) {
    return undefined;
  }
  return { lat, lng };
}

/** Doctor-side coordinates (NPPES gives zip, not lat/lng). */
export function zip3Centroid(postalCode: string): { lat: number; lng: number } | undefined {
  return ZIP3_CENTROIDS[postalCode.slice(0, 3)];
}
