// Step 2 storage: the single source of truth around the capture store. The capture service is the only
// writer; every other reader opens the database read-only and follows the change log (changes.ts).
import type Database from 'better-sqlite3'
import type { ExclusionRule } from '../capture/defaults.ts'
import { Privacy, type GapPoint, type ObservationRow } from '../capture/normalize.ts'
import { Store } from '../capture/store.ts'
import { ChangeBus, pruneChangeLog, type ChangeKind } from './changes.ts'
import { Derived, HOUR_MS, hoursOf, nfc, siteOf } from './derive.ts'
import { applyMigrations } from './migrations.ts'
import { STORAGE_MIGRATIONS } from './schema.ts'

const DAY_MS = 86_400_000
const PRUNE_BATCH = 500
const CHANGE_LOG_KEEP_MS = 7 * DAY_MS

export type HourField = 'title' | 'summary' | 'detail' | 'outcome' | 'suggestion'
export const HOUR_FIELDS: readonly HourField[] = ['title', 'summary', 'detail', 'outcome', 'suggestion']

export interface HourSource {
  app_id?: string
  site?: string
}

export interface HourInput {
  start_wall_ms: number
  tz: string
  status: 'facts' | 'written'
  title?: string | null
  summary?: string | null
  detail?: string | null
  outcome?: string | null
  suggestion?: string | null
  sources?: HourSource[]
  writer?: string | null
}

export interface Hour {
  id: number
  start_wall_ms: number
  end_wall_ms: number
  tz: string
  status: 'facts' | 'written'
  title: string | null
  summary: string | null
  detail: string | null
  outcome: string | null
  suggestion: string | null
  sources: HourSource[]
  writer: string | null
  version: number
  needs_rewrite: boolean
  // Fields where the user's correction replaced the written text.
  corrected: HourField[]
}

export interface Tombstone {
  id: number
  kind: 'range' | 'source' | 'site'
  from_wall_ms: number | null
  to_wall_ms: number | null
  app_id: string | null
  site: string | null
}

export interface DeletionResult {
  tombstone: number
  observations: number
  intervals: number
  searchDocs: number
  hoursRemoved: number
  hoursCleared: number
  assistantReads: number
}

export interface PauseState {
  id: number
  since_wall_ms: number
  // null: until resumed.
  until_wall_ms: number | null
  // Set once the pause is over; while null the pause is active.
  ended_wall_ms: number | null
  gap_id: number | null
}

export type PauseFor = 'hour' | 'tomorrow' | 'until_resumed'

// There is no start-of-day setting yet, so "until tomorrow" ends at the next local midnight (as on the browser branch).
export function nextLocalMidnight(nowMs: number): number {
  const d = new Date(nowMs)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

/** Where a pause stops refusing material: when it ended, else when it was set to end, else never. */
function pauseEnd(p: PauseState): number {
  return p.ended_wall_ms ?? p.until_wall_ms ?? Number.POSITIVE_INFINITY
}

export interface UsageEntry {
  kind: 'answer' | 'hour'
  provider: string
  model: string
  input_tokens: number
  output_tokens: number
  cost_micro_usd: number
  ref?: string | null
}

export interface PlanEntry {
  plan: string
  status: string
  confirmed_wall_ms: number
  expires_wall_ms?: number | null
  payload?: Record<string, unknown>
}

export interface AssistantRead {
  assistant: string
  tool: string
  from_wall_ms: number
  to_wall_ms: number
  query?: string | null
}

export interface SearchHit {
  kind: 'activity' | 'hour'
  hour_start_wall_ms: number
  app_id: string
  app_name: string | null
  title: string
  url: string
  hour_id: number | null
  first_wall_ms: number
  last_wall_ms: number
}

/** What storage needs from the live capture pipeline when shared state changes under it. */
export interface CaptureControl {
  // Forget open rows and ask the helper for current state, so no row is extended across the change.
  interrupt(): void
  setExclusions(rules: ExclusionRule[]): void
}

export class DeletedMaterialError extends Error {}

function matchesSite(site: string | null, tombSite: string): boolean {
  return site !== null && (site === tombSite || site.endsWith(`.${tombSite}`))
}

/** For every reader (screens, Ask, the MCP server): the user's latest correction of a field wins over the written text. */
export function readHour(db: Database.Database, id: number): Hour | null {
  const h = db.prepare('SELECT * FROM hours WHERE id = ?').get(id) as (Omit<Hour, 'sources' | 'needs_rewrite' | 'corrected'> & { sources: string; needs_rewrite: number }) | undefined
  if (!h) return null
  const out: Hour = { ...h, sources: JSON.parse(h.sources) as HourSource[], needs_rewrite: h.needs_rewrite === 1, corrected: [] }
  const active = db.prepare('SELECT field, text FROM corrections WHERE hour_id = ? AND undone_wall_ms IS NULL ORDER BY id').all(id) as { field: HourField; text: string }[]
  for (const c of active) {
    out[c.field] = c.text
    if (!out.corrected.includes(c.field)) out.corrected.push(c.field)
  }
  return out
}

export class Storage {
  readonly store: Store
  readonly db: Database.Database
  readonly bus: ChangeBus
  readonly derived: Derived
  private readonly now: () => number
  private capture: CaptureControl | null = null
  private tombstones: Tombstone[] = []
  private pauses: PauseState[] = []
  private retentionDays: number | null = null
  private pauseTimer: ReturnType<typeof setTimeout> | null = null
  private retentionTimer: ReturnType<typeof setTimeout> | null = null
  private readonly onError: (code: string) => void
  private prunedData = 0
  private privacy: Privacy

  constructor(store: Store, dir: string, opts: { now?: () => number; onError?: (code: string) => void } = {}) {
    this.store = store
    this.db = store.database
    this.now = opts.now ?? Date.now
    this.onError = opts.onError ?? (() => {})
    this.db.pragma('foreign_keys = ON')
    // Freed pages are overwritten, so deleted text does not linger in the file.
    this.db.pragma('secure_delete = ON')
    // The log is reused, not shrunk, after a large write (a rebuild, a big deletion); this caps what stays on disk.
    this.db.pragma('journal_size_limit = 16777216')
    applyMigrations(this.db, STORAGE_MIGRATIONS, this.now)
    this.bus = new ChangeBus(this.db, dir, this.now)
    this.derived = new Derived(this.db, (s, e) => {
      for (const t of this.tombstones) if (t.kind === 'range' && t.from_wall_ms !== null && t.from_wall_ms > s && t.from_wall_ms < e) e = t.from_wall_ms
      return e
    })
    this.loadTombstones()
    this.privacy = new Privacy(store.exclusions())
    this.loadPauses()
    this.retentionDays = this.getSetting<number>('retention_days')
    store.acceptObservation = (row) => this.admit(row)
    store.onFlushed = (ids) => {
      try {
        this.derived.refresh(ids)
      } catch (err) {
        // Derived state is rebuildable; a failure here never blocks capture.
        this.onError(`derive_${(err as { code?: string }).code ?? 'failed'}`)
      }
    }
  }

  attachCapture(control: CaptureControl): void {
    this.capture = control
  }

  /** Arms the pause and retention timers. */
  start(): void {
    const p = this.paused()
    if (p) {
      if (p.until_wall_ms !== null && this.now() >= p.until_wall_ms) this.endPause('expired')
      else this.armPauseTimer()
    }
    this.scheduleRetention(60_000)
  }

  stop(): void {
    if (this.pauseTimer) clearTimeout(this.pauseTimer)
    if (this.retentionTimer) clearTimeout(this.retentionTimer)
    this.pauseTimer = this.retentionTimer = null
  }

  // --- what may be stored --------------------------------------------------

  /** One rule for capture and import: paused, past retention, or deleted material is never written. */
  accepts(eventWallMs: number, appId: string | null, url: string | null): boolean {
    for (const p of this.pauses) if (eventWallMs >= p.since_wall_ms && eventWallMs < pauseEnd(p)) return false
    if (this.retentionDays !== null && eventWallMs < this.now() - this.retentionDays * DAY_MS) return false
    if (this.tombstones.length === 0) return true
    const site = siteOf(url)
    const app = appId?.toLowerCase() ?? null
    for (const t of this.tombstones) {
      const inRange = (t.from_wall_ms === null || eventWallMs >= t.from_wall_ms) && (t.to_wall_ms === null || eventWallMs < t.to_wall_ms)
      if (!inRange) continue
      if (t.kind === 'range') return false
      if (t.kind === 'source' && app !== null && app === t.app_id) return false
      if (t.kind === 'site' && matchesSite(site, t.site!)) return false
    }
    return true
  }

  /**
   * The one gate for every row, from capture or import. An excluded app's row becomes an excluded gap; paused,
   * expired or deleted material is dropped.
   */
  private admit(row: ObservationRow & { url?: string | null; last_seen_wall_ms?: number }): boolean {
    let aumid: string | null = null
    if (row.detail?.includes('"aumid"')) {
      try {
        aumid = (JSON.parse(row.detail) as { store?: { aumid?: string } }).store?.aumid ?? null
      } catch {
        aumid = null
      }
    }
    if (row.kind === 'focus' && this.privacy.excludes(row.app_id, row.app_path, aumid)) {
      if (this.accepts(row.event_wall_ms, null, null)) {
        const gap = this.store.openGap({ reason: 'excluded', scope: 'all', run: row.run, start: this.point(row.event_wall_ms), detail: null })
        this.store.closeGap(gap, this.point(Math.max(row.event_wall_ms, row.last_seen_wall_ms ?? row.event_wall_ms)))
      }
      return false
    }
    return this.accepts(row.event_wall_ms, row.app_id, row.url ?? null)
  }

  /** Re-import (a backup, an older Daylens): the same rules as capture, so deleted material stays deleted. */
  importObservations(rows: readonly (ObservationRow & { url?: string | null })[]): { imported: number; refused: number } {
    let imported = 0
    for (const r of rows) if (this.store.insertObservation(r) !== Store.REFUSED) imported++
    this.flushOrThrow()
    return { imported, refused: rows.length - imported }
  }

  private loadTombstones(): void {
    this.tombstones = (this.db.prepare('SELECT id, kind, from_wall_ms, to_wall_ms, app_id, site FROM deletions').all() as Tombstone[]).map((t) => ({
      ...t,
      app_id: t.app_id?.toLowerCase() ?? null,
      site: t.site?.toLowerCase() ?? null,
    }))
  }

  private flushOrThrow(): void {
    // Queued capture writes go in first, so a deletion or pause applies to everything captured before it.
    if (!this.store.flush()) throw new Error('storage is failing; nothing was changed')
  }

  private point(wallMs = this.now()): GapPoint {
    return { wall_ms: wallMs, mono_us: null, boot: null }
  }

  // --- deletion --------------------------------------------------------------

  deleteLast(ms: number): DeletionResult {
    const now = this.now()
    return this.deleteRange(now - ms, now)
  }

  deleteEverything(): DeletionResult {
    return this.deleteRange(0, this.now())
  }

  /** Deletes everything captured in [from, to). */
  deleteRange(fromWallMs: number, toWallMs: number): DeletionResult {
    return this.delete({ kind: 'range', from_wall_ms: fromWallMs, to_wall_ms: toWallMs, app_id: null, site: null })
  }

  /** Deletes one app's material, in a range or across all time. */
  deleteSource(appId: string, range?: { from_wall_ms: number; to_wall_ms: number }): DeletionResult {
    return this.delete({ kind: 'source', from_wall_ms: range?.from_wall_ms ?? null, to_wall_ms: range?.to_wall_ms ?? null, app_id: appId.toLowerCase(), site: null })
  }

  /** Deletes one site (and its subdomains), in a range or across all time. */
  deleteSite(site: string, range?: { from_wall_ms: number; to_wall_ms: number }): DeletionResult {
    const s = site.toLowerCase().replace(/^www\./, '')
    return this.delete({ kind: 'site', from_wall_ms: range?.from_wall_ms ?? null, to_wall_ms: range?.to_wall_ms ?? null, app_id: null, site: s })
  }

  private delete(t: Omit<Tombstone, 'id'>): DeletionResult {
    this.flushOrThrow()
    const result = this.bus.commit(
      'deletion',
      { kind: t.kind, from_wall_ms: t.from_wall_ms, to_wall_ms: t.to_wall_ms },
      () => this.applyDeletion(t),
      () => {
        this.loadTombstones()
        this.capture?.interrupt()
      },
    )
    this.compactAfterDeletion()
    return result
  }

  private applyDeletion(t: Omit<Tombstone, 'id'>): DeletionResult {
    const db = this.db
    const tombstone = Number(
      db.prepare('INSERT INTO deletions (kind, from_wall_ms, to_wall_ms, app_id, site, created_wall_ms) VALUES (?, ?, ?, ?, ?, ?)').run(t.kind, t.from_wall_ms, t.to_wall_ms, t.app_id, t.site, this.now())
        .lastInsertRowid,
    )
    const from = t.from_wall_ms ?? Number.MIN_SAFE_INTEGER
    const to = t.to_wall_ms ?? Number.MAX_SAFE_INTEGER
    const r: DeletionResult = { tombstone, observations: 0, intervals: 0, searchDocs: 0, hoursRemoved: 0, hoursCleared: 0, assistantReads: 0 }
    const touchedHours = new Set<number>()
    const appNames: string[] = []
    const hasUrl = (db.prepare(`SELECT 1 FROM pragma_table_info('observations') WHERE name = 'url'`).get() as unknown) !== undefined

    if (t.kind === 'range') {
      // A row that began before the range keeps only its part before it; anything that began inside is removed.
      db.prepare('UPDATE observations SET last_seen_wall_ms = ? WHERE event_wall_ms < ? AND last_seen_wall_ms > ?').run(from, from, from)
      r.observations = db.prepare('DELETE FROM observations WHERE event_wall_ms >= ? AND event_wall_ms < ?').run(from, to).changes
      // By start-time membership or overlap: a zero-length row at the range start overlaps nothing but is inside it.
      const affected = db
        .prepare('SELECT start_wall_ms, end_wall_ms, tz_offset_min FROM intervals WHERE (start_wall_ms >= ? AND start_wall_ms < ?) OR (end_wall_ms > ? AND start_wall_ms < ?)')
        .all(from, to, from, to) as { start_wall_ms: number; end_wall_ms: number; tz_offset_min: number }[]
      for (const row of affected) for (const h of hoursOf(row.start_wall_ms, row.end_wall_ms, row.tz_offset_min)) touchedHours.add(h)
      db.prepare('UPDATE intervals SET end_wall_ms = ? WHERE start_wall_ms < ? AND end_wall_ms > ?').run(from, from, from)
      r.intervals = db.prepare('DELETE FROM intervals WHERE start_wall_ms >= ? AND start_wall_ms < ?').run(from, to).changes
      db.prepare('UPDATE capture_gaps SET end_wall_ms = ? WHERE start_wall_ms < ? AND end_wall_ms > ?').run(from, from, from)
      db.prepare('DELETE FROM capture_gaps WHERE start_wall_ms >= ? AND start_wall_ms < ?').run(from, to)
    } else {
      const matchSql = t.kind === 'source' ? 'lower(app_id) = ?' : `(site = ? OR site LIKE '%.' || ?)`
      const matchArgs = t.kind === 'source' ? [t.app_id] : [t.site, t.site]
      if (t.kind === 'source') {
        const names = db.prepare('SELECT DISTINCT lower(app_name) AS n FROM intervals WHERE lower(app_id) = ? AND app_name IS NOT NULL').all(t.app_id) as { n: string }[]
        for (const { n } of names) if (n.length >= 3) appNames.push(n)
      }
      if (t.kind === 'source') {
        r.observations = db.prepare('DELETE FROM observations WHERE lower(app_id) = ? AND event_wall_ms >= ? AND event_wall_ms < ?').run(t.app_id, from, to).changes
      } else if (hasUrl) {
        const ids = (db.prepare(`SELECT id, url FROM observations WHERE url IS NOT NULL AND event_wall_ms >= ? AND event_wall_ms < ?`).all(from, to) as { id: number; url: string }[])
          .filter((o) => matchesSite(siteOf(o.url), t.site!))
          .map((o) => o.id)
        const del = db.prepare('DELETE FROM observations WHERE id = ?')
        for (const id of ids) r.observations += del.run(id).changes
      }
      for (const row of db.prepare(`SELECT start_wall_ms, end_wall_ms, tz_offset_min FROM intervals WHERE ${matchSql} AND start_wall_ms >= ? AND start_wall_ms < ?`).all(...matchArgs, from, to) as {
        start_wall_ms: number
        end_wall_ms: number
        tz_offset_min: number
      }[]) {
        for (const h of hoursOf(row.start_wall_ms, row.end_wall_ms, row.tz_offset_min)) touchedHours.add(h)
      }
      r.intervals = db.prepare(`DELETE FROM intervals WHERE ${matchSql} AND start_wall_ms >= ? AND start_wall_ms < ?`).run(...matchArgs, from, to).changes
      // Every activity document of the app or site goes; other documents in those hours are untouched.
      r.searchDocs += db.prepare(`DELETE FROM search_docs WHERE kind = 'activity' AND ${matchSql} AND last_wall_ms > ? AND first_wall_ms < ?`).run(...matchArgs, from, to).changes
    }

    if (t.kind === 'range') {
      const before = (db.prepare(`SELECT count(*) AS n FROM search_docs WHERE kind = 'activity'`).get() as { n: number }).n
      this.derived.rebuildDocs(touchedHours)
      r.searchDocs += Math.max(0, before - (db.prepare(`SELECT count(*) AS n FROM search_docs WHERE kind = 'activity'`).get() as { n: number }).n)
    }

    // Hours: wholly inside a deleted range they go; otherwise any hour that drew on the material loses its text.
    const hours = db.prepare('SELECT id, start_wall_ms, end_wall_ms, sources FROM hours WHERE end_wall_ms > ? AND start_wall_ms < ?').all(from, to) as {
      id: number
      start_wall_ms: number
      end_wall_ms: number
      sources: string
    }[]
    for (const h of hours) {
      const sources = JSON.parse(h.sources) as HourSource[]
      const affected =
        t.kind === 'range' ||
        (t.kind === 'source' && sources.some((s) => s.app_id?.toLowerCase() === t.app_id)) ||
        (t.kind === 'site' && sources.some((s) => matchesSite(s.site?.toLowerCase() ?? null, t.site!)))
      if (!affected) continue
      if (t.kind === 'range' && h.start_wall_ms >= from && h.end_wall_ms <= to) {
        db.prepare('DELETE FROM search_docs WHERE hour_id = ?').run(h.id)
        db.prepare('DELETE FROM hours WHERE id = ?').run(h.id)
        r.hoursRemoved++
      } else {
        this.clearHour(h.id, sources, t)
        r.hoursCleared++
      }
    }

    if (t.kind === 'range') {
      r.assistantReads = db.prepare('DELETE FROM assistant_reads WHERE to_wall_ms > ? AND from_wall_ms < ?').run(from, to).changes
    } else {
      // A read is about the deleted material when its question names it: the app id, the app's name, or the site.
      const del = db.prepare(`DELETE FROM assistant_reads WHERE to_wall_ms > ? AND from_wall_ms < ? AND instr(lower(coalesce(query, '')), ?) > 0`)
      for (const needle of new Set([t.app_id ?? t.site!, ...appNames])) r.assistantReads += del.run(from, to, needle).changes
    }
    return r
  }

  // The hour's text and the corrections on it may describe the deleted material; both go, and the hour waits for a rewrite.
  private clearHour(id: number, sources: HourSource[], t: Omit<Tombstone, 'id'>): void {
    const kept = sources.filter((s) => !(t.kind === 'source' && s.app_id?.toLowerCase() === t.app_id) && !(t.kind === 'site' && matchesSite(s.site?.toLowerCase() ?? null, t.site!)))
    this.db.prepare('DELETE FROM corrections WHERE hour_id = ?').run(id)
    this.db
      .prepare(
        `UPDATE hours SET status = 'facts', title = NULL, summary = NULL, detail = NULL, outcome = NULL, suggestion = NULL, writer = NULL,
           sources = ?, needs_rewrite = 1, version = version + 1, updated_wall_ms = ? WHERE id = ?`,
      )
      .run(JSON.stringify(kept), this.now(), id)
    this.indexHour(id)
  }

  // A deleted search document is only masked until its index segment is rewritten: 'optimize' rewrites the index now,
  // and secure_delete zeroes the pages it frees. The checkpoint then moves old pages out of the write-ahead log.
  // Best effort: a reader holding an old snapshot keeps the log until it finishes, and the next checkpoint clears it.
  private compactAfterDeletion(): void {
    try {
      this.db.exec(`INSERT INTO search (search) VALUES ('optimize')`)
      this.db.pragma('wal_checkpoint(TRUNCATE)')
    } catch (err) {
      this.onError(`checkpoint_${(err as { code?: string }).code ?? 'failed'}`)
    }
  }

  // --- hours, corrections, threads ----------------------------------------

  writeHour(h: HourInput): Hour {
    this.flushOrThrow()
    const start = h.start_wall_ms
    const end = start + HOUR_MS
    const sources = h.sources ?? []
    for (const t of this.tombstones) {
      const overlaps = (t.from_wall_ms === null || end > t.from_wall_ms) && (t.to_wall_ms === null || start < t.to_wall_ms)
      if (!overlaps) continue
      const covers = t.kind === 'range' && (t.from_wall_ms ?? -Infinity) <= start && (t.to_wall_ms ?? Infinity) >= end
      const uses =
        (t.kind === 'source' && sources.some((s) => s.app_id?.toLowerCase() === t.app_id)) || (t.kind === 'site' && sources.some((s) => matchesSite(s.site?.toLowerCase() ?? null, t.site!)))
      if (covers || uses) throw new DeletedMaterialError('this hour draws on deleted material')
    }
    const id = this.bus.commit('hour', { start_wall_ms: start }, () => {
      const v = {
        start,
        end,
        tz: h.tz,
        status: h.status,
        title: h.title ?? null,
        summary: h.summary ?? null,
        detail: h.detail ?? null,
        outcome: h.outcome ?? null,
        suggestion: h.suggestion ?? null,
        sources: JSON.stringify(sources),
        writer: h.writer ?? null,
        now: this.now(),
      }
      const row = this.db
        .prepare(
          `INSERT INTO hours (start_wall_ms, end_wall_ms, tz, status, title, summary, detail, outcome, sources, suggestion, writer, updated_wall_ms)
           VALUES (@start, @end, @tz, @status, @title, @summary, @detail, @outcome, @sources, @suggestion, @writer, @now)
           ON CONFLICT (start_wall_ms) DO UPDATE SET tz = excluded.tz, status = excluded.status, title = excluded.title, summary = excluded.summary,
             detail = excluded.detail, outcome = excluded.outcome, sources = excluded.sources, suggestion = excluded.suggestion,
             writer = excluded.writer, version = version + 1, needs_rewrite = 0, updated_wall_ms = excluded.updated_wall_ms
           RETURNING id`,
        )
        .get(v) as { id: number }
      this.indexHour(row.id)
      return row.id
    })
    return this.hour(id)!
  }

  /** The hour as every screen shows it: the user's latest correction of a field wins over the written text. */
  hour(id: number): Hour | null {
    return readHour(this.db, id)
  }

  hourAt(startWallMs: number): Hour | null {
    const row = this.db.prepare('SELECT id FROM hours WHERE start_wall_ms = ?').get(startWallMs) as { id: number } | undefined
    return row ? this.hour(row.id) : null
  }

  correct(hourId: number, field: HourField, text: string): number {
    return this.bus.commit('correction', { hour_id: hourId, field }, () => {
      const id = Number(this.db.prepare('INSERT INTO corrections (hour_id, field, text, created_wall_ms) VALUES (?, ?, ?, ?)').run(hourId, field, text, this.now()).lastInsertRowid)
      this.indexHour(hourId)
      return id
    })
  }

  /** Undo restores what was shown before this correction: an earlier correction, or the written text. */
  undoCorrection(correctionId: number): void {
    const c = this.db.prepare('SELECT hour_id FROM corrections WHERE id = ? AND undone_wall_ms IS NULL').get(correctionId) as { hour_id: number } | undefined
    if (!c) return
    this.bus.commit('correction', { hour_id: c.hour_id, undone: correctionId }, () => {
      this.db.prepare('UPDATE corrections SET undone_wall_ms = ? WHERE id = ?').run(this.now(), correctionId)
      this.indexHour(c.hour_id)
    })
  }

  private indexHour(id: number): void {
    const h = this.hour(id)
    if (!h) return
    const text = HOUR_FIELDS.map((f) => h[f])
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .join('\n')
    this.db.prepare(`DELETE FROM search_docs WHERE kind = 'hour' AND hour_id = ?`).run(id)
    if (text) {
      this.db
        .prepare(`INSERT INTO search_docs (kind, hour_start_wall_ms, hour_id, hour_text, first_wall_ms, last_wall_ms) VALUES ('hour', ?, ?, ?, ?, ?)`)
        .run(h.start_wall_ms, id, nfc(text), h.start_wall_ms, h.end_wall_ms)
    }
  }

  createThread(title: string, hourIds: number[] = []): number {
    return this.bus.commit('hour', { thread: 'created' }, () => {
      const now = this.now()
      const id = Number(this.db.prepare('INSERT INTO threads (title, created_wall_ms, updated_wall_ms) VALUES (?, ?, ?)').run(title, now, now).lastInsertRowid)
      for (const h of hourIds) this.db.prepare('INSERT OR IGNORE INTO thread_hours (thread_id, hour_id) VALUES (?, ?)').run(id, h)
      return id
    })
  }

  linkHour(threadId: number, hourId: number): void {
    this.bus.commit('hour', { thread: threadId }, () => {
      this.db.prepare('INSERT OR IGNORE INTO thread_hours (thread_id, hour_id) VALUES (?, ?)').run(threadId, hourId)
      this.db.prepare('UPDATE threads SET updated_wall_ms = ? WHERE id = ?').run(this.now(), threadId)
    })
  }

  deleteThread(threadId: number): void {
    this.bus.commit('hour', { thread: threadId, deleted: true }, () => this.db.prepare('DELETE FROM threads WHERE id = ?').run(threadId))
  }

  threadsForHour(hourId: number): { id: number; title: string }[] {
    return this.db.prepare('SELECT t.id, t.title FROM threads t JOIN thread_hours th ON th.thread_id = t.id WHERE th.hour_id = ? ORDER BY t.id').all(hourId) as { id: number; title: string }[]
  }

  // --- pause -----------------------------------------------------------------

  /** Pauses capture for an hour, until tomorrow, until resumed, or until a given time. Nothing stamped inside is stored. */
  pause(until: PauseFor | number | null): PauseState {
    this.flushOrThrow()
    if (this.paused()) this.endPause('replaced')
    const since = this.now()
    const untilWallMs =
      typeof until === 'number' ? until : until === 'hour' ? since + HOUR_MS : until === 'tomorrow' ? nextLocalMidnight(since) : null
    const state = this.bus.commit(
      'pause',
      { since_wall_ms: since, until_wall_ms: untilWallMs },
      () => {
        const gap = this.store.writeGapNow({ reason: 'paused', scope: 'all', run: null, start: this.point(since), detail: null }, untilWallMs === null ? null : this.point(untilWallMs))
        const id = Number(this.db.prepare('INSERT INTO pauses (since_wall_ms, until_wall_ms, gap_id) VALUES (?, ?, ?)').run(since, untilWallMs, gap).lastInsertRowid)
        return { id, since_wall_ms: since, until_wall_ms: untilWallMs, ended_wall_ms: null, gap_id: gap }
      },
      () => {
        this.loadPauses()
        this.store.flush()
        this.capture?.interrupt()
      },
    )
    this.armPauseTimer()
    return state
  }

  resume(): void {
    if (this.paused()) this.endPause('resumed')
  }

  /** The active pause, if any. */
  paused(): PauseState | null {
    return this.pauses.find((p) => p.ended_wall_ms === null) ?? null
  }

  private loadPauses(): void {
    this.pauses = this.db.prepare('SELECT id, since_wall_ms, until_wall_ms, ended_wall_ms, gap_id FROM pauses ORDER BY id').all() as PauseState[]
  }

  private endPause(reason: 'resumed' | 'expired' | 'replaced'): void {
    const p = this.paused()
    if (!p) return
    if (this.pauseTimer) clearTimeout(this.pauseTimer)
    this.pauseTimer = null
    const end = p.until_wall_ms !== null && reason === 'expired' ? p.until_wall_ms : Math.max(p.since_wall_ms, this.now())
    this.bus.commit(
      'pause',
      { ended: reason, at_wall_ms: end },
      () => {
        if (p.gap_id !== null) this.store.setGapEndNow(p.gap_id, this.point(end))
        this.db.prepare('UPDATE pauses SET ended_wall_ms = ? WHERE id = ?').run(end, p.id)
      },
      () => {
        this.loadPauses()
        this.store.flush()
        if (reason !== 'replaced') this.capture?.interrupt()
      },
    )
  }

  private armPauseTimer(): void {
    const p = this.paused()
    if (!p || p.until_wall_ms === null) return
    if (this.pauseTimer) clearTimeout(this.pauseTimer)
    // Timers run on monotonic time and drift across sleep; re-arm until the wall clock reaches the end.
    const wait = Math.min(Math.max(0, p.until_wall_ms - this.now()), 3_600_000)
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null
      const active = this.paused()
      if (active && active.until_wall_ms !== null && this.now() >= active.until_wall_ms) this.endPause('expired')
      else this.armPauseTimer()
    }, wait)
    this.pauseTimer.unref?.()
  }

  // --- exclusions and settings -------------------------------------------

  addExclusion(rule: ExclusionRule): void {
    this.flushOrThrow()
    this.bus.commit('exclusion', { match: rule.match, added: true }, () => {
      this.db.prepare('INSERT OR IGNORE INTO exclusions (match, value, label, is_default) VALUES (?, ?, ?, 0)').run(rule.match, rule.value, rule.label)
    }, () => this.installExclusions())
  }

  removeExclusion(match: ExclusionRule['match'], value: string): void {
    this.flushOrThrow()
    this.bus.commit('exclusion', { match, removed: true }, () => {
      this.db.prepare('DELETE FROM exclusions WHERE match = ? AND value = ?').run(match, value)
    }, () => this.installExclusions())
  }

  private installExclusions(): void {
    this.privacy = new Privacy(this.store.exclusions())
    this.capture?.setExclusions(this.store.exclusions())
    this.capture?.interrupt()
  }

  getSetting<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : null
  }

  setSetting(key: string, value: unknown, kind: ChangeKind = 'setting'): void {
    this.bus.commit(kind, { key }, () => this.putSetting(key, value))
  }

  private putSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value, updated_wall_ms) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_wall_ms = excluded.updated_wall_ms')
      .run(key, JSON.stringify(value), this.now())
  }

  setAiChoice(choice: { provider: 'off' | string; model?: string | null }): void {
    this.setSetting('ai_choice', choice, 'ai_choice')
  }

  /** null keeps everything. Applies to capture and import at once; older rows are pruned in the background. */
  setRetentionDays(days: number | null): void {
    this.setSetting('retention_days', days, 'retention')
    this.retentionDays = days
    this.scheduleRetention(0)
  }

  // --- usage, plan, assistant reads ----------------------------------------

  recordUsage(u: UsageEntry): number {
    return this.bus.commit('usage', { kind: u.kind }, () =>
      Number(
        this.db
          .prepare('INSERT INTO usage_ledger (at_wall_ms, kind, provider, model, input_tokens, output_tokens, cost_micro_usd, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(this.now(), u.kind, u.provider, u.model, u.input_tokens, u.output_tokens, u.cost_micro_usd, u.ref ?? null).lastInsertRowid,
      ),
    )
  }

  usageTotals(fromWallMs: number, toWallMs: number): { answers: number; hours: number; cost_micro_usd: number } {
    const r = this.db
      .prepare(
        `SELECT coalesce(sum(kind = 'answer'), 0) AS answers, coalesce(sum(kind = 'hour'), 0) AS hours, coalesce(sum(cost_micro_usd), 0) AS cost_micro_usd
         FROM usage_ledger WHERE at_wall_ms >= ? AND at_wall_ms < ?`,
      )
      .get(fromWallMs, toWallMs) as { answers: number; hours: number; cost_micro_usd: number }
    return r
  }

  setPlan(p: PlanEntry): void {
    this.bus.commit('plan', { plan: p.plan, status: p.status }, () =>
      this.db
        .prepare(
          `INSERT INTO plan_cache (id, plan, status, confirmed_wall_ms, expires_wall_ms, payload) VALUES (1, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET plan = excluded.plan, status = excluded.status, confirmed_wall_ms = excluded.confirmed_wall_ms,
             expires_wall_ms = excluded.expires_wall_ms, payload = excluded.payload`,
        )
        .run(p.plan, p.status, p.confirmed_wall_ms, p.expires_wall_ms ?? null, JSON.stringify(p.payload ?? {})),
    )
  }

  plan(): PlanEntry | null {
    const r = this.db.prepare('SELECT plan, status, confirmed_wall_ms, expires_wall_ms, payload FROM plan_cache WHERE id = 1').get() as (Omit<PlanEntry, 'payload'> & { payload: string }) | undefined
    return r ? { ...r, payload: JSON.parse(r.payload) as Record<string, unknown> } : null
  }

  recordAssistantRead(r: AssistantRead): number {
    return Number(
      this.db
        .prepare('INSERT INTO assistant_reads (assistant, at_wall_ms, tool, from_wall_ms, to_wall_ms, query) VALUES (?, ?, ?, ?, ?, ?)')
        .run(r.assistant, this.now(), r.tool, r.from_wall_ms, r.to_wall_ms, r.query ?? null).lastInsertRowid,
    )
  }

  // --- search ----------------------------------------------------------------

  /** Words match anywhere in titles, addresses, file names and hour text; the last word also matches as a prefix. */
  search(text: string, opts: { limit?: number; fromWallMs?: number; toWallMs?: number } = {}): SearchHit[] {
    const words = text.normalize('NFC').match(/[\p{L}\p{N}\p{M}]+/gu) ?? []
    if (words.length === 0) return []
    const q = words.map((w, i) => `"${w}"${i === words.length - 1 ? '*' : ''}`).join(' ')
    return this.db
      .prepare(
        `SELECT d.kind, d.hour_start_wall_ms, d.app_id, d.app_name, d.title, d.url, d.hour_id, d.first_wall_ms, d.last_wall_ms
         FROM search JOIN search_docs d ON d.id = search.rowid
         WHERE search MATCH ? AND d.hour_start_wall_ms >= ? AND d.hour_start_wall_ms < ?
         ORDER BY search.rank LIMIT ?`,
      )
      .all(q, opts.fromWallMs ?? Number.MIN_SAFE_INTEGER, opts.toWallMs ?? Number.MAX_SAFE_INTEGER, opts.limit ?? 50) as SearchHit[]
  }

  // --- retention ---------------------------------------------------------------

  /** Removes one small batch of rows older than the retention window; returns how many went. Each statement is its own short transaction. */
  pruneBatch(batch = PRUNE_BATCH): number {
    const now = this.now()
    const logRows = pruneChangeLog(this.db, now - CHANGE_LOG_KEEP_MS, batch)
    let n = 0
    if (this.retentionDays === null) return logRows
    const cutoff = now - this.retentionDays * DAY_MS
    const statements = [
      'DELETE FROM observations WHERE id IN (SELECT id FROM observations WHERE event_wall_ms < ? ORDER BY event_wall_ms LIMIT ?)',
      'DELETE FROM intervals WHERE id IN (SELECT id FROM intervals WHERE start_wall_ms < ? ORDER BY start_wall_ms LIMIT ?)',
      'DELETE FROM capture_gaps WHERE id IN (SELECT id FROM capture_gaps WHERE end_wall_ms < ? LIMIT ?)',
      'DELETE FROM assistant_reads WHERE id IN (SELECT id FROM assistant_reads WHERE to_wall_ms < ? LIMIT ?)',
    ]
    for (const sql of statements) n += this.db.prepare(sql).run(cutoff, batch).changes
    // Pruning is spread over many small batches, so here FTS5 secure-delete removes each document's terms as it goes
    // (about 0.5 ms a document at a year's size) instead of one long 'optimize'. The setting is a literal: FTS5 rejects a bound value.
    this.db.transaction(() => {
      this.db.exec(`INSERT INTO search (search, rank) VALUES ('secure-delete', 1)`)
      n += this.db
        .prepare(`DELETE FROM search_docs WHERE id IN (SELECT id FROM search_docs WHERE hour_start_wall_ms < ? AND last_wall_ms < ? LIMIT ?)`)
        .run(cutoff, cutoff, Math.ceil(batch / 10)).changes
      n += this.db.prepare('DELETE FROM hours WHERE id IN (SELECT id FROM hours WHERE end_wall_ms <= ? LIMIT ?)').run(cutoff, Math.ceil(batch / 25)).changes
      this.db.exec(`INSERT INTO search (search, rank) VALUES ('secure-delete', 0)`)
    })()
    this.prunedData += n
    return n + logRows
  }

  /** Prunes in batches, yielding to capture between them; then moves old pages out of the write-ahead log. */
  async prune(): Promise<number> {
    let total = 0
    this.prunedData = 0
    for (;;) {
      const n = this.pruneBatch()
      total += n
      if (n === 0) break
      await new Promise((r) => setImmediate(r))
    }
    // Readers holding pruned hours, intervals or search results must drop them.
    if (this.prunedData > 0 && this.retentionDays !== null) this.bus.commit('retention', { pruned: true, cutoff_wall_ms: this.now() - this.retentionDays * DAY_MS }, () => {})
    if (total > 0) this.db.pragma('wal_checkpoint(TRUNCATE)')
    return total
  }

  private scheduleRetention(delayMs: number): void {
    if (this.retentionTimer) clearTimeout(this.retentionTimer)
    this.retentionTimer = setTimeout(() => {
      this.retentionTimer = null
      this.prune()
        .catch((err: { code?: string }) => this.onError(`prune_${err?.code ?? 'failed'}`))
        .finally(() => {
          if (this.retentionTimer === null) this.scheduleRetention(DAY_MS)
        })
    }, delayMs)
    this.retentionTimer.unref?.()
  }
}
