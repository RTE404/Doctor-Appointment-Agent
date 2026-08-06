// tools/seed/specialty-resolver.ts
import { parseDiseaseDescriptions } from './disease-csv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// ESM has no __dirname; this is the standard replacement (matches index.ts's Task 9 fix).
// This module is imported transitively (index.ts -> pass1-scan.ts -> specialty-resolver.ts)
// and runs its DISEASE_NAMES lookup at import time, so a bare __dirname here crashes the
// whole CLI before any seed logic executes.
const __dirname = dirname(fileURLToPath(import.meta.url));

// Ported VERBATIM (by row order, not by guessing) from the retired Python
// specialty_mapping.py's SPECIALTIES_IN_FILE_ORDER — a correction pass
// caught that an earlier version of this array was invented without
// actually reading Disease_Description.csv's real row order, producing
// nonsense pairings (Drug Reaction -> Cardiology, Malaria -> Pulmonology).
// This array's row order matches the CSV exactly; each comment is the
// disease name at that row, kept so a future re-check doesn't have to
// cross-reference two files by hand.
const DISEASE_SPECIALTIES: string[] = [
  'Allergy and Immunology',  // Drug Reaction
  'Infectious Disease',      // Malaria
  'Allergy and Immunology',  // Allergy
  'Endocrinology',           // Hypothyroidism
  'Dermatology',             // Psoriasis
  'Gastroenterology',        // GERD
  'Gastroenterology',        // Chronic cholestasis
  'Gastroenterology',        // hepatitis A
  'Orthopedics',             // Osteoarthristis
  'Otolaryngology',          // (vertigo) Paroymsal Positional Vertigo
  'Endocrinology',           // Hypoglycemia
  'Dermatology',             // Acne
  'Endocrinology',           // Diabetes
  'Dermatology',             // Impetigo
  'Cardiology',              // Hypertension
  'Gastroenterology',        // Peptic ulcer diseae
  'General Surgery',         // Dimorphic hemorrhoids(piles)
  'General Practice',        // Common Cold
  'Infectious Disease',      // Chicken pox
  'Orthopedics',             // Cervical spondylosis
  'Endocrinology',           // Hyperthyroidism
  'Urology',                 // Urinary tract infection
  'Vascular Surgery',        // Varicose veins
  'Infectious Disease',      // AIDS
  'Neurology',                // Paralysis (brain hemorrhage)
  'Infectious Disease',      // Typhoid
  'Gastroenterology',        // Hepatitis B
  'Dermatology',             // Fungal infection
  'Gastroenterology',        // Hepatitis C
  'Neurology',                // Migraine
  'Pulmonology',              // Bronchial Asthma
  'Gastroenterology',        // Alcoholic hepatitis
  'Gastroenterology',        // Jaundice
  'Gastroenterology',        // Hepatitis E
  'Infectious Disease',      // Dengue
  'Gastroenterology',        // Hepatitis D
  'Cardiology',               // Heart attack
  'Pulmonology',               // Pneumonia
  'Rheumatology',              // Arthritis
  'Gastroenterology',         // Gastroenteritis
  'Pulmonology',               // Tuberculosis
];

const DISEASE_NAMES = parseDiseaseDescriptions(join(__dirname, '../../Disease_Description.csv'));

if (DISEASE_NAMES.length !== DISEASE_SPECIALTIES.length) {
  throw new Error(
    `Disease_Description.csv has ${DISEASE_NAMES.length} rows but DISEASE_SPECIALTIES has ` +
      `${DISEASE_SPECIALTIES.length} entries — they must stay in lockstep. Update DISEASE_SPECIALTIES.`
  );
}

/** disease name (from Disease_Description.csv) -> specialty. Tier 1's match target. */
export const SPECIALTY_MAP: Map<string, string> = new Map(
  DISEASE_NAMES.map((name, i) => [name, DISEASE_SPECIALTIES[i]])
);

/**
 * Encounter.type[].text -> specialty. Tier 2's match target.
 *
 * Covers all 49 distinct values actually present in this repo's fhir/ corpus, as
 * enumerated by running Step 1's enumeration script (see task-4-report.md for the
 * full printed list and COUNT: 49 confirmation) — verified by
 * specialty-resolver.test.ts's completeness test, which checks
 * ENCOUNTER_TYPE_SPECIALTY_MAP.has(text) for each of those 49 exact strings.
 *
 * One extra entry, 'Well child visit' (no "(procedure)" suffix), is included beyond
 * those 49: it is NOT a real corpus value (the real value is 'Well child visit
 * (procedure)', which is separately mapped below) but is required verbatim by
 * specialty-resolver.test.ts's fixed tier-2 behavioral test
 * (`resolveSpecialty([], ['Well child visit'])` must return 'Pediatrics'), and
 * resolveSpecialty's substring match only succeeds when a map key is a substring
 * of the input text — the longer, real '(procedure)' key does not match the
 * shorter test string. So this map intentionally has 50 entries, not 49.
 */
export const ENCOUNTER_TYPE_SPECIALTY_MAP: Map<string, string> = new Map([
  // --- Surgical admissions ---
  ['Admission to surgical department', 'General Surgery'],
  ['Admission to thoracic surgery department', 'General Surgery'],
  ['Postoperative follow-up visit (procedure)', 'General Surgery'],
  ['Non-urgent orthopedic admission', 'Orthopedics'],

  // --- Allergy / Immunology ---
  ['Allergic disorder follow-up assessment', 'Allergy and Immunology'],
  ['Allergic disorder initial assessment', 'Allergy and Immunology'],

  // --- Pulmonology (asthma) ---
  ['Asthma follow-up', 'Pulmonology'],
  ['Emergency hospital admission for asthma', 'Pulmonology'],

  // --- Cardiology ---
  ['Cardiac Arrest', 'Cardiology'],
  ['Hypertension follow-up encounter', 'Cardiology'],
  ['Myocardial Infarction', 'Cardiology'],

  // --- Neurology ---
  ['Stroke', 'Neurology'],

  // --- Psychiatry ---
  ['Drug rehabilitation and detoxification', 'Psychiatry'],
  ['Initial Psychiatric Interview with mental status evaluation', 'Psychiatry'],
  ['posttraumatic stress disorder', 'Psychiatry'],

  // --- Obstetrics and Gynecology ---
  ['Gynecology service (qualifier value)', 'Obstetrics and Gynecology'],
  ['Obstetric emergency hospital admission', 'Obstetrics and Gynecology'],
  ['Postnatal visit', 'Obstetrics and Gynecology'],
  ['Prenatal initial visit', 'Obstetrics and Gynecology'],
  ['Prenatal visit', 'Obstetrics and Gynecology'],

  // --- Pediatrics ---
  ['Well child visit (procedure)', 'Pediatrics'],
  ['Well child visit', 'Pediatrics'], // synthetic short form; see doc comment above — not a real corpus value

  // --- General Practice (generic/administrative encounter kinds with no specialty signal) ---
  ['Consultation for treatment', 'General Practice'],
  ['Death Certification', 'General Practice'],
  ['Discussion about treatment (procedure)', 'General Practice'],
  ['Domiciliary or rest home patient evaluation and management', 'General Practice'],
  ['Emergency Encounter', 'General Practice'],
  ['Emergency Room Admission', 'General Practice'],
  ['Emergency room admission (procedure)', 'General Practice'],
  ['Encounter Inpatient', 'General Practice'],
  ["Encounter for 'check-up'", 'General Practice'],
  ['Encounter for Problem', 'General Practice'],
  ['Encounter for check up (procedure)', 'General Practice'],
  ['Encounter for problem', 'General Practice'],
  ['Encounter for problem (procedure)', 'General Practice'],
  ['Encounter for symptom', 'General Practice'],
  ['Encounter for symptom (procedure)', 'General Practice'],
  ['Follow-up encounter', 'General Practice'],
  ['Follow-up visit (procedure)', 'General Practice'],
  ['General examination of patient (procedure)', 'General Practice'],
  ['Hospital admission', 'General Practice'],
  ['Inpatient stay (finding)', 'General Practice'],
  ['Office Visit', 'General Practice'],
  ['Outpatient procedure', 'General Practice'],
  ['Patient encounter procedure', 'General Practice'],
  ['Patient-initiated encounter', 'General Practice'],
  ['Periodic reevaluation and management of healthy individual (procedure)', 'General Practice'],
  ['Screening surveillance (regime/therapy)', 'General Practice'],
  ['Telephone encounter (procedure)', 'General Practice'],
  ['Urgent care clinic (procedure)', 'General Practice'],
]);

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

function matchAgainstMap(texts: string[], map: Map<string, string>): string | undefined {
  for (const text of texts) {
    const normalizedText = normalize(text);
    for (const [key, specialty] of map) {
      if (normalizedText.includes(normalize(key))) {
        return specialty;
      }
    }
  }
  return undefined;
}

/**
 * Tiered specialty matcher. Tier 1: substring-match reasonTexts (from
 * Encounter.reasonCode[].coding[].display + linked Condition.code.text)
 * against SPECIALTY_MAP. Tier 2: substring-match typeTexts (from
 * Encounter.type[].text) against ENCOUNTER_TYPE_SPECIALTY_MAP. Tier 3:
 * 'General Practice'. Tier 1 always takes priority when both would match.
 */
export function resolveSpecialty(reasonTexts: string[], typeTexts: string[]): string {
  return matchAgainstMap(reasonTexts, SPECIALTY_MAP) ?? matchAgainstMap(typeTexts, ENCOUNTER_TYPE_SPECIALTY_MAP) ?? 'General Practice';
}

/**
 * Real NUCC provider taxonomy codes for every specialty label this resolver
 * can produce. Deliberately duplicated from (not imported from)
 * `src/config/specialties.ts`'s `SPECIALTY_TABLE` — `tools/seed/` stays a
 * fully standalone CLI with no dependency on `src/` (Backend doc's module
 * boundary), and this module's own specialty vocabulary is a strict subset
 * of that table's, kept in sync by the completeness test below rather than
 * a shared import. Codes are the same NUCC registry either way.
 */
export const SPECIALTY_NUCC_CODES: Record<string, string> = {
  'Allergy and Immunology': '207K00000X',
  Cardiology: '207RC0000X',
  Dermatology: '207N00000X',
  Endocrinology: '207RE0101X',
  Gastroenterology: '207RG0100X',
  'General Practice': '208D00000X',
  'General Surgery': '208600000X',
  'Infectious Disease': '207RI0200X',
  Neurology: '2084N0400X',
  'Obstetrics and Gynecology': '207V00000X',
  Orthopedics: '207X00000X',
  Otolaryngology: '207Y00000X',
  Pediatrics: '208000000X',
  Psychiatry: '2084P0800X',
  Pulmonology: '207RP1001X',
  Rheumatology: '207RR0500X',
  Urology: '208800000X',
  'Vascular Surgery': '2086S0129X',
};

/** Every label DISEASE_SPECIALTIES/ENCOUNTER_TYPE_SPECIALTY_MAP can produce, for the completeness test. */
export function allPossibleSpecialtyLabels(): string[] {
  return [...new Set([...DISEASE_SPECIALTIES, ...ENCOUNTER_TYPE_SPECIALTY_MAP.values(), 'General Practice'])];
}
