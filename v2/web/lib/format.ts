export function hm(seconds: number): string {
  const m = Math.round(seconds / 60);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return h ? `${h} h${rest ? ` ${rest} min` : ""}` : `${rest} min`;
}

export function hrs(seconds: number): string {
  return `${(Math.round((seconds / 3600) * 10) / 10).toLocaleString("en-GB")} h`;
}

export function wholeHours(seconds: number): string {
  return Math.round(seconds / 3600).toLocaleString("en-GB");
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function initials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2);
}

export function clock(ms: number, timeZone: string, withPeriod = true): string {
  const s = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(ms);
  return withPeriod ? s : s.replace(/\s?[AP]M$/, "");
}

/** "8:12 – 9:40 AM", or "11:30 AM – 12:30 PM" when the two halves differ. */
export function span(start: number, end: number, timeZone: string): string {
  const a = clock(start, timeZone);
  const b = clock(end, timeZone);
  return a.slice(-2) === b.slice(-2) ? `${clock(start, timeZone, false)} – ${b}` : `${a} – ${b}`;
}

const day = (date: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...opts }).format(new Date(`${date}T00:00:00Z`));

export const weekdayName = (date: string) => day(date, { weekday: "long" });
export const weekdayShort = (date: string) => day(date, { weekday: "short" });
export const dayOfMonth = (date: string) => Number(date.slice(8));
export const monthName = (date: string) => day(date, { month: "long" });
export const longDate = (date: string) => day(date, { weekday: "long", day: "numeric", month: "long" });

/** "16–20 November", or "30 November – 4 December" across months. */
export function dayRange(from: string, to: string): string {
  if (from.slice(0, 7) === to.slice(0, 7)) return `${dayOfMonth(from)}–${dayOfMonth(to)} ${monthName(to)}`;
  return `${dayOfMonth(from)} ${monthName(from)} – ${dayOfMonth(to)} ${monthName(to)}`;
}
