export type TimeOfDay = 'morning' | 'afternoon' | 'evening';

export interface SchedulingPreferences {
  timeOfDay?: TimeOfDay;
  preferPreviousDoctor: boolean;
  preferNearby: boolean;
}

const TIME_VALUES = new Set<TimeOfDay>(['morning', 'afternoon', 'evening']);

export function normalizeSchedulingPreferences(value: unknown): SchedulingPreferences {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const timeOfDay = TIME_VALUES.has(record.timeOfDay as TimeOfDay) ? (record.timeOfDay as TimeOfDay) : undefined;

  return {
    timeOfDay,
    preferPreviousDoctor: record.preferPreviousDoctor === true,
    preferNearby: record.preferNearby === true,
  };
}

export function timeOfDayAt(instant: string, timeZone: string): TimeOfDay {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(instant))
  );
  if (hour < 12) {
    return 'morning';
  }
  if (hour < 17) {
    return 'afternoon';
  }
  return 'evening';
}
