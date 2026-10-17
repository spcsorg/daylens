// Step 2 storage: the single source of truth around the capture store. The capture service is the only
// writer; every other reader opens the database read-only and follows the change log (changes.ts).
import type Database from 'better-sqlite3'
import type { ExclusionRule } from '../capture/defaults.ts'
import type { GapPoint, ObservationRow } from '../capture/normalize.ts'
import { Store } from '../capture/store.ts'
import { ChangeBus, pruneChangeLog, type ChangeKind } from './changes.ts'
import { DeletionWorker, fenceEdges, type DeletionResult } from './deletion.ts'
import { Derived, HOUR_MS, siteOf } from './derive.ts'
import { indexHour, readHour, sourceMatches, type Hour, type HourField, type HourSource } from './hours.ts'
import { applyMigrations } from './migrations.ts'
import { DAY_MS, matchesSite, Rules, tombstoneMatches, type PauseState, type Tombstone } from './rules.ts'
import { STORAGE_MIGRATIONS } from './schema.ts'

export type { DeletionResult } from './deletion.ts'
export { HOUR_FIELDS, readHour, type Hour, type HourField, type HourSource } from './hours.ts'
export type { PauseState, Tombstone } from './rules.ts'

const PRUNE_BATCH = 500
const CHANGE_LOG_KEEP_MS = 7 * DAY_MS

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

export type PauseFor = 'hour' | 'tomorrow' | 'until_resumed'

// There is no start-of-day setting yet, so "until tomorrow" ends at the next local midnight (as on the browser branch).
export function nextLocalMidnight(nowMs: number): number {
  const d = new Date(nowMs)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
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
  // What the read returned: hours, and apps or sites whose activity it showed.
  hours?: number[]
  sources?: HourSource[]
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

/** A deletion is in force (capture and import refuse the material) when this returns; `done` settles once it is removed. */
export interface DeletionHandle {
  tombstone: number
  done: Promise<DeletionResult>
}

export class DeletedMaterialError extends Error {}
// The hour changed (rewritten, cleared by a deletion) or material in it was deleted after the result was computed.
export class StaleHourError extends Error {}

/** What an hour's text is computed from: read it before computing, pass it back when writing. */
export interface HourBasis {
  version: number | null
  deletion: number
}

export class Storage {
  readonly store: Store
  readonly db: Database.Database
  readonly bus: ChangeBus
  readonly derived: Derived
  readonly rules: Rules
  private readonly now: () => number
  private capture: CaptureControl | null = null
  private pauseTimer: ReturnType<typeof setTimeout> | null = null
  private retentionTimer: ReturnType<typeof setTimeout> | null = null
  private readonly onError: (code: string) => void
  private prunedData = 0
  private backfill: Promise<void> = Promise.resolve()
  private stopped = false
  private readonly deletions: DeletionWorker

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
    this.rules = new Rules(this.db, this.now)
    // Derivation follows the same rules as admission, so a rebuild never brings back deleted or paused time.
    this.derived = new Derived(this.db, {
      cut: (s, e, row) => this.rules.cut(s, e, row),
      admit: (row) => this.rules.accepts(row.event_wall_ms, row.app_id, row.url),
    })
    this.deletions = new DeletionWorker(store.file)
    store.acceptObservation = (row) => this.admit(row)
    store.acceptExtension = (row, from, to) => this.rules.mayCover(row.app_id, (row as { url?: string | null }).url ?? null, from, to)
    store.onFlushed = () => {
      try {
        this.derived.refreshFromMark()
      } catch (err) {
        // Derived state is rebuildable; a failure here never blocks capture.
        this.onError(`derive_${(err as { code?: string }).code ?? 'failed'}`)
      }
    }
  }

  attachCapture(control: CaptureControl): void {
    this.capture = control
  }

  /** Arms the pause and retention timers, and resumes work left unfinished: derivation, and deletions still pending. */
  start(): void {
    // A mark left by a capture flush whose derivation never ran becomes part of the backfill.
    this.db.exec(`INSERT INTO meta (key, value) SELECT 'derive_backfill_from', value FROM meta WHERE key = 'derive_from'
                  ON CONFLICT (key) DO UPDATE SET value = CAST(min(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`)
    this.db.exec(`DELETE FROM meta WHERE key = 'derive_from'`)
    this.backfill = this.runBackfill()
    for (const t of this.rules.tombstones) {
      if (t.state === 'pending') this.track(this.finishDeletion(t.id)).catch((err: Error) => this.onError(`deletion_resume_${err.message}`))
    }
    const p = this.paused()
    if (p) {
      if (p.until_wall_ms !== null && this.now() >= p.until_wall_ms) this.endPause('expired')
      else this.armPauseTimer()
    }
    this.scheduleRetention(60_000)
  }

  /** Resolves once derivation has caught up with everything captured before start(). */
  derivationSettled(): Promise<void> {
    return this.backfill
  }

  private async runBackfill(): Promise<void> {
    try {
      // Steps are short transactions with a yield between them, so capture keeps flushing.
      while (!this.stopped && this.derived.backfillStep()) await new Promise((r) => setImmediate(r))
    } catch (err) {
      this.onError(`backfill_${(err as { code?: string }).code ?? 'failed'}`)
    }
  }

  stop(): void {
    this.stopped = true
    if (this.pauseTimer) clearTimeout(this.pauseTimer)
    if (this.retentionTimer) clearTimeout(this.retentionTimer)
    this.pauseTimer = this.retentionTimer = null
    void this.deletions.close()
  }

  // --- what may be stored --------------------------------------------------

  /** One rule for capture and import: paused, past retention, or deleted material is never written. */
  accepts(eventWallMs: number, appId: string | null, url: string | null): boolean {
    return this.rules.accepts(eventWallMs, appId, url)
  }

  /**
   * The one gate for every row, from capture or import. An excluded app's row becomes an excluded gap; paused,
   * expired or deleted material is dropped.
   */
  private admit(row: ObservationRow & { url?: string | null; last_seen_wall_ms?: number }): boolean {
    if (this.rules.excluded(row)) {
      if (this.rules.accepts(row.event_wall_ms, null, null)) {
        const gap = this.store.openGap({ reason: 'excluded', scope: 'all', run: row.run, start: this.point(row.event_wall_ms), detail: null })
        this.store.closeGap(gap, this.point(Math.max(row.event_wall_ms, row.last_seen_wall_ms ?? row.event_wall_ms)))
      }
      return false
    }
    return this.rules.accepts(row.event_wall_ms, row.app_id, row.url ?? null)
  }

  /** Re-import (a backup, an older Daylens): the same rules as capture, so deleted material stays deleted. */
  importObservations(rows: readonly (ObservationRow & { url?: string | null })[]): { imported: number; refused: number } {
    let imported = 0
    for (const r of rows) if (this.store.insertObservation(r) !== Store.REFUSED) imported++
    this.flushOrThrow()
    return { imported, refused: rows.length - imported }
  }

  private flushOrThrow(): void {
    // Queued capture writes go in first, so a deletion or pause applies to everything captured before it.
    if (!this.store.flush()) throw new Error('storage is failing; nothing was changed')
  }

  private point(wallMs = this.now()): GapPoint {
    return { wall_ms: wallMs, mono_us: null, boot: null }
  }

  // --- deletion --------------------------------------------------------------

  deleteLast(ms: number): DeletionHandle {
    const now = this.now()
    return this.deleteRange(now - ms, now)
  }

  deleteEverything(): DeletionHandle {
    return this.deleteRange(0, this.now())
  }

  /** Deletes everything captured in [from, to). */
  deleteRange(fromWallMs: number, toWallMs: number): DeletionHandle {
    return this.delete({ kind: 'range', from_wall_ms: fromWallMs, to_wall_ms: toWallMs, app_id: null, site: null })
  }

  /** Deletes one app's material, in a range or across all time. */
  deleteSource(appId: string, range?: { from_wall_ms: number; to_wall_ms: number }): DeletionHandle {
    return this.delete({ kind: 'source', from_wall_ms: range?.from_wall_ms ?? null, to_wall_ms: range?.to_wall_ms ?? null, app_id: appId.toLowerCase(), site: null })
  }

  /** Deletes one site (and its subdomains), in a range or across all time. */
  deleteSite(site: string, range?: { from_wall_ms: number; to_wall_ms: number }): DeletionHandle {
    const s = site.toLowerCase().replace(/^www\./, '')
    return this.delete({ kind: 'site', from_wall_ms: range?.from_wall_ms ?? null, to_wall_ms: range?.to_wall_ms ?? null, app_id: null, site: s })
  }

  private delete(t: Omit<Tombstone, 'id' | 'state'>): DeletionHandle {
    this.flushOrThrow()
    let tombstone: number
    try {
      tombstone = this.bus.commit(
        'deletion',
        { state: 'started', kind: t.kind, from_wall_ms: t.from_wall_ms, to_wall_ms: t.to_wall_ms },
        () => {
          const id = Number(
            this.db
              .prepare(`INSERT INTO deletions (kind, from_wall_ms, to_wall_ms, app_id, site, created_wall_ms, state) VALUES (?, ?, ?, ?, ?, ?, 'pending')`)
              .run(t.kind, t.from_wall_ms, t.to_wall_ms, t.app_id, t.site, this.now()).lastInsertRowid,
          )
          fenceEdges(this.db, t, () => this.store.allocateObservationId())
          return id
        },
        () => {
          this.rules.loadTombstones()
          this.capture?.interrupt()
        },
      )
    } catch (err) {
      this.rules.loadTombstones()
      throw err
    }
    return { tombstone, done: this.track(this.finishDeletion(tombstone)) }
  }

  private readonly inFlight = new Set<Promise<unknown>>()

  private track<T>(p: Promise<T>): Promise<T> {
    this.inFlight.add(p)
    const forget = () => this.inFlight.delete(p)
    p.then(forget, forget)
    return p
  }

  /** Resolves once every deletion started so far (or resumed at start) has finished or failed. */
  async deletionsSettled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight])
  }

  private async finishDeletion(tombstone: number): Promise<DeletionResult> {
    const result = await this.deletions.run(tombstone, this.now())
    this.bus.commit('deletion', { state: 'done', tombstone }, () => {}, () => this.rules.loadTombstones())
    return result
  }

  // --- hours, corrections, threads ----------------------------------------

  hourBasis(startWallMs: number): HourBasis {
    const h = this.db.prepare('SELECT version FROM hours WHERE start_wall_ms = ?').get(startWallMs) as { version: number } | undefined
    const d = this.db.prepare('SELECT max(id) AS id FROM deletions').get() as { id: number | null }
    return { version: h?.version ?? null, deletion: d.id ?? 0 }
  }

  writeHour(h: HourInput, basis: HourBasis): Hour {
    this.flushOrThrow()
    const start = h.start_wall_ms
    const end = start + HOUR_MS
    const sources = h.sources ?? []
    const current = this.db.prepare('SELECT version FROM hours WHERE start_wall_ms = ?').get(start) as { version: number } | undefined
    if ((current?.version ?? null) !== basis.version) throw new StaleHourError('the hour changed after this text was computed')
    for (const t of this.rules.tombstones) {
      const overlaps = (t.from_wall_ms === null || end > t.from_wall_ms) && (t.to_wall_ms === null || start < t.to_wall_ms)
      if (overlaps && t.id > basis.deletion) throw new StaleHourError('material in this hour was deleted after this text was computed')
    }
    for (const t of this.rules.tombstones) {
      const overlaps = (t.from_wall_ms === null || end > t.from_wall_ms) && (t.to_wall_ms === null || start < t.to_wall_ms)
      if (!overlaps) continue
      const covers = t.kind === 'range' && (t.from_wall_ms ?? -Infinity) <= start && (t.to_wall_ms ?? Infinity) >= end
      const uses = sources.some((s) => sourceMatches(t, s))
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
      indexHour(this.db, row.id)
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
      indexHour(this.db, hourId)
      return id
    })
  }

  /** Undo restores what was shown before this correction: an earlier correction, or the written text. */
  undoCorrection(correctionId: number): void {
    const c = this.db.prepare('SELECT hour_id FROM corrections WHERE id = ? AND undone_wall_ms IS NULL').get(correctionId) as { hour_id: number } | undefined
    if (!c) return
    this.bus.commit('correction', { hour_id: c.hour_id, undone: correctionId }, () => {
      this.db.prepare('UPDATE corrections SET undone_wall_ms = ? WHERE id = ?').run(this.now(), correctionId)
      indexHour(this.db, c.hour_id)
    })
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
        this.rules.loadPauses()
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
    return this.rules.pauses.find((p) => p.ended_wall_ms === null) ?? null
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
        this.rules.loadPauses()
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
    this.rules.loadExclusions()
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
    this.rules.retentionDays = days
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
    return this.db.transaction(() => {
      const id = Number(
        this.db
          .prepare('INSERT INTO assistant_reads (assistant, at_wall_ms, tool, from_wall_ms, to_wall_ms, query) VALUES (?, ?, ?, ?, ?, ?)')
          .run(r.assistant, this.now(), r.tool, r.from_wall_ms, r.to_wall_ms, r.query ?? null).lastInsertRowid,
      )
      const item = this.db.prepare('INSERT INTO assistant_read_items (read_id, hour_id, app_id, site) VALUES (?, ?, ?, ?)')
      for (const h of r.hours ?? []) item.run(id, h, null, null)
      for (const s of r.sources ?? []) item.run(id, null, s.app_id?.toLowerCase() ?? null, s.site?.toLowerCase().replace(/^www\./, '') ?? null)
      return id
    })()
  }

  // --- search ----------------------------------------------------------------

  /** Words match anywhere in titles, addresses, file names and hour text; the last word also matches as a prefix. */
  search(text: string, opts: { limit?: number; fromWallMs?: number; toWallMs?: number } = {}): SearchHit[] {
    const words = text.normalize('NFC').match(/[\p{L}\p{N}\p{M}]+/gu) ?? []
    if (words.length === 0) return []
    const q = words.map((w, i) => `"${w}"${i === words.length - 1 ? '*' : ''}`).join(' ')
    const limit = opts.limit ?? 50
    const pending = this.rules.tombstones.filter((t) => t.state === 'pending')
    // While a deletion is still being carried out, what it covers is already hidden.
    const hidden = (h: SearchHit) =>
      pending.some((t) => {
        if ((t.from_wall_ms !== null && h.last_wall_ms < t.from_wall_ms) || (t.to_wall_ms !== null && h.first_wall_ms >= t.to_wall_ms)) return false
        if (h.kind === 'hour') {
          if (t.kind === 'range') return true
          const row = this.db.prepare('SELECT sources FROM hours WHERE id = ?').get(h.hour_id) as { sources: string } | undefined
          return (JSON.parse(row?.sources ?? '[]') as HourSource[]).some((s) => sourceMatches(t, s))
        }
        return tombstoneMatches(t, h.app_id || null, h.url || null)
      })
    const rows = this.db
      .prepare(
        `SELECT d.kind, d.hour_start_wall_ms, d.app_id, d.app_name, d.title, d.url, d.hour_id, d.first_wall_ms, d.last_wall_ms
         FROM search JOIN search_docs d ON d.id = search.rowid
         WHERE search MATCH ? AND d.hour_start_wall_ms >= ? AND d.hour_start_wall_ms < ?
         ORDER BY search.rank LIMIT ?`,
      )
      .all(q, opts.fromWallMs ?? Number.MIN_SAFE_INTEGER, opts.toWallMs ?? Number.MAX_SAFE_INTEGER, pending.length ? limit * 4 : limit) as SearchHit[]
    return pending.length ? rows.filter((h) => !hidden(h)).slice(0, limit) : rows
  }

  // --- retention ---------------------------------------------------------------

  /** Removes one small batch of rows older than the retention window; returns how many went. Each statement is its own short transaction. */
  pruneBatch(batch = PRUNE_BATCH): number {
    const now = this.now()
    const logRows = pruneChangeLog(this.db, now - CHANGE_LOG_KEEP_MS, batch)
    let n = 0
    if (this.rules.retentionDays === null) return logRows
    const cutoff = now - this.rules.retentionDays * DAY_MS
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
    const days = this.rules.retentionDays
    if (this.prunedData > 0 && days !== null) this.bus.commit('retention', { pruned: true, cutoff_wall_ms: this.now() - days * DAY_MS }, () => {})
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
