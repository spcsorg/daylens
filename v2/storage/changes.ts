// Change announcements. A change to shared state is written once, together with a change_log row in the same
// transaction, then announced: in-process by a direct call to listeners, across processes by rewriting a tiny
// signal file that readers watch with fs.watch. The OS reports the write (FSEvents/kqueue, ReadDirectoryChangesW),
// so nobody polls; watch events can coalesce, so readers always catch up from the log by sequence number.
import type Database from 'better-sqlite3'
import { readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { Migration } from './migrations.ts'

export type ChangeKind = 'kept_titles' | 'correction' | 'deletion' | 'exclusion' | 'ai_choice' | 'plan' | 'usage' | 'pause' | 'retention' | 'setting' | 'hour'

export interface Change {
  seq: number
  at: number
  kind: ChangeKind
  // Content-free description: ids, ranges, keys. Never titles or addresses.
  payload: Record<string, unknown>
}

export const SIGNAL_FILE = 'changes.signal'

export const changeLogMigration: Migration = {
  name: 'change_log',
  up: (db) =>
    db.exec(`CREATE TABLE IF NOT EXISTS change_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at_wall_ms INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL
    )`),
}

type Listener = (c: Change) => void

export class ChangeBus {
  private readonly listeners = new Set<Listener>()
  private readonly db: Database.Database
  private readonly dir: string
  private readonly now: () => number

  constructor(db: Database.Database, dir: string, now: () => number = Date.now) {
    this.db = db
    this.dir = dir
    this.now = now
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private readonly queue: Change[] = []
  private dispatching = false

  /**
   * Runs `write` and records the change in one transaction. After it commits, `install` puts the new rules in force
   * (what capture and import may store), and only then is the change announced: a listener never acts on a change
   * whose rules are not yet in force. Changes made by listeners are queued, so every listener sees them in order.
   */
  commit<T>(kind: ChangeKind, payload: Record<string, unknown>, write: () => T, install?: (result: T) => void): T {
    let change!: Change
    // Immediate: write() may read before writing while another connection (the deletion worker) commits.
    const result = this.db.transaction(() => {
      const out = write()
      const at = this.now()
      const info = this.db.prepare('INSERT INTO change_log (at_wall_ms, kind, payload) VALUES (?, ?, ?)').run(at, kind, JSON.stringify(payload))
      change = { seq: Number(info.lastInsertRowid), at, kind, payload }
      return out
    }).immediate()
    install?.(result)
    this.queue.push(change)
    this.dispatch()
    return result
  }

  private dispatch(): void {
    if (this.dispatching) return
    this.dispatching = true
    try {
      for (let c = this.queue.shift(); c; c = this.queue.shift()) {
        this.signal(c.seq)
        for (const l of this.listeners) {
          try {
            l(c)
          } catch {
            // One reader's failure must not stop the others.
          }
        }
      }
    } finally {
      this.dispatching = false
    }
  }

  private signal(seq: number): void {
    const file = path.join(this.dir, SIGNAL_FILE)
    const tmp = `${file}.tmp`
    try {
      writeFileSync(tmp, String(seq))
      renameSync(tmp, file)
    } catch {
      // Readers still catch up from change_log on their next signal or start.
    }
  }
}

// The highest sequence already pruned from the log; a reader that has not reached it must refresh everything.
export function changeFloor(db: Database.Database): number {
  const r = db.prepare(`SELECT value FROM meta WHERE key = 'change_log_floor'`).get() as { value: string } | undefined
  return r ? Number(r.value) : 0
}

/** Removes announcements older than keepFromWallMs, at most `limit`, and raises the floor in the same transaction. */
export function pruneChangeLog(db: Database.Database, keepFromWallMs: number, limit: number): number {
  return db.transaction(() => {
    const top = db.prepare('SELECT max(seq) AS m FROM (SELECT seq FROM change_log WHERE at_wall_ms < ? ORDER BY seq LIMIT ?)').get(keepFromWallMs, limit) as { m: number | null }
    if (top.m === null) return 0
    const n = db.prepare('DELETE FROM change_log WHERE seq <= ?').run(top.m).changes
    db.prepare(`INSERT INTO meta (key, value) VALUES ('change_log_floor', ?) ON CONFLICT (key) DO UPDATE SET value = max(CAST(value AS INTEGER), excluded.value)`).run(String(top.m))
    return n
  }).immediate()
}

export function changesSince(db: Database.Database, seq: number, limit = 1000): Change[] {
  return (db.prepare('SELECT seq, at_wall_ms AS at, kind, payload FROM change_log WHERE seq > ? ORDER BY seq LIMIT ?').all(seq, limit) as {
    seq: number
    at: number
    kind: ChangeKind
    payload: string
  }[]).map((r) => ({ ...r, payload: JSON.parse(r.payload) as Record<string, unknown> }))
}

/** For another process (the MCP server, the interface): a read-only view that follows announcements. */
export class ChangeWatcher {
  private watcher: FSWatcher | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private retryMs = 25
  private last: number
  private readonly db: Database.Database
  private readonly dir: string
  private readonly onChange: (c: Change) => void
  private readonly onReset: () => void

  /** onReset: announcements this reader had not seen were pruned; reload everything, then follow changes again. */
  constructor(db: Database.Database, dir: string, onChange: (c: Change) => void, from: number | 'now' = 'now', opts: { onReset?: () => void } = {}) {
    this.db = db
    this.dir = dir
    this.onChange = onChange
    this.onReset = opts.onReset ?? (() => {})
    this.last = from === 'now' ? ((db.prepare('SELECT max(seq) AS m FROM change_log').get() as { m: number | null }).m ?? 0) : from
  }

  start(): void {
    this.watcher = watch(this.dir, (_event, name) => this.onFsEvent(name))
    // Reconcile regardless of the signal file: a signal can be lost, and changes may predate this reader.
    this.catchUp()
    this.followSignal()
  }

  /** Platforms name the atomic rename differently (the final name, the temporary one, or none). */
  onFsEvent(name: string | null): void {
    if (name !== null && !name.startsWith(SIGNAL_FILE)) return
    this.catchUp()
    this.followSignal()
  }

  get delivered(): number {
    return this.last
  }

  catchUp(): void {
    for (;;) {
      // Each page is read in its own transaction, so it sees everything committed before it began.
      const { floor, batch } = this.db.transaction(() => ({ floor: changeFloor(this.db), batch: changesSince(this.db, this.last) }))()
      if (this.last < floor) {
        this.last = floor
        this.onReset()
      }
      for (const c of batch) {
        this.last = c.seq
        this.onChange(c)
      }
      if (batch.length < 1000) return
    }
  }

  // The signal names the sequence that must be delivered; until it is, look again with backoff.
  private followSignal(): void {
    if (this.retry || !this.watcher) return
    const required = this.signalled()
    if (required <= this.last) {
      this.retryMs = 25
      return
    }
    this.retry = setTimeout(() => {
      this.retry = null
      this.catchUp()
      this.retryMs = Math.min(this.retryMs * 2, 1000)
      this.followSignal()
    }, this.retryMs)
    this.retry.unref?.()
  }

  private signalled(): number {
    try {
      const n = Number(readFileSync(path.join(this.dir, SIGNAL_FILE), 'utf8'))
      return Number.isFinite(n) ? n : 0
    } catch {
      return 0
    }
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
  }
}
