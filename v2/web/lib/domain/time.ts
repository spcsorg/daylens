const MINUTE = 60_000;
export const DAY_MS = 86_400_000;

function offsetMinutes(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(ms);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((asUtc - Math.floor(ms / MINUTE) * MINUTE) / MINUTE);
}

export function localDate(ms: number, timeZone: string): string {
  return new Date(ms + offsetMinutes(ms, timeZone) * MINUTE).toISOString().slice(0, 10);
}

export function dayStart(date: string, timeZone: string): number {
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  const guess = utcMidnight - offsetMinutes(utcMidnight, timeZone) * MINUTE;
  return utcMidnight - offsetMinutes(guess, timeZone) * MINUTE;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Monday is 1, Sunday is 7, as in ISO 8601. */
export function isoWeekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
}

export function mondayOf(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
