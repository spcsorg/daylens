// Agent session tables: one named migration, new tables only, written through the capture store's connection.

import type Database from 'better-sqlite3'
import type { Agent, AgentRecord, ParseCounts } from './types.ts'

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
  // The first real end wins; 'missing' only ever gives way to a real one.
  // The end is kept apart from the last activity: a turn that fails after a stalled request ended late but did nothing since.
  end: `UPDATE agent_turns SET end_state = @state, end_wall_ms = CASE WHEN @at IS NULL THEN NULL ELSE max(@at, start_wall_ms) END
    WHERE agent = @agent AND turn_key = @key AND (end_state IS NULL OR (end_state = 'missing' AND @state != 'missing'))`,
  user: `INSERT INTO agent_events (agent, event_key, session_id, turn_key, kind, detail, basis, wall_ms, recorded_wall_ms)
    VALUES (@agent, @key, @session, @turn, 'user', @act, @basis, @at, @now) ON CONFLICT (agent, event_key) DO NOTHING`,
  wait: `INSERT INTO agent_events (agent, event_key, session_id, turn_key, kind, detail, basis, wall_ms, end_wall_ms, recorded_wall_ms)
    VALUES (@agent, @key, @session, @turn, 'wait', @reason, NULL, @start, @end, @now)
    ON CONFLICT (agent, event_key) DO UPDATE SET end_wall_ms = coalesce(end_wall_ms, excluded.end_wall_ms)`,
  source: `INSERT INTO agent_sources (path, agent, root, session_id, dev, ino, offset, size, state, lines, bad_lines, unknown_records, updated_wall_ms)
    VALUES (@path, @agent, @root, @session, @dev, @ino, @offset, @size, @state, @lines, @bad, @unknown, @now)
    ON CONFLICT (path) DO UPDATE SET agent = excluded.agent, root = excluded.root, session_id = coalesce(excluded.session_id, session_id),
      dev = excluded.dev, ino = excluded.ino, offset = excluded.offset, size = excluded.size, state = excluded.state,
      lines = lines + excluded.lines, bad_lines = bad_lines + excluded.bad_lines, unknown_records = unknown_records + excluded.unknown_records,
      updated_wall_ms = excluded.updated_wall_ms`,
}

export class AgentStore {
  private readonly db: Database.Database
  private readonly now: () => number
  private readonly stmts = new Map<string, Database.Statement>()

  constructor(db: Database.Database, now: () => number = Date.now) {
    this.db = db
    this.now = now
    applyMigrations(db, [agentSessionsMigration], now)
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
      const latest = new Map<string, { at: number; session: string }>()
      const flushActivity = () => {
        for (const [key, a] of latest) {
          this.stmt(SQL.activity).run({ agent, key, at: a.at })
          this.stmt(SQL.sessionSeen).run({ agent, session: a.session, at: a.at })
        }
        latest.clear()
      }
      for (const r of records) {
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
            this.stmt(SQL.end).run({ agent, key: r.key, state: r.state, at: r.at })
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
          state: source.state,
          lines: source.counts.lines,
          bad: source.counts.bad,
          unknown: source.counts.unknown,
          now,
        })
      }
    })()
  }

  hasSources(): boolean {
    return this.stmt('SELECT 1 FROM agent_sources LIMIT 1').get() !== undefined
  }

  source(file: string): SourceRow | null {
    return (this.stmt('SELECT path, agent, root, session_id, dev, ino, offset, size, state FROM agent_sources WHERE path = ?').get(file) as SourceRow | undefined) ?? null
  }

  sourcesByInode(dev: string, ino: string): SourceRow[] {
    return this.stmt('SELECT path, agent, root, session_id, dev, ino, offset, size, state FROM agent_sources WHERE dev = ? AND ino = ?').all(dev, ino) as SourceRow[]
  }

  sourcesForSession(agent: Agent, session: string): SourceRow[] {
    return this.stmt('SELECT path, agent, root, session_id, dev, ino, offset, size, state FROM agent_sources WHERE agent = ? AND session_id = ?').all(agent, session) as SourceRow[]
  }

  sourcesUnder(root: string): SourceRow[] {
    return this.stmt('SELECT path, agent, root, session_id, dev, ino, offset, size, state FROM agent_sources WHERE root = ?').all(root) as SourceRow[]
  }

  movedSource(from: string, to: string): void {
    this.stmt('UPDATE agent_sources SET path = ? WHERE path = ?').run(to, from)
  }

  // A file read through to its end that was then compressed into the archive needs no second read.
  markRead(update: Omit<SourceUpdate, 'counts'>): void {
    this.stmt(SQL.source).run({ ...update, lines: 0, bad: 0, unknown: 0, now: this.now() })
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
