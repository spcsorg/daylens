// Intervals and activity search documents, derived from observations. Both can be dropped and rebuilt.
import type Database from 'better-sqlite3'
import { hasColumn } from './migrations.ts'

export const HOUR_MS = 3_600_000
// How far past its last sighting a focus row may run toward the next one: the helper reconciles every 60 s.
export const CONTINUITY_MS = 90_000

export function hourStart(wallMs: number, tzOffsetMin: number): number {
  const off = tzOffsetMin * 60_000
  return Math.floor((wallMs + off) / HOUR_MS) * HOUR_MS - off
}

export function siteOf(url: string | null): string | null {
  if (!url) return null
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host.startsWith('www.') ? host.slice(4) : host || null
  } catch {
    return null
  }
}

const FILE_NAME =
  /[\p{L}\p{N}_@+-][\p{L}\p{N}_@+.-]*\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|txt|py|rb|go|rs|swift|kt|java|cs|c|h|cpp|hpp|m|mm|sql|sh|zsh|yml|yaml|toml|xml|html|css|scss|vue|svelte|pdf|docx?|xlsx?|pptx?|csv|key|pages|numbers|png|jpe?g|gif|svg|fig|sketch|psd|ai|mp4|mov|ipynb|lock|env|log)\b/giu

// The index tokenizer folds only composed accents; decomposed text (common in macOS file names) would split at each mark.
export function nfc(s: string | null): string | null {
  return s === null ? null : s.normalize('NFC')
}

export function filesOf(title: string | null): string {
  if (!title) return ''
  return [...new Set(title.match(FILE_NAME) ?? [])].join(' ')
}

interface ObsRow {
  id: number
  kind: string
  state: string | null
  event_wall_ms: number
  last_seen_wall_ms: number
  tz_offset_min: number
  app_id: string | null
  app_name: string | null
  title: string | null
  title_state: string | null
  url: string | null
}

export interface IntervalRow {
  obs_id: number
  start_wall_ms: number
  end_wall_ms: number
  tz_offset_min: number
  app_id: string | null
  app_name: string | null
  title: string | null
  title_state: string | null
  url: string | null
  site: string | null
  files: string
}

const STOPS = `(kind = 'session' AND state IN ('locked', 'console_disconnect', 'remote_disconnect', 'logoff')) OR (kind = 'power' AND state IN ('sleep', 'display_off'))`

function isStop(r: ObsRow): boolean {
  return (
    (r.kind === 'session' && (r.state === 'locked' || r.state === 'console_disconnect' || r.state === 'remote_disconnect' || r.state === 'logoff')) ||
    (r.kind === 'power' && (r.state === 'sleep' || r.state === 'display_off'))
  )
}

/** Turns observations (focus rows and the events that end them), in id order, into intervals. */
// The earliest point in (start, end) where coverage stopped (a capture gap, a pause, a deleted range), else end.
export type Cut = (startWallMs: number, endWallMs: number) => number

export class IntervalBuilder {
  private open: ObsRow | null = null
  private readonly emit: (i: IntervalRow) => void
  private readonly cut: Cut

  constructor(emit: (i: IntervalRow) => void, cut: Cut = (_s, e) => e) {
    this.emit = emit
    this.cut = cut
  }

  push(r: ObsRow): void {
    if (r.kind === 'focus') {
      this.close(r.event_wall_ms)
      this.open = r
    } else if (isStop(r)) this.close(r.event_wall_ms)
  }

  finish(): void {
    this.close(null)
  }

  private close(nextWallMs: number | null): void {
    const o = this.open
    if (!o) return
    this.open = null
    let end = o.last_seen_wall_ms
    // Up to the next row, but never more than CONTINUITY_MS past the last sighting.
    if (nextWallMs !== null) end = Math.min(Math.max(end, Math.min(nextWallMs, end + CONTINUITY_MS)), nextWallMs)
    end = Math.max(this.cut(o.event_wall_ms, end), o.event_wall_ms)
    this.emit({
      obs_id: o.id,
      start_wall_ms: o.event_wall_ms,
      end_wall_ms: end,
      tz_offset_min: o.tz_offset_min,
      app_id: o.app_id,
      app_name: o.app_name,
      title: o.title,
      title_state: o.title_state,
      url: o.url,
      site: siteOf(o.url),
      files: filesOf(o.title),
    })
  }
}

export class Derived {
  private readonly db: Database.Database
  private readonly obsColumns: string
  private readonly upsertInterval: Database.Statement
  private readonly upsertDoc: Database.Statement
  private readonly cut: Cut

  constructor(db: Database.Database, cut?: Cut) {
    this.db = db
    const firstGap = db.prepare(`SELECT min(start_wall_ms) AS t FROM capture_gaps WHERE scope = 'all' AND start_wall_ms > ? AND start_wall_ms < ?`)
    this.cut = (s, e) => {
      const g = (firstGap.get(s, e) as { t: number | null }).t
      const c = cut ? cut(s, e) : e
      return Math.min(c, g ?? e)
    }
    // Page addresses arrive with the browser step; until then observations have no url column.
    const url = hasColumn(db, 'observations', 'url') ? 'url' : 'NULL AS url'
    this.obsColumns = `id, kind, state, event_wall_ms, last_seen_wall_ms, tz_offset_min, app_id, app_name, title, title_state, ${url}`
    this.upsertInterval = db.prepare(`
      INSERT INTO intervals (obs_id, start_wall_ms, end_wall_ms, tz_offset_min, app_id, app_name, title, title_state, url, site, files)
      VALUES (@obs_id, @start_wall_ms, @end_wall_ms, @tz_offset_min, @app_id, @app_name, @title, @title_state, @url, @site, @files)
      ON CONFLICT (obs_id) DO UPDATE SET start_wall_ms = excluded.start_wall_ms, end_wall_ms = excluded.end_wall_ms`)
    this.upsertDoc = db.prepare(`
      INSERT INTO search_docs (kind, hour_start_wall_ms, app_id, app_name, title, url, site, files, first_wall_ms, last_wall_ms)
      VALUES ('activity', @hour, coalesce(@app_id, ''), @app_name, coalesce(@title, ''), coalesce(@url, ''), @site, @files, @start_wall_ms, @end_wall_ms)
      ON CONFLICT (kind, hour_start_wall_ms, app_id, title, url) DO UPDATE SET
        first_wall_ms = min(first_wall_ms, excluded.first_wall_ms), last_wall_ms = max(last_wall_ms, excluded.last_wall_ms)`)
  }

  private write(i: IntervalRow): void {
    this.upsertInterval.run(i)
    if (i.title !== null || i.url !== null) this.upsertDoc.run({ ...i, title: nfc(i.title), files: nfc(i.files), hour: hourStart(i.start_wall_ms, i.tz_offset_min) })
  }

  /** After a flush: re-derive from the focus row before the earliest touched observation to the end. */
  refresh(touchedIds: readonly number[]): void {
    if (touchedIds.length === 0) return
    const min = Math.min(...touchedIds)
    const from = (this.db.prepare(`SELECT max(id) AS id FROM observations WHERE kind = 'focus' AND id < ?`).get(min) as { id: number | null }).id ?? min
    this.db.transaction(() => this.derive(from))()
  }

  /** Drops every interval and activity document and derives them again from observations. */
  rebuild(): void {
    this.db.transaction(() => {
      this.db.exec(`DELETE FROM intervals; DELETE FROM search_docs WHERE kind = 'activity'`)
      this.derive(0)
    })()
  }

  /** Re-derives the activity documents of the given hours from the intervals that remain (after a deletion). */
  rebuildDocs(hourStarts: Iterable<number>): void {
    const del = this.db.prepare(`DELETE FROM search_docs WHERE kind = 'activity' AND hour_start_wall_ms = ?`)
    const rows = this.db.prepare(`SELECT * FROM intervals WHERE start_wall_ms >= ? AND start_wall_ms < ? ORDER BY id`)
    for (const h of hourStarts) {
      del.run(h)
      // An interval belongs to hour h only if it starts within an hour of h, whatever its offset; filter exactly.
      for (const i of rows.all(h - HOUR_MS, h + HOUR_MS) as IntervalRow[]) {
        if (hourStart(i.start_wall_ms, i.tz_offset_min) === h && (i.title !== null || i.url !== null)) this.upsertDoc.run({ ...i, title: nfc(i.title), files: nfc(i.files), hour: h })
      }
    }
  }

  private derive(fromId: number): void {
    const b = new IntervalBuilder((i) => this.write(i), this.cut)
    // Pages, not an open iterator: better-sqlite3 cannot write on a connection while a read is still iterating.
    const page = this.db.prepare(`SELECT ${this.obsColumns} FROM observations WHERE id >= ? AND (kind = 'focus' OR ${STOPS}) ORDER BY id LIMIT 5000`)
    for (let from = fromId; ; ) {
      const rows = page.all(from) as ObsRow[]
      for (const r of rows) b.push(r)
      if (rows.length < 5000) break
      from = rows[rows.length - 1]!.id + 1
    }
    b.finish()
  }
}
