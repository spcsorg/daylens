import { clock, dateKey, dayMonth, parseKey } from '../../lib/format.ts'

const DAY_MS = 86_400_000

/**
 * What keeping `days` of history deletes now, given the first recorded day: "everything before 1 October, 4 PM", or
 * null when nothing goes. Storage cuts at now minus the days, not at midnight, so the first day can lose its morning.
 */
export function retentionCuts(firstDay: string | null, days: number | null, now: number): string | null {
  if (days === null || firstDay === null) return null
  const cutoff = now - days * DAY_MS
  if (parseKey(firstDay).getTime() >= cutoff) return null
  return `everything before ${dayMonth(dateKey(new Date(cutoff)))}, ${clock(cutoff)}`
}
