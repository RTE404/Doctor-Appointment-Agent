// src/config/specialties.ts

export interface SpecialtyDef {
  label: string;
  nuccCode: string;
  nuccDisplay: string;
  nppesTaxonomyDescription: string;
}

// Real NUCC provider taxonomy codes (http://nucc.org/provider-taxonomy),
// matching the specialty names produced by tools/seed/specialty-resolver.ts
// so both doctor pools resolve to the same vocabulary. The 18 codes shared
// with that file's SPECIALTY_NUCC_CODES were cross-checked to match exactly.
export const SPECIALTY_TABLE: SpecialtyDef[] = [
  { label: 'General Practice', nuccCode: '208D00000X', nuccDisplay: 'General Practice Physician', nppesTaxonomyDescription: 'General Practice' },
  { label: 'Cardiology', nuccCode: '207RC0000X', nuccDisplay: 'Cardiovascular Disease Physician', nppesTaxonomyDescription: 'Cardiovascular Disease' },
  { label: 'Pulmonology', nuccCode: '207RP1001X', nuccDisplay: 'Pulmonary Disease Physician', nppesTaxonomyDescription: 'Pulmonary Disease' },
  { label: 'Endocrinology', nuccCode: '207RE0101X', nuccDisplay: 'Endocrinology Physician', nppesTaxonomyDescription: 'Endocrinology, Diabetes & Metabolism' },
  { label: 'Gastroenterology', nuccCode: '207RG0100X', nuccDisplay: 'Gastroenterology Physician', nppesTaxonomyDescription: 'Gastroenterology' },
  { label: 'Neurology', nuccCode: '2084N0400X', nuccDisplay: 'Neurology Physician', nppesTaxonomyDescription: 'Neurology' },
  { label: 'Rheumatology', nuccCode: '207RR0500X', nuccDisplay: 'Rheumatology Physician', nppesTaxonomyDescription: 'Rheumatology' },
  { label: 'Nephrology', nuccCode: '207RN0300X', nuccDisplay: 'Nephrology Physician', nppesTaxonomyDescription: 'Nephrology' },
  { label: 'Dermatology', nuccCode: '207N00000X', nuccDisplay: 'Dermatology Physician', nppesTaxonomyDescription: 'Dermatology' },
  { label: 'Ophthalmology', nuccCode: '207W00000X', nuccDisplay: 'Ophthalmology Physician', nppesTaxonomyDescription: 'Ophthalmology' },
  { label: 'Otolaryngology', nuccCode: '207Y00000X', nuccDisplay: 'Otolaryngology Physician', nppesTaxonomyDescription: 'Otolaryngology' },
  { label: 'Urology', nuccCode: '208800000X', nuccDisplay: 'Urology Physician', nppesTaxonomyDescription: 'Urology' },
  { label: 'Hematology', nuccCode: '207RH0000X', nuccDisplay: 'Hematology Physician', nppesTaxonomyDescription: 'Hematology' },
  { label: 'Oncology', nuccCode: '207RX0202X', nuccDisplay: 'Medical Oncology Physician', nppesTaxonomyDescription: 'Medical Oncology' },
  { label: 'Infectious Disease', nuccCode: '207RI0200X', nuccDisplay: 'Infectious Disease Physician', nppesTaxonomyDescription: 'Infectious Disease' },
  { label: 'Psychiatry', nuccCode: '2084P0800X', nuccDisplay: 'Psychiatry Physician', nppesTaxonomyDescription: 'Psychiatry' },
  { label: 'Orthopedics', nuccCode: '207X00000X', nuccDisplay: 'Orthopaedic Surgery Physician', nppesTaxonomyDescription: 'Orthopaedic Surgery' },
  { label: 'Pediatrics', nuccCode: '208000000X', nuccDisplay: 'Pediatrics Physician', nppesTaxonomyDescription: 'Pediatrics' },
  { label: 'Obstetrics and Gynecology', nuccCode: '207V00000X', nuccDisplay: 'Obstetrics & Gynecology Physician', nppesTaxonomyDescription: 'Obstetrics & Gynecology' },
  // These three were absent from an earlier version of this table even
  // though the retired Python specialty_mapping.py — the source this
  // whole vocabulary is meant to match — uses them. Added during a
  // correction pass so the previous-physician pool can't be seeded with a
  // specialty this table has no NUCC code for.
  { label: 'Allergy and Immunology', nuccCode: '207K00000X', nuccDisplay: 'Allergy & Immunology Physician', nppesTaxonomyDescription: 'Allergy & Immunology' },
  { label: 'General Surgery', nuccCode: '208600000X', nuccDisplay: 'Surgery Physician', nppesTaxonomyDescription: 'General Surgery' },
  { label: 'Vascular Surgery', nuccCode: '2086S0129X', nuccDisplay: 'Surgery, Vascular Surgery Physician', nppesTaxonomyDescription: 'Vascular Surgery' },
];

// One synonym set per SPECIALTY_TABLE row. Deliberately small and expanded as
// real LLM output is observed in testing (see Design doc §"normalizeLlmSpecialty").
const SYNONYMS: Record<string, string[]> = {
  'General Practice': ['gp', 'family doctor', 'general doctor', 'primary care', 'family medicine'],
  Cardiology: ['heart doctor', 'cardiologist', 'heart'],
  Dermatology: ['skin doctor', 'dermatologist', 'skin'],
  Orthopedics: ['bone doctor', 'orthopedist', 'orthopedics', 'orthopedic surgeon'],
  Pediatrics: ['kids doctor', 'pediatrician', "children's doctor"],
  Ophthalmology: ['eye doctor', 'eye specialist'],
  Psychiatry: ['mental health doctor', 'psychiatrist'],
  Otolaryngology: ['ent', 'ear nose throat doctor'],
};

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * Maps the LLM's free-text specialty guess onto a controlled SPECIALTY_TABLE
 * entry. Case-insensitive exact match against `label` first, then a fixed
 * synonym map. Returns undefined on no match in either — the caller
 * (agent-intake) must ask the user to clarify rather than guess.
 */
export function normalizeLlmSpecialty(freeText: string): SpecialtyDef | undefined {
  const normalized = normalize(freeText);
  const exact = SPECIALTY_TABLE.find((entry) => normalize(entry.label) === normalized);
  if (exact) return exact;

  for (const entry of SPECIALTY_TABLE) {
    const synonyms = SYNONYMS[entry.label] ?? [];
    if (synonyms.some((s) => normalize(s) === normalized)) {
      return entry;
    }
  }
  return undefined;
}
