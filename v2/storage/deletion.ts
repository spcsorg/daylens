// Deletion in two parts. The fence runs on the capture thread in one short transaction: the tombstone goes in force
// for capture and import, and rows crossing the range edges are trimmed or split. The rest (removing rows, search
// entries, hours, threads and reads) runs in a worker thread with its own connection, in short transactions, so
// capture never waits on it for long and the user's action returns at once.
import type Database from 'better-sqlite3'
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ObservationRow } from '../capture/normalize.ts'
import { Derived, hoursOf, MAX_INTERVAL_MS } from './derive.ts'
import { clearHour, sourceMatches, type HourSource } from './hours.ts'
import { Rules, tombstoneMatches, type Tombstone } from './rules.ts'

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

const ROWS_PER_STEP = 500
const DOCS_PER_STEP = 50
const HOURS_PER_STEP = 25

/** Removes everything a tombstone covers, in short transactions. Safe to run again after a crash. */
export class Deleter {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  // FTS5 secure-delete removes a deleted entry's terms as it goes; set only inside these transactions, as a literal.
  private withSecureFts<T>(fn: () => T): T {
    return this.db.transaction(() => {
      this.db.exec(`INSERT INTO search (search, rank) VALUES ('secure-delete', 1)`)
      const out = fn()
      this.db.exec(`INSERT INTO search (search, rank) VALUES ('secure-delete', 0)`)
      return out
    })()
  }

  run(tombstoneId: number, nowWallMs: number): DeletionResult {
    const db = this.db
    const t = db.prepare('SELECT id, kind, from_wall_ms, to_wall_ms, app_id, site, state FROM deletions WHERE id = ?').get(tombstoneId) as Tombstone | undefined
    const r: DeletionResult = { tombstone: tombstoneId, observations: 0, intervals: 0, searchDocs: 0, hoursRemoved: 0, hoursCleared: 0, assistantReads: 0, purged: false }
    if (!t) return r
    const rules = new Rules(db, () => nowWallMs)
    const derived = new Derived(db, { cut: (s, e, row) => rules.cut(s, e, row), admit: (row) => rules.accepts(row.event_wall_ms, row.app_id, row.url) })
    const args = bounds(t)
    const { from, to } = args
    const bounded = t.from_wall_ms !== null && t.to_wall_ms !== null
    const pre = prefilter(db, t)
    const ivMatch = intervalMatch(t)
    const matches = (o: { app_id: string | null; url?: string | null }) => tombstoneMatches(t, o.app_id, o.url ?? null)

    // Hours whose search entries may change: every hour an affected interval touched, by start or by overlap.
    const touchedHours = new Set<number>()
    for (const row of db
      .prepare(`SELECT start_wall_ms, end_wall_ms, tz_offset_min FROM intervals WHERE ${ivMatch} AND ((start_wall_ms >= @from AND start_wall_ms < @to) OR (end_wall_ms > @from AND start_wall_ms < @to))`)
      .all(args) as { start_wall_ms: number; end_wall_ms: number; tz_offset_min: number }[]) {
      for (const h of hoursOf(row.start_wall_ms, row.end_wall_ms, row.tz_offset_min)) touchedHours.add(h)
    }

    if (t.kind === 'site') {
      const page = db.prepare(`SELECT id, app_id, url FROM observations WHERE url IS NOT NULL AND event_wall_ms >= @from AND event_wall_ms < @to AND id > @after ORDER BY id LIMIT 2000`)
      const del = db.prepare('DELETE FROM observations WHERE id = ?')
      for (let after = 0; hasUrl(db); ) {
        const rows = page.all({ ...args, after }) as Obs[]
        if (rows.length === 0) break
        db.transaction(() => {
          for (const o of rows.filter(matches)) r.observations += del.run(o.id).changes
        })()
        after = rows[rows.length - 1]!.id
      }
    } else {
      const step = db.prepare(`DELETE FROM observations WHERE id IN (SELECT id FROM observations WHERE event_wall_ms >= @from AND event_wall_ms < @to AND ${pre} LIMIT ${ROWS_PER_STEP})`)
      for (let n = -1; n !== 0; ) r.observations += n = step.run(args).changes
    }
    const ivStep = db.prepare(`DELETE FROM intervals WHERE id IN (SELECT id FROM intervals WHERE ${ivMatch} AND start_wall_ms >= @from AND start_wall_ms < @to LIMIT ${ROWS_PER_STEP})`)
    for (let n = -1; n !== 0; ) r.intervals += n = ivStep.run(args).changes

    const docCount = db.prepare(`SELECT count(*) AS n FROM search_docs WHERE kind = 'activity'`)
    if (bounded) {
      // Rows around the range (trimmed, split, or whose next row is gone) get their intervals again.
      for (let at: number | null = from; at !== null; ) {
        const s: number = at
        at = db.transaction(() => derived.rederiveStep(s, to))()
      }
      const before = (docCount.get() as { n: number }).n
      const hours = [...touchedHours]
      for (let i = 0; i < hours.length; i += HOURS_PER_STEP) this.withSecureFts(() => derived.rebuildDocs(hours.slice(i, i + HOURS_PER_STEP)))
      r.searchDocs += Math.max(0, before - (docCount.get() as { n: number }).n)
    } else {
      // Across all time no row crosses an edge; every search entry of the app or site goes.
      const step = db.prepare(`DELETE FROM search_docs WHERE id IN (SELECT id FROM search_docs WHERE kind = 'activity' AND ${ivMatch} LIMIT ${DOCS_PER_STEP})`)
      for (let n = -1; n !== 0; ) r.searchDocs += n = this.withSecureFts(() => step.run(args).changes)
    }
    if (t.kind === 'range') {
      db.transaction(() => {
        db.prepare('UPDATE capture_gaps SET end_wall_ms = ? WHERE start_wall_ms < ? AND end_wall_ms > ?').run(from, from, from)
        db.prepare(`DELETE FROM capture_gaps WHERE start_wall_ms >= ? AND start_wall_ms < ? AND reason != 'paused'`).run(from, to)
      })()
    }

    // Hours: wholly inside a deleted range they go; otherwise any hour that drew on the material loses its text.
    const hours = (db.prepare('SELECT id, start_wall_ms, end_wall_ms, sources FROM hours WHERE end_wall_ms > ? AND start_wall_ms < ?').all(from, to) as {
      id: number
      start_wall_ms: number
      end_wall_ms: number
      sources: string
    }[]).filter((h) => t.kind === 'range' || (JSON.parse(h.sources) as HourSource[]).some((s) => sourceMatches(t, s)))
    const touchedThreads = new Set<number>()
    const touchedReads = new Set<number>()
    for (let i = 0; i < hours.length; i += HOURS_PER_STEP) {
      this.withSecureFts(() => {
        for (const h of hours.slice(i, i + HOURS_PER_STEP)) {
          for (const { id } of db.prepare('SELECT thread_id AS id FROM thread_hours WHERE hour_id = ?').all(h.id) as { id: number }[]) touchedThreads.add(id)
          // Reads that returned an affected hour saw its text; collected before the hour is removed or cleared.
          for (const { id } of db.prepare('SELECT read_id AS id FROM assistant_read_items WHERE hour_id = ?').all(h.id) as { id: number }[]) touchedReads.add(id)
          if (t.kind === 'range' && h.start_wall_ms >= from && h.end_wall_ms <= to) {
            db.prepare('DELETE FROM search_docs WHERE hour_id = ?').run(h.id)
            db.prepare('DELETE FROM hours WHERE id = ?').run(h.id)
            r.hoursRemoved++
          } else {
            clearHour(db, h.id, JSON.parse(h.sources) as HourSource[], t, nowWallMs)
            r.hoursCleared++
          }
        }
      })
    }

    db.transaction(() => {
      // Threads: one left with no hours goes; one still linked elsewhere keeps its id and waits for a new title.
      for (const id of touchedThreads) {
        const left = (db.prepare('SELECT count(*) AS n FROM thread_hours WHERE thread_id = ?').get(id) as { n: number }).n
        if (left === 0) db.prepare('DELETE FROM threads WHERE id = ?').run(id)
        else db.prepare(`UPDATE threads SET title = '', needs_rewrite = 1, updated_wall_ms = ? WHERE id = ?`).run(nowWallMs, id)
      }
      // A thread created inside a deleted range with no hours at all goes too.
      if (t.kind === 'range') db.prepare('DELETE FROM threads WHERE created_wall_ms >= ? AND created_wall_ms < ? AND id NOT IN (SELECT thread_id FROM thread_hours)').run(from, to)

      // Reads go by what they read: any read over a deleted range, a read that returned the deleted app or site
      // within its span, and a read that returned an affected hour.
      const items =
        t.kind === 'range'
          ? db.prepare('SELECT id FROM assistant_reads WHERE to_wall_ms > ? AND from_wall_ms < ?').all(from, to)
          : t.kind === 'source'
            ? db.prepare('SELECT i.read_id AS id FROM assistant_read_items i JOIN assistant_reads a ON a.id = i.read_id WHERE i.app_id = ? AND a.to_wall_ms > ? AND a.from_wall_ms < ?').all(t.app_id, from, to)
            : db
                .prepare(`SELECT i.read_id AS id FROM assistant_read_items i JOIN assistant_reads a ON a.id = i.read_id WHERE (i.site = ? OR i.site LIKE '%.' || ?) AND a.to_wall_ms > ? AND a.from_wall_ms < ?`)
                .all(t.site, t.site, from, to)
      for (const { id } of items as { id: number }[]) touchedReads.add(id)
      const delRead = db.prepare('DELETE FROM assistant_reads WHERE id = ?')
      for (const id of touchedReads) r.assistantReads += delRead.run(id).changes
      db.prepare(`UPDATE deletions SET state = 'done' WHERE id = ? AND state = 'pending'`).run(tombstoneId)
    })()
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
  private readonly pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>()
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

  private send(job: Record<string, unknown>): Promise<unknown> {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    const w = this.ensure()
    const id = this.next++
    w.ref()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
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
      if (this.pending.size === 0) {
        w.unref()
        this.idle = setTimeout(() => void this.close(), DeletionWorker.IDLE_EXIT_MS)
        this.idle.unref()
      }
      if (!p) return
      if (m.error === undefined) p.resolve(m.result)
      else p.reject(new Error(m.error))
    })
    w.on('error', (err) => this.failAll(err as Error))
    w.on('exit', () => {
      if (this.worker === w) this.worker = null
      this.failAll(new Error('deletion worker stopped'))
    })
    this.worker = w
    return w
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  async close(): Promise<void> {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    const w = this.worker
    this.worker = null
    if (w) await w.terminate()
  }
}
