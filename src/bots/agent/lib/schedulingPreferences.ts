export type TimeOfDay = 'morning' | 'afternoon' | 'evening';

export interface SchedulingPreferences {
  timeOfDay?: TimeOfDay;
  preferPreviousDoctor: boolean;
  preferNearby: boolean;
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
