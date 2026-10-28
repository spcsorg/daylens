// How the day's hours become rows: consecutive empty hours with the same reason read as one range.
import type { GapReason, HourRow } from '../../../../shared/types.ts'

// `current`: the range runs into the current hour, so it ends now, not at the hour's end.
export type DayRow = { kind: 'hour'; h: HourRow } | { kind: 'gap'; reason: GapReason; start_ms: number; end_ms: number; current: boolean }

export function dayRows(hours: readonly HourRow[]): DayRow[] {
  const out: DayRow[] = []
  for (const h of hours) {
    const last = out.at(-1)
    if (h.gap && last?.kind === 'gap' && last.reason === h.gap && last.end_ms === h.start_ms) {
      last.end_ms = h.end_ms
      last.current = h.current
    } else out.push(h.gap ? { kind: 'gap', reason: h.gap, start_ms: h.start_ms, end_ms: h.end_ms, current: h.current } : { kind: 'hour', h })
  }
  return out
}

/** How a recorded hour is drawn. An hour known only from browser history keeps that design even while it is current. */
export function kindOf(h: HourRow): 'filled' | 'current' | 'written' | 'facts' {
  if (h.from_history) return 'filled'
  if (h.current) return 'current'
  return h.title !== null ? 'written' : 'facts'
}

/** An hour known only from browser history: the first page as its title, the others under it, and where they came
 * from said once. */
export function historyLines(h: HourRow): { title: string; summary: string | null; where: string } {
  const [first, ...rest] = h.facts.titles
  const browsers = h.facts.apps.map((a) => a.name)
  const by = browsers.length > 1 ? `${browsers.slice(0, -1).join(', ')} and ${browsers.at(-1)}` : (browsers[0] ?? 'your browser')
  return { title: first ?? 'Pages opened', summary: rest.length > 0 ? rest.join(', ') : null, where: `Opened in ${by} · from browser history` }
}
