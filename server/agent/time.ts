/** Timezone-aware date helpers built on Intl only (no dependencies). */
export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function partsInZone(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '0';
  return { year: Number(get('year')), month: Number(get('month')), day: Number(get('day')), hour: Number(get('hour')) % 24, minute: Number(get('minute')), second: Number(get('second')), weekday: WEEKDAYS.indexOf(get('weekday')) };
}

/** Offset in ms between the zone's wall clock and UTC at the given instant. */
function offsetAt(instant: Date, timeZone: string): number {
  const p = partsInZone(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Converts a wall-clock time in `timeZone` to the matching UTC instant (DST-safe). */
export function zonedTimeToUtc(wall: { year: number; month: number; day: number; hour?: number; minute?: number }, timeZone: string): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour ?? 0, wall.minute ?? 0, 0);
  let instant = new Date(guess - offsetAt(new Date(guess), timeZone));
  const corrected = new Date(guess - offsetAt(instant, timeZone));
  if (corrected.getTime() !== instant.getTime()) instant = corrected;
  return instant;
}

/** Adds calendar days in the zone (so 24h DST days do not drift) and returns the wall time at `hour:minute`. */
export function localDayAt(base: Date, addDays: number, hour: number, minute: number, timeZone: string): Date {
  const p = partsInZone(base, timeZone);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + addDays));
  return zonedTimeToUtc({ year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), hour, minute }, timeZone);
}

export function parseClock(value: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!match || hour > 23 || minute > 59) throw new Error(`Invalid time "${value}". Use HH:MM.`);
  return { hour, minute };
}

/** Next occurrence of a daily HH:MM wall-clock time strictly after `now`. */
export function nextDailyRun(now: Date, at: string, timeZone: string): Date {
  const { hour, minute } = parseClock(at);
  const today = localDayAt(now, 0, hour, minute, timeZone);
  return today.getTime() > now.getTime() ? today : localDayAt(now, 1, hour, minute, timeZone);
}

/** Next occurrence of `weekday` (0 = Sunday) at HH:MM strictly after `now`. */
export function nextWeeklyRun(now: Date, weekday: number, at: string, timeZone: string): Date {
  const { hour, minute } = parseClock(at);
  const current = partsInZone(now, timeZone).weekday;
  for (let offset = 0; offset <= 7; offset += 1) {
    if ((current + offset) % 7 !== weekday) continue;
    const candidate = localDayAt(now, offset, hour, minute, timeZone);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  return localDayAt(now, 7, hour, minute, timeZone);
}
