import Database from 'better-sqlite3'
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_EXCLUSIONS, type ExclusionRule } from './defaults.ts'
import type { GapDetail, GapPoint, GapReason, GapStart, ObservationRow, Sink } from './normalize.ts'
import type { Line, LineOf } from './protocol.ts'

export const DB_FILE = 'daylens-v2.sqlite'
const SCHEMA_VERSION = 3
const FLUSH_INTERVAL_MS = 1000
const FLUSH_AT_OPS = 256
const MAX_RETRY_MS = 30_000

export function defaultDataDir(): string {
  if (process.env.DAYLENS_V2_DATA_DIR) return process.env.DAYLENS_V2_DATA_DIR
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Daylens V2 Dev')
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Daylens V2 Dev')
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'daylens-v2-dev')
}

const V1_DIR_NAMES = new Set(['daylens', 'daylenswindows'])
const V1_FILE_NAMES = new Set(['daylens.sqlite', 'daylens.db'])

// V1's live database must never be opened by V2.
export function assertNotV1(dir: string): void {
  const resolved = existsSync(dir) ? realpathSync(dir) : path.resolve(dir)
  const parts = resolved.split(/[\\/]+/).map((p) => p.toLowerCase())
  for (const p of parts) {
    if (V1_DIR_NAMES.has(p)) throw new Error('refusing V1 data folder')
  }
  for (const f of V1_FILE_NAMES) {
    if (existsSync(path.join(resolved, f))) throw new Error('refusing a folder that holds a V1 database')
  }
}

// The folder check alone is not enough: a linked database file could point V2 at V1's database.
export function assertRealDatabaseFiles(dir: string): void {
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    let isLink = false
    try {
      isLink = lstatSync(path.join(dir, f)).isSymbolicLink()
    } catch {
      continue
    }
    if (isLink) throw new Error('refusing a linked database file')
  }
}

// One writer per data folder: ids are allocated in memory, so a second writer would collide.
// The lock is an exclusive SQLite transaction on a separate file: the OS holds it, a dead process
// releases it, and there is no half-written state for another process to mistake as abandoned.
export function acquireWriterLock(dir: string): () => void {
  const lock = new Database(path.join(dir, 'capture-writer.lock'))
  lock.pragma('busy_timeout = 0')
  // Simultaneous starters can each block the other's upgrade, so a busy reply is retried briefly;
  // once one process holds the lock, the others keep getting busy and give up.
  for (let attempt = 0; ; attempt++) {
    try {
      lock.exec('BEGIN EXCLUSIVE')
      break
    } catch (err) {
      const code = (err as { code?: unknown }).code
      const busy = typeof code === 'string' && code.startsWith('SQLITE_BUSY')
      if (!busy || attempt >= 20) {
        lock.close()
        throw busy ? new Error('another capture service is writing this folder') : err
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + Math.floor(Math.random() * 20))
    }
  }
  return () => {
    try {
      lock.close()
    } catch {}
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS capture_runs (
  id INTEGER PRIMARY KEY,
  run TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  helper TEXT NOT NULL,
  version TEXT NOT NULL,
  pid INTEGER NOT NULL,
  os TEXT NOT NULL,
  boot TEXT NOT NULL,
  boot_identity TEXT,
  started_wall_ms INTEGER NOT NULL,
  ended_wall_ms INTEGER,
  end_reason TEXT,
  last_heartbeat_wall_ms INTEGER,
  last_heartbeat_mono_us INTEGER,
  permissions TEXT NOT NULL,
  config TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY,
  run TEXT NOT NULL,
  seq INTEGER NOT NULL,
  boot TEXT NOT NULL,
  platform TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_wall_ms INTEGER NOT NULL,
  event_mono_us INTEGER NOT NULL,
  tz TEXT NOT NULL,
  tz_offset_min INTEGER NOT NULL,
  recorded_wall_ms INTEGER NOT NULL,
  last_seen_wall_ms INTEGER NOT NULL,
  repeat_count INTEGER NOT NULL DEFAULT 0,
  app_id TEXT,
  app_name TEXT,
  app_path TEXT,
  pid INTEGER,
  window TEXT,
  title TEXT,
  title_raw TEXT,
  title_state TEXT,
  state TEXT,
  detail TEXT,
  possibly_stale_since_wall_ms INTEGER
);
CREATE INDEX IF NOT EXISTS observations_event_wall ON observations(event_wall_ms);
CREATE TABLE IF NOT EXISTS capture_gaps (
  id INTEGER PRIMARY KEY,
  reason TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('all', 'titles', 'focus', 'session', 'power')),
  run TEXT,
  start_wall_ms INTEGER NOT NULL,
  start_mono_us INTEGER,
  start_boot TEXT,
  end_wall_ms INTEGER,
  end_mono_us INTEGER,
  end_boot TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS capture_gaps_start ON capture_gaps(start_wall_ms);
CREATE TABLE IF NOT EXISTS exclusions (
  id INTEGER PRIMARY KEY,
  match TEXT NOT NULL CHECK (match IN ('app_id', 'exe')),
  value TEXT NOT NULL,
  label TEXT NOT NULL,
  is_default INTEGER NOT NULL,
  UNIQUE (match, value)
);
`

type Op = { sql: string; params: unknown[] }

export interface StoreHealth {
  committedWallMs: number | null
  failingSinceWallMs: number | null
  droppedOps: number
  pendingOps: number
}

// The last point the service is known to have been running, written in execution order. Wall clocks can move
// backwards, so the latest write wins rather than the largest time, and it carries boot and monotonic context.
export interface Checkpoint {
  wall_ms: number
  mono_us: number | null
  boot: string | null
  // How the helper named that boot; only 'kernel' names can prove two readings share a boot.
  boot_identity?: 'kernel' | 'clock' | null
  clean: boolean
}

export interface PreviousCoverage {
  endWallMs: number
  clean: boolean
  monoUs: number | null
  boot: string | null
  bootIdentity: 'kernel' | 'clock' | null
}

export interface StoreOptions {
  now?: () => number
  onError?: (code: string) => void
  busyTimeoutMs?: number
  maxPendingOps?: number
}

// Errors from a single bad statement; retrying the batch would fail forever.
function isStatementError(code: string): boolean {
  return code.startsWith('SQLITE_CONSTRAINT') || code === 'SQLITE_MISMATCH' || code === 'SQLITE_RANGE' || code === 'SQLITE_ERROR'
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown })?.code
  return typeof code === 'string' ? code : 'unknown'
}

export class Store implements Sink {
  readonly file: string
  private readonly db: Database.Database
  private readonly now: () => number
  private readonly onError: (code: string) => void
  private readonly stmts = new Map<string, Database.Statement>()
  private pending: Op[] = []
  private heartbeatOps = new Map<string, Op>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private nextObsId: number
  private nextGapId: number
  private health: StoreHealth = { committedWallMs: null, failingSinceWallMs: null, droppedOps: 0, pendingOps: 0 }
  private droppedSinceFailure = 0
  private failingStart: GapPoint | null = null
  private retryMs = FLUSH_INTERVAL_MS
  private overflowing = false
  private readonly releaseLock: () => void
  onOverflow: () => void = () => {}
  onRecovered: () => void = () => {}
  // Storage decides what may be written (pause, tombstones); a refused observation is never queued.
  acceptObservation: (row: ObservationRow) => boolean = () => true
  // Whether a row may be extended from its current last sighting to a later one (nothing forbidden in between).
  acceptExtension: (row: ObservationRow, fromWallMs: number, toWallMs: number) => boolean = () => true
  // Rows still open for extension: the normalizer keeps only the newest few, so a short window is enough.
  private readonly openRows = new Map<number, { row: ObservationRow; lastSeen: number }>()
  // Observation ids written by each committed flush, for state derived from observations (intervals, search).
  onFlushed: (observationIds: number[]) => void = () => {}
  private touched = new Set<number>()
  private touchedFromWallMs = Number.POSITIVE_INFINITY
  private readonly maxPendingOps: number

  constructor(dir: string, opts: StoreOptions = {}) {
    assertNotV1(dir)
    mkdirSync(dir, { recursive: true })
    assertNotV1(dir)
    assertRealDatabaseFiles(dir)
    this.releaseLock = acquireWriterLock(dir)
    this.file = path.join(dir, DB_FILE)
    this.now = opts.now ?? Date.now
    this.onError = opts.onError ?? (() => {})
    this.maxPendingOps = opts.maxPendingOps ?? 50_000
    this.db = new Database(this.file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 1000}`)
    this.db.pragma('cache_size = -2000')
    this.db.pragma('wal_autocheckpoint = 1000')
    this.db.exec(SCHEMA)
    const version = this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined
    if (!version) this.db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION))
    else {
      let v = Number(version.value)
      if (v === 1) v = this.migrateV1()
      if (v === 2) v = this.migrateV2()
      if (v !== SCHEMA_VERSION) throw new Error(`unsupported schema version ${version.value}`)
    }
    this.seedExclusions()
    this.nextObsId = ((this.db.prepare('SELECT max(id) AS m FROM observations').get() as { m: number | null }).m ?? 0) + 1
    this.nextGapId = ((this.db.prepare('SELECT max(id) AS m FROM capture_gaps').get() as { m: number | null }).m ?? 0) + 1
  }

  // v2 widens the gap scopes; SQLite cannot alter a CHECK, so the table is rebuilt.
  private migrateV1(): number {
    this.db.transaction(() => {
      this.db.exec(`
        ALTER TABLE capture_gaps RENAME TO capture_gaps_v1;
        ${SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS capture_gaps'), SCHEMA.indexOf('CREATE INDEX IF NOT EXISTS capture_gaps_start'))}
        INSERT INTO capture_gaps SELECT * FROM capture_gaps_v1;
        DROP TABLE capture_gaps_v1;
        CREATE INDEX IF NOT EXISTS capture_gaps_start ON capture_gaps(start_wall_ms);
      `)
      this.db.prepare(`UPDATE meta SET value = '2' WHERE key = 'schema_version'`).run()
    })()
    return 2
  }

  // v3 records whether each run's boot identity can survive a clock change.
  private migrateV2(): number {
    this.db.transaction(() => {
      const cols = this.db.prepare(`PRAGMA table_info(capture_runs)`).all() as { name: string }[]
      if (!cols.some((c) => c.name === 'boot_identity')) this.db.exec('ALTER TABLE capture_runs ADD COLUMN boot_identity TEXT')
      this.db.prepare(`UPDATE meta SET value = '3' WHERE key = 'schema_version'`).run()
    })()
    return 3
  }

  private seedExclusions(): void {
    const seeded = this.db.prepare(`SELECT value FROM meta WHERE key = 'exclusions_seeded'`).get()
    if (seeded) return
    const ins = this.db.prepare('INSERT OR IGNORE INTO exclusions (match, value, label, is_default) VALUES (?, ?, ?, 1)')
    this.db.transaction(() => {
      for (const r of DEFAULT_EXCLUSIONS) ins.run(r.match, r.value, r.label)
      this.db.prepare(`INSERT INTO meta (key, value) VALUES ('exclusions_seeded', '1')`).run()
    })()
  }

  exclusions(): ExclusionRule[] {
    return this.db.prepare('SELECT match, value, label FROM exclusions ORDER BY id').all() as ExclusionRule[]
  }

  // --- coverage bookkeeping ---------------------------------------------

  // Where the last service run's confirmed coverage ended, and whether it stopped cleanly.
  previousCoverage(): PreviousCoverage | null {
    const cp = this.db.prepare(`SELECT value FROM meta WHERE key = 'checkpoint'`).get() as { value: string } | undefined
    if (cp) {
      const c = JSON.parse(cp.value) as Checkpoint
      return { endWallMs: c.wall_ms, clean: c.clean, monoUs: c.mono_us, boot: c.boot, bootIdentity: c.boot_identity ?? null }
    }
    const run = this.db
      .prepare('SELECT max(coalesce(ended_wall_ms, 0), coalesce(last_heartbeat_wall_ms, 0), started_wall_ms) AS t FROM capture_runs ORDER BY id DESC LIMIT 1')
      .get() as { t: number } | undefined
    const obs = this.db.prepare('SELECT last_seen_wall_ms AS t FROM observations ORDER BY id DESC LIMIT 1').get() as { t: number } | undefined
    const stopped = this.db.prepare(`SELECT value FROM meta WHERE key = 'service_stopped_wall_ms'`).get() as { value: string } | undefined
    const alive = this.db.prepare(`SELECT value FROM meta WHERE key = 'service_alive_wall_ms'`).get() as { value: string } | undefined
    const candidates = [run?.t ?? null, obs?.t ?? null, stopped ? Number(stopped.value) : null, alive ? Number(alive.value) : null].filter((v): v is number => v !== null)
    if (candidates.length === 0) return null
    const endWallMs = Math.max(...candidates)
    return { endWallMs, clean: stopped !== undefined && Number(stopped.value) >= endWallMs, monoUs: null, boot: null, bootIdentity: null }
  }

  // Gaps left open by a service that died are closed where its coverage ended.
  closeDanglingGaps(end: GapPoint): void {
    // A pause outlives the service that started it; storage owns its gap and ends it on resume.
    this.db.prepare(`UPDATE capture_gaps SET end_wall_ms = ?, end_mono_us = ?, end_boot = ? WHERE end_wall_ms IS NULL AND reason != 'paused'`).run(end.wall_ms, end.mono_us, end.boot)
    this.db.prepare(`UPDATE capture_runs SET ended_wall_ms = coalesce(last_heartbeat_wall_ms, started_wall_ms), end_reason = 'service_died' WHERE ended_wall_ms IS NULL`).run()
  }

  markServiceStarted(wallMs: number): void {
    this.db.prepare(`DELETE FROM meta WHERE key = 'service_stopped_wall_ms'`).run()
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES ('checkpoint', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify({ wall_ms: wallMs, mono_us: null, boot: null, boot_identity: null, clean: false } satisfies Checkpoint))
  }

  writeCheckpoint(cp: Checkpoint): void {
    this.enqueue(`INSERT INTO meta (key, value) VALUES ('checkpoint', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(cp)])
  }

  setGapStart(id: number, start: GapPoint): void {
    this.enqueue('UPDATE capture_gaps SET start_wall_ms = ?, start_mono_us = ?, start_boot = ? WHERE id = ?', [start.wall_ms, start.mono_us, start.boot, id])
  }

  // Proof the service itself was running, independent of the helper: bounds a later service_down gap.
  touchAlive(wallMs: number): void {
    this.enqueue(`INSERT INTO meta (key, value) VALUES ('service_alive_wall_ms', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(wallMs)])
  }

  markServiceStopped(wallMs: number): void {
    this.enqueue(`INSERT INTO meta (key, value) VALUES ('service_stopped_wall_ms', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(wallMs)])
  }

  startRun(line: LineOf<'hello'>): void {
    const o = line.obs
    this.enqueue(
      `INSERT INTO capture_runs (run, platform, helper, version, pid, os, boot, boot_identity, started_wall_ms, permissions, config)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run) DO NOTHING`,
      [line.run, line.platform, o.helper, o.version, o.pid, o.os, line.boot, o.boot_identity, line.t.wall_ms, JSON.stringify(o.permissions), JSON.stringify(o.config)],
    )
  }

  recordHeartbeat(line: Line): void {
    this.heartbeatOps.set(line.run, {
      sql: 'UPDATE capture_runs SET last_heartbeat_wall_ms = ?, last_heartbeat_mono_us = ? WHERE run = ?',
      params: [line.t.wall_ms, line.t.mono_us, line.run],
    })
    this.schedule()
  }

  endRun(run: string, wallMs: number, reason: string): void {
    this.enqueue('UPDATE capture_runs SET ended_wall_ms = ?, end_reason = ? WHERE run = ? AND ended_wall_ms IS NULL', [wallMs, reason, run])
  }

  // --- Sink -------------------------------------------------------------

  /** The connection, for storage modules in the same process. Only this process writes the database. */
  get database(): Database.Database {
    return this.db
  }

  /** An id for a row written directly by storage (a row split by a deletion); queued writes are flushed first. */
  allocateObservationId(): number {
    return this.nextObsId++
  }

  // A row that fell out of the in-memory window is read back; one still queued is in the window by construction.
  private storedOpenRow(id: number): { row: ObservationRow; lastSeen: number } | undefined {
    const r = this.db.prepare('SELECT * FROM observations WHERE id = ?').get(id) as (ObservationRow & { last_seen_wall_ms: number }) | undefined
    return r ? { row: r, lastSeen: r.last_seen_wall_ms } : undefined
  }

  /** Ids handed out for refused observations; extending them does nothing. */
  static readonly REFUSED = -1

  insertObservation(row: ObservationRow): number {
    if (!this.acceptObservation(row)) return Store.REFUSED
    const id = this.nextObsId++
    this.touched.add(id)
    this.touchedFromWallMs = Math.min(this.touchedFromWallMs, row.event_wall_ms)
    this.openRows.set(id, { row, lastSeen: row.event_wall_ms })
    if (this.openRows.size > 64) this.openRows.delete(this.openRows.keys().next().value!)
    this.enqueue(
      `INSERT INTO observations (id, run, seq, boot, platform, source, kind, event_wall_ms, event_mono_us, tz, tz_offset_min,
         recorded_wall_ms, last_seen_wall_ms, app_id, app_name, app_path, pid, window, title, title_raw, title_state, state, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, row.run, row.seq, row.boot, row.platform, row.source, row.kind, row.event_wall_ms, row.event_mono_us, row.tz, row.tz_offset_min,
        this.now(), row.event_wall_ms, row.app_id, row.app_name, row.app_path, row.pid, row.window, row.title, row.title_raw, row.title_state,
        row.state, row.detail,
      ],
    )
    return id
  }

  extendObservation(id: number, lastSeenWallMs: number): boolean {
    if (id === Store.REFUSED) return false
    const open = this.openRows.get(id) ?? this.storedOpenRow(id)
    if (open && lastSeenWallMs > open.lastSeen) {
      if (!this.acceptExtension(open.row, open.lastSeen, lastSeenWallMs)) {
        this.openRows.delete(id)
        return false
      }
      open.lastSeen = lastSeenWallMs
    }
    if (open) {
      this.openRows.delete(id)
      this.openRows.set(id, open)
      this.touchedFromWallMs = Math.min(this.touchedFromWallMs, open.row.event_wall_ms)
    }
    this.touched.add(id)
    this.enqueue('UPDATE observations SET last_seen_wall_ms = max(last_seen_wall_ms, ?), repeat_count = repeat_count + 1 WHERE id = ?', [lastSeenWallMs, id])
    return true
  }

  flagObservation(id: number, _flag: 'possibly_stale', wallMs: number): void {
    this.enqueue('UPDATE observations SET possibly_stale_since_wall_ms = coalesce(possibly_stale_since_wall_ms, ?) WHERE id = ?', [wallMs, id])
  }

  openGap(gap: GapStart): number {
    const id = this.nextGapId++
    this.enqueue(
      'INSERT INTO capture_gaps (id, reason, scope, run, start_wall_ms, start_mono_us, start_boot, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, gap.reason, gap.scope, gap.run, gap.start.wall_ms, gap.start.mono_us, gap.start.boot, gap.detail ? JSON.stringify(gap.detail) : null],
    )
    return id
  }

  /** Writes a gap at once, inside the caller's transaction, for state that must commit together with it (a pause). */
  writeGapNow(gap: GapStart, end: GapPoint | null): number {
    const id = this.nextGapId++
    this.db
      .prepare('INSERT INTO capture_gaps (id, reason, scope, run, start_wall_ms, start_mono_us, start_boot, end_wall_ms, end_mono_us, end_boot, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, gap.reason, gap.scope, gap.run, gap.start.wall_ms, gap.start.mono_us, gap.start.boot, end?.wall_ms ?? null, end?.mono_us ?? null, end?.boot ?? null, gap.detail ? JSON.stringify(gap.detail) : null)
    return id
  }

  /** Sets a gap's end at once (earlier or later than before), inside the caller's transaction. */
  setGapEndNow(id: number, end: GapPoint): void {
    this.db.prepare('UPDATE capture_gaps SET end_wall_ms = max(?, start_wall_ms), end_mono_us = ?, end_boot = ? WHERE id = ?').run(end.wall_ms, end.mono_us, end.boot, id)
  }

  updateGap(id: number, patch: { reason?: GapReason; detail?: GapDetail }): void {
    if (patch.reason) this.enqueue('UPDATE capture_gaps SET reason = ? WHERE id = ?', [patch.reason, id])
    if (patch.detail) this.enqueue('UPDATE capture_gaps SET detail = ? WHERE id = ?', [JSON.stringify(patch.detail), id])
  }

  closeGap(id: number, end: GapPoint): void {
    // An end before the start (a hang found after a later gap opened) collapses to an empty gap, never a negative one.
    this.enqueue(
      'UPDATE capture_gaps SET end_wall_ms = max(?, start_wall_ms), end_mono_us = ?, end_boot = ? WHERE id = ? AND end_wall_ms IS NULL',
      [end.wall_ms, end.mono_us, end.boot, id],
    )
  }

  setGapEnd(id: number, end: GapPoint): void {
    this.enqueue('UPDATE capture_gaps SET end_wall_ms = max(?, start_wall_ms), end_mono_us = ?, end_boot = ? WHERE id = ?', [end.wall_ms, end.mono_us, end.boot, id])
  }

  reopenGap(id: number): void {
    this.enqueue('UPDATE capture_gaps SET end_wall_ms = NULL, end_mono_us = NULL, end_boot = NULL WHERE id = ?', [id])
  }

  // --- batching ---------------------------------------------------------

  private enqueue(sql: string, params: unknown[]): void {
    if (this.pending.length >= this.maxPendingOps) {
      this.pending.shift()
      this.health.droppedOps++
      this.droppedSinceFailure++
      if (!this.overflowing) {
        this.overflowing = true
        this.onOverflow()
      }
    }
    this.pending.push({ sql, params })
    if (this.pending.length >= FLUSH_AT_OPS && this.health.failingSinceWallMs === null) this.flush()
    else this.schedule()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, this.retryMs)
  }

  private stmt(sql: string): Database.Statement {
    let s = this.stmts.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.stmts.set(sql, s)
    }
    return s
  }

  flush(): boolean {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const ops = this.pending.concat([...this.heartbeatOps.values()])
    // Committed with the rows: where derived state (intervals, search) must be brought up to date from. Whoever
    // derives clears it in the same transaction as the derivation, so a crash in between loses nothing.
    if (this.touched.size > 0 && Number.isFinite(this.touchedFromWallMs)) {
      ops.push({
        sql: `INSERT INTO meta (key, value) VALUES ('derive_from', ?) ON CONFLICT (key) DO UPDATE SET value = CAST(min(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`,
        params: [String(this.touchedFromWallMs)],
      })
    }
    if (ops.length === 0) return true
    try {
      this.db.transaction(() => {
        for (const op of ops) this.stmt(op.sql).run(...(op.params as unknown[]))
      })()
    } catch (err) {
      const code = errorCode(err)
      this.onError(code)
      let retry = !isStatementError(code)
      if (!retry) {
        try {
          this.runSkippingBadOps(ops)
        } catch (inner) {
          this.onError(errorCode(inner))
          retry = true
        }
      }
      if (retry) {
        if (this.health.failingSinceWallMs === null) {
          this.health.failingSinceWallMs = this.now()
          this.failingStart = { wall_ms: this.health.failingSinceWallMs, mono_us: null, boot: null }
        }
        this.health.pendingOps = this.pending.length
        this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS)
        this.schedule()
        return false
      }
    }
    this.retryMs = FLUSH_INTERVAL_MS
    this.pending = []
    this.heartbeatOps.clear()
    const committed = this.now()
    if (this.failingStart !== null) {
      const dropped = this.droppedSinceFailure
      const start = this.failingStart
      this.failingStart = null
      this.health.failingSinceWallMs = null
      this.droppedSinceFailure = 0
      if (dropped > 0) {
        const id = this.openGap({ reason: 'storage_failed', scope: 'all', run: null, start, detail: { dropped_ops: dropped } })
        this.closeGap(id, { wall_ms: committed, mono_us: null, boot: null })
        this.flush()
      }
      if (this.overflowing) {
        this.overflowing = false
        this.onRecovered()
      }
    }
    this.health.committedWallMs = committed
    this.health.pendingOps = 0
    if (this.touched.size > 0) {
      const ids = [...this.touched]
      this.touched.clear()
      this.touchedFromWallMs = Number.POSITIVE_INFINITY
      this.onFlushed(ids)
    }
    return true
  }

  private runSkippingBadOps(ops: Op[]): void {
    this.db.transaction(() => {
      for (const op of ops) {
        try {
          this.stmt(op.sql).run(...(op.params as unknown[]))
        } catch (err) {
          const code = errorCode(err)
          // Only a statement that can never succeed is dropped; anything else fails the batch for a retry.
          if (!isStatementError(code)) throw err
          this.onError(code)
          this.health.droppedOps++
        }
      }
    })()
  }

  storeHealth(): StoreHealth {
    return { ...this.health, pendingOps: this.pending.length }
  }

  close(): void {
    this.flush()
    this.db.close()
    this.releaseLock()
  }

  // Test and tooling access; never used by capture itself.
  query<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[]
  }
}
