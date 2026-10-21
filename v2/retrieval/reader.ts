// Retrieval's own read-only view of the database, for search, Ask and the MCP server. It never migrates or writes:
// the capture service owns the schema, and a schema this build was not written for is refused, not guessed at.
import Database from 'better-sqlite3'
import { presenceFromCapture } from '../capture/agents/attribution.ts'
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

function checkSchema(db: Database.Database): void {
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
    return starts.map((start) => {
      const slot = byHour.get(start)
      const hour = hourRows.get(start) ?? null
      const end = hour?.end_wall_ms ?? start + HOUR_MS
      return {
        start_wall_ms: start,
        end_wall_ms: end,
        tz_offset_min: slot?.tz ?? null,
        hour,
        recorded_ms: slot?.recorded ?? 0,
        apps: [...(slot?.apps.values() ?? [])].sort((a, b) => b.ms - a.ms),
        sources: [...(slot?.sources.values() ?? [])].sort((a, b) => b.ms - a.ms || a.first_wall_ms - b.first_wall_ms),
        gaps: this.gaps(start, end),
      }
    })
  }

  private gaps(from: number, to: number): HourGap[] {
    const out = new Map<string, number>()
    const add = (reason: string, s: number, e: number) => {
      const ms = Math.min(e, to) - Math.max(s, from)
      if (ms > 0) out.set(reason, (out.get(reason) ?? 0) + ms)
    }
    const captured = this.db
      .prepare(`SELECT reason, start_wall_ms AS s, coalesce(end_wall_ms, ?) AS e FROM capture_gaps WHERE scope = 'all' AND start_wall_ms < ? AND coalesce(end_wall_ms, ?) > ?`)
      .all(to, to, to, from) as { reason: string; s: number; e: number }[]
    for (const g of captured) add(g.reason, g.s, g.e)
    const presence = presenceFromCapture(this.db, from, to)
    for (const k of ['locked', 'asleep', 'idle'] as const) for (const p of presence[k]) add(k, p.start, p.end)
    return [...out].map(([reason, ms]) => ({ reason, ms })).sort((a, b) => b.ms - a.ms)
  }
}
