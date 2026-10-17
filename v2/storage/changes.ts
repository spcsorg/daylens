// Change announcements. A change to shared state is written once, together with a change_log row in the same
// transaction, then announced: in-process by a direct call to listeners, across processes by rewriting a tiny
// signal file that readers watch with fs.watch. The OS reports the write (FSEvents/kqueue, ReadDirectoryChangesW),
// so nobody polls; watch events can coalesce, so readers always catch up from the log by sequence number.
import type Database from 'better-sqlite3'
import { existsSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { Migration } from './migrations.ts'

export type ChangeKind = 'correction' | 'deletion' | 'exclusion' | 'ai_choice' | 'plan' | 'usage' | 'pause' | 'retention' | 'setting' | 'hour'

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

  /** Runs `write` and records the change in one transaction; announces only after it commits. */
  commit<T>(kind: ChangeKind, payload: Record<string, unknown>, write: () => T): T {
    let change!: Change
    const result = this.db.transaction(() => {
      const out = write()
      const at = this.now()
      const info = this.db.prepare('INSERT INTO change_log (at_wall_ms, kind, payload) VALUES (?, ?, ?)').run(at, kind, JSON.stringify(payload))
      change = { seq: Number(info.lastInsertRowid), at, kind, payload }
      return out
    })()
    this.signal(change.seq)
    for (const l of this.listeners) {
      try {
        l(change)
      } catch {
        // One reader's failure must not stop the others.
      }
    }
    return result
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
  private last: number
  private readonly db: Database.Database
  private readonly dir: string
  private readonly onChange: (c: Change) => void

  constructor(db: Database.Database, dir: string, onChange: (c: Change) => void, from: number | 'now' = 'now') {
    this.db = db
    this.dir = dir
    this.onChange = onChange
    this.last = from === 'now' ? ((db.prepare('SELECT max(seq) AS m FROM change_log').get() as { m: number | null }).m ?? 0) : from
  }

  start(): void {
    this.watcher = watch(this.dir, (_event, name) => {
      if (name === SIGNAL_FILE || name === null) this.catchUp()
    })
    if (existsSync(path.join(this.dir, SIGNAL_FILE)) && Number(readFileSync(path.join(this.dir, SIGNAL_FILE), 'utf8')) > this.last) this.catchUp()
  }

  catchUp(): void {
    for (;;) {
      const batch = changesSince(this.db, this.last)
      for (const c of batch) {
        this.last = c.seq
        this.onChange(c)
      }
      if (batch.length < 1000) return
    }
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
  }
}
