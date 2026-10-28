// Agent session tables: named migrations over new tables only, written through the capture store's connection.

import { randomBytes } from 'node:crypto'
import { chmodSync, linkSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { threadId } from 'node:worker_threads'
import type Database from 'better-sqlite3'
import { clientApp, type HostApp } from './host.ts'
import { processKey, type Agent, type AgentRecord, type ParseCounts } from './types.ts'
import { admitsAt, admitsSpan, type Span } from './withheld.ts'
import type { RemovedSpan } from '../../storage/hours.ts'
import { copiesOf, dbHostLookup, descendants, forgetSession, Gate, resolveHost, type DeletedSpan, type GatePolicy, type HostLookup, type HostRecordBasis, type SessionHost } from './gate.ts'

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

// A session's time an app deletion reached: none of its records from then is written again, from any copy of its logs.
// It keeps the session's id and the deletion's range, not which app the session ran in or when.
export const agentDeletedSpansMigration: Migration = {
  name: 'agent_deleted_spans_v1',
  up: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_deleted_spans (
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        from_wall_ms INTEGER NOT NULL,
        to_wall_ms INTEGER NOT NULL,
        PRIMARY KEY (agent, session_id, from_wall_ms, to_wall_ms)
      ) WITHOUT ROWID;
    `),
}

// An app deletion's span names the app it deleted ('' for spans written before it did).
export const agentDeletedSpansAppMigration: Migration = {
  name: 'agent_deleted_spans_app_v1',
  up: (db) =>
    db.exec(`
      CREATE TABLE agent_deleted_spans_app (
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        from_wall_ms INTEGER NOT NULL,
        to_wall_ms INTEGER NOT NULL,
        PRIMARY KEY (agent, session_id, app_id, from_wall_ms, to_wall_ms)
      ) WITHOUT ROWID;
      INSERT INTO agent_deleted_spans_app SELECT agent, session_id, '', from_wall_ms, to_wall_ms FROM agent_deleted_spans;
      DROP TABLE agent_deleted_spans;
      ALTER TABLE agent_deleted_spans_app RENAME TO agent_deleted_spans;
    `),
}

// An app deletion's span holds the app and the range it deleted, never the parts of the range the session spent in the
// app: spans that held those become the range of the deletion they came from. Spans kept no deletion id, so a span
// inside several deletions of the app is taken to come from the narrowest: never a wider one that may not have reached
// the session.
export const agentDeletedSpansWholeRangeMigration: Migration = {
  name: 'agent_deleted_spans_whole_range_v1',
  up: (db) => {
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deletions'`).get() === undefined) {
      db.exec(`DELETE FROM agent_deleted_spans WHERE app_id != ''`)
      return
    }
    const from = `coalesce(d.from_wall_ms, ${Number.MIN_SAFE_INTEGER})`
    db.exec(`
      CREATE TEMP TABLE agent_deleted_spans_whole AS
        SELECT DISTINCT agent, session_id, app_id, from_wall_ms, to_wall_ms FROM (
          SELECT s.agent, s.session_id, s.app_id, ${from} AS from_wall_ms, d.to_wall_ms,
            row_number() OVER (PARTITION BY s.agent, s.session_id, s.app_id, s.from_wall_ms, s.to_wall_ms ORDER BY d.to_wall_ms - ${from}, d.id) AS n
          FROM agent_deleted_spans s JOIN deletions d ON d.kind = 'source' AND lower(d.app_id) = s.app_id
            AND ${from} <= s.from_wall_ms AND d.to_wall_ms >= s.to_wall_ms
          WHERE s.app_id != ''
        ) WHERE n = 1;
      DELETE FROM agent_deleted_spans WHERE app_id != '';
      INSERT OR IGNORE INTO agent_deleted_spans (agent, session_id, app_id, from_wall_ms, to_wall_ms) SELECT * FROM agent_deleted_spans_whole;
      DROP TABLE agent_deleted_spans_whole;
    `)
  },
}

// Records a deletion removed: no copy of them in any log is written again, while records the logs gain later are.
// Keys: a turn's or event's own key; for what "delete everything" removed though dated after it (a clock that ran
// ahead), also a session's id and an app span's session and time.
export const agentDeletedRecordsMigration: Migration = {
  name: 'agent_deleted_records_v1',
  up: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_deleted_records (
        agent TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('turn', 'event', 'session', 'host')),
        key TEXT NOT NULL,
        PRIMARY KEY (agent, kind, key)
      ) WITHOUT ROWID;
    `),
}

// A turn or event copied from another session (a fork) keeps that session, so deleting it reaches the copies.
export const agentCopiesMigration: Migration = {
  name: 'agent_copies_v1',
  up: (db) =>
    db.exec(`
      ALTER TABLE agent_turns ADD COLUMN source_session TEXT;
      ALTER TABLE agent_events ADD COLUMN source_session TEXT;
      CREATE INDEX IF NOT EXISTS agent_turns_source ON agent_turns(agent, source_session) WHERE source_session IS NOT NULL;
      CREATE INDEX IF NOT EXISTS agent_events_source ON agent_events(agent, source_session) WHERE source_session IS NOT NULL;
    `),
}

// Which app each session ran in, from when: a session resumed in another app has a span for each. A span with no
// app says the app is not known from then on.
export const agentHostsMigration: Migration = {
  name: 'agent_hosts_v1',
  up: (db) =>
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_hosts (
        id INTEGER PRIMARY KEY,
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        app_id TEXT,
        app_name TEXT,
        app_path TEXT,
        basis TEXT NOT NULL,
        from_wall_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_hosts_session ON agent_hosts(agent, session_id, from_wall_ms);
      CREATE INDEX IF NOT EXISTS agent_hosts_app ON agent_hosts(app_id) WHERE app_id IS NOT NULL;
    `),
}

/**
 * Everything recorded from one session's logs, with the message fingerprints kept in its read state. The tombstone
 * keeps it from being written again, from any copy of its logs.
 */
export function deleteAgentSession(db: Database.Database, agent: Agent, session: string, nowWallMs: number): { sessions: string[]; copies: RemovedSpan[] } {
  // Its subagents at any depth go with it, and are returned with it; one not read yet is refused through the parent its log names.
  const out = db.transaction(() => {
    const sessions = [session, ...descendants(db, agent, session)]
    const copies = copiesOf(db, agent, sessions)
    forgetSession(db, agent, session, nowWallMs)
    return { sessions, copies }
  })()
  const dir = db.name && db.name !== ':memory:' ? path.dirname(db.name) : null
  if (dir !== null) removeStaging(dir)
  return out
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
  // The earliest and latest times the lines read in this batch carry, records or not.
  lines?: { first: number; last: number } | null
  // The parser state stored when the read began, or that it last wrote. Any other state stored now was changed since
  // (a deletion cleared it), and the parser's state, built on the old one, is not kept.
  prevState?: string | null
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
      branch = coalesce(branch, excluded.branch),
      client = coalesce(client, excluded.client),
      parent_session_id = coalesce(parent_session_id, excluded.parent_session_id)`,
  link: `INSERT INTO agent_sessions (agent, session_id, origin, parent_session_id, first_wall_ms, last_wall_ms, recorded_wall_ms)
    VALUES (@agent, @session, 'subagent', @parent, @at, @at, @now) ON CONFLICT (agent, session_id) DO NOTHING`,
  sessionSeen: 'UPDATE agent_sessions SET last_wall_ms = max(last_wall_ms, @at) WHERE agent = @agent AND session_id = @session',
  // A live copy of a turn takes over from a replayed one that happened to be read first.
  turn: `INSERT INTO agent_turns (agent, turn_key, session_id, project_dir, branch, opened_by, replayed, start_wall_ms, last_activity_wall_ms, recorded_wall_ms, source_session)
    VALUES (@agent, @key, @session, @dir, @branch, @opener, @replayed, @start, @start, @now, @source)
    ON CONFLICT (agent, turn_key) DO UPDATE SET session_id = excluded.session_id, replayed = 0,
      start_wall_ms = excluded.start_wall_ms, opened_by = CASE WHEN opened_by = 'unknown' THEN excluded.opened_by ELSE opened_by END
    WHERE agent_turns.replayed = 1 AND excluded.replayed = 0`,
  turnDir: 'UPDATE agent_turns SET project_dir = @dir WHERE agent = @agent AND turn_key = @key',
  turnOpener: `UPDATE agent_turns SET opened_by = @opener WHERE agent = @agent AND turn_key = @key AND opened_by = 'unknown'`,
  activity: 'UPDATE agent_turns SET last_activity_wall_ms = max(last_activity_wall_ms, @at) WHERE agent = @agent AND turn_key = @key',
  deletedSession: 'SELECT 1 FROM agent_deleted_sessions WHERE agent = ? AND session_id = ?',
  turnSpan: 'SELECT session_id AS session, source_session AS source, max(last_activity_wall_ms, coalesce(end_wall_ms, 0)) AS last FROM agent_turns WHERE agent = @agent AND turn_key = @key',
  deletedSpans: 'SELECT from_wall_ms AS "from", to_wall_ms AS "to", app_id AS app FROM agent_deleted_spans WHERE agent = ? AND session_id = ?',
  // The first real end wins; 'missing' only ever gives way to a real one.
  // The end is kept apart from the last activity: a turn that fails after a stalled request ended late but did nothing since.
  end: `UPDATE agent_turns SET end_state = @state, end_wall_ms = CASE WHEN @at IS NULL THEN NULL ELSE max(@at, start_wall_ms) END
    WHERE agent = @agent AND turn_key = @key AND (end_state IS NULL OR (end_state = 'missing' AND @state != 'missing'))`,
  user: `INSERT INTO agent_events (agent, event_key, session_id, turn_key, kind, detail, basis, wall_ms, recorded_wall_ms, source_session)
    VALUES (@agent, @key, @session, @turn, 'user', @act, @basis, @at, @now, @source) ON CONFLICT (agent, event_key) DO NOTHING`,
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

export interface ApplyOptions {
  // The apps sessions ran in, each from `at` on: traced from a running process, or merged by the first read.
  hosts?: readonly { session: string; app: HostApp | null; basis: HostRecordBasis; at: number }[]
  // Parent links the logs being read named in earlier batches (session → parent).
  parents?: ReadonlyMap<string, string>
}

export class AgentStore implements GatePolicy {
  private readonly db: Database.Database
  private readonly now: () => number
  private readonly stmts = new Map<string, Database.Statement>()
  private key: Buffer | null = null

  /** Where the logs were written: which app a client name stands for depends on it. */
  platform: NodeJS.Platform = process.platform
  /** Time storage withholds: pauses, deleted ranges and anything past retention. */
  withheld: () => readonly Span[] = () => []
  hostAllowed: GatePolicy['hostAllowed'] = () => true
  hostRefused: GatePolicy['hostRefused'] = () => []
  hostExcluded: GatePolicy['hostExcluded'] = () => false
  hostExcludedAt: GatePolicy['hostExcludedAt'] = (host) => this.hostExcluded(host)
  appDeleted: GatePolicy['appDeleted'] = () => []
  /** Called after a write in which the gate removed rows already stored, so the files can be scrubbed of them. */
  onRemoved: () => void = () => {}
  /** Whether the last apply kept the parser state it was given; a reader keeps none for the rest of that read if not. */
  stateKept = true
  /** The first read's worker: the live database, read-only, whose tombstones, links and apps the gate also reads. */
  live: Database.Database | null = null

  constructor(db: Database.Database, now: () => number = Date.now) {
    this.db = db
    this.now = now
    applyMigrations(db, [agentSessionsMigration, agentSourcesTurnlessMigration, agentDeletedSessionsMigration, agentHostsMigration, agentDeletedSpansMigration, agentDeletedSpansAppMigration, agentDeletedSpansWholeRangeMigration, agentDeletedRecordsMigration, agentCopiesMigration], now)
  }

  private stmt(sql: string): Database.Statement {
    let s = this.stmts.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.stmts.set(sql, s)
    }
    return s
  }

  /**
   * One transaction per batch: the records and the read position that produced them land together or not at all.
   * Every row passes the gate first. Returns false when the read position was not kept: the log belongs to a session
   * in an excluded app, one whose app is not known while it may be (hostAllowed), or one with nothing kept, and
   * nothing that names it is stored.
   */
  apply(agent: Agent, records: readonly AgentRecord[], source?: SourceUpdate, opts: ApplyOptions = {}): boolean {
    const now = this.now()
    const named = new Map(opts.parents ?? [])
    for (const r of records) if (r.t === 'session' && r.parent !== null && r.parent !== r.session) named.set(r.session, r.parent)
    let gate: Gate | null = null
    try {
      return this.applyIn((gate = new Gate(this.db, agent, this, now, named, this.live)), agent, records, now, named, source, opts)
    } finally {
      if (gate?.removedRows && !this.db.inTransaction) this.onRemoved()
    }
  }

  private applyIn(gate: Gate, agent: Agent, records: readonly AgentRecord[], now: number, named: Map<string, string>, source: SourceUpdate | undefined, opts: ApplyOptions): boolean {
    return this.db.transaction(() => {
      const sessions = new Set<string>()
      for (const r of records) if ('session' in r) sessions.add(r.session)
      if (source?.session) sessions.add(source.session)
      for (const h of opts.hosts ?? []) sessions.add(h.session)
      for (const s of sessions) gate.inherit(s)
      for (const h of opts.hosts ?? []) this.writeHost(gate, agent, h.session, h.app, h.basis, h.at)
      let dropped = false
      const turnOf = (key: string) => this.stmt(SQL.turnSpan).get({ agent, key }) as { session: string; source: string | null; last: number } | undefined
      // A copied turn is judged by the session it was copied from as well as by its own.
      const judges = (t: { session: string; source: string | null }) => (t.source === null ? [t.session] : [t.session, t.source])
      // A turn never stretches across refused time: its last activity or end stays before it.
      const reaches = (key: string, at: number) => {
        const t = turnOf(key)
        return !t || judges(t).every((s) => gate.stretches(s, t.last, at))
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
      // A subagent whose own session record was refused is linked to its parent from its first record kept.
      const link = (session: string, at: number) => {
        const parent = named.get(session)
        if (parent !== undefined) this.stmt(SQL.link).run({ agent, session, parent, at, now })
      }
      for (const r of records) {
        if (r.t === 'client') {
          this.writeHost(gate, agent, r.session, clientApp(agent, r.client, this.platform), 'log', r.at)
          continue
        }
        if (r.t === 'end') {
          flushActivity()
          // An end in refused time keeps the turn ended without saying when or how; one across it, without saying when.
          const turn = turnOf(r.key)
          const inside = r.at !== null && turn !== undefined && judges(turn).some((s) => !gate.admits(s, r.at))
          this.stmt(SQL.end).run({ agent, key: r.key, state: inside ? 'missing' : r.state, at: r.at !== null && !inside && reaches(r.key, r.at) ? r.at : null })
          continue
        }
        // A record that names only its turn is judged by the turn's session.
        const turn = 'session' in r && r.t !== 'activity' ? undefined : turnOf(r.key)
        const owner = 'session' in r ? r.session : (turn?.session ?? null)
        // A copy is judged by the session it was copied from too, which may be deleted though the copy's is not.
        const source = 'source' in r ? r.source : (turn?.source ?? undefined)
        if (owner === null || !gate.admits(owner, recordAt(r)) || gate.removed(r) || (source !== undefined && !gate.admits(source, recordAt(r)))) {
          dropped = true
          continue
        }
        switch (r.t) {
          case 'session':
            this.stmt(SQL.session).run({ agent, session: r.session, origin: r.origin, parent: r.parent, client: r.client, dir: r.dir, branch: r.branch, at: r.at, now })
            break
          case 'turn':
            link(r.session, r.start)
            this.stmt(SQL.turn).run({ agent, key: r.key, session: r.session, dir: r.dir, branch: r.branch, opener: r.opener, replayed: r.replayed ? 1 : 0, start: r.start, now, source: r.source ?? null })
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
          case 'user':
            link(r.session, r.at)
            this.stmt(SQL.user).run({ agent, key: r.key, session: r.session, turn: r.turn, act: r.act, basis: r.basis, at: r.at, now, source: r.source ?? null })
            break
          case 'wait': {
            link(r.session, r.start)
            // A wait running into refused time ends where it begins.
            const end = r.end === null || gate.stretches(r.session, r.start, r.end) ? r.end : (gate.edge(r.session, r.start, r.end) ?? r.end)
            if (end !== r.end) dropped = true
            this.stmt(SQL.wait).run({ agent, key: r.key, session: r.session, turn: r.turn, reason: r.reason, start: r.start, end, now })
            break
          }
        }
      }
      flushActivity()
      // A session with nothing kept (all of it deleted, withheld or not yet seen) is not named by where it ran either.
      for (const s of sessions) if (gate.gone(s) || !gate.kept(s)) this.forgetHosts(gate, agent, s)
      if (source && source.session !== null) {
        const s = source.session
        const host = resolveHost(gate.look, agent, s, Number.MAX_SAFE_INTEGER)
        const excluded = host !== null && (host.excluded === true || this.hostExcluded(host))
        // Nor is its log.
        if (gate.gone(s) || !gate.kept(s) || excluded || (host === null && !this.hostAllowed(null, now))) {
          this.stmt('DELETE FROM agent_sources WHERE path = ?').run(source.path)
          this.stateKept = false
          return false
        }
      }
      // Parser state written while refused records went by, or from lines of refused time that made no record (a
      // queued message), could describe them; the read position still advances.
      const changed = source?.prevState !== undefined && ((this.stmt('SELECT state FROM agent_sources WHERE path = ?').get(source.path) as { state: string | null } | undefined)?.state ?? null) !== source.prevState
      this.stateKept = !(changed || dropped || (source?.session != null && gate.deleted(source.session).length > 0) || (source !== undefined && !linesClear(gate, source)))
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
          state: this.stateKept ? source.state : null,
          turnless: source.turnless ? 1 : 0,
          lines: source.counts.lines,
          bad: source.counts.bad,
          unknown: source.counts.unknown,
          now,
        })
      }
      return true
    })()
  }

  // A session with nothing kept keeps no app, except as excluded, unless a session below it has rows.
  private forgetHosts(gate: Gate, agent: Agent, session: string): void {
    if (gate.gone(session)) this.stmt('DELETE FROM agent_hosts WHERE agent = ? AND session_id = ?').run(agent, session)
    else if (this.stmt('SELECT 1 FROM agent_sessions WHERE agent = ? AND parent_session_id = ? AND session_id != ? LIMIT 1').get(agent, session, session) === undefined) {
      this.stmt(`DELETE FROM agent_hosts WHERE agent = ? AND session_id = ? AND basis != 'excluded'`).run(agent, session)
    }
  }

  /**
   * The app a session ran in from `at` on, through the gate. A log that names no app never replaces an app traced from
   * the running process; the same app again keeps the span it has.
   */
  private writeHost(gate: Gate, agent: Agent, session: string, app: HostApp | null, basis: HostRecordBasis, at: number): void {
    if (gate.gone(session) || gate.removedHost(session, at)) return
    if (app?.app_id) gate.reachedBy(session, app.app_id, at)
    const from = gate.hostFrom(session, at)
    if (from === null) return
    // An app excluded at that time is kept only as excluded, which keeps the session's records out without naming the
    // app. An app deleted or paused for a time keeps its name: that is what refuses the session's records then.
    if (app !== null && gate.excludedAt(app, from)) {
      app = null
      basis = 'excluded'
    }
    const last = this.stmt('SELECT app_id, basis FROM agent_hosts WHERE agent = ? AND session_id = ? AND from_wall_ms <= ? ORDER BY from_wall_ms DESC, id DESC LIMIT 1').get(agent, session, from) as
      | { app_id: string | null; basis: string }
      | undefined
    if (last && (last.app_id?.toLowerCase() ?? null) === (app?.app_id?.toLowerCase() ?? null) && (last.basis === 'excluded') === (basis === 'excluded')) return
    if (app === null && basis === 'log' && last && last.basis !== 'log') return
    this.stmt('INSERT INTO agent_hosts (agent, session_id, app_id, app_name, app_path, basis, from_wall_ms) VALUES (?, ?, ?, ?, ?, ?, ?)').run(agent, session, app?.app_id ?? null, app?.name ?? null, app?.path ?? null, basis, from)
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

  deleteSession(agent: Agent, session: string): void {
    deleteAgentSession(this.db, agent, session, this.now())
  }

  /** The app a session ran in from `at` on, through the gate. */
  recordHost(agent: Agent, session: string, app: HostApp | null, basis: HostRecordBasis, at: number): void {
    const gate = new Gate(this.db, agent, this, this.now(), new Map(), this.live)
    this.db.transaction(() => {
      gate.inherit(session)
      this.writeHost(gate, agent, session, app, basis, at)
    })()
    if (gate.removedRows && !this.db.inTransaction) this.onRemoved()
  }

  private lookup: HostLookup | null = null

  /** The app a session ran in at a time, or its parent's; null when it is not known. */
  hostAt(agent: Agent, session: string, at: number): SessionHost | null {
    this.lookup ??= dbHostLookup(this.db)
    return resolveHost(this.lookup, agent, session, at)
  }

  deletedSpans(agent: Agent, session: string): DeletedSpan[] {
    return this.stmt(SQL.deletedSpans).all(agent, session) as DeletedSpan[]
  }

  isDeletedSession(agent: Agent, session: string | null): boolean {
    return session !== null && this.stmt(SQL.deletedSession).get(agent, session) !== undefined
  }

  sourceUpdatedAt(file: string): number | null {
    return (this.stmt('SELECT updated_wall_ms AS t FROM agent_sources WHERE path = ?').get(file) as { t: number } | undefined)?.t ?? null
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

// Whether nothing refused lies within the time the batch's lines were written.
function linesClear(gate: Gate, source: SourceUpdate): boolean {
  const l = source.lines
  if (!l) return true
  if (source.session === null) return admitsAt(gate.withheld, l.first) && admitsAt(gate.withheld, l.last) && admitsSpan(gate.withheld, l.first, l.last)
  return gate.admits(source.session, l.first) && gate.admits(source.session, l.last) && gate.stretches(source.session, l.first, l.last)
}

// When a record says the session was doing something; null for one that carries no time of its own.
function recordAt(r: AgentRecord): number | null {
  switch (r.t) {
    case 'session':
    case 'activity':
    case 'user':
    case 'turn_dir':
    case 'turn_opener':
      return r.at
    case 'turn':
    case 'wait':
      return r.start
    default:
      return null
  }
}
