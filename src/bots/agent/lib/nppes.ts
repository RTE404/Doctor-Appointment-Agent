// src/bots/agent/lib/nppes.ts
import type { DoctorCandidate } from './ranking';

const NPPES_BASE_URL = 'https://npiregistry.cms.hhs.gov/api/';

interface NppesAddress {
  address_purpose: string;
  address_1?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  telephone_number?: string;
}

interface NppesResult {
  number: string;
  basic: { first_name: string; last_name: string };
  taxonomies: { code: string; desc: string; primary: boolean; state?: string }[];
  addresses: NppesAddress[];
  // Not documented in NPPES's API reference — observed live: a state+city
  // search can match a provider via an entry here while every address in
  // `addresses` is in a different state entirely (real example: searching
  // Boston, MA matched a provider whose addresses[LOCATION] was Cleveland,
  // OH, because this array had a Boston, MA entry). Optional and
  // best-effort since it's empirically sourced, not a documented contract.
  practiceLocations?: Omit<NppesAddress, 'address_purpose'>[];
}

/**
 * Picks the address to report for a result. Prefers addresses[LOCATION]
 * (or the first address) as long as it already matches the state that was
 * searched for; only falls back to a practiceLocations entry in that state
 * when the default address doesn't match — otherwise a result with two
 * same-state addresses (e.g. Boston, MA main office + Woburn, MA
 * practiceLocations) would have its already-correct address swapped out.
 */
function pickAddress(result: NppesResult, expectedState: string | undefined): NppesAddress | undefined {
  const defaultAddress = result.addresses.find((a) => a.address_purpose === 'LOCATION') ?? result.addresses[0];
  if (!expectedState || defaultAddress?.state === expectedState) {
    return defaultAddress;
  }
  const practiceMatch = (result.practiceLocations ?? []).find((a) => a.state === expectedState);
  return practiceMatch ? { ...practiceMatch, address_purpose: 'LOCATION' } : defaultAddress;
}

function mapResult(result: NppesResult, expectedState?: string): DoctorCandidate {
  const primaryTaxonomy = result.taxonomies.find((t) => t.primary) ?? result.taxonomies[0];
  const address = pickAddress(result, expectedState);
  return {
    npi: result.number,
    firstName: result.basic.first_name,
    lastName: result.basic.last_name,
    nuccCode: primaryTaxonomy.code,
    nuccDisplay: primaryTaxonomy.desc,
    address: {
      line: address?.address_1 ? [address.address_1] : undefined,
      city: address?.city,
      state: address?.state,
      postalCode: address?.postal_code,
    },
    phone: address?.telephone_number,
  };
}

// Full US state/territory name -> 2-letter postal code, the format NPPES
// requires. Every seeded patient's address.state is the full name (e.g.
// "Massachusetts") — confirmed directly against the real corpus — so this
// normalization runs unconditionally; a value already in 2-letter form
// passes through the lookup miss and is used as-is (see normalizeState).
const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC',
};

function normalizeState(state: string): string {
  if (state.length === 2) return state.toUpperCase();
  return STATE_NAME_TO_CODE[state.toLowerCase().trim()] ?? state;
}

async function nppesFetch(taxonomyDescription: string, city: string | undefined, state: string, limit: number): Promise<NppesResult[]> {
  const params = new URLSearchParams({
    version: '2.1',
    enumeration_type: 'NPI-1',
    taxonomy_description: taxonomyDescription,
    state,
    limit: String(limit),
  });
  if (city) params.set('city', city);
  const response = await fetch(`${NPPES_BASE_URL}?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`NPPES search failed: ${response.status}`);
  }
  const body = (await response.json()) as { results: NppesResult[] };
  return body.results;
}

/**
 * Searches NPPES's public registry for active doctors matching a taxonomy
 * description and location. `state` may be a 2-letter code or a full US
 * state name (normalized automatically — every seeded patient stores the
 * full name, and NPPES requires the code). Falls back to a state-only
 * search if an exact city+state search returns nothing, rather than
 * reporting "no doctors found" when NPPES actually has matches elsewhere
 * in the state. Network/5xx failures propagate to the caller (bot-level
 * failure) — never swallowed.
 */
export async function searchNppesDoctors(
  taxonomyDescription: string,
  city: string,
  state: string,
  limit = 20
): Promise<DoctorCandidate[]> {
  const normalizedState = normalizeState(state);
  let results = await nppesFetch(taxonomyDescription, city, normalizedState, limit);
  if (results.length === 0 && city) {
    results = await nppesFetch(taxonomyDescription, undefined, normalizedState, limit);
  }
  return results.map((r) => mapResult(r, normalizedState));
}

/** Single-result lookup by NPI. Returns undefined (not an error) if NPPES has no record. */
export async function getNppesDoctorByNpi(npi: string): Promise<DoctorCandidate | undefined> {
  const url = `${NPPES_BASE_URL}?version=2.1&number=${npi}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`NPPES lookup failed: ${response.status}`);
  }
  const body = (await response.json()) as { results: NppesResult[] };
  return body.results[0] ? mapResult(body.results[0]) : undefined;
}
