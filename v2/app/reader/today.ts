// Today's reads: an open hour, where you left off, the week and the month.
import type { Source } from '../shared/types.ts'
import type { HourDetail, MonthView, TodayQuery, WeekView } from '../shared/today.ts'
import { HOUR_MS, dateOf, factsTitle, hourStarts, startOf, type Handlers, type Reader, type Span } from './queries.ts'

export function hour(r: Reader, startMs: number): HourDetail {
  const end = startMs + HOUR_MS
  const inHour = r.spans(startMs, Math.min(end, r.now()))
  const sources = [...r.sources(inHour, inHour), ...r.visitSources(r.visits(startMs, Math.min(end, r.now())))]
  const w = r.writtenHours(startMs, end).get(startMs)
  return { start_ms: startMs, detail: w?.detail ?? null, sources }
}

const BREAK_MS = 30 * 60_000

/**
 * The last three windows and pages before your most recent break, half an hour or more with nothing in front, looking
 * back a week; most recent first. Nothing from the stretch you're in now.
 */
export function leftOff(r: Reader): Source[] {
  const now = r.now()
  const spans = r.spans(startOf(dateOf(now), -7), now).sort((a, b) => a.s - b.s)
  let edge = now
  let i = spans.length
  while (i > 0 && edge - spans[i - 1]!.e < BREAK_MS) edge = Math.min(edge, spans[--i]!.s)
  const last = new Map<string, Span>()
  for (let j = i - 1; j >= 0 && last.size < 3; j--) {
    const x = spans[j]!
    const k = `${x.app_id}\u0000${x.url ?? ''}\u0000${x.title ?? ''}`
    if (!last.has(k)) last.set(k, x)
  }
  const picked = [...last.values()]
  return r.sources(picked, picked).sort((a, b) => b.last_ms - a.last_ms)
}

export function week(r: Reader, start: string): WeekView {
  const now = r.now()
  const days: WeekView['days'] = []
  const all: Span[] = []
  for (let i = 0; i < 7; i++) {
    const date = dateOf(startOf(start, i))
    const from = startOf(start, i)
    const to = Math.min(startOf(start, i + 1), now)
    if (to <= from) {
      days.push({ date, total_ms: 0, blocks: [] })
      continue
    }
    const spans = r.spans(from, to)
    all.push(...spans)
    const visits = r.visits(from, to)
    const written = r.writtenHours(from, to)
    const blocks: WeekView['days'][number]['blocks'] = []
    for (const h of hourStarts(from, to)) {
      const live = r.facts(spans.filter((x) => x.e > h && x.s < h + HOUR_MS).map((x) => ({ ...x, s: Math.max(x.s, h), e: Math.min(x.e, h + HOUR_MS) })))
      const f = r.withVisits(live, visits.filter((v) => v.t >= h && v.t < h + HOUR_MS))
      const w = written.get(h)
      if (f.apps.length === 0 && !w) continue
      blocks.push({ start_ms: h, title: w?.title ?? factsTitle(f.apps), written: Boolean(w?.title) })
    }
    days.push({ date, total_ms: r.facts(spans).total_ms, blocks })
  }
  const apps = r.appTotals(all)
  return { start, days, apps, total_ms: apps.reduce((n, a) => n + a.ms, 0), first_day: r.firstDay(), today: dateOf(now) }
}

export function month(r: Reader, month: string): MonthView {
  const now = r.now()
  const first = `${month}-01`
  const days: MonthView['days'] = []
  const all: Span[] = []
  for (let i = 0; ; i++) {
    const from = startOf(first, i)
    const date = dateOf(from)
    if (!date.startsWith(month)) break
    const to = Math.min(startOf(first, i + 1), now)
    const spans = to > from ? r.spans(from, to) : []
    all.push(...spans)
    const apps = r.appTotals(spans)
    const total = apps.reduce((n, a) => n + a.ms, 0)
    for (const v of to > from ? r.visits(from, to) : []) if (!apps.some((a) => a.id === v.app_id)) apps.push({ id: v.app_id, name: v.app_name, ms: 0 })
    days.push({ date, total_ms: total, apps })
  }
  const apps = r.appTotals(all)
  return { month, days, apps, total_ms: apps.reduce((n, a) => n + a.ms, 0), first_day: r.firstDay(), today: dateOf(now) }
}

export const today: Handlers<TodayQuery> = {
  hour: ({ record }, q) => hour(record, q.start_ms),
  left_off: ({ record }) => leftOff(record),
  week: ({ record }, q) => week(record, q.start),
  month: ({ record }, q) => month(record, q.month),
}
