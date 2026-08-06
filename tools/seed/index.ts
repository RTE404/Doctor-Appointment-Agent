// tools/seed/index.ts
import { MedplumClient } from '@medplum/core';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import type { Bundle } from '@medplum/fhirtypes';
import 'dotenv/config';
import { scanPractitionerSpecialties } from './pass1-scan';
import { transformBundle } from './pass2-transform';
import { uploadBundle } from './upload';
import { uploadPatientBundle } from './chunk-bundle';

// ESM has no __dirname; this is the standard replacement.
const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(__dirname, '../../.seed-manifest.json');

export interface CliArgs {
  limit: number | undefined;
  mode: 'slim' | 'full';
  dryRun: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
  // `mode` (slim/full transform) and `limit` (how many files to select) are deliberately
  // orthogonal. `--full` used to also clear the limit, which made "run --slim against every
  // file" inexpressible — there was no flag combination that meant "all 983 files, slim mode."
  // `--all` is the one explicit way to select every file, independent of transform mode.
  const args: CliArgs = { limit: 50, mode: 'slim', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') {
      args.limit = Number(argv[++i]);
    } else if (argv[i] === '--all') {
      args.limit = undefined;
    } else if (argv[i] === '--full') {
      args.mode = 'full';
    } else if (argv[i] === '--slim') {
      args.mode = 'slim';
    } else if (argv[i] === '--dry-run') {
      args.dryRun = true;
    }
  }
  return args;
}

/** Filenames already successfully uploaded in a prior run — lets a resumed run skip them. */
function loadManifest(): Set<string> {
  if (!existsSync(MANIFEST_PATH)) return new Set();
  return new Set(JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as string[]);
}

function saveManifest(uploadedFileNames: Set<string>): void {
  writeFileSync(MANIFEST_PATH, JSON.stringify([...uploadedFileNames], null, 2));
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  // 'full' mode only exists as an escape hatch; the plan's actual seed run (Task 36) always
  // uses --slim --all. resolveReferences (pass2-transform.ts) only rewrites reference fields
  // for the 7 slim-mode resource types (Patient/Practitioner/Organization/Encounter/Condition/
  // MedicationRequest/AllergyIntolerance) — a full-corpus scan found 622,776 urn:uuid:
  // references on other resource types (Claim, CareTeam, etc.) that would be left dangling if
  // 'full' mode were actually run against real data. Warn loudly rather than silently corrupt.
  if (args.mode === 'full') {
    console.warn(
      'WARNING: --full mode\'s reference resolution is incomplete. resolveReferences() only rewrites reference ' +
        'fields on the 7 slim-mode resource types (Patient, Practitioner, Organization, Encounter, Condition, ' +
        'MedicationRequest, AllergyIntolerance). Resources of other types (e.g. Claim, CareTeam) may retain ' +
        'dangling urn:uuid: references after upload. This mode is not used by the documented seed run and is ' +
        'not recommended for production use.'
    );
  }

  const fhirDir = join(__dirname, '../../fhir');
  let files = readdirSync(fhirDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(fhirDir, f));
  if (args.limit !== undefined) {
    files = files.slice(0, args.limit);
  }

  console.log(`Scanning ${files.length} bundles for practitioner specialties...`);
  const specialtiesByStableId = scanPractitionerSpecialties(files);

  if (args.dryRun) {
    const histogram = new Map<string, number>();
    for (const specialty of specialtiesByStableId.values()) {
      histogram.set(specialty, (histogram.get(specialty) ?? 0) + 1);
    }
    console.log('Specialty histogram (dry run, no writes):');
    for (const [specialty, count] of [...histogram].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${specialty}: ${count}`);
    }
    return;
  }

  // Validate, don't cast — a missing credential silently became the
  // literal string "undefined" in an earlier version of this function,
  // producing a confusing auth failure instead of a clear configuration error.
  const { MEDPLUM_BASE_URL, MEDPLUM_CLIENT_ID, MEDPLUM_CLIENT_SECRET } = process.env;
  if (!MEDPLUM_BASE_URL || !MEDPLUM_CLIENT_ID || !MEDPLUM_CLIENT_SECRET) {
    throw new Error('Missing required environment variables: MEDPLUM_BASE_URL, MEDPLUM_CLIENT_ID, MEDPLUM_CLIENT_SECRET (see .env)');
  }

  const medplum = new MedplumClient({ baseUrl: MEDPLUM_BASE_URL });
  await medplum.startClientLogin(MEDPLUM_CLIENT_ID, MEDPLUM_CLIENT_SECRET);

  console.log('Uploading bootstrap config (HealthcareServices, Device, CodeSystem)...');
  const bootstrapBundle = JSON.parse(readFileSync(join(__dirname, '../../data/core/agent-config.json'), 'utf-8')) as Bundle;
  await uploadBundle(medplum, bootstrapBundle);

  const alreadyUploaded = loadManifest();
  console.log(`Uploading ${files.length} transformed bundles (${alreadyUploaded.size} already done per manifest)...`);
  let uploaded = 0;
  for (const filePath of files) {
    if (alreadyUploaded.has(filePath)) {
      continue;
    }
    const bundle = JSON.parse(readFileSync(filePath, 'utf-8')) as Bundle;
    const transformed = transformBundle(bundle, specialtiesByStableId, args.mode);
    await uploadPatientBundle(medplum, transformed);
    alreadyUploaded.add(filePath);
    uploaded++;
    if (uploaded % 50 === 0) {
      console.log(`  ${uploaded}/${files.length - (alreadyUploaded.size - uploaded)}`);
      saveManifest(alreadyUploaded); // checkpoint periodically, not just at the end
    }
  }
  saveManifest(alreadyUploaded);
  console.log(`Done. Uploaded ${uploaded} bundles this run (${alreadyUploaded.size} total per manifest).`);
}

// ESM-safe "was this module run directly" check. A correction pass found
// the original version of this check (`import.meta.url ===
// `file://${process.argv[1]}`) is silently false on Windows: argv[1] is
// a raw path with backslashes (D:\...\index.ts), while import.meta.url is
// a proper URL with forward slashes and percent-encoding
// (file:///D:/...%20.../index.ts) — the two never match, so main() never
// ran on this workspace. pathToFileURL() normalizes argv[1] into the same
// URL form import.meta.url already uses, on every platform.
const isMainModule = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
