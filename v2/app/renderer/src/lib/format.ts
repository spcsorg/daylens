// Dates and durations as the design writes them: "Tuesday, 5 March", "7 PM", "12–3 PM", "1h 35m".

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function parseKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d)
}

export function addDays(key: string, n: number): string {
  const d = parseKey(key)
  d.setDate(d.getDate() + n)
  return dateKey(d)
}

/** Monday of the week the day is in. */
export function weekStart(key: string): string {
  const d = parseKey(key)
  return addDays(key, -((d.getDay() + 6) % 7))
}

export function monthOf(key: string): string {
  return key.slice(0, 7)
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const d = new Date(y, m - 1 + n, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function longDay(key: string): string {
  const d = parseKey(key)
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

export function plainDay(key: string): string {
  const d = parseKey(key)
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

export function dayMonth(key: string): string {
  const d = parseKey(key)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

export function shortDay(key: string): string {
  const d = parseKey(key)
  return `${DAYS[d.getDay()]!.slice(0, 3)} ${d.getDate()}`
}

export function monthTitle(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return `${MONTHS[m - 1]} ${y}`
}

export function rangeTitle(from: string, to: string): string {
  const a = parseKey(from)
  const b = parseKey(to)
  if (a.getMonth() === b.getMonth()) return `${a.getDate()}–${b.getDate()} ${MONTHS[b.getMonth()]}`
  return `${a.getDate()} ${MONTHS[a.getMonth()]} – ${b.getDate()} ${MONTHS[b.getMonth()]}`
}

function parts(ms: number): { h: number; m: number; pm: boolean } {
  const d = new Date(ms)
  const h24 = d.getHours()
  return { h: h24 % 12 === 0 ? 12 : h24 % 12, m: d.getMinutes(), pm: h24 >= 12 }
}

export function hourLabel(ms: number): string {
  const p = parts(ms)
  return `${p.h} ${p.pm ? 'PM' : 'AM'}`
}

export function clock(ms: number): string {
  const p = parts(ms)
  return `${p.h}${p.m ? `:${String(p.m).padStart(2, '0')}` : ''} ${p.pm ? 'PM' : 'AM'}`
}

/** "12:04 PM", or a span "12–3 PM" / "11 AM–1 PM" when it lasts a while. */
export function span(from: number, to: number): string {
  if (to - from < 5 * 60_000) return clock(from)
  const a = parts(from)
  const b = parts(to)
  const left = `${a.h}${a.m ? `:${String(a.m).padStart(2, '0')}` : ''}`
  return a.pm === b.pm ? `${left}–${clock(to)}` : `${clock(from)}–${clock(to)}`
}

export function duration(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins < 1) return ms > 0 ? '<1m' : '0m'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  return m ? `${h}h ${m}m` : `${h}h`
}

export function hoursList(starts: number[]): string {
  const labels = starts.map(hourLabel)
  if (labels.length <= 1) return labels.join('')
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`
}

/** "Tue 5 Mar, 12 PM": a day and an hour, as search results name when something was seen. */
export function seenAt(ms: number): string {
  const d = new Date(ms)
  return `${DAYS[d.getDay()]!.slice(0, 3)} ${d.getDate()} ${MONTHS[d.getMonth()]!.slice(0, 3)}, ${hourLabel(ms)}`
}

/** A facts hour's title: the apps it was spent in, longest first. */
export function factsTitle(h: { facts: { apps: { name: string }[] } }): string {
  return h.facts.apps
    .slice(0, 3)
    .map((a) => a.name)
    .join(' · ')
}
