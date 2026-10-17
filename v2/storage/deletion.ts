// Deletion in two parts. The fence runs on the capture thread in one short transaction: the tombstone goes in force
// for capture and import, and rows crossing the range edges are trimmed or split. The rest (removing rows, search
// entries, hours, threads and reads) runs in a worker thread with its own connection, in short transactions, so
// capture never waits on it for long and the user's action returns at once.
import type Database from 'better-sqlite3'
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ObservationRow } from '../capture/normalize.ts'
import { Derived, HOUR_MS, MAX_INTERVAL_MS } from './derive.ts'
import { clearHour, sourceMatches, type HourSource } from './hours.ts'
import { Rules, tombstoneMatches, type Tombstone } from './rules.ts'
import { immediateRetrying } from './tx.ts'
import { pruneChangeLog } from './changes.ts'

export interface DeletionResult {
  tombstone: number
  observations: number
  intervals: number
  searchDocs: number
  hoursRemoved: number
  hoursCleared: number
  assistantReads: number
  // Whether the old pages were also moved out of the write-ahead log when the removal finished; if not, storage
  // keeps retrying and announces when they are gone.
  purged: boolean
}

type Obs = ObservationRow & { id: number; last_seen_wall_ms: number; url?: string | null }
type Spec = Pick<Tombstone, 'kind' | 'from_wall_ms' | 'to_wall_ms' | 'app_id' | 'site'>

function hasUrl(db: Database.Database): boolean {
  return db.prepare(`SELECT 1 FROM pragma_table_info('observations') WHERE name = 'url'`).get() !== undefined
}

// SQL narrows the candidates; tombstoneMatches decides (sites are matched on the parsed address).
function prefilter(db: Database.Database, t: Spec): string {
  return t.kind === 'range' ? '1' : t.kind === 'source' ? 'lower(app_id) = @app' : hasUrl(db) ? 'url IS NOT NULL' : '0'
}

function intervalMatch(t: Spec): string {
  return t.kind === 'range' ? '1' : t.kind === 'source' ? 'lower(app_id) = @app' : `(site = @site OR site LIKE '%.' || @site)`
}

function bounds(t: Spec) {
  const from = t.from_wall_ms ?? Number.MIN_SAFE_INTEGER
  const to = t.to_wall_ms ?? Number.MAX_SAFE_INTEGER
  return { from, to, app: t.app_id, site: t.site, lo: from - MAX_INTERVAL_MS }
}

/**
 * Inside the fence transaction: rows crossing an edge keep only their parts outside the range, and one that spans
 * it is split in two. Only a bounded range has edges; the scan before it is limited by MAX_INTERVAL_MS.
 */
export function fenceEdges(db: Database.Database, t: Spec, allocateId: () => number): void {
  if (t.from_wall_ms === null || t.to_wall_ms === null) return
  const args = bounds(t)
  const { from, to } = args
  const pre = prefilter(db, t)
  const matches = (o: Obs) => tombstoneMatches(t, o.app_id, o.url ?? null)
  const cols = (db.prepare('PRAGMA table_info(observations)').all() as { name: string }[]).map((c) => c.name)
  const insertCopy = db.prepare(`INSERT INTO observations (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`)
  for (const o of (db.prepare(`SELECT * FROM observations WHERE event_wall_ms >= @lo AND event_wall_ms < @from AND last_seen_wall_ms > @from AND ${pre}`).all(args) as Obs[]).filter(matches)) {
    if (o.last_seen_wall_ms > to) insertCopy.run({ ...o, id: allocateId(), event_wall_ms: to, event_mono_us: o.event_mono_us + (to - o.event_wall_ms) * 1000 })
    db.prepare('UPDATE observations SET last_seen_wall_ms = ? WHERE id = ?').run(from, o.id)
  }
  for (const o of (db.prepare(`SELECT * FROM observations WHERE event_wall_ms >= @from AND event_wall_ms < @to AND last_seen_wall_ms > @to AND ${pre}`).all(args) as Obs[]).filter(matches)) {
    db.prepare('UPDATE observations SET event_wall_ms = ?, event_mono_us = ? WHERE id = ?').run(to, o.event_mono_us + (to - o.event_wall_ms) * 1000, o.id)
  }
}

/**
 * Inside the fence transaction, with the tombstone: everything later steps must reach, before any of it changes.
 * Hours: those the deletion removes or clears. Threads and assistant reads: those linked to them, and reads over
 * the range or of the app or site. Search entries: only the hours cut by a range edge need rebuilding; entries
 * wholly inside the range are deleted by query, which stays correct after a restart.
 */
export function planDeletion(db: Database.Database, tombstoneId: number, t: Spec): void {
  const { from, to, app, site } = bounds(t)
  const item = db.prepare('INSERT OR IGNORE INTO deletion_work (tombstone_id, kind, ref) VALUES (?, ?, ?)')
  if (t.from_wall_ms !== null && t.to_wall_ms !== null) {
    const edges = db
      .prepare(
        `SELECT DISTINCT hour_start_wall_ms AS h FROM search_docs WHERE kind = 'activity' AND hour_start_wall_ms >= ? AND hour_start_wall_ms < ?
           AND ((hour_start_wall_ms < ? AND hour_start_wall_ms + ? > ?) OR (hour_start_wall_ms < ? AND hour_start_wall_ms + ? > ?))`,
      )
      .all(from - HOUR_MS, to, from, HOUR_MS, from, to, HOUR_MS, to) as { h: number }[]
    for (const { h } of edges) item.run(tombstoneId, 'doc_hour', h)
  }
  const hours = db.prepare('SELECT id, sources FROM hours WHERE end_wall_ms > ? AND start_wall_ms < ?').all(from, to) as { id: number; sources: string }[]
  for (const h of hours) {
    if (t.kind === 'range' || (JSON.parse(h.sources) as HourSource[]).some((s) => sourceMatches(t, s))) item.run(tombstoneId, 'hour', h.id)
  }
  const planned = `(SELECT ref FROM deletion_work WHERE tombstone_id = ? AND kind = 'hour')`
  db.prepare(`INSERT OR IGNORE INTO deletion_work SELECT ?, 'thread', thread_id FROM thread_hours WHERE hour_id IN ${planned}`).run(tombstoneId, tombstoneId)
  db.prepare(`INSERT OR IGNORE INTO deletion_work SELECT ?, 'read', read_id FROM assistant_read_items WHERE hour_id IN ${planned}`).run(tombstoneId, tombstoneId)
  if (t.kind === 'range') {
    db.prepare(`INSERT OR IGNORE INTO deletion_work SELECT ?, 'read', id FROM assistant_reads WHERE to_wall_ms > ? AND from_wall_ms < ?`).run(tombstoneId, from, to)
  } else {
    const match = t.kind === 'source' ? 'i.app_id = @app' : `(i.site = @site OR i.site LIKE '%.' || @site)`
    db.prepare(
      `INSERT OR IGNORE INTO deletion_work SELECT @id, 'read', i.read_id FROM assistant_read_items i JOIN assistant_reads a ON a.id = i.read_id
       WHERE ${match} AND a.to_wall_ms > @from AND a.from_wall_ms < @to`,
    ).run({ id: tombstoneId, app, site, from, to })
  }
}

const ROWS_PER_STEP = 500
const DOCS_PER_STEP = 50
const HOURS_PER_STEP = 25
// A secure-delete of an hour's text rewrites index pages for each of its many terms (13 ms warm at a year's size);
// a transaction stops taking on more entries after this long, so capture's flushes never wait long for the lock.
const FTS_STEP_MS = 20

// Reads the search index into the cache outside any write transaction: cold, the first secure-delete of an hour's
// text took 136 ms with the writer lock held; warm, 7 ms.
export function warmSearchIndex(db: Database.Database): void {
  db.prepare('SELECT count(*) AS n, sum(length(block)) AS b FROM search_data').get()
}

/** Runs `each` for items in order until all are done or FTS_STEP_MS has passed; returns how many it ran. */
function timeBoxed<T>(items: readonly T[], each: (item: T) => void): number {
  const start = performance.now()
  let n = 0
  for (const item of items) {
    each(item)
    n++
    if (performance.now() - start > FTS_STEP_MS) break
  }
  return n
}

export interface PruneResult {
  removed: number
  data: number
  batches: number
  maxTransactionMs: number
}

/**
 * One retention batch, each part its own short transaction: announcements older than `logKeepFrom`, and, when a
 * cutoff is set, observations, intervals, gaps and reads before it, then search entries and hours, time-boxed.
 */
export function pruneStep(db: Database.Database, cutoff: number | null, logKeepFrom: number, batch = ROWS_PER_STEP, onTransaction: (ms: number) => void = () => {}): { removed: number; data: number } {
  const timed = <T>(fn: () => T): T => {
    const t = performance.now()
    const out = immediateRetrying(db, fn)
    onTransaction(performance.now() - t)
    return out
  }
  const logRows = timed(() => pruneChangeLog(db, logKeepFrom, batch))
  if (cutoff === null) return { removed: logRows, data: 0 }
  let n = 0
  for (const sql of [
    'DELETE FROM observations WHERE id IN (SELECT id FROM observations WHERE event_wall_ms < ? ORDER BY event_wall_ms LIMIT ?)',
    'DELETE FROM intervals WHERE id IN (SELECT id FROM intervals WHERE start_wall_ms < ? ORDER BY start_wall_ms LIMIT ?)',
    'DELETE FROM capture_gaps WHERE id IN (SELECT id FROM capture_gaps WHERE end_wall_ms < ? LIMIT ?)',
    'DELETE FROM assistant_reads WHERE id IN (SELECT id FROM assistant_reads WHERE to_wall_ms < ? LIMIT ?)',
  ]) {
    n += timed(() => db.prepare(sql).run(cutoff, batch).changes)
  }
  const docs = (db.prepare('SELECT id FROM search_docs WHERE hour_start_wall_ms < ? AND last_wall_ms < ? LIMIT ?').all(cutoff, cutoff, DOCS_PER_STEP) as { id: number }[]).map((r) => r.id)
  const hours = (db.prepare('SELECT id FROM hours WHERE end_wall_ms <= ? LIMIT ?').all(cutoff, HOURS_PER_STEP) as { id: number }[]).map((r) => r.id)
  const delDoc = db.prepare('DELETE FROM search_docs WHERE id = ?')
  const delHourDocs = db.prepare(`DELETE FROM search_docs WHERE kind = 'hour' AND hour_id = ?`)
  const delHour = db.prepare('DELETE FROM hours WHERE id = ?')
  for (let i = 0; i < docs.length; ) {
    i += timed(() => secureFts(db, () => timeBoxed(docs.slice(i), (id) => (n += delDoc.run(id).changes))))
  }
  for (let i = 0; i < hours.length; ) {
    i += timed(() =>
      secureFts(db, () =>
        timeBoxed(hours.slice(i), (id) => {
          delHourDocs.run(id)
          n += delHour.run(id).changes
        }),
      ),
    )
  }
  return { removed: n + logRows, data: n }
}

// FTS5 secure-delete removes a deleted entry's terms as it goes; set only inside the caller's transaction, as a
// literal (FTS5 rejects a bound value).
function secureFts<T>(db: Database.Database, fn: () => T): T {
  db.exec(`INSERT INTO search (search, rank) VALUES ('secure-delete', 1)`)
  const out = fn()
  db.exec(`INSERT INTO search (search, rank) VALUES ('secure-delete', 0)`)
  return out
}

export type DeletionStep = 'observations' | 'intervals' | 'search' | 'hours' | 'threads'

/** Removes everything a tombstone covers, in short transactions, driven by its planned work. Safe to run again. */
export class Deleter {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  private withSecureFts<T>(fn: () => T): T {
    return immediateRetrying(this.db, () => secureFts(this.db, fn))
  }

  /** Retention, off the capture thread: batches until nothing is older than the cutoff, then the log is purged. */
  prune(cutoff: number | null, logKeepFrom: number): PruneResult {
    const r: PruneResult = { removed: 0, data: 0, batches: 0, maxTransactionMs: 0 }
    if (cutoff !== null) warmSearchIndex(this.db)
    for (;;) {
      const step = pruneStep(this.db, cutoff, logKeepFrom, ROWS_PER_STEP, (ms) => (r.maxTransactionMs = Math.max(r.maxTransactionMs, ms)))
      r.removed += step.removed
      r.data += step.data
      r.batches++
      if (step.removed === 0) break
    }
    if (r.removed > 0) this.db.pragma('wal_checkpoint(TRUNCATE)')
    return r
  }

  private work(tombstoneId: number, kind: 'doc_hour' | 'hour' | 'thread' | 'read', limit: number): number[] {
    return (this.db.prepare('SELECT ref FROM deletion_work WHERE tombstone_id = ? AND kind = ? ORDER BY ref LIMIT ?').all(tombstoneId, kind, limit) as { ref: number }[]).map((r) => r.ref)
  }

  private done(tombstoneId: number, kind: string, refs: number[]): void {
    const del = this.db.prepare('DELETE FROM deletion_work WHERE tombstone_id = ? AND kind = ? AND ref = ?')
    for (const ref of refs) del.run(tombstoneId, kind, ref)
  }

  /** `stopAfter` ends the run after a step, as a crash there would (tests). */
  run(tombstoneId: number, nowWallMs: number, opts: { stopAfter?: DeletionStep } = {}): DeletionResult {
    const db = this.db
    const t = db.prepare('SELECT id, kind, from_wall_ms, to_wall_ms, app_id, site, state FROM deletions WHERE id = ?').get(tombstoneId) as Tombstone | undefined
    const r: DeletionResult = { tombstone: tombstoneId, observations: 0, intervals: 0, searchDocs: 0, hoursRemoved: 0, hoursCleared: 0, assistantReads: 0, purged: false }
    if (!t) return r
    const stop = (step: DeletionStep) => {
      if (opts.stopAfter === step) throw new Error(`stopped after ${step}`)
    }
    const rules = new Rules(db, () => nowWallMs)
    const derived = new Derived(db, { cut: (s, e, row) => rules.cut(s, e, row), admit: (row) => rules.accepts(row.event_wall_ms, row.app_id, row.url) })
    const args = bounds(t)
    const { from, to } = args
    const bounded = t.from_wall_ms !== null && t.to_wall_ms !== null
    const pre = prefilter(db, t)
    const ivMatch = intervalMatch(t)
    const matches = (o: { app_id: string | null; url?: string | null }) => tombstoneMatches(t, o.app_id, o.url ?? null)

    if (t.kind === 'site') {
      const page = db.prepare(`SELECT id, app_id, url FROM observations WHERE url IS NOT NULL AND event_wall_ms >= @from AND event_wall_ms < @to AND id > @after ORDER BY id LIMIT 2000`)
      const del = db.prepare('DELETE FROM observations WHERE id = ?')
      for (let after = 0; hasUrl(db); ) {
        const rows = page.all({ ...args, after }) as Obs[]
        if (rows.length === 0) break
        immediateRetrying(db, () => {
          for (const o of rows.filter(matches)) r.observations += del.run(o.id).changes
        })
        after = rows[rows.length - 1]!.id
      }
    } else {
      const step = db.prepare(`DELETE FROM observations WHERE id IN (SELECT id FROM observations WHERE event_wall_ms >= @from AND event_wall_ms < @to AND ${pre} LIMIT ${ROWS_PER_STEP})`)
      for (let n = -1; n !== 0; ) r.observations += n = immediateRetrying(db, () => step.run(args).changes)
    }
    stop('observations')
    const ivStep = db.prepare(`DELETE FROM intervals WHERE id IN (SELECT id FROM intervals WHERE ${ivMatch} AND start_wall_ms >= @from AND start_wall_ms < @to LIMIT ${ROWS_PER_STEP})`)
    for (let n = -1; n !== 0; ) r.intervals += n = immediateRetrying(db, () => ivStep.run(args).changes)
    if (bounded) {
      // Rows around the range (trimmed, split, or whose next row is gone) get their intervals again.
      for (let at: number | null = from; at !== null; ) {
        const s: number = at
        at = immediateRetrying(db, () => derived.rederiveStep(s, to))
      }
    }
    stop('intervals')

    // Search: entries in hours wholly inside the range (or, across all time, every entry of the app or site) go by
    // query; hours cut by a range edge are rebuilt from the intervals that remain, as planned.
    const inside = bounded
      ? `hour_start_wall_ms >= @from AND hour_start_wall_ms + ${HOUR_MS} <= @to AND ${ivMatch}`
      : ivMatch
    warmSearchIndex(db)
    const docIds = db.prepare(`SELECT id FROM search_docs WHERE kind = 'activity' AND ${inside} LIMIT ${DOCS_PER_STEP}`)
    const delDoc = db.prepare('DELETE FROM search_docs WHERE id = ?')
    for (let ids = docIds.all(args) as { id: number }[]; ids.length > 0; ids = docIds.all(args) as { id: number }[]) {
      const batch = ids
      r.searchDocs += this.withSecureFts(() => timeBoxed(batch, ({ id }) => delDoc.run(id)))
    }
    const docCount = db.prepare(`SELECT count(*) AS n FROM search_docs WHERE kind = 'activity'`)
    for (let hours = this.work(tombstoneId, 'doc_hour', HOURS_PER_STEP); hours.length > 0; hours = this.work(tombstoneId, 'doc_hour', HOURS_PER_STEP)) {
      const batch = hours
      r.searchDocs += this.withSecureFts(() => {
        const before = (docCount.get() as { n: number }).n
        derived.rebuildDocs(batch)
        this.done(tombstoneId, 'doc_hour', batch)
        return Math.max(0, before - (docCount.get() as { n: number }).n)
      })
    }
    if (t.kind === 'range') {
      immediateRetrying(db, () => {
        db.prepare('UPDATE capture_gaps SET end_wall_ms = ? WHERE start_wall_ms < ? AND end_wall_ms > ?').run(from, from, from)
        db.prepare(`DELETE FROM capture_gaps WHERE start_wall_ms >= ? AND start_wall_ms < ? AND reason != 'paused'`).run(from, to)
      })
    }
    stop('search')

    // Hours: wholly inside a deleted range they go; otherwise the hour loses its text and waits for a rewrite.
    for (let ids = this.work(tombstoneId, 'hour', HOURS_PER_STEP); ids.length > 0; ids = this.work(tombstoneId, 'hour', HOURS_PER_STEP)) {
      const batch = ids
      this.withSecureFts(() => {
        const ran = timeBoxed(batch, (id) => {
          const h = db.prepare('SELECT id, start_wall_ms, end_wall_ms, sources FROM hours WHERE id = ?').get(id) as
            | { id: number; start_wall_ms: number; end_wall_ms: number; sources: string }
            | undefined
          if (!h) return
          if (t.kind === 'range' && h.start_wall_ms >= from && h.end_wall_ms <= to) {
            db.prepare('DELETE FROM search_docs WHERE hour_id = ?').run(h.id)
            db.prepare('DELETE FROM hours WHERE id = ?').run(h.id)
            r.hoursRemoved++
          } else {
            clearHour(db, h.id, JSON.parse(h.sources) as HourSource[], t, nowWallMs)
            r.hoursCleared++
          }
        })
        this.done(tombstoneId, 'hour', batch.slice(0, ran))
      })
    }
    stop('hours')

    // Threads: one left with no hours goes; one still linked elsewhere keeps its id and waits for a new title.
    for (let ids = this.work(tombstoneId, 'thread', HOURS_PER_STEP); ids.length > 0; ids = this.work(tombstoneId, 'thread', HOURS_PER_STEP)) {
      const batch = ids
      immediateRetrying(db, () => {
        for (const id of batch) {
          const left = (db.prepare('SELECT count(*) AS n FROM thread_hours WHERE thread_id = ?').get(id) as { n: number }).n
          if (left === 0) db.prepare('DELETE FROM threads WHERE id = ?').run(id)
          else db.prepare(`UPDATE threads SET title = '', needs_rewrite = 1, updated_wall_ms = ? WHERE id = ?`).run(nowWallMs, id)
        }
        this.done(tombstoneId, 'thread', batch)
      })
    }
    stop('threads')
    immediateRetrying(db, () => {
      // A thread created inside a deleted range with no hours at all goes too.
      if (t.kind === 'range') db.prepare('DELETE FROM threads WHERE created_wall_ms >= ? AND created_wall_ms < ? AND id NOT IN (SELECT thread_id FROM thread_hours)').run(from, to)
      // Reads go as planned: over the range, of the app or site, or of an affected hour.
      const delRead = db.prepare('DELETE FROM assistant_reads WHERE id = ?')
      for (const id of this.work(tombstoneId, 'read', Number.MAX_SAFE_INTEGER)) r.assistantReads += delRead.run(id).changes
      db.prepare(`DELETE FROM deletion_work WHERE tombstone_id = ?`).run(tombstoneId)
      db.prepare(`UPDATE deletions SET state = 'done' WHERE id = ? AND state = 'pending'`).run(tombstoneId)
    })
    return r
  }

  /**
   * Moves old pages out of the write-ahead log and marks the tombstone purged; false while a reader's snapshot still
   * holds them (the caller retries). Waits only briefly, since a reader may hold its snapshot for a long time.
   */
  purge(tombstoneId: number): boolean {
    const wait = this.db.pragma('busy_timeout', { simple: true }) as number
    this.db.pragma('busy_timeout = 100')
    try {
      const [res] = this.db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number; log: number; checkpointed: number }[]
      if (res === undefined || res.busy !== 0 || res.log !== 0) return false
    } finally {
      this.db.pragma(`busy_timeout = ${wait}`)
    }
    this.db.prepare(`UPDATE deletions SET state = 'purged' WHERE id = ? AND state = 'done'`).run(tombstoneId)
    return true
  }
}

/** The deletion worker thread, started on first use; jobs run one at a time, in order. */
export class DeletionWorker {
  private worker: Worker | null = null
  private next = 1
  // Each job remembers its worker: a closed worker exiting fails only the jobs it was given.
  private readonly pending = new Map<number, { worker: Worker; resolve: (r: unknown) => void; reject: (e: Error) => void }>()
  private readonly file: string
  private idle: ReturnType<typeof setTimeout> | null = null

  constructor(file: string) {
    this.file = file
  }

  // An idle worker holds about 22 MB, so it exits a while after its last job and starts again on the next.
  private static readonly IDLE_EXIT_MS = 30_000

  run(tombstone: number, nowWallMs: number): Promise<DeletionResult> {
    return this.send({ op: 'delete', tombstone, now: nowWallMs }) as Promise<DeletionResult>
  }

  purge(tombstone: number): Promise<boolean> {
    return this.send({ op: 'purge', tombstone }) as Promise<boolean>
  }

  prune(cutoff: number | null, logKeepFrom: number): Promise<PruneResult> {
    return this.send({ op: 'prune', cutoff, logKeepFrom }) as Promise<PruneResult>
  }

  private send(job: Record<string, unknown>): Promise<unknown> {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    const w = this.ensure()
    const id = this.next++
    w.ref()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { worker: w, resolve, reject })
      w.postMessage({ id, ...job })
    })
  }

  private ensure(): Worker {
    if (this.worker) return this.worker
    // The worker is a sibling module: .ts when run from source, .js when built.
    const ext = path.extname(fileURLToPath(import.meta.url))
    const w = new Worker(new URL(`./deletionWorker${ext}`, import.meta.url), { workerData: { file: this.file } })
    w.on('message', (m: { id: number; result?: unknown; error?: string }) => {
      const p = this.pending.get(m.id)
      this.pending.delete(m.id)
      if (![...this.pending.values()].some((p) => p.worker === w)) {
        w.unref()
        this.idle = setTimeout(() => void this.close(), DeletionWorker.IDLE_EXIT_MS)
        this.idle.unref()
      }
      if (!p) return
      if (m.error === undefined) p.resolve(m.result)
      else p.reject(new Error(m.error))
    })
    w.on('error', (err) => this.failAll(w, err as Error))
    w.on('exit', () => {
      if (this.worker === w) this.worker = null
      this.failAll(w, new Error('deletion worker stopped'))
    })
    this.worker = w
    return w
  }

  private failAll(w: Worker, err: Error): void {
    for (const [id, p] of this.pending) {
      if (p.worker !== w) continue
      this.pending.delete(id)
      p.reject(err)
    }
  }

  async close(): Promise<void> {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    const w = this.worker
    this.worker = null
    if (w) await w.terminate()
  }
}
