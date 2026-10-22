// Intervals and activity search documents, derived from observations. Both can be dropped and rebuilt.
import type Database from 'better-sqlite3'
import { MAX_ROW_SPAN_MS } from '../capture/store.ts'
import { immediate } from './tx.ts'
import { hasColumn } from './migrations.ts'

export const HOUR_MS = 3_600_000
// How far past its last sighting (a focus line, or a heartbeat while nothing stops the row) a focus row may run toward
// the next one.
export const CONTINUITY_MS = 90_000

export function hourStart(wallMs: number, tzOffsetMin: number): number {
  const off = tzOffsetMin * 60_000
  return Math.floor((wallMs + off) / HOUR_MS) * HOUR_MS - off
}

// No row spans more than MAX_ROW_SPAN_MS (the store enforces it) and an interval runs at most CONTINUITY_MS past its
// row; together they bound the scans for rows crossing a time.
export const MAX_INTERVAL_MS = MAX_ROW_SPAN_MS + CONTINUITY_MS

/** Every local hour that [start, end] touches; a zero-length interval belongs to the hour it starts in. */
export function hoursOf(startWallMs: number, endWallMs: number, tzOffsetMin: number): number[] {
  const out = [hourStart(startWallMs, tzOffsetMin)]
  for (let h = out[0]! + HOUR_MS; h < endWallMs; h += HOUR_MS) out.push(h)
  return out
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

export interface ObsRow {
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

const STOPS = `(kind = 'session' AND state IN ('locked', 'console_disconnect', 'remote_disconnect', 'logoff')) OR (kind = 'power' AND state IN ('sleep', 'display_off')) OR (kind = 'input' AND state = 'idle')`

function isStop(r: ObsRow): boolean {
  return (
    (r.kind === 'session' && (r.state === 'locked' || r.state === 'console_disconnect' || r.state === 'remote_disconnect' || r.state === 'logoff')) ||
    (r.kind === 'power' && (r.state === 'sleep' || r.state === 'display_off')) ||
    isIdle(r)
  )
}

// Capture ends the window in front at the last input when idle begins, so an interval ends at its last sighting.
function isIdle(r: ObsRow): boolean {
  return r.kind === 'input' && r.state === 'idle'
}

/** Turns observations (focus rows, the browser pages within them, and the events that end them), in order, into intervals. */
// The earliest point in (start, end) where this row's coverage must stop (a capture gap, a pause, a deletion), else end.
export type Cut = (startWallMs: number, endWallMs: number, row: ObsRow) => number
// Whether a row may appear at all; a refused row (deleted, paused) still ends the row before it.
export type Admit = (row: ObsRow) => boolean

export class IntervalBuilder {
  // The row in front (a focus row), and the row whose interval is open: the focus row itself, or a page of it.
  private front: ObsRow | null = null
  private open: ObsRow | null = null
  private readonly emit: (i: IntervalRow) => void
  private readonly cut: Cut
  private readonly admit: Admit

  constructor(emit: (i: IntervalRow) => void, cut: Cut = (_s, e) => e, admit: Admit = () => true) {
    this.emit = emit
    this.cut = cut
    this.admit = admit
  }

  push(r: ObsRow): void {
    if (r.kind === 'focus') {
      this.close(r.event_wall_ms)
      this.front = this.open = this.admit(r) ? r : null
    } else if (r.kind === 'page') {
      // A page divides the time of the browser in front; a page of any other app was not what was in front.
      if (this.front === null || this.front.app_id?.toLowerCase() !== r.app_id?.toLowerCase()) return
      this.close(r.event_wall_ms)
      this.open = this.admit(r) ? r : null
    } else if (isStop(r)) {
      this.close(isIdle(r) ? Math.min(r.event_wall_ms, this.front?.last_seen_wall_ms ?? r.event_wall_ms) : r.event_wall_ms)
      this.front = null
    }
  }

  finish(): void {
    this.close(null)
  }

  private close(nextWallMs: number | null): void {
    const o = this.open
    const f = this.front
    if (!o || !f) return
    this.open = null
    // The browser's own row is what keeps being sighted while it stays in front; a page lasts as long.
    let end = f.last_seen_wall_ms
    // Up to the next row, but never more than CONTINUITY_MS past the last sighting.
    if (nextWallMs !== null) end = Math.min(Math.max(end, Math.min(nextWallMs, end + CONTINUITY_MS)), nextWallMs)
    end = Math.max(this.cut(o.event_wall_ms, end, o), o.event_wall_ms)
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
  private readonly admit: Admit

  constructor(db: Database.Database, opts: { cut?: Cut; admit?: Admit } = {}) {
    this.db = db
    const firstGap = db.prepare(`SELECT min(start_wall_ms) AS t FROM capture_gaps WHERE scope = 'all' AND start_wall_ms > ? AND start_wall_ms < ?`)
    this.cut = (s, e, row) => {
      const g = (firstGap.get(s, e) as { t: number | null }).t
      const c = opts.cut ? opts.cut(s, e, row) : e
      return Math.min(c, g ?? e)
    }
    this.admit = opts.admit ?? (() => true)
    // Page addresses arrive with the browser step; until then observations have no url column.
    const url = hasColumn(db, 'observations', 'url') ? 'url' : 'NULL AS url'
    this.obsColumns = `id, kind, state, event_wall_ms, last_seen_wall_ms, tz_offset_min, app_id, app_name, title, title_state, ${url}`
    this.upsertInterval = db.prepare(`
      INSERT INTO intervals (obs_id, start_wall_ms, end_wall_ms, tz_offset_min, app_id, app_name, title, title_state, url, site, files)
      VALUES (@obs_id, @start_wall_ms, @end_wall_ms, @tz_offset_min, @app_id, @app_name, @title, @title_state, @url, @site, @files)
      ON CONFLICT (obs_id) DO UPDATE SET start_wall_ms = excluded.start_wall_ms, end_wall_ms = excluded.end_wall_ms,
        tz_offset_min = excluded.tz_offset_min, app_id = excluded.app_id, app_name = excluded.app_name, title = excluded.title,
        title_state = excluded.title_state, url = excluded.url, site = excluded.site, files = excluded.files`)
    this.upsertDoc = db.prepare(`
      INSERT INTO search_docs (kind, hour_start_wall_ms, app_id, app_name, title, url, site, files, first_wall_ms, last_wall_ms)
      VALUES ('activity', @hour, coalesce(@app_id, ''), @app_name, coalesce(@title, ''), coalesce(@url, ''), @site, @files, @start_wall_ms, @end_wall_ms)
      ON CONFLICT (kind, hour_start_wall_ms, app_id, title, url) DO UPDATE SET
        first_wall_ms = min(first_wall_ms, excluded.first_wall_ms), last_wall_ms = max(last_wall_ms, excluded.last_wall_ms)`)
  }

  private write(i: IntervalRow): void {
    this.upsertInterval.run(i)
    this.writeDocs(i)
  }

  private writeDocs(i: IntervalRow, onlyHour?: number): void {
    if (i.title === null && i.url === null) return
    for (const h of hoursOf(i.start_wall_ms, i.end_wall_ms, i.tz_offset_min)) {
      if (onlyHour !== undefined && h !== onlyHour) continue
      this.upsertDoc.run({
        ...i,
        title: nfc(i.title),
        files: nfc(i.files),
        hour: h,
        start_wall_ms: Math.max(i.start_wall_ms, h),
        end_wall_ms: Math.max(Math.min(i.end_wall_ms, h + HOUR_MS), Math.max(i.start_wall_ms, h)),
      })
    }
  }

  /** After a flush: re-derive, in event-time order, from the focus row before the earliest touched observation to the end. */
  refresh(touchedIds: readonly number[]): void {
    if (touchedIds.length === 0) return
    let minEvent: number | null = null
    for (let i = 0; i < touchedIds.length; i += 500) {
      const chunk = touchedIds.slice(i, i + 500)
      const m = (this.db.prepare(`SELECT min(event_wall_ms) AS t FROM observations WHERE id IN (${chunk.map(() => '?').join(',')})`).get(...chunk) as { t: number | null }).t
      if (m !== null && (minEvent === null || m < minEvent)) minEvent = m
    }
    if (minEvent === null) return
    const start = this.startKey(minEvent)
    immediate(this.db, () => this.derive(start, null))
  }

  /** Brings derived state up to date from the mark capture commits with its rows, and clears the mark with it. */
  refreshFromMark(): void {
    immediate(this.db, () => {
      const mark = this.db.prepare(`SELECT value FROM meta WHERE key = 'derive_from'`).get() as { value: string } | undefined
      if (!mark) return
      this.derive(this.startKey(Number(mark.value)), null)
      this.db.prepare(`DELETE FROM meta WHERE key = 'derive_from'`).run()
    })
  }

  /**
   * One resumable step of a backfill from `meta.derive_backfill_from`: about `rows` observations, then the mark moves
   * on in the same transaction. Returns false once the backfill is complete.
   */
  backfillStep(rows = 2000): boolean {
    return immediate(this.db, () => {
      const mark = this.db.prepare(`SELECT value FROM meta WHERE key = 'derive_backfill_from'`).get() as { value: string } | undefined
      if (!mark) return false
      const from = Number(mark.value)
      const edge = this.db
        .prepare(`SELECT event_wall_ms AS e FROM observations WHERE event_wall_ms >= ? AND (kind = 'focus' OR ${STOPS}) ORDER BY event_wall_ms LIMIT 1 OFFSET ?`)
        .get(from, rows) as { e: number } | undefined
      if (!edge || edge.e === from) {
        this.derive(this.startKey(from), null)
        this.db.prepare(`DELETE FROM meta WHERE key = 'derive_backfill_from'`).run()
        return false
      }
      this.derive(this.startKey(from), edge.e)
      this.db.prepare(`UPDATE meta SET value = ? WHERE key = 'derive_backfill_from'`).run(String(edge.e))
      return true
    })
  }

  /**
   * One step of re-deriving the rows around [from, to] (a deletion trimmed, split or removed them): about `rows`
   * observations from `from`. Returns where the next step starts, or null when the range is done.
   */
  rederiveStep(fromWallMs: number, toWallMs: number, rows = 1000): number | null {
    const edge = this.db
      .prepare(`SELECT event_wall_ms AS e FROM observations WHERE event_wall_ms >= ? AND (kind = 'focus' OR ${STOPS}) ORDER BY event_wall_ms LIMIT 1 OFFSET ?`)
      .get(fromWallMs, rows) as { e: number } | undefined
    if (!edge || edge.e > toWallMs || edge.e === fromWallMs) {
      this.derive(this.startKey(fromWallMs), toWallMs)
      return null
    }
    this.derive(this.startKey(fromWallMs), edge.e)
    return edge.e
  }

  /** Drops every interval and activity document and derives them again from observations. */
  rebuild(): void {
    immediate(this.db, () => {
      this.db.exec(`DELETE FROM intervals; DELETE FROM search_docs WHERE kind = 'activity'`)
      this.derive({ e: Number.MIN_SAFE_INTEGER, id: 0 }, null)
    })
  }

  // The leading range on event_wall_ms lets the index bound the scan; the OR alone would read every row each flush.
  pageSql(): string {
    return `SELECT ${this.obsColumns} FROM observations WHERE event_wall_ms >= ? AND (event_wall_ms > ? OR id >= ?) AND (kind IN ('focus', 'page') OR ${STOPS})
       ORDER BY event_wall_ms, id LIMIT 1000`
  }

  // The focus row before a time: its end depends on what follows it.
  private startKey(wallMs: number): { e: number; id: number } {
    const r = this.db.prepare(`SELECT event_wall_ms AS e, id FROM observations WHERE kind = 'focus' AND event_wall_ms < ? ORDER BY event_wall_ms DESC, id DESC LIMIT 1`).get(wallMs) as
      | { e: number; id: number }
      | undefined
    return r ?? { e: wallMs, id: 0 }
  }

  /** Re-derives the activity documents of the given hours from the intervals that remain (after a deletion). */
  rebuildDocs(hourStarts: Iterable<number>): void {
    const del = this.db.prepare(`DELETE FROM search_docs WHERE kind = 'activity' AND hour_start_wall_ms = ?`)
    // Any interval that touches hour h, whatever its offset (an hour either side covers half-hour zones); filtered exactly.
    const rows = this.db.prepare(`SELECT * FROM intervals WHERE start_wall_ms >= ? AND start_wall_ms < ? AND end_wall_ms >= ? ORDER BY id`)
    for (const h of hourStarts) {
      del.run(h)
      for (const i of rows.all(h - MAX_INTERVAL_MS, h + 2 * HOUR_MS, h - HOUR_MS) as IntervalRow[]) {
        if (hoursOf(i.start_wall_ms, i.end_wall_ms, i.tz_offset_min).includes(h)) this.writeDocs(i, h)
      }
    }
  }

  // In event-time order (late lines and split rows have newer ids than their neighbours). With `until`, stops after the
  // first row past it, which only closes the row before; without, every open row is closed at the end.
  private derive(start: { e: number; id: number }, until: number | null): void {
    const b = new IntervalBuilder((i) => this.write(i), this.cut, this.admit)
    // Pages, not an open iterator: better-sqlite3 cannot write on a connection while a read is still iterating.
    const page = this.db.prepare(this.pageSql())
    let key = start
    for (;;) {
      const rows = page.all(key.e, key.e, key.id) as ObsRow[]
      for (const r of rows) {
        b.push(r)
        if (until !== null && r.event_wall_ms > until) return
      }
      if (rows.length < 1000) break
      const last = rows[rows.length - 1]!
      key = { e: last.event_wall_ms, id: last.id + 1 }
    }
    b.finish()
  }
}
