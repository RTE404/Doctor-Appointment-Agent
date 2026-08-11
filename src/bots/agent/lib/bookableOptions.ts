import type { SchedulingPreferences } from './schedulingPreferences.js';
import { timeOfDayAt } from './schedulingPreferences.js';

export interface BookableOption {
  id: string;
  npi: string;
  practitionerId: string;
  scheduleId: string;
  doctorName: string;
  start: string;
  end: string;
  timeZone: string;
  previousDoctor: boolean;
  distanceMiles?: number;
}

export function rankBookableOptions(
  options: BookableOption[],
  preferences: SchedulingPreferences,
  limit: number = 3
): BookableOption[] {
  const ranked = [...options].sort((left, right) => {
      if (preferences.timeOfDay) {
        const leftMatches = timeOfDayAt(left.start, left.timeZone) === preferences.timeOfDay;
        const rightMatches = timeOfDayAt(right.start, right.timeZone) === preferences.timeOfDay;
        if (leftMatches !== rightMatches) {
          return leftMatches ? -1 : 1;
        }
      }

      if (preferences.preferPreviousDoctor && left.previousDoctor !== right.previousDoctor) {
        return left.previousDoctor ? -1 : 1;
      }

      if (preferences.preferNearby) {
        if (left.distanceMiles === undefined && right.distanceMiles !== undefined) {
          return 1;
        }
        if (left.distanceMiles !== undefined && right.distanceMiles === undefined) {
          return -1;
        }
        if (
          left.distanceMiles !== undefined &&
          right.distanceMiles !== undefined &&
          left.distanceMiles !== right.distanceMiles
        ) {
          return left.distanceMiles - right.distanceMiles;
        }
      }

      const startDifference = Date.parse(left.start) - Date.parse(right.start);
      return startDifference || left.id.localeCompare(right.id);
    });

  const providerNpis = new Set<string>();
  const distinctProviders: BookableOption[] = [];
  for (const option of ranked) {
    if (providerNpis.has(option.npi)) {
      continue;
    }
    providerNpis.add(option.npi);
    distinctProviders.push(option);
    if (distinctProviders.length === limit) {
      break;
    }
  }
  return distinctProviders;
}
