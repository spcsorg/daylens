// Retrieval's own read-only view of the database, for search, Ask and the MCP server. It never migrates or writes:
// the capture service owns the schema, and a schema this build was not written for is refused, not guessed at.
import Database from 'better-sqlite3'
import { presenceFromCapture } from '../capture/agents/attribution.ts'
import { dbHostLookup, resolveHost } from '../capture/agents/store.ts'
import type { Agent } from '../capture/agents/types.ts'
import { HOUR_MS, hoursOf, MAX_INTERVAL_MS } from '../storage/derive.ts'
import { readHour, type Hour } from '../storage/hours.ts'
import { matchesSite, pendingTombstones, type Tombstone } from '../storage/rules.ts'
import { STORAGE_MIGRATIONS } from '../storage/schema.ts'

export const KNOWN_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([4])

export class UnknownSchemaError extends Error {}

export type SourceKind = 'page' | 'file' | 'window'

export interface Source {
  kind: SourceKind
  app_id: string | null
  app_name: string | null
  // The window or page title it was seen under; for a file, the title the name was read from.
  title: string | null
  url: string | null
  file: string | null
  ms: number
  first_wall_ms: number
  last_wall_ms: number
}

export interface AppTime {
  app_id: string | null
  app_name: string | null
  ms: number
}

export interface HourGap {
  reason: string
  ms: number
}

export interface HourView {
  start_wall_ms: number
  end_wall_ms: number
  // From the recorded activity; null for an hour that has only written text.
  tz_offset_min: number | null
  // The written or corrected hour as every screen shows it; null while the hour is facts only.
  hour: Hour | null
  recorded_ms: number
  apps: AppTime[]
  sources: Source[]
  gaps: HourGap[]
}

export interface AgentTurn {
  start_wall_ms: number
  // The turn's end, else its last activity: the agent never counts as working past it.
  end_wall_ms: number
  end_state: string | null
}

export interface AgentSessionWork {
  agent: string
  session_id: string
  origin: string
  project_dir: string | null
  branch: string | null
  // The app the session ran in, when known.
  app_id: string | null
  turns: AgentTurn[]
  // When the person sent a message to the agent; what was said is never read.
  user_messages_wall_ms: number[]
}

interface IntervalRow {
  start_wall_ms: number
  end_wall_ms: number
  tz_offset_min: number
  app_id: string | null
  app_name: string | null
  title: string | null
  url: string | null
  site: string | null
  files: string
}

/** The open, read-only connection to a database whose schema this build knows. */
export function openReadOnly(file: string): Database.Database {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    checkSchema(db)
  } catch (err) {
    db.close()
    throw err
  }
  return db
}

export function checkSchema(db: Database.Database): void {
  const meta = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'migrations')`).all()
  if (meta.length < 2) throw new UnknownSchemaError('this is not a Daylens V2 database that storage has set up')
  const v = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined
  if (!v || !KNOWN_SCHEMA_VERSIONS.has(Number(v.value))) throw new UnknownSchemaError(`unsupported schema version ${v?.value ?? 'none'}`)
  const applied = new Set((db.prepare('SELECT name FROM migrations').all() as { name: string }[]).map((r) => r.name))
  const missing = STORAGE_MIGRATIONS.filter((m) => !applied.has(m.name)).map((m) => m.name)
  if (missing.length > 0) throw new UnknownSchemaError(`storage has not finished setting up this database (missing ${missing.join(', ')})`)
}

/** What remains of [s, e) once every pending deletion that covers the row has taken its span out. */
function fenced(i: IntervalRow, pending: readonly Tombstone[]): [number, number][] {
  let parts: [number, number][] = [[i.start_wall_ms, i.end_wall_ms]]
  for (const t of pending) {
    const covers = t.kind === 'range' || (t.kind === 'source' ? i.app_id?.toLowerCase() === t.app_id : matchesSite(i.site?.toLowerCase().replace(/^www\./, '') ?? null, t.site!))
    if (!covers) continue
    const from = t.from_wall_ms ?? Number.NEGATIVE_INFINITY
    const to = t.to_wall_ms ?? Number.POSITIVE_INFINITY
    parts = parts.flatMap(([s, e]): [number, number][] => {
      if (e <= from || s >= to) return [[s, e]]
      const out: [number, number][] = []
      if (s < from) out.push([s, from])
      if (e > to) out.push([to, e])
      return out
    })
  }
  return parts
}

function sourcesOf(i: IntervalRow): { kind: SourceKind; key: string; file: string | null }[] {
  if (i.url) return [{ kind: 'page', key: `p\u0000${i.url}`, file: null }]
  const files = i.files ? i.files.split(' ').filter(Boolean) : []
  if (files.length > 0) return files.map((f) => ({ kind: 'file' as const, key: `f\u0000${(i.app_id ?? '').toLowerCase()}\u0000${f.toLowerCase()}`, file: f }))
  if (i.title) return [{ kind: 'window', key: `w\u0000${(i.app_id ?? '').toLowerCase()}\u0000${i.title}`, file: null }]
  return []
}

export class Reader {
  readonly db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  static open(file: string): Reader {
    return new Reader(openReadOnly(file))
  }

  close(): void {
    this.db.close()
  }

  /**
   * Reads the search index and its entries once, in order, so the first searches after the reader opens do not wait
   * on scattered disk reads; the system keeps the file in its cache, not this process. Returns the bytes read.
   */
  warmSearch(): number {
    const sum = (sql: string) => this.db.prepare(sql).pluck().get() as number
    return (
      sum('SELECT coalesce(sum(length(block)), 0) FROM search_data') +
      sum('SELECT coalesce(sum(length(sz)), 0) FROM search_docsize') +
      sum(`SELECT coalesce(sum(length(title) + length(url) + length(files) + length(hour_text)), 0) FROM search_docs`)
    )
  }

  /** The hour as every screen shows it (corrections win, pending deletions already applied), or null. */
  writtenHour(id: number): Hour | null {
    return readHour(this.db, id)
  }

  /** Each local hour that starts in [from, to) and has recorded activity or a written hour, oldest first. */
  hours(fromWallMs: number, toWallMs: number): HourView[] {
    return this.db.transaction(() => this.hoursNow(fromWallMs, toWallMs))()
  }

  hourAt(startWallMs: number): HourView | null {
    return this.hours(startWallMs, startWallMs + 1).find((h) => h.start_wall_ms === startWallMs) ?? null
  }

  private hoursNow(from: number, to: number): HourView[] {
    const pending = pendingTombstones(this.db)
    // An hour that starts inside [from, to) can reach an hour past `to` in a zone east of UTC; read one hour either side.
    const rows = this.db
      .prepare(
        `SELECT start_wall_ms, end_wall_ms, tz_offset_min, app_id, app_name, title, url, site, files FROM intervals
         WHERE start_wall_ms >= ? AND start_wall_ms < ? AND end_wall_ms > ? ORDER BY start_wall_ms, id`,
      )
      .all(from - HOUR_MS - MAX_INTERVAL_MS, to + HOUR_MS, from - HOUR_MS) as IntervalRow[]
    const byHour = new Map<number, { tz: number; apps: Map<string, AppTime>; sources: Map<string, Source>; recorded: number }>()
    for (const i of rows) {
      for (const [s, e] of fenced(i, pending)) {
        for (const h of hoursOf(s, e, i.tz_offset_min)) {
          if (h < from || h >= to) continue
          const cs = Math.max(s, h)
          const ce = Math.min(e, h + HOUR_MS)
          if (ce < cs) continue
          const ms = ce - cs
          let slot = byHour.get(h)
          if (!slot) byHour.set(h, (slot = { tz: i.tz_offset_min, apps: new Map(), sources: new Map(), recorded: 0 }))
          slot.recorded += ms
          const appKey = (i.app_id ?? '').toLowerCase()
          const app = slot.apps.get(appKey) ?? { app_id: i.app_id, app_name: i.app_name, ms: 0 }
          app.ms += ms
          slot.apps.set(appKey, app)
          for (const src of sourcesOf(i)) {
            const prev = slot.sources.get(src.key)
            if (prev) {
              prev.ms += ms
              prev.first_wall_ms = Math.min(prev.first_wall_ms, cs)
              if (ce >= prev.last_wall_ms) {
                prev.last_wall_ms = ce
                prev.title = i.title
              }
            } else {
              slot.sources.set(src.key, { kind: src.kind, app_id: i.app_id, app_name: i.app_name, title: i.title, url: i.url, file: src.file, ms, first_wall_ms: cs, last_wall_ms: ce })
            }
          }
        }
      }
    }
    const written = this.db.prepare('SELECT id, start_wall_ms FROM hours WHERE start_wall_ms >= ? AND start_wall_ms < ? ORDER BY start_wall_ms').all(from, to) as { id: number; start_wall_ms: number }[]
    const hourRows = new Map<number, Hour>()
    for (const w of written) {
      const h = readHour(this.db, w.id)
      if (h) hourRows.set(w.start_wall_ms, h)
    }
    const starts = [...new Set([...byHour.keys(), ...hourRows.keys()])].sort((a, b) => a - b)
    const ends = new Map(starts.map((s) => [s, hourRows.get(s)?.end_wall_ms ?? s + HOUR_MS]))
    const gaps = starts.length ? this.gapsOver(starts[0]!, Math.max(...ends.values())) : () => []
    return starts.map((start) => {
      const slot = byHour.get(start)
      const hour = hourRows.get(start) ?? null
      const end = ends.get(start)!
      return {
        start_wall_ms: start,
        end_wall_ms: end,
        tz_offset_min: slot?.tz ?? null,
        hour,
        recorded_ms: slot?.recorded ?? 0,
        apps: [...(slot?.apps.values() ?? [])].sort((a, b) => b.ms - a.ms),
        sources: [...(slot?.sources.values() ?? [])].sort((a, b) => b.ms - a.ms || a.first_wall_ms - b.first_wall_ms),
        gaps: gaps(start, end),
      }
    })
  }

  /**
   * Agent sessions with a turn in [from, to), as a pending deletion will leave them: a deleted range removes turns that
   * begin in it and cuts turns that cross its start, and a deleted app removes the sessions that ran in it. Null when
   * the agent reader has never been enabled on this database.
   */
  agentWork(fromWallMs: number, toWallMs: number): AgentSessionWork[] | null {
    if (!this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_turns'`).get()) return null
    return this.db.transaction(() => this.agentWorkNow(fromWallMs, toWallMs))()
  }

  private agentWorkNow(from: number, to: number): AgentSessionWork[] {
    const pending = pendingTombstones(this.db)
    const ranges = pending.filter((t) => t.kind === 'range').map((t) => [t.from_wall_ms ?? Number.NEGATIVE_INFINITY, t.to_wall_ms ?? Number.POSITIVE_INFINITY] as const)
    const apps = new Set(pending.filter((t) => t.kind === 'source').map((t) => t.app_id!))
    const hosts = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_hosts'`).get() ? dbHostLookup(this.db) : null
    const turns = this.db
      .prepare(
        `SELECT t.agent, t.session_id, t.start_wall_ms, coalesce(t.end_wall_ms, t.last_activity_wall_ms) AS end_wall_ms, t.end_state,
                coalesce(s.origin, 'interactive') AS origin, coalesce(t.project_dir, s.project_dir) AS project_dir, coalesce(t.branch, s.branch) AS branch
         FROM agent_turns t LEFT JOIN agent_sessions s ON s.agent = t.agent AND s.session_id = t.session_id
         WHERE t.replayed = 0 AND t.start_wall_ms < ? AND coalesce(t.end_wall_ms, t.last_activity_wall_ms) >= ? ORDER BY t.start_wall_ms, t.id`,
      )
      .all(to, from) as (AgentTurn & { agent: Agent; session_id: string; origin: string; project_dir: string | null; branch: string | null })[]
    const sessions = new Map<string, AgentSessionWork>()
    for (const t of turns) {
      if (ranges.some(([a, b]) => t.start_wall_ms >= a && t.start_wall_ms < b)) continue
      const end = Math.min(t.end_wall_ms, ...ranges.filter(([a]) => a > t.start_wall_ms).map(([a]) => a))
      if (end < from) continue
      const host = hosts ? resolveHost(hosts, t.agent, t.session_id, t.start_wall_ms) : null
      if (host?.app_id && apps.has(host.app_id.toLowerCase())) continue
      const key = `${t.agent}\u0000${t.session_id}`
      let s = sessions.get(key)
      if (!s) sessions.set(key, (s = { agent: t.agent, session_id: t.session_id, origin: t.origin, project_dir: t.project_dir, branch: t.branch, app_id: host?.app_id ?? null, turns: [], user_messages_wall_ms: [] }))
      s.turns.push({ start_wall_ms: t.start_wall_ms, end_wall_ms: end, end_state: end < t.end_wall_ms ? null : t.end_state })
    }
    const acts = this.db.prepare(`SELECT wall_ms FROM agent_events WHERE kind = 'user' AND detail IN ('prompt', 'queued', 'steer', 'answer') AND agent = ? AND session_id = ? AND wall_ms >= ? AND wall_ms < ? ORDER BY wall_ms`)
    for (const s of sessions.values()) {
      for (const { wall_ms } of acts.all(s.agent, s.session_id, from, to) as { wall_ms: number }[]) {
        if (s.turns.some((t) => wall_ms >= t.start_wall_ms && wall_ms <= t.end_wall_ms)) s.user_messages_wall_ms.push(wall_ms)
      }
    }
    return [...sessions.values()]
  }

  /**
   * Gaps in [from, to), read once and then cut to each hour: the presence read looks back for the last state before
   * `from`, which costs about as much as the read itself on a large file, so it must not run once per hour.
   */
  private gapsOver(from: number, to: number): (hourFrom: number, hourTo: number) => HourGap[] {
    const spans: { reason: string; s: number; e: number }[] = this.db
      .prepare(`SELECT reason, start_wall_ms AS s, coalesce(end_wall_ms, ?) AS e FROM capture_gaps WHERE scope = 'all' AND start_wall_ms < ? AND coalesce(end_wall_ms, ?) > ?`)
      .all(to, to, to, from) as { reason: string; s: number; e: number }[]
    const presence = presenceFromCapture(this.db, from, to)
    for (const k of ['locked', 'asleep', 'idle'] as const) for (const p of presence[k]) spans.push({ reason: k, s: p.start, e: p.end })
    return (hourFrom, hourTo) => {
      const out = new Map<string, number>()
      for (const g of spans) {
        const ms = Math.min(g.e, hourTo) - Math.max(g.s, hourFrom)
        if (ms > 0) out.set(g.reason, (out.get(g.reason) ?? 0) + ms)
      }
      return [...out].map(([reason, ms]) => ({ reason, ms })).sort((a, b) => b.ms - a.ms)
    }
  }
}
