// Agent session tables: named migrations over new tables only, written through the capture store's connection.

import { randomBytes } from 'node:crypto'
import { chmodSync, linkSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { threadId } from 'node:worker_threads'
import type Database from 'better-sqlite3'
import { processKey, type Agent, type AgentRecord, type ParseCounts } from './types.ts'
import { admitsAt, admitsSpan, type Span } from './withheld.ts'
import { VACUUM_PENDING } from '../../storage/deletion.ts'

export const STAGING_FILE = 'agent-backfill.sqlite'
const KEY_FILE = 'agent-fingerprint.key'
const KEY_BYTES = 32

// The install's message fingerprint key, kept beside the database and readable only by its owner.
export function loadFingerprintKey(dataDir: string): Buffer {
  const file = path.join(dataDir, KEY_FILE)
  const tmp = `${file}.${process.pid}.${threadId}`
  try {
    // Linked in whole, so a concurrent reader never sees a partly written key.
    writeFileSync(tmp, randomBytes(KEY_BYTES), { mode: 0o600 })
    linkSync(tmp, file)
  } catch (err) {
    if ((err as { code?: unknown }).code !== 'EEXIST') throw err
  } finally {
    rmSync(tmp, { force: true })
  }
  let key = readFileSync(file)
  if (key.length !== KEY_BYTES) {
    key = randomBytes(KEY_BYTES)
    writeFileSync(file, key, { mode: 0o600 })
  }
  if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600)
  return key
}

// The first read's staging copy holds agent metadata outside the live tables, so it must not outlive a run.
export function removeStaging(dataDir: string): void {
  const staging = path.join(dataDir, STAGING_FILE)
  for (const f of [staging, `${staging}-wal`, `${staging}-shm`, `${staging}-journal`]) rmSync(f, { force: true })
}

export interface Migration {
  name: string
  up: (db: Database.Database) => void
}

// The same contract as the storage step's named migrations, so this one joins that list unchanged.
export function applyMigrations(db: Database.Database, migrations: readonly Migration[], now: () => number = Date.now): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_wall_ms INTEGER NOT NULL)')
  const done = new Set((db.prepare('SELECT name FROM migrations').all() as { name: string }[]).map((r) => r.name))
  const applied: string[] = []
  for (const m of migrations) {
    if (done.has(m.name)) continue
    db.transaction(() => {
      m.up(db)
      db.prepare('INSERT INTO migrations (name, applied_wall_ms) VALUES (?, ?)').run(m.name, now())
    })()
    applied.push(m.name)
  }
  return applied
}

export const agentSessionsMigration: Migration = {
  name: 'agent_sessions_v1',
  up: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id INTEGER PRIMARY KEY,
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN ('interactive', 'automated', 'subagent')),
        parent_session_id TEXT,
        client TEXT,
        project_dir TEXT,
        branch TEXT,
        first_wall_ms INTEGER NOT NULL,
        last_wall_ms INTEGER NOT NULL,
        recorded_wall_ms INTEGER NOT NULL,
        UNIQUE (agent, session_id)
      );
      CREATE TABLE IF NOT EXISTS agent_turns (
        id INTEGER PRIMARY KEY,
        agent TEXT NOT NULL,
        turn_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        project_dir TEXT,
        branch TEXT,
        opened_by TEXT NOT NULL,
        replayed INTEGER NOT NULL DEFAULT 0,
        start_wall_ms INTEGER NOT NULL,
        last_activity_wall_ms INTEGER NOT NULL,
        end_wall_ms INTEGER,
        end_state TEXT CHECK (end_state IN ('completed', 'aborted', 'failed', 'missing')),
        recorded_wall_ms INTEGER NOT NULL,
        UNIQUE (agent, turn_key)
      );
      CREATE INDEX IF NOT EXISTS agent_turns_start ON agent_turns(start_wall_ms);
      CREATE INDEX IF NOT EXISTS agent_turns_last ON agent_turns(last_activity_wall_ms);
      CREATE TABLE IF NOT EXISTS agent_events (
        id INTEGER PRIMARY KEY,
        agent TEXT NOT NULL,
        event_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_key TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('user', 'wait')),
        detail TEXT NOT NULL,
        basis TEXT,
        wall_ms INTEGER NOT NULL,
        end_wall_ms INTEGER,
        recorded_wall_ms INTEGER NOT NULL,
        UNIQUE (agent, event_key)
      );
      CREATE INDEX IF NOT EXISTS agent_events_wall ON agent_events(wall_ms);
      CREATE TABLE IF NOT EXISTS agent_sources (
        path TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        root TEXT NOT NULL,
        session_id TEXT,
        dev TEXT,
        ino TEXT,
        offset INTEGER NOT NULL,
        size INTEGER NOT NULL,
        state TEXT,
        lines INTEGER NOT NULL DEFAULT 0,
        bad_lines INTEGER NOT NULL DEFAULT 0,
        unknown_records INTEGER NOT NULL DEFAULT 0,
        updated_wall_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_sources_inode ON agent_sources(dev, ino);
      CREATE INDEX IF NOT EXISTS agent_sources_session ON agent_sources(agent, session_id);
      CREATE TABLE IF NOT EXISTS agent_health (
        agent TEXT NOT NULL,
        root TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('ok', 'not_found', 'unreadable', 'degraded')),
        reason TEXT,
        since_wall_ms INTEGER NOT NULL,
        checked_wall_ms INTEGER NOT NULL,
        detail TEXT,
        PRIMARY KEY (agent, root)
      );
    `),
}

export const agentSourcesTurnlessMigration: Migration = {
  name: 'agent_sources_turnless_v1',
  up: (db) =>
    db.exec(`
      ALTER TABLE agent_sources ADD COLUMN turnless INTEGER NOT NULL DEFAULT 0;
      UPDATE agent_sources SET turnless = 1 WHERE coalesce(json_extract(state, '$._drift'),
        json_extract(state, '$._readCounts.orphan') > 0 AND json_extract(state, '$._readCounts.turns') = 0) > 0;
      CREATE INDEX IF NOT EXISTS agent_sources_turnless ON agent_sources(root) WHERE turnless = 1;
    `),
}

// A deleted session's tombstone: its records are never written again, whichever file or folder they are read from.
export const agentDeletedSessionsMigration: Migration = {
  name: 'agent_deleted_sessions_v1',
  up: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_deleted_sessions (
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        deleted_wall_ms INTEGER NOT NULL,
        PRIMARY KEY (agent, session_id)
      ) WITHOUT ROWID;
    `),
}

export interface SourceRow {
  path: string
  agent: Agent
  root: string
  session_id: string | null
  dev: string | null
  ino: string | null
  offset: number
  size: number
  state: string | null
  turnless: number
}

export interface SourceUpdate {
  path: string
  agent: Agent
  root: string
  session: string | null
  dev: string
  ino: string
  offset: number
  size: number
  state: string | null
  // Agent output since the file's last recognized turn start.
  turnless: boolean
  counts: ParseCounts
}

export type HealthState = 'ok' | 'not_found' | 'unreadable' | 'degraded'

export interface HealthRow {
  agent: Agent
  root: string
  state: HealthState
  reason: string | null
  since_wall_ms: number
  checked_wall_ms: number
  detail: string | null
}

export interface AgentHealth {
  agent: Agent
  state: HealthState
  reason: string | null
  since_wall_ms: number
}

// What Settings shows per agent: any folder it cannot read or understand is the answer; a folder that does not exist
// (Codex has no archive until a session is archived) only matters when no folder for that agent exists at all.
export function summarizeHealth(rows: readonly HealthRow[]): AgentHealth[] {
  const rank: Record<HealthState, number> = { unreadable: 3, degraded: 2, ok: 1, not_found: 0 }
  const out = new Map<Agent, AgentHealth>()
  for (const r of rows) {
    const prev = out.get(r.agent)
    if (!prev || rank[r.state] > rank[prev.state] || (rank[r.state] === rank[prev.state] && r.since_wall_ms < prev.since_wall_ms)) {
      out.set(r.agent, { agent: r.agent, state: r.state, reason: r.reason, since_wall_ms: r.since_wall_ms })
    }
  }
  return [...out.values()]
}

export interface TurnRow {
  agent: Agent
  turn_key: string
  session_id: string
  project_dir: string | null
  branch: string | null
  opened_by: string
  replayed: number
  start_wall_ms: number
  last_activity_wall_ms: number
  end_wall_ms: number | null
  end_state: string | null
  origin: string
}

export interface EventRow {
  agent: Agent
  event_key: string
  session_id: string
  turn_key: string | null
  kind: 'user' | 'wait'
  detail: string
  basis: string | null
  wall_ms: number
  end_wall_ms: number | null
}

const SQL = {
  session: `INSERT INTO agent_sessions (agent, session_id, origin, parent_session_id, client, project_dir, branch, first_wall_ms, last_wall_ms, recorded_wall_ms)
    VALUES (@agent, @session, @origin, @parent, @client, @dir, @branch, @at, @at, @now)
    ON CONFLICT (agent, session_id) DO UPDATE SET
      first_wall_ms = min(first_wall_ms, excluded.first_wall_ms),
      project_dir = coalesce(project_dir, excluded.project_dir),
      branch = coalesce(branch, excluded.branch)`,
  sessionSeen: 'UPDATE agent_sessions SET last_wall_ms = max(last_wall_ms, @at) WHERE agent = @agent AND session_id = @session',
  // A live copy of a turn takes over from a replayed one that happened to be read first.
  turn: `INSERT INTO agent_turns (agent, turn_key, session_id, project_dir, branch, opened_by, replayed, start_wall_ms, last_activity_wall_ms, recorded_wall_ms)
    VALUES (@agent, @key, @session, @dir, @branch, @opener, @replayed, @start, @start, @now)
    ON CONFLICT (agent, turn_key) DO UPDATE SET session_id = excluded.session_id, replayed = 0,
      start_wall_ms = excluded.start_wall_ms, opened_by = CASE WHEN opened_by = 'unknown' THEN excluded.opened_by ELSE opened_by END
    WHERE agent_turns.replayed = 1 AND excluded.replayed = 0`,
  turnDir: 'UPDATE agent_turns SET project_dir = @dir WHERE agent = @agent AND turn_key = @key',
  turnOpener: `UPDATE agent_turns SET opened_by = @opener WHERE agent = @agent AND turn_key = @key AND opened_by = 'unknown'`,
  activity: 'UPDATE agent_turns SET last_activity_wall_ms = max(last_activity_wall_ms, @at) WHERE agent = @agent AND turn_key = @key',
  deletedSession: 'SELECT 1 FROM agent_deleted_sessions WHERE agent = ? AND session_id = ?',
  turnSpan: 'SELECT max(last_activity_wall_ms, coalesce(end_wall_ms, 0)) AS last FROM agent_turns WHERE agent = @agent AND turn_key = @key',
  // The first real end wins; 'missing' only ever gives way to a real one.
  // The end is kept apart from the last activity: a turn that fails after a stalled request ended late but did nothing since.
  end: `UPDATE agent_turns SET end_state = @state, end_wall_ms = CASE WHEN @at IS NULL THEN NULL ELSE max(@at, start_wall_ms) END
    WHERE agent = @agent AND turn_key = @key AND (end_state IS NULL OR (end_state = 'missing' AND @state != 'missing'))`,
  user: `INSERT INTO agent_events (agent, event_key, session_id, turn_key, kind, detail, basis, wall_ms, recorded_wall_ms)
    VALUES (@agent, @key, @session, @turn, 'user', @act, @basis, @at, @now) ON CONFLICT (agent, event_key) DO NOTHING`,
  wait: `INSERT INTO agent_events (agent, event_key, session_id, turn_key, kind, detail, basis, wall_ms, end_wall_ms, recorded_wall_ms)
    VALUES (@agent, @key, @session, @turn, 'wait', @reason, NULL, @start, @end, @now)
    ON CONFLICT (agent, event_key) DO UPDATE SET end_wall_ms = coalesce(end_wall_ms, excluded.end_wall_ms)`,
  source: `INSERT INTO agent_sources (path, agent, root, session_id, dev, ino, offset, size, state, turnless, lines, bad_lines, unknown_records, updated_wall_ms)
    VALUES (@path, @agent, @root, @session, @dev, @ino, @offset, @size, @state, @turnless, @lines, @bad, @unknown, @now)
    ON CONFLICT (path) DO UPDATE SET agent = excluded.agent, root = excluded.root, session_id = coalesce(excluded.session_id, session_id),
      dev = excluded.dev, ino = excluded.ino, offset = excluded.offset, size = excluded.size, state = excluded.state, turnless = excluded.turnless,
      lines = lines + excluded.lines, bad_lines = bad_lines + excluded.bad_lines, unknown_records = unknown_records + excluded.unknown_records,
      updated_wall_ms = excluded.updated_wall_ms`,
}

export class AgentStore {
  private readonly db: Database.Database
  private readonly now: () => number
  private readonly stmts = new Map<string, Database.Statement>()
  private key: Buffer | null = null

  /** Time storage withholds: pauses, deleted ranges and anything past retention. */
  withheld: () => readonly Span[] = () => []

  constructor(db: Database.Database, now: () => number = Date.now) {
    this.db = db
    this.now = now
    applyMigrations(db, [agentSessionsMigration, agentSourcesTurnlessMigration, agentDeletedSessionsMigration], now)
  }

  private stmt(sql: string): Database.Statement {
    let s = this.stmts.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.stmts.set(sql, s)
    }
    return s
  }

  // One transaction per batch: the records and the read position that produced them land together or not at all.
  apply(agent: Agent, records: readonly AgentRecord[], source?: SourceUpdate): void {
    const now = this.now()
    this.db.transaction(() => {
      const spans = this.withheld()
      let dropped = false
      // A turn never stretches across withheld time: its last activity or end stays before the gap.
      const reaches = (key: string, at: number) => {
        const t = this.stmt(SQL.turnSpan).get({ agent, key }) as { last: number } | undefined
        return !t || admitsSpan(spans, t.last, at)
      }
      const latest = new Map<string, { at: number; session: string }>()
      const flushActivity = () => {
        for (const [key, a] of latest) {
          if (!reaches(key, a.at)) {
            dropped = true
            continue
          }
          this.stmt(SQL.activity).run({ agent, key, at: a.at })
          this.stmt(SQL.sessionSeen).run({ agent, session: a.session, at: a.at })
        }
        latest.clear()
      }
      const ok = (at: number | null) => admitsAt(spans, at)
      const deleted = new Map<string, boolean>()
      const isDeleted = (session: string | null) => {
        if (session === null) return false
        let d = deleted.get(session)
        if (d === undefined) deleted.set(session, (d = this.stmt(SQL.deletedSession).get(agent, session) !== undefined))
        return d
      }
      for (const r of records) {
        if (!admitted(r, ok) || ('session' in r && isDeleted(r.session))) {
          dropped = true
          continue
        }
        switch (r.t) {
          case 'session':
            this.stmt(SQL.session).run({ agent, session: r.session, origin: r.origin, parent: r.parent, client: r.client, dir: r.dir, branch: r.branch, at: r.at, now })
            break
          case 'turn':
            this.stmt(SQL.turn).run({ agent, key: r.key, session: r.session, dir: r.dir, branch: r.branch, opener: r.opener, replayed: r.replayed ? 1 : 0, start: r.start, now })
            this.stmt(SQL.sessionSeen).run({ agent, session: r.session, at: r.start })
            break
          case 'turn_dir':
            this.stmt(SQL.turnDir).run({ agent, key: r.key, dir: r.dir })
            break
          case 'turn_opener':
            this.stmt(SQL.turnOpener).run({ agent, key: r.key, opener: r.opener })
            break
          case 'activity': {
            const prev = latest.get(r.key)
            if (!prev || r.at > prev.at) latest.set(r.key, { at: r.at, session: r.session })
            break
          }
          case 'end':
            flushActivity()
            // An end inside withheld time keeps the turn ended without saying when.
            this.stmt(SQL.end).run({ agent, key: r.key, state: r.state, at: r.at !== null && reaches(r.key, r.at) ? r.at : null })
            break
          case 'user':
            this.stmt(SQL.user).run({ agent, key: r.key, session: r.session, turn: r.turn, act: r.act, basis: r.basis, at: r.at, now })
            break
          case 'wait':
            this.stmt(SQL.wait).run({ agent, key: r.key, session: r.session, turn: r.turn, reason: r.reason, start: r.start, end: r.end, now })
            break
        }
      }
      flushActivity()
      if (source) {
        this.stmt(SQL.source).run({
          path: source.path,
          agent: source.agent,
          root: source.root,
          session: source.session,
          dev: source.dev,
          ino: source.ino,
          offset: source.offset,
          size: source.size,
          // Parser state written while withheld records went by could describe them; the read position still advances.
          state: dropped || isDeleted(source.session) ? null : source.state,
          turnless: source.turnless ? 1 : 0,
          lines: source.counts.lines,
          bad: source.counts.bad,
          unknown: source.counts.unknown,
          now,
        })
      }
    })()
  }

  hasTurnlessSource(root: string): boolean {
    return this.stmt('SELECT 1 FROM agent_sources WHERE root = ? AND turnless = 1 LIMIT 1').get(root) !== undefined
  }

  private get dataDir(): string | null {
    return this.db.name && this.db.name !== ':memory:' ? path.dirname(this.db.name) : null
  }

  fingerprintKey(): Buffer {
    const dir = this.dataDir
    this.key ??= dir === null ? processKey : loadFingerprintKey(dir)
    return this.key
  }

  // Everything recorded from one session's logs, with the message fingerprints kept in its read state. The tombstone
  // keeps it from being written again, from any copy of its logs.
  deleteSession(agent: Agent, session: string): void {
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO agent_deleted_sessions (agent, session_id, deleted_wall_ms) VALUES (?, ?, ?)').run(agent, session, this.now())
      for (const table of ['agent_events', 'agent_turns', 'agent_sessions']) this.db.prepare(`DELETE FROM ${table} WHERE agent = ? AND session_id = ?`).run(agent, session)
      this.db.prepare(`UPDATE agent_sources SET state = CASE agent
          WHEN 'codex' THEN json_remove(json_set(state, '$.recentUsers', json('[]')), '$.lastUser')
          ELSE json_set(state, '$.queued', json('{}')) END
        WHERE agent = ? AND session_id = ? AND state IS NOT NULL`).run(agent, session)
      this.db.prepare(VACUUM_PENDING).run()
    })()
    const dir = this.dataDir
    if (dir !== null) removeStaging(dir)
  }

  hasSources(): boolean {
    return this.db.prepare('SELECT 1 FROM agent_sources LIMIT 1').get() !== undefined
  }

  source(file: string): SourceRow | null {
    return (this.stmt('SELECT path, agent, root, session_id, dev, ino, offset, size, state, turnless FROM agent_sources WHERE path = ?').get(file) as SourceRow | undefined) ?? null
  }

  sourcesByInode(dev: string, ino: string): SourceRow[] {
    return this.stmt('SELECT path, agent, root, session_id, dev, ino, offset, size, state, turnless FROM agent_sources WHERE dev = ? AND ino = ?').all(dev, ino) as SourceRow[]
  }

  sourcesForSession(agent: Agent, session: string): SourceRow[] {
    return this.stmt('SELECT path, agent, root, session_id, dev, ino, offset, size, state, turnless FROM agent_sources WHERE agent = ? AND session_id = ?').all(agent, session) as SourceRow[]
  }

  sourcesUnder(root: string): SourceRow[] {
    return this.stmt('SELECT path, agent, root, session_id, dev, ino, offset, size, state, turnless FROM agent_sources WHERE root = ?').all(root) as SourceRow[]
  }

  movedSource(from: string, to: string): void {
    this.stmt('UPDATE agent_sources SET path = ? WHERE path = ?').run(to, from)
  }

  // A file read through to its end that was then compressed into the archive needs no second read.
  markRead(update: Omit<SourceUpdate, 'counts'>): void {
    this.stmt(SQL.source).run({ ...update, turnless: update.turnless ? 1 : 0, lines: 0, bad: 0, unknown: 0, now: this.now() })
  }

  setHealth(agent: Agent, root: string, state: HealthState, reason: string | null, detail: Record<string, number | string> | null): void {
    const now = this.now()
    const d = detail ? JSON.stringify(detail) : null
    this.stmt(
      `INSERT INTO agent_health (agent, root, state, reason, since_wall_ms, checked_wall_ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent, root) DO UPDATE SET
         since_wall_ms = CASE WHEN state = excluded.state THEN since_wall_ms ELSE excluded.since_wall_ms END,
         state = excluded.state, reason = excluded.reason, checked_wall_ms = excluded.checked_wall_ms, detail = excluded.detail`,
    ).run(agent, root, state, reason, now, now, d)
  }

  healthFor(agent: Agent, root: string): HealthRow | null {
    return (this.stmt('SELECT agent, root, state, reason, since_wall_ms, checked_wall_ms, detail FROM agent_health WHERE agent = ? AND root = ?').get(agent, root) as HealthRow | undefined) ?? null
  }

  health(): HealthRow[] {
    return this.stmt('SELECT agent, root, state, reason, since_wall_ms, checked_wall_ms, detail FROM agent_health ORDER BY agent, root').all() as HealthRow[]
  }

  turns(fromMs: number, toMs: number): TurnRow[] {
    return this.stmt(
      `SELECT t.agent, t.turn_key, t.session_id, t.project_dir, t.branch, t.opened_by, t.replayed, t.start_wall_ms, t.last_activity_wall_ms,
              t.end_wall_ms, t.end_state, coalesce(s.origin, 'interactive') AS origin
       FROM agent_turns t LEFT JOIN agent_sessions s ON s.agent = t.agent AND s.session_id = t.session_id
       WHERE t.start_wall_ms < ? AND coalesce(t.end_wall_ms, t.last_activity_wall_ms) >= ? ORDER BY t.start_wall_ms`,
    ).all(toMs, fromMs) as TurnRow[]
  }

  events(fromMs: number, toMs: number): EventRow[] {
    return this.stmt(
      'SELECT agent, event_key, session_id, turn_key, kind, detail, basis, wall_ms, end_wall_ms FROM agent_events WHERE wall_ms < ? AND coalesce(end_wall_ms, wall_ms) >= ? ORDER BY wall_ms',
    ).all(toMs, fromMs) as EventRow[]
  }
}

// Records stamped inside withheld time are dropped; their read position still advances, so they never come back.
function admitted(r: AgentRecord, ok: (at: number | null) => boolean): boolean {
  switch (r.t) {
    case 'session':
    case 'activity':
    case 'user':
      return ok(r.at)
    case 'turn':
      return ok(r.start)
    case 'wait':
      return ok(r.start) && ok(r.end)
    case 'turn_dir':
    case 'turn_opener':
      return ok(r.at)
    default:
      return true
  }
}
