// The Apps screen's reads: time by app over a day or a week, and one app's detail.
import { KNOWN_BROWSER_APP_IDS } from '../../capture/defaults.ts'
import type { AppDetail, AppsQuery, AppsView } from '../shared/apps.ts'
import { dateOf, hourStarts, startOf, type Handlers, type Reader } from './queries.ts'

function appsView(r: Reader, from: string, days: number): AppsView {
  const now = r.now()
  const lo = startOf(from)
  const hi = Math.min(startOf(from, days), now)
  const spans = hi > lo ? r.spans(lo, hi) : []
  const perDay: AppsView['per_day'] = []
  for (let i = 0; i < days; i++) {
    const a = startOf(from, i)
    const b = startOf(from, i + 1)
    perDay.push({ date: dateOf(a), total_ms: spans.reduce((n, x) => n + Math.max(0, Math.min(x.e, b) - Math.max(x.s, a)), 0) })
  }
  const apps = r.appTotals(spans)
  return { from, days, apps, total_ms: apps.reduce((n, a) => n + a.ms, 0), per_day: perDay, first_day: r.firstDay(), today: dateOf(now) }
}

export function app(r: Reader, id: string, from: string, days: number): AppDetail | null {
  const lo = startOf(from)
  const hi = Math.min(startOf(from, days), r.now())
  const spans = hi > lo ? r.spans(lo, hi).filter((x) => x.app_id === id) : []
  if (spans.length === 0) return null
  const hours = new Set<number>()
  for (const x of spans) for (const h of hourStarts(x.s, x.e)) hours.add(new Date(h).setMinutes(0, 0, 0))
  const perDay: AppDetail['per_day'] = []
  for (let i = 0; i < days; i++) {
    const a = startOf(from, i)
    const b = startOf(from, i + 1)
    const ms = spans.reduce((n, x) => n + Math.max(0, Math.min(x.e, b) - Math.max(x.s, a)), 0)
    if (ms > 0) perDay.push({ date: dateOf(a), ms })
  }
  const total = spans.reduce((n, x) => n + (x.e - x.s), 0)
  const browser = KNOWN_BROWSER_APP_IDS.has(id) || spans.some((x) => x.url !== null)
  return {
    app: { id, name: spans[0]!.app_name, ms: total },
    hours: [...hours].sort((a, b) => a - b),
    per_day: perDay,
    sources: r.sources(spans, spans).filter((s) => s.title !== s.app.name || s.url !== null),
    browser,
  }
}

export const apps: Handlers<AppsQuery> = {
  apps: ({ record }, q) => appsView(record, q.from, q.days),
  app: ({ record }, q) => app(record, q.id, q.from, q.days),
}
