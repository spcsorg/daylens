// The screens' reads, on a read-only connection. Every read hides what a pending deletion covers and what is past the
// retention cutoff, the same rules readHour and the search fence apply, so a deletion shows the moment it is in force.
import type Database from 'better-sqlite3'
import { MAX_INTERVAL_MS, siteOf } from '../../storage/derive.ts'
import { readHour } from '../../storage/hours.ts'
import type { Reader as Finder } from '../../retrieval/reader.ts'
import { DAY_MS, pendingTombstones, tombstoneMatches, type Tombstone } from '../../storage/rules.ts'
import { STATUS_KEY } from '../../capture/history.ts'
import type { AppTime, DayView, GapReason, HourFacts, HourRow, Query, QueryResult, RecordingView, Source } from '../shared/types.ts'

export const HOUR_MS = 3_600_000

/** What a query handler reads from: the record, and the search index over it. */
export interface Sources {
  record: Reader
  finder: Finder
}

/** Each screen answers its own queries; the reader merges them. */
export type Handlers<Q extends Query> = { [K in Q['q']]: (src: Sources, q: Extract<Q, { q: K }>) => QueryResult[K] }

export interface Span {
  s: number
  e: number
  app_id: string
  app_name: string
  title: string | null
  url: string | null
  site: string | null
}

interface VisitRow {
  t: number
  app_id: string
  app_name: string
  title: string | null
  url: string
  site: string | null
}

export function dateOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function startOf(date: string, addDays = 0): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d + addDays).getTime()
}

export function hourStarts(from: number, to: number): number[] {
  const out: number[] = []
  const d = new Date(from)
  for (let h = 0; ; h++) {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + h).getTime()
    if (t >= to) break
    if (out.length === 0 || t > out[out.length - 1]!) out.push(t)
  }
  return out
}

export class Reader {
  readonly db: Database.Database
  readonly now: () => number
  private retentionDays: number | null | undefined = undefined

  constructor(db: Database.Database, now: () => number = Date.now) {
    this.db = db
    this.now = now
  }

  /** Retention changed: the next read loads it again. */
  invalidate(): void {
    this.retentionDays = undefined
  }

  /** One query's reads share one snapshot, so a deletion is either in force for all of them or for none. */
  read<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  // Read with every query, never cached: a deletion is hidden the moment its fence commits.
  private tombstones(): Tombstone[] {
    return pendingTombstones(this.db)
  }

  cutoff(): number | null {
    if (this.retentionDays === undefined) {
      const r = this.db.prepare(`SELECT value FROM settings WHERE key = 'retention_days'`).get() as { value: string } | undefined
      this.retentionDays = r ? (JSON.parse(r.value) as number | null) : null
    }
    return this.retentionDays === null ? null : this.now() - this.retentionDays * DAY_MS
  }

  /** Focus time in [from, to), clipped to it, with pending deletions cut out. */
  spans(from: number, to: number): Span[] {
    const cutoff = this.cutoff()
    const lo = cutoff === null ? from : Math.max(from, cutoff)
    if (lo >= to) return []
    const rows = this.db
      .prepare(
        `SELECT start_wall_ms AS s, end_wall_ms AS e, app_id, app_name, title, title_state, url, site FROM intervals
         WHERE start_wall_ms >= ? AND start_wall_ms < ? AND end_wall_ms > ? AND app_id IS NOT NULL ORDER BY start_wall_ms`,
      )
      .all(lo - MAX_INTERVAL_MS, to, lo) as { s: number; e: number; app_id: string; app_name: string | null; title: string | null; title_state: string | null; url: string | null; site: string | null }[]
    const pending = this.tombstones()
    const out: Span[] = []
    for (const r of rows) {
      let parts: [number, number][] = [[Math.max(r.s, lo), Math.min(r.e, to)]]
      for (const t of pending) {
        if (!tombstoneMatches(t, r.app_id, r.url)) continue
        const ts = t.from_wall_ms ?? Number.NEGATIVE_INFINITY
        const te = t.to_wall_ms ?? Number.POSITIVE_INFINITY
        parts = parts.flatMap(([a, b]): [number, number][] => {
          if (te <= a || ts >= b) return [[a, b]]
          const keep: [number, number][] = []
          if (ts > a) keep.push([a, ts])
          if (te < b) keep.push([te, b])
          return keep
        })
      }
      for (const [a, b] of parts) {
        if (b <= a) continue
        out.push({ s: a, e: b, app_id: r.app_id, app_name: r.app_name ?? r.app_id, title: r.title_state === 'ok' ? r.title : null, url: r.url, site: r.site })
      }
    }
    return out
  }

  /** Pages opened in [from, to), from browser history, with pending deletions left out. */
  visits(from: number, to: number): VisitRow[] {
    const cutoff = this.cutoff()
    const lo = cutoff === null ? from : Math.max(from, cutoff)
    if (lo >= to) return []
    const rows = this.db
      .prepare(`SELECT event_wall_ms AS t, app_id, app_name, title, url FROM observations WHERE event_wall_ms >= ? AND event_wall_ms < ? AND kind = 'visit' AND app_id IS NOT NULL ORDER BY event_wall_ms, id`)
      .all(lo, to) as Omit<VisitRow, 'site'>[]
    const pending = this.tombstones()
    return rows
      .filter((r) => !pending.some((t) => tombstoneMatches(t, r.app_id, r.url) && r.t >= (t.from_wall_ms ?? Number.NEGATIVE_INFINITY) && r.t < (t.to_wall_ms ?? Number.POSITIVE_INFINITY)))
      .map((r) => ({ ...r, app_name: r.app_name ?? r.app_id, site: siteOf(r.url) }))
  }

  // Visits add their browser and page titles to an hour's facts, never time.
  withVisits(f: HourFacts & { total_ms: number }, visits: readonly VisitRow[]): HourFacts & { total_ms: number } {
    const apps = [...f.apps]
    const titles = [...f.titles]
    for (const v of visits) {
      if (!apps.some((a) => a.id === v.app_id)) apps.push({ id: v.app_id, name: v.app_name, ms: 0 })
      if (v.title && !titles.includes(v.title)) titles.push(v.title)
    }
    return { apps, titles, total_ms: f.total_ms }
  }

  facts(spans: readonly Span[]): HourFacts & { total_ms: number } {
    const apps = new Map<string, AppTime>()
    const titles = new Map<string, number>()
    let total = 0
    for (const x of spans) {
      const ms = x.e - x.s
      total += ms
      const a = apps.get(x.app_id) ?? { id: x.app_id, name: x.app_name, ms: 0 }
      a.ms += ms
      apps.set(x.app_id, a)
      if (x.title) titles.set(x.title, (titles.get(x.title) ?? 0) + ms)
    }
    return {
      apps: [...apps.values()].sort((a, b) => b.ms - a.ms),
      titles: [...titles.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t),
      total_ms: total,
    }
  }

  appTotals(spans: readonly Span[]): AppTime[] {
    return this.facts(spans).apps
  }

  // --- pauses, gaps, presence ---------------------------------------------------

  private activePause(now: number): { since_wall_ms: number; until_wall_ms: number | null } | null {
    return (
      (this.db
        .prepare(
          `SELECT since_wall_ms, until_wall_ms FROM pauses WHERE ended_wall_ms IS NULL AND app_id IS NULL AND (until_wall_ms IS NULL OR until_wall_ms > ?)
           ORDER BY since_wall_ms DESC LIMIT 1`,
        )
        .get(now) as { since_wall_ms: number; until_wall_ms: number | null } | undefined) ?? null
    )
  }

  private gaps(from: number, to: number): { reason: string; s: number; e: number }[] {
    const now = this.now()
    return (
      this.db
        .prepare(
          `SELECT reason, start_wall_ms AS s, coalesce(end_wall_ms, ?) AS e FROM capture_gaps
           WHERE scope IN ('all', 'focus') AND start_wall_ms < ? AND coalesce(end_wall_ms, ?) > ?`,
        )
        .all(now, to, now, from) as { reason: string; s: number; e: number }[]
    ).map((g) => ({ ...g, s: Math.max(g.s, from), e: Math.min(g.e, to) }))
  }

  private presence(from: number, to: number): { kind: string; state: string; t: number }[] {
    const before = this.db
      .prepare(
        `SELECT kind, state, event_wall_ms AS t FROM observations WHERE kind IN ('power', 'session', 'input') AND event_wall_ms < ?
         ORDER BY event_wall_ms DESC LIMIT 1`,
      )
      .all(from) as { kind: string; state: string; t: number }[]
    const inside = this.db
      .prepare(`SELECT kind, state, event_wall_ms AS t FROM observations WHERE kind IN ('power', 'session', 'input') AND event_wall_ms >= ? AND event_wall_ms < ? ORDER BY event_wall_ms`)
      .all(from, to) as { kind: string; state: string; t: number }[]
    return [...before, ...inside]
  }

  private gapReason(from: number, to: number): GapReason {
    const half = (to - from) / 2
    const byReason = new Map<string, number>()
    for (const g of this.gaps(from, to)) byReason.set(g.reason, (byReason.get(g.reason) ?? 0) + (g.e - g.s))
    const top = [...byReason.entries()].sort((a, b) => b[1] - a[1])[0]
    if (top && top[1] >= half) {
      if (top[0] === 'paused') return 'paused'
      if (top[0] === 'excluded') return 'excluded'
      if (top[0] === 'service_down' || top[0] === 'service_starting') return 'not_running'
      return 'stopped'
    }
    const states = this.presence(from, to).map((p) => `${p.kind}:${p.state}`)
    if (states.some((s) => s === 'power:sleep' || s === 'power:display_off')) return 'asleep'
    if (states.some((s) => s === 'session:locked')) return 'locked'
    if (states.some((s) => s === 'input:idle')) return 'idle'
    if (top) return top[0] === 'paused' ? 'paused' : top[0] === 'excluded' ? 'excluded' : 'nothing'
    return 'nothing'
  }

  // The current hour with nothing in it yet is still "recording now" unless something explains the silence.
  private emptyHour(from: number, to: number, current: boolean): GapReason | null {
    const reason = this.gapReason(from, to)
    return current && reason === 'nothing' ? null : reason
  }

  private stoppedSince(): number | null {
    const r = this.db
      .prepare(
        `SELECT min(start_wall_ms) AS s FROM capture_gaps WHERE end_wall_ms IS NULL AND scope = 'all'
         AND reason IN ('helper_crashed', 'helper_hung', 'helper_stalled', 'helper_unavailable', 'storage_failed', 'events_unavailable')`,
      )
      .get() as { s: number | null }
    return r.s
  }

  // --- days ----------------------------------------------------------------------

  firstDay(): string | null {
    const cutoff = this.cutoff()
    const lo = cutoff ?? Number.MIN_SAFE_INTEGER
    const r = this.db.prepare('SELECT min(start_wall_ms) AS s FROM intervals WHERE start_wall_ms >= ?').get(lo) as { s: number | null }
    const v = this.db.prepare(`SELECT event_wall_ms AS s FROM observations WHERE kind = 'visit' AND event_wall_ms >= ? ORDER BY event_wall_ms LIMIT 1`).get(lo) as { s: number } | undefined
    const first = Math.min(r.s ?? Number.POSITIVE_INFINITY, v?.s ?? Number.POSITIVE_INFINITY)
    return Number.isFinite(first) ? dateOf(first) : null
  }

  writtenHours(from: number, to: number): Map<number, { title: string | null; summary: string | null; detail: string | null; edited: boolean }> {
    const out = new Map<number, { title: string | null; summary: string | null; detail: string | null; edited: boolean }>()
    const ids = this.db.prepare('SELECT id FROM hours WHERE start_wall_ms >= ? AND start_wall_ms < ?').all(from, to) as { id: number }[]
    for (const { id } of ids) {
      const h = readHour(this.db, id)
      if (!h || h.status !== 'written') continue
      out.set(h.start_wall_ms, { title: h.title, summary: h.summary, detail: h.detail, edited: h.corrected.length > 0 })
    }
    return out
  }

  day(date: string): DayView {
    const now = this.now()
    const today = dateOf(now)
    const from = startOf(date)
    const to = Math.min(startOf(date, 1), now)
    const spans = to > from ? this.spans(from, to) : []
    const visits = to > from ? this.visits(from, to) : []
    const written = to > from ? this.writtenHours(from, to) : new Map()
    const firstDay = this.firstDay()
    const isToday = date === today
    const hours: HourRow[] = []
    if (to > from) {
      const starts = hourStarts(from, to)
      const withActivity = new Set<number>()
      const byHour = new Map<number, Span[]>()
      for (const x of spans) {
        for (const h of starts) {
          if (x.e <= h || x.s >= h + HOUR_MS) continue
          const part = { ...x, s: Math.max(x.s, h), e: Math.min(x.e, h + HOUR_MS) }
          if (!byHour.has(h)) byHour.set(h, [])
          byHour.get(h)!.push(part)
          withActivity.add(h)
        }
      }
      const visitsByHour = new Map<number, VisitRow[]>()
      for (const v of visits) {
        const h = starts.findLast((s) => s <= v.t)
        if (h === undefined) continue
        if (!visitsByHour.has(h)) visitsByHour.set(h, [])
        visitsByHour.get(h)!.push(v)
        withActivity.add(h)
      }
      const active = [...withActivity].sort((a, b) => a - b)
      const currentHour = isToday ? starts[starts.length - 1]! : null
      const first = active[0] ?? currentHour
      const last = isToday ? currentHour : active[active.length - 1]
      const pause = isToday ? this.activePause(now) : null
      const stopped = isToday ? this.stoppedSince() : null
      if (first !== undefined && first !== null && last !== undefined && last !== null) {
        for (const h of starts) {
          if (h < first || h > last) continue
          const live = this.facts(byHour.get(h) ?? [])
          const f = this.withVisits(live, visitsByHour.get(h) ?? [])
          const w = written.get(h)
          const current = h === currentHour
          const empty = f.apps.length === 0
          hours.push({
            start_ms: h,
            end_ms: h + HOUR_MS,
            current,
            title: w?.title ?? null,
            summary: w?.summary ?? null,
            edited: w?.edited ?? false,
            facts: { apps: f.apps, titles: f.titles },
            gap: empty ? this.emptyHour(h, Math.min(h + HOUR_MS, now), current) : null,
            recorded_until_ms: current ? (pause?.since_wall_ms ?? stopped ?? null) : null,
            from_history: live.apps.length === 0 && !empty,
          })
        }
      }
    }
    return { date, today, hours, total_ms: this.facts(spans).total_ms, first_day: firstDay }
  }

  /** The windows and pages in `focus`, each with its first and last sighting across `context`. */
  sources(focus: readonly Span[], context: readonly Span[]): Source[] {
    const key = (x: Span) => `${x.app_id}\u0000${x.url ?? ''}\u0000${x.title ?? ''}`
    const map = new Map<string, Source>()
    for (const x of focus) {
      const k = key(x)
      const s = map.get(k)
      if (s) {
        s.ms += x.e - x.s
        continue
      }
      map.set(k, {
        kind: x.url ? 'page' : 'window',
        app: { id: x.app_id, name: x.app_name, ms: 0 },
        title: x.title ?? x.site ?? x.app_name,
        url: x.url,
        site: x.site,
        first_ms: x.s,
        last_ms: x.e,
        ms: x.e - x.s,
      })
    }
    for (const x of context) {
      const s = map.get(key(x))
      if (!s) continue
      s.first_ms = Math.min(s.first_ms, x.s)
      s.last_ms = Math.max(s.last_ms, x.e)
    }
    return [...map.values()].sort((a, b) => b.ms - a.ms)
  }

  /** Each page opened, once, with its first and last visit. */
  visitSources(visits: readonly VisitRow[]): Source[] {
    const map = new Map<string, Source>()
    for (const v of visits) {
      const k = `${v.app_id}\u0000${v.url}`
      const s = map.get(k)
      if (s) {
        s.last_ms = v.t
        continue
      }
      map.set(k, { kind: 'visit', app: { id: v.app_id, name: v.app_name, ms: 0 }, title: v.title ?? v.site ?? v.url, url: v.url, site: v.site, first_ms: v.t, last_ms: v.t, ms: 0 })
    }
    return [...map.values()]
  }

  recordedDays(month: string): string[] {
    const from = startOf(`${month}-01`)
    const to = startOf(`${month}-01`, 40)
    const cutoff = this.cutoff()
    const rows = this.db
      .prepare(
        `SELECT DISTINCT CAST((start_wall_ms + tz_offset_min * 60000) / 86400000 AS INTEGER) AS d FROM intervals
         WHERE start_wall_ms >= ? AND start_wall_ms < ?
         UNION SELECT DISTINCT CAST((event_wall_ms + tz_offset_min * 60000) / 86400000 AS INTEGER) FROM observations
         WHERE kind = 'visit' AND event_wall_ms >= ? AND event_wall_ms < ?`,
      )
      .all(Math.max(from - DAY_MS, cutoff ?? Number.MIN_SAFE_INTEGER), to, Math.max(from - DAY_MS, cutoff ?? Number.MIN_SAFE_INTEGER), to) as { d: number }[]
    const days = new Set<string>()
    for (const r of rows) {
      const utc = new Date(r.d * DAY_MS)
      days.add(`${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, '0')}-${String(utc.getUTCDate()).padStart(2, '0')}`)
    }
    // A day whose every interval a pending deletion covers is not marked.
    return [...days].filter((d) => d.startsWith(month) && (this.tombstones().length === 0 || this.spans(startOf(d), startOf(d, 1)).length > 0 || this.visits(startOf(d), startOf(d, 1)).length > 0)).sort()
  }

  recording(): RecordingView {
    const now = this.now()
    const pause = this.activePause(now)
    const titles = this.db
      .prepare(`SELECT detail FROM capture_gaps WHERE reason = 'titles_unavailable' AND end_wall_ms IS NULL ORDER BY start_wall_ms DESC LIMIT 1`)
      .get() as { detail: string | null } | undefined
    const run = this.db.prepare('SELECT last_heartbeat_wall_ms AS hb FROM capture_runs ORDER BY started_wall_ms DESC LIMIT 1').get() as { hb: number | null } | undefined
    const today = startOf(dateOf(now))
    const firstToday = this.db.prepare('SELECT min(start_wall_ms) AS s FROM intervals WHERE start_wall_ms >= ?').get(today) as { s: number | null }
    let agents: RecordingView['agents'] = []
    try {
      agents = this.db.prepare(`SELECT agent, state FROM agent_health WHERE state != 'ok'`).all() as RecordingView['agents']
    } catch {
      // No agent tables until agent sessions were turned on once.
    }
    return {
      pause: pause ? { since_ms: pause.since_wall_ms, until_ms: pause.until_wall_ms } : null,
      titles: titles ? (((titles.detail ? (JSON.parse(titles.detail) as { state?: string }).state : null) ?? 'degraded') as RecordingView['titles']) : 'ok',
      stopped_since_ms: this.stoppedSince(),
      last_heartbeat_ms: run?.hb ?? null,
      first_day: this.firstDay(),
      today_first_ms: firstToday.s,
      agents,
      browsers: this.browsers(),
    }
  }

  private browsers(): RecordingView['browsers'] {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(STATUS_KEY) as { value: string } | undefined
    return r ? (JSON.parse(r.value) as RecordingView['browsers']) : []
  }

  appPath(id: string): string | null {
    const r = this.db
      .prepare(`SELECT o.app_path FROM intervals i JOIN observations o ON o.id = i.obs_id WHERE i.app_id = ? AND o.app_path IS NOT NULL ORDER BY i.start_wall_ms DESC LIMIT 1`)
      .get(id) as { app_path: string } | undefined
    return r?.app_path ?? null
  }
}

/** A facts hour's title: the apps it was spent in, longest first. */
export function factsTitle(apps: readonly AppTime[]): string {
  return apps
    .slice(0, 3)
    .map((a) => a.name)
    .join(' · ')
}
