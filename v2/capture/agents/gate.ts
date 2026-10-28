// The one decision on what of an agent session may be stored. Records, the apps a session ran in, parent links and
// log read positions all pass it, whether read live or by the first read's merge, and deletion removes exactly what
// it refuses (forgetRange, forgetSession).
import type Database from 'better-sqlite3'
import type { HostApp } from './host.ts'
import type { Agent, AgentRecord } from './types.ts'
import { admitsAt, admitsSpan, nextWithheld, type Span } from './withheld.ts'
import { SCRUB_PENDING } from '../store.ts'
import { clearHoursForRemoved, type RemovedSpan } from '../../storage/hours.ts'

export interface SessionHost {
  app_id: string | null
  app_path: string | null
  // Ran in an excluded app; which one is not kept.
  excluded?: true
}

const EXCLUDED_HOST: SessionHost = { app_id: null, app_path: null, excluded: true }

export interface HostSpan {
  app_id: string | null
  app_path: string | null
  basis: string
}

/** Where the app a session ran in is looked up: its own spans, and the session that started it. */
export interface HostLookup {
  span: (agent: Agent, session: string, at: number) => HostSpan | undefined
  parent: (agent: Agent, session: string) => string | null
}

/**
 * The app a session ran in at a time; a session with no span of its own then runs where its parent did, up the
 * chain. Null when it is not known.
 */
export function resolveHost(look: HostLookup, agent: Agent, session: string, at: number): SessionHost | null {
  const seen = new Set<string>()
  for (let s: string | null = session; s !== null && !seen.has(s); s = look.parent(agent, s)) {
    seen.add(s)
    const span = look.span(agent, s, at)
    if (span) return span.basis === 'excluded' ? EXCLUDED_HOST : span.app_id === null ? null : { app_id: span.app_id, app_path: span.app_path }
  }
  return null
}

/**
 * Looks the app up in a database's agent tables; with `live`, in the live database's too (the first read's worker,
 * which writes a staging copy): the later span of the two holds, and a parent link from either counts.
 */
export function dbHostLookup(db: Database.Database, live: Database.Database | null = null): HostLookup {
  const spanSql = 'SELECT app_id, app_path, basis, from_wall_ms FROM agent_hosts WHERE agent = ? AND session_id = ? AND from_wall_ms <= ? ORDER BY from_wall_ms DESC, id DESC LIMIT 1'
  const parentSql = 'SELECT parent_session_id AS p FROM agent_sessions WHERE agent = ? AND session_id = ?'
  const span = db.prepare(spanSql)
  const parent = db.prepare(parentSql)
  const liveSpan = live && hasTable(live, 'agent_hosts') ? live.prepare(spanSql) : null
  const liveParent = live && hasTable(live, 'agent_sessions') ? live.prepare(parentSql) : null
  type Row = HostSpan & { from_wall_ms: number }
  return {
    span: (agent, session, at) => {
      const a = span.get(agent, session, at) as Row | undefined
      const b = liveSpan?.get(agent, session, at) as Row | undefined
      return a && b ? (b.from_wall_ms > a.from_wall_ms ? b : a) : (a ?? b)
    },
    parent: (agent, session) =>
      (parent.get(agent, session) as { p: string | null } | undefined)?.p ?? (liveParent?.get(agent, session) as { p: string | null } | undefined)?.p ?? null,
  }
}

/** What storage refuses, as the gate asks it. */
export interface GatePolicy {
  // Time nothing may be kept from, whatever the app: pauses, deleted ranges and anything past retention.
  withheld: () => readonly Span[]
  // Whether what a session did at a time is kept, given the app it ran in then (null: the app is not known).
  hostAllowed: (host: SessionHost | null, atWallMs: number) => boolean
  // The times hostAllowed refuses the app at, as spans: its pauses, deletions and exclusions, past ones included.
  hostRefused: (host: SessionHost | null) => readonly Span[]
  // Whether the app is excluded now; no log of a session in it is named.
  hostExcluded: (host: SessionHost) => boolean
  // Whether the app was excluded at a time; a session seen in it then is kept only as excluded.
  hostExcludedAt: (host: SessionHost, atWallMs: number) => boolean
  // The ranges the app was deleted for.
  appDeleted: (appId: string) => readonly Span[]
}

export const ALLOW_ALL: GatePolicy = { withheld: () => [], hostAllowed: () => true, hostRefused: () => [], hostExcluded: () => false, hostExcludedAt: () => false, appDeleted: () => [] }

/** An app deletion's tombstone for a session: the app and the range it deleted ('' for spans that name no app). */
export interface DeletedSpan {
  from: number
  to: number
  app: string
}

export type HostRecordBasis = 'log' | 'responsible' | 'parent' | 'none' | 'excluded'

const OWN_ROWS = `SELECT 1 WHERE EXISTS (SELECT 1 FROM agent_sessions WHERE agent = @agent AND session_id = @session)
  OR EXISTS (SELECT 1 FROM agent_turns WHERE agent = @agent AND session_id = @session) OR EXISTS (SELECT 1 FROM agent_events WHERE agent = @agent AND session_id = @session)`

/**
 * The decision for one agent's rows, inside one transaction. Ancestry comes from the parent links stored and those
 * the logs being read name; a session refused because of a session above it gets that refusal as its own tombstone,
 * so it holds without the link.
 */
export class Gate {
  readonly withheld: readonly Span[]
  readonly look: HostLookup
  // Rows already stored were removed: what they held stays in the files until a scrub.
  removedRows = false
  private readonly db: Database.Database
  private readonly agent: Agent
  private readonly policy: GatePolicy
  private readonly now: number
  private readonly goneCache = new Map<string, boolean>()
  private readonly deletedCache = new Map<string, DeletedSpan[]>()
  private readonly unknownAt = new Map<number, boolean>()
  private readonly hostRefusedCache = new Map<string, readonly Span[]>()
  private readonly q

  /**
   * `live`: during the first read, the live database read-only, whose tombstones, parent links and apps count with
   * those of `db`, the staging copy written to.
   */
  constructor(db: Database.Database, agent: Agent, policy: GatePolicy, now: number, named: ReadonlyMap<string, string> = new Map(), live: Database.Database | null = null) {
    this.db = db
    this.agent = agent
    this.policy = policy
    this.now = now
    this.withheld = policy.withheld()
    const stored = dbHostLookup(db, live)
    this.look = { span: stored.span, parent: (a, s) => (a === agent ? named.get(s) : undefined) ?? stored.parent(a, s) }
    const both = (table: string, sql: string) => [db, live].filter((c): c is Database.Database => c !== null && hasTable(c, table)).map((c) => c.prepare(sql))
    this.q = {
      gone: both('agent_deleted_sessions', 'SELECT 1 FROM agent_deleted_sessions WHERE agent = ? AND session_id = ?'),
      spans: both('agent_deleted_spans', 'SELECT from_wall_ms AS "from", to_wall_ms AS "to", app_id AS app FROM agent_deleted_spans WHERE agent = ? AND session_id = ?'),
      removed: both('agent_deleted_records', 'SELECT 1 FROM agent_deleted_records WHERE agent = ? AND kind = ? AND key = ?'),
    }
  }

  /** The sessions above this one, nearest first. */
  ancestors(session: string): string[] {
    const chain: string[] = []
    for (let s = this.look.parent(this.agent, session); s !== null && s !== session && !chain.includes(s); s = this.look.parent(this.agent, s)) chain.push(s)
    return chain
  }

  private ownGone(session: string): boolean {
    return this.q.gone.some((q) => q.get(this.agent, session) !== undefined)
  }

  private ownSpans(session: string): DeletedSpan[] {
    return this.q.spans.flatMap((q) => q.all(this.agent, session) as DeletedSpan[])
  }

  /** Deleted for good, it or a session above it. */
  gone(session: string): boolean {
    let g = this.goneCache.get(session)
    if (g === undefined) this.goneCache.set(session, (g = this.ownGone(session) || this.ancestors(session).some((s) => this.ownGone(s))))
    return g
  }

  /** The app deletions that reached it or a session above it: the range of each. */
  deleted(session: string): DeletedSpan[] {
    let d = this.deletedCache.get(session)
    if (d === undefined) this.deletedCache.set(session, (d = [session, ...this.ancestors(session)].flatMap((s) => this.ownSpans(s))))
    return d
  }

  /** Time none of the session's records may come from, whatever app it ran in. */
  refused(session: string): Span[] {
    return [...this.withheld, ...this.deleted(session).map((d) => [d.from, d.to] as const)]
  }

  private hostOk(session: string, at: number): boolean {
    const host = resolveHost(this.look, this.agent, session, at)
    if (host?.excluded) return false
    if (host !== null) return this.policy.hostAllowed(host, at)
    let v = this.unknownAt.get(at)
    if (v === undefined) this.unknownAt.set(at, (v = this.policy.hostAllowed(null, at)))
    return v
  }

  /** Whether a record of the session at `at` may be stored (null: a record with no time of its own). */
  admits(session: string, at: number | null): boolean {
    if (this.gone(session)) return false
    if (at === null) return true
    return admitsAt(this.refused(session), at) && this.hostOk(session, at)
  }

  /**
   * What is refused of the session between two moments: what refused() holds, and the times the app it ran in at the
   * first was paused, deleted or excluded.
   */
  private refusedOver(session: string, a: number, b: number): Span[] {
    const lo = Math.min(a, b)
    const spans = this.refused(session)
    const host = resolveHost(this.look, this.agent, session, lo)
    if (host?.excluded) return [...spans, [lo, Number.POSITIVE_INFINITY]]
    const k = host === null ? '' : `${host.app_id?.toLowerCase()}\n${host.app_path}`
    let refused = this.hostRefusedCache.get(k)
    if (refused === undefined) this.hostRefusedCache.set(k, (refused = this.policy.hostRefused(host)))
    return [...spans, ...refused]
  }

  /** Whether nothing refused lies between two moments, so the session's work may stretch from one to the other. */
  stretches(session: string, a: number, b: number): boolean {
    return admitsSpan(this.refusedOver(session, a, b), a, b)
  }

  /** Where work kept at `start` has to stop on its way to `end`: the first refused moment after it (null: none, or `start` is refused). */
  edge(session: string, start: number, end: number): number | null {
    const spans = this.refusedOver(session, start, end)
    return admitsAt(spans, start) ? nextWithheld(spans, start) : null
  }

  /**
   * From when a span of the app the session ran in, seen from `at`, may be kept: refused time keeps no record of where
   * the session ran, so the app holds from where that time ends. Null when it never may.
   */
  hostFrom(session: string, at: number): number | null {
    if (this.gone(session)) return null
    const spans = this.refused(session)
    for (let moved = true; moved; ) {
      moved = false
      for (const [from, to] of spans) {
        if (at >= from && at < to) {
          if (!Number.isFinite(to)) return null
          at = to
          moved = true
        }
      }
    }
    return at
  }

  /** Whether an app named for a session at `at` is kept only as excluded. */
  excludedAt(app: HostApp, at: number): boolean {
    return app.app_id !== null && this.policy.hostExcludedAt({ app_id: app.app_id, app_path: app.path }, at)
  }

  /**
   * Gives the session the refusals of every session above it as tombstones of its own, and removes what it and the
   * sessions below it already stored that those refuse, as the deletion that reached the session above would have.
   */
  inherit(session: string): void {
    const above = this.ancestors(session)
    if (above.length === 0) return
    if (!this.ownGone(session) && above.some((s) => this.ownGone(s))) {
      const sessions = [session, ...descendants(this.db, this.agent, session)]
      const removed = [...sessions.map((s) => ({ session: s, from: Number.MIN_SAFE_INTEGER, to: Number.MAX_SAFE_INTEGER })), ...copiesOf(this.db, this.agent, sessions)]
      if (forgetSession(this.db, this.agent, session, this.now) > 0) this.removedRows = true
      clearHoursForRemoved(this.db, this.agent, removed, this.now)
      this.forgetCaches()
      return
    }
    for (const d of above.flatMap((s) => this.ownSpans(s))) this.reach(session, d)
  }

  /**
   * A session seen running in an app from `at` on, until its next span of its own, is reached by every deletion of the
   * app over that time, as it would have been had it been known when the app was deleted.
   */
  reachedBy(session: string, appId: string, at: number): void {
    const next = (this.db.prepare('SELECT min(from_wall_ms) AS t FROM agent_hosts WHERE agent = ? AND session_id = ? AND from_wall_ms > ?').get(this.agent, session, at) as { t: number | null }).t
    for (const [from, to] of this.policy.appDeleted(appId)) if (to > at && (next === null || from < next)) this.reach(session, { app: appId.toLowerCase(), from, to })
  }

  // The deletion's tombstone, for the session and the sessions below it, and what they stored inside its range goes.
  private reach(session: string, d: DeletedSpan): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO agent_deleted_spans (agent, session_id, app_id, from_wall_ms, to_wall_ms) VALUES (?, ?, ?, ?, ?)')
    for (const s of [session, ...descendants(this.db, this.agent, session)]) {
      if (insert.run(this.agent, s, d.app, d.from, d.to).changes === 0) continue
      this.forgetCaches()
      const copies = copiesOf(this.db, this.agent, [s], d.from, d.to)
      if (forgetRange(this.db, this.agent, s, d.from, d.to) === 0) continue
      this.db.prepare(SCRUB_PENDING).run()
      this.removedRows = true
      clearHoursForRemoved(this.db, this.agent, [{ session: s, from: d.from, to: d.to }, ...copies], this.now)
    }
  }

  private forgetCaches(): void {
    this.goneCache.clear()
    this.deletedCache.clear()
  }

  /** Whether "delete everything" removed this record, though it was dated after the deletion. */
  removed(r: AgentRecord): boolean {
    switch (r.t) {
      case 'session':
        return this.removedKey('session', r.session)
      case 'turn':
        return this.removedKey('turn', r.key)
      case 'user':
      case 'wait':
        return this.removedKey('event', r.key)
      default:
        return false
    }
  }

  removedHost(session: string, at: number): boolean {
    return this.removedKey('host', `${session}\n${at}`)
  }

  private removedKey(kind: string, key: string): boolean {
    return this.q.removed.some((q) => q.get(this.agent, kind, key) !== undefined)
  }

  /** Whether the session has rows of its own: a session row, a turn or an event. */
  kept(session: string): boolean {
    return this.db.prepare(OWN_ROWS).get({ agent: this.agent, session }) !== undefined
  }
}

/** The sessions stored below one, at any depth. */
export function descendants(db: Database.Database, agent: Agent, session: string): string[] {
  const children = db.prepare('SELECT session_id FROM agent_sessions WHERE agent = ? AND parent_session_id = ?').pluck()
  const out: string[] = []
  for (let i = -1; i < out.length; i++) {
    for (const c of children.all(agent, i < 0 ? session : out[i]) as string[]) if (c !== session && !out.includes(c)) out.push(c)
  }
  return out
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column) !== undefined
}

function hasTable(db: Database.Database, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined
}

/**
 * A session deleted for good, with the sessions below it: everything they stored goes, and their tombstones keep any
 * copy of their logs from being written again.
 */
export function forgetSession(db: Database.Database, agent: Agent, session: string, nowWallMs: number): number {
  const tables = ['agent_events', 'agent_turns', 'agent_sessions', 'agent_sources', ...['agent_hosts', 'agent_deleted_spans'].filter((t) => hasTable(db, t))]
  const keyed = hasTable(db, 'agent_deleted_records')
  let n = 0
  for (const s of [session, ...descendants(db, agent, session)]) {
    db.prepare('INSERT OR IGNORE INTO agent_deleted_sessions (agent, session_id, deleted_wall_ms) VALUES (?, ?, ?)').run(agent, s, nowWallMs)
    const copies = hasColumn(db, 'agent_turns', 'source_session')
    if (keyed) {
      db.prepare(`INSERT OR IGNORE INTO agent_deleted_records (agent, kind, key) SELECT agent, 'turn', turn_key FROM agent_turns WHERE agent = ? AND session_id = ?`).run(agent, s)
      db.prepare(`INSERT OR IGNORE INTO agent_deleted_records (agent, kind, key) SELECT agent, 'event', event_key FROM agent_events WHERE agent = ? AND session_id = ?`).run(agent, s)
      if (copies) {
        db.prepare(`INSERT OR IGNORE INTO agent_deleted_records (agent, kind, key) SELECT agent, 'turn', turn_key FROM agent_turns WHERE agent = ? AND source_session = ?`).run(agent, s)
        db.prepare(`INSERT OR IGNORE INTO agent_deleted_records (agent, kind, key) SELECT agent, 'event', event_key FROM agent_events WHERE agent = ? AND source_session = ?`).run(agent, s)
      }
    }
    // Copies of its records in other sessions (a fork) go with it, and so does the parser state of the logs that hold them.
    if (copies) {
      n += forgetCopierState(db, agent, s, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
      for (const table of ['agent_events', 'agent_turns']) n += db.prepare(`DELETE FROM ${table} WHERE agent = ? AND source_session = ?`).run(agent, s).changes
    }
    for (const table of tables) n += db.prepare(`DELETE FROM ${table} WHERE agent = ? AND session_id = ?`).run(agent, s).changes
  }
  if (n > 0) db.prepare(SCRUB_PENDING).run()
  return n
}

/** Where other sessions (forks) hold copies of these sessions' records that overlap [from, to); the copies go with them. */
export function copiesOf(db: Database.Database, agent: Agent, sources: readonly string[], from = Number.MIN_SAFE_INTEGER, to = Number.MAX_SAFE_INTEGER): RemovedSpan[] {
  if (!hasColumn(db, 'agent_turns', 'source_session')) return []
  const rows = db.prepare(
    `SELECT session_id AS session, start_wall_ms AS "from", max(last_activity_wall_ms, coalesce(end_wall_ms, 0)) + 1 AS "to" FROM agent_turns
       WHERE agent = @agent AND source_session = @source AND session_id <> @source AND start_wall_ms < @to AND max(last_activity_wall_ms, coalesce(end_wall_ms, 0)) >= @from
     UNION ALL SELECT session_id, wall_ms, max(wall_ms, coalesce(end_wall_ms, 0)) + 1 FROM agent_events
       WHERE agent = @agent AND source_session = @source AND session_id <> @source AND wall_ms < @to AND max(wall_ms, coalesce(end_wall_ms, 0)) >= @from`,
  )
  return sources.flatMap((source) => rows.all({ agent, source, from, to }) as RemovedSpan[])
}

// A turn cut where refused time begins: an end inside that time (or one kept without a time) says only that it ended.
export const CUT_END_STATE = (cut: string) => `CASE WHEN end_state IS NOT NULL AND (end_wall_ms IS NULL OR (end_wall_ms > ${cut} AND end_wall_ms < @to)) THEN 'missing' ELSE end_state END`

// Removes rows one at a time with `each`, which returns the rows it changed; the worker batches them in short transactions.
export type RemoveRows = <T>(rows: readonly T[], each: (row: T) => number) => number

const removeAll: RemoveRows = (rows, each) => rows.reduce((n, row) => n + each(row), 0)

/**
 * The first part of forgetRange: the records that began inside [from, to). Each record's key is tombstoned in the
 * transaction that removes it, so no copy of it (a fork, a resumed or imported log) is written again under any session.
 */
export function removeInside(db: Database.Database, agent: Agent, session: string, from: number, to: number, remove: RemoveRows = removeAll): number {
  const events = db.prepare('SELECT id, event_key AS key FROM agent_events WHERE agent = ? AND session_id = ? AND wall_ms >= ? AND wall_ms < ? LIMIT 500')
  const turns = db.prepare('SELECT id, turn_key AS key FROM agent_turns WHERE agent = ? AND session_id = ? AND start_wall_ms >= ? AND start_wall_ms < ? LIMIT 500')
  const tombstone = hasTable(db, 'agent_deleted_records') ? db.prepare('INSERT OR IGNORE INTO agent_deleted_records (agent, kind, key) VALUES (?, ?, ?)') : null
  const removing = (kind: 'event' | 'turn', del: Database.Statement) => (row: { id: number; key: string }) => {
    tombstone?.run(agent, kind, row.key)
    return del.run(row.id).changes
  }
  const event = removing('event', db.prepare('DELETE FROM agent_events WHERE id = ?'))
  const turn = removing('turn', db.prepare('DELETE FROM agent_turns WHERE id = ?'))
  type Row = { id: number; key: string }
  let n = 0
  const each = (q: Database.Statement, del: (row: Row) => number) => {
    for (let rows = q.all(agent, session, from, to) as Row[]; rows.length > 0; rows = q.all(agent, session, from, to) as Row[]) n += remove(rows, del)
  }
  // Copies of the session's records in other sessions (a fork) go with them, and so does the parser state of the logs
  // that hold them, cleared while the turns it may name are still there.
  const copies = hasColumn(db, 'agent_turns', 'source_session')
  if (copies) n += forgetCopierState(db, agent, session, from, to)
  each(events, event)
  each(turns, turn)
  if (copies) {
    each(db.prepare('SELECT id, event_key AS key FROM agent_events WHERE agent = ? AND source_session = ? AND wall_ms >= ? AND wall_ms < ? LIMIT 500'), event)
    each(db.prepare('SELECT id, turn_key AS key FROM agent_turns WHERE agent = ? AND source_session = ? AND start_wall_ms >= ? AND start_wall_ms < ? LIMIT 500'), turn)
  }
  return n
}

/**
 * The rest of forgetRange, in one transaction; returns the rows it changed or removed. Work begun before `from` and
 * running into the range ends at `from`; the session keeps no app it was seen in from inside the range (the app in
 * force at `to` holds from `to`), and its logs keep no parser state nor a read time inside it. A session left with
 * nothing of its own keeps no log path or read position, nor, unless a session below it still has rows, any app; nor
 * does a session above it left the same way.
 */
export function settleRange(db: Database.Database, agent: Agent, session: string, from: number, to: number): number {
  const args = { agent, session, from, to }
  let n = 0
  // Copies of its turns in other sessions (a fork) are cut with them.
  const copies = hasColumn(db, 'agent_turns', 'source_session') ? ' OR source_session = @session' : ''
  const crossing = db.prepare(`SELECT id, session_id FROM agent_turns WHERE agent = @agent AND (session_id = @session${copies}) AND start_wall_ms < @from AND (last_activity_wall_ms > @from OR end_wall_ms > @from)`).all(args) as { id: number; session_id: string }[]
  const clear = db.prepare('UPDATE agent_sources SET state = NULL WHERE agent = ? AND session_id = ? AND state IS NOT NULL')
  for (const t of crossing) if (t.session_id !== session) n += clear.run(agent, t.session_id).changes
  const cut = db.prepare(`UPDATE agent_turns SET last_activity_wall_ms = min(last_activity_wall_ms, @from), end_wall_ms = CASE WHEN end_wall_ms > @from THEN @from ELSE end_wall_ms END, end_state = ${CUT_END_STATE('@from')} WHERE id = @id`)
  for (const t of crossing) n += cut.run({ id: t.id, from, to }).changes
  n += db.prepare(`UPDATE agent_events SET end_wall_ms = @from WHERE agent = @agent AND (session_id = @session${copies}) AND wall_ms < @from AND end_wall_ms > @from`).run(args).changes
  const parent = (db.prepare('SELECT parent_session_id AS p FROM agent_sessions WHERE agent = ? AND session_id = ?').get(agent, session) as { p: string | null } | undefined)?.p ?? null
  n += tidySession(db, agent, session, from, to)
  const hosts = hasTable(db, 'agent_hosts')
  if (hosts) {
    const inForce = db.prepare('SELECT * FROM agent_hosts WHERE agent = @agent AND session_id = @session AND from_wall_ms <= @to ORDER BY from_wall_ms DESC, id DESC LIMIT 1').get(args) as
      | { app_id: string | null; app_name: string | null; app_path: string | null; basis: string; from_wall_ms: number }
      | undefined
    n += db.prepare('DELETE FROM agent_hosts WHERE agent = @agent AND session_id = @session AND from_wall_ms >= @from AND from_wall_ms < @to').run(args).changes
    if (inForce && inForce.from_wall_ms >= from && inForce.from_wall_ms < to) {
      db.prepare('INSERT INTO agent_hosts (agent, session_id, app_id, app_name, app_path, basis, from_wall_ms) VALUES (@agent, @session, @app_id, @app_name, @app_path, @basis, @to)').run({ ...inForce, agent, session, to })
    }
  }
  n += db
    .prepare(
      `UPDATE agent_sources SET state = NULL, updated_wall_ms = CASE WHEN updated_wall_ms >= @from AND updated_wall_ms < @to THEN @to ELSE updated_wall_ms END
       WHERE agent = @agent AND session_id = @session AND (state IS NOT NULL OR (updated_wall_ms >= @from AND updated_wall_ms < @to))`,
    )
    .run(args).changes
  const own = db.prepare(OWN_ROWS)
  const below = db.prepare('SELECT 1 FROM agent_sessions WHERE agent = ? AND parent_session_id = ? AND session_id != ? LIMIT 1')
  for (let s: string | null = session, seen = new Set<string>(); s !== null && !seen.has(s); s = s === session ? parent : null) {
    seen.add(s)
    if (own.get({ agent, session: s }) !== undefined) break
    n += db.prepare('DELETE FROM agent_sources WHERE agent = ? AND session_id = ?').run(agent, s).changes
    if (hosts && below.get(agent, s, s) === undefined) n += db.prepare('DELETE FROM agent_hosts WHERE agent = ? AND session_id = ?').run(agent, s).changes
  }
  return n
}

// The logs of other sessions holding copies of the session's records begun in [from, to) keep no parser state: it may
// describe those copies.
function forgetCopierState(db: Database.Database, agent: Agent, session: string, from: number, to: number): number {
  return db
    .prepare(
      `UPDATE agent_sources SET state = NULL WHERE agent = @agent AND state IS NOT NULL AND session_id IN (
         SELECT session_id FROM agent_turns WHERE agent = @agent AND source_session = @session AND start_wall_ms >= @from AND start_wall_ms < @to
         UNION SELECT session_id FROM agent_events WHERE agent = @agent AND source_session = @session AND wall_ms >= @from AND wall_ms < @to)
       -- A fork that copied a turn already stored under this session holds no row of it, only parser state naming its key.
       OR (session_id <> @session AND state IS NOT NULL AND EXISTS (SELECT 1 FROM agent_turns t WHERE t.agent = @agent AND t.session_id = @session
         AND t.start_wall_ms < @to AND (t.end_wall_ms IS NULL OR t.end_wall_ms > @from) AND instr(agent_sources.state, t.turn_key) > 0))`,
    )
    .run({ agent, session, from, to }).changes
}

/** What a session refused for [from, to) keeps: removeInside, then settleRange. */
export function forgetRange(db: Database.Database, agent: Agent, session: string, from: number, to: number): number {
  return removeInside(db, agent, session, from, to) + settleRange(db, agent, session, from, to)
}

// A session keeps only the span of the turns it has left. With none: it goes if it began inside the range, or else ends
// where the range begins.
function tidySession(db: Database.Database, agent: Agent, session: string, from: number, to: number): number {
  const own = 't.agent = agent_sessions.agent AND t.session_id = agent_sessions.session_id'
  const args = { agent, session, from, to }
  const none = `NOT EXISTS (SELECT 1 FROM agent_turns t WHERE ${own})`
  let n = db.prepare(`DELETE FROM agent_sessions WHERE agent = @agent AND session_id = @session AND ${none} AND first_wall_ms >= @from AND first_wall_ms < @to`).run(args).changes
  n += db.prepare(`UPDATE agent_sessions SET last_wall_ms = @from WHERE agent = @agent AND session_id = @session AND ${none} AND first_wall_ms < @from AND last_wall_ms > @from`).run(args).changes
  db.prepare(
    `UPDATE agent_sessions SET
       first_wall_ms = (SELECT min(start_wall_ms) FROM agent_turns t WHERE ${own}),
       last_wall_ms = (SELECT max(max(last_activity_wall_ms, coalesce(end_wall_ms, 0))) FROM agent_turns t WHERE ${own})
     WHERE agent = @agent AND session_id = @session AND NOT ${none}`,
  ).run(args)
  return n
}
