import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectEncounterTypeTexts, validateEncounterTypeCoverage } from './specialty-corpus.js';
import { ENCOUNTER_TYPE_SPECIALTY_MAP } from './specialty-resolver.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const corpusDirectory = join(currentDirectory, '../../fhir');
const bundlePaths = readdirSync(corpusDirectory).filter((name) => name.endsWith('.json')).sort().map((name) => join(corpusDirectory, name));
const encounterTypes = collectEncounterTypeTexts(bundlePaths);
validateEncounterTypeCoverage(encounterTypes, ENCOUNTER_TYPE_SPECIALTY_MAP, 49);
console.log(`Verified ${encounterTypes.size} encounter types across ${bundlePaths.length} FHIR bundles.`);
