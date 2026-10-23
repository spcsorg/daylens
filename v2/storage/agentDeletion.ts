// The agent part of a deletion. Its plan is written in the deletion's fence, with the tombstone, before anything
// changes: every session it touches, with the spans of time whose records go. The worker carries the plan out one
// session at a time and crosses each off in the transaction that finishes it, so a run that resumes after a crash
// works from the plan, never from rows an earlier run already changed.
import type Database from 'better-sqlite3'
import { dbHostLookup, resolveHost, type HostLookup } from '../capture/agents/store.ts'
import type { Agent } from '../capture/agents/types.ts'
import { immediateRetrying } from './tx.ts'

type Span = [from: number, to: number]

interface PlanRow {
  agent: Agent
  session_id: string
  spans: string
  removes: number
}

// A turn cut where deleted time begins: an end inside that time (or one kept without a time) says only that it ended.
export const CUT_END_STATE = (cut: string) => `CASE WHEN end_state IS NOT NULL AND (end_wall_ms IS NULL OR (end_wall_ms > ${cut} AND end_wall_ms < @to)) THEN 'missing' ELSE end_state END`

function hasTable(db: Database.Database, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined
}

function noHosts(db: Database.Database): HostLookup {
  const parent = db.prepare('SELECT parent_session_id AS p FROM agent_sessions WHERE agent = ? AND session_id = ?')
  return { span: () => undefined, parent: (agent, session) => (parent.get(agent, session) as { p: string | null } | undefined)?.p ?? null }
}

function ancestors(look: HostLookup, agent: Agent, session: string): string[] {
  const chain: string[] = []
  for (let s = look.parent(agent, session); s !== null && s !== session && !chain.includes(s); s = look.parent(agent, s)) chain.push(s)
  return chain
}

/**
 * Inside the fence transaction. A range: every session with records in it, a turn or wait crossing into it, an app
 * seen from inside it or a log read since it began; their spans are the range. An app: the sessions known to have run
 * in it and their subagents at any depth, each with the parts of the range in which it, or the session above it, was
 * in the app, judged now from the app spans as they are. Those sessions get their tombstones (the app and the range)
 * here too.
 */
export function planAgentDeletion(db: Database.Database, tombstoneId: number, app: string | null, from: number, to: number): void {
  if (!hasTable(db, 'agent_turns')) return
  const hosts = hasTable(db, 'agent_hosts')
  const look = hosts ? dbHostLookup(db) : noHosts(db)
  const insert = db.prepare('INSERT OR IGNORE INTO deletion_agent (tombstone_id, agent, session_id, spans, removes, depth) VALUES (?, ?, ?, ?, ?, ?)')
  const add = (agent: Agent, session: string, spans: Span[], removes: boolean) => insert.run(tombstoneId, agent, session, JSON.stringify(spans), removes ? 1 : 0, ancestors(look, agent, session).length)
  if (app === null) {
    const range: Span[] = [[from, to]]
    const touched = db
      .prepare(
        `SELECT agent, session_id FROM agent_turns WHERE start_wall_ms >= @from AND start_wall_ms < @to
         UNION SELECT agent, session_id FROM agent_events WHERE wall_ms >= @from AND wall_ms < @to
         UNION SELECT agent, session_id FROM agent_turns WHERE start_wall_ms < @from AND (last_activity_wall_ms > @from OR end_wall_ms > @from)
         UNION SELECT agent, session_id FROM agent_events WHERE wall_ms < @from AND end_wall_ms > @from`,
      )
      .all({ from, to }) as { agent: Agent; session_id: string }[]
    for (const s of touched) add(s.agent, s.session_id, range, true)
    const seen = [
      ...(hosts ? (db.prepare('SELECT DISTINCT agent, session_id FROM agent_hosts WHERE from_wall_ms >= ? AND from_wall_ms < ?').all(from, to) as { agent: Agent; session_id: string }[]) : []),
      ...(db.prepare('SELECT DISTINCT agent, session_id FROM agent_sources WHERE session_id IS NOT NULL AND updated_wall_ms >= ?').all(from) as { agent: Agent; session_id: string }[]),
    ]
    for (const s of seen) add(s.agent, s.session_id, range, false)
    return
  }
  if (!hosts) return
  const reached = new Map<string, { agent: Agent; session: string }>()
  const children = db.prepare('SELECT session_id FROM agent_sessions WHERE agent = ? AND parent_session_id = ?')
  const roots = db.prepare('SELECT DISTINCT agent, session_id FROM agent_hosts WHERE lower(app_id) = ?').all(app) as { agent: Agent; session_id: string }[]
  for (const queue = roots.map((x) => ({ agent: x.agent, session: x.session_id })); queue.length > 0; ) {
    const next = queue.shift()!
    const k = `${next.agent}\n${next.session}`
    if (reached.has(k)) continue
    reached.set(k, next)
    for (const c of children.all(next.agent, next.session) as { session_id: string }[]) queue.push({ agent: next.agent, session: c.session_id })
  }
  const moves = db.prepare('SELECT from_wall_ms FROM agent_hosts WHERE agent = ? AND session_id = ? AND from_wall_ms > ? AND from_wall_ms < ?').pluck()
  const tombstone = db.prepare('INSERT OR IGNORE INTO agent_deleted_spans (agent, session_id, app_id, from_wall_ms, to_wall_ms) VALUES (?, ?, ?, ?, ?)')
  for (const { agent, session } of reached.values()) {
    // The app a session resolves to changes only where it or a session above it has a span of its own.
    const points = [...new Set([from, ...[session, ...ancestors(look, agent, session)].flatMap((s) => moves.all(agent, s, from, to) as number[])])].sort((a, b) => a - b)
    const spans: Span[] = []
    for (const [i, at] of points.entries()) {
      if (resolveHost(look, agent, session, at)?.app_id?.toLowerCase() !== app) continue
      const end = points[i + 1] ?? to
      const last = spans[spans.length - 1]
      if (last && last[1] === at) last[1] = end
      else spans.push([at, end])
    }
    if (spans.length === 0) continue
    add(agent, session, spans, true)
    // Only what the deletion request holds, the app and the range: when the session was in the app inside it is part
    // of what was deleted. So the session's records anywhere in the range are refused, whatever app they resolve to.
    tombstone.run(agent, session, app, from, to)
  }
}

/** Carries out a deletion's agent plan; safe to run again after a crash at any point. Returns the records changed. */
export function runAgentDeletion(db: Database.Database, tombstoneId: number, app: string | null, from: number, to: number, removeRows: (del: Database.Statement, rows: readonly { id: number }[]) => number): number {
  if (!hasTable(db, 'deletion_agent') || !hasTable(db, 'agent_turns')) return 0
  const next = db.prepare('SELECT agent, session_id, spans, removes FROM deletion_agent WHERE tombstone_id = ? ORDER BY depth DESC, agent, session_id LIMIT 1')
  let n = 0
  for (let row = next.get(tombstoneId) as PlanRow | undefined; row; row = next.get(tombstoneId) as PlanRow | undefined) {
    n += runSession(db, tombstoneId, row, app, from, to, removeRows)
  }
  if (app === null) {
    // Logs with no session of their own: a read since the range began may hold parser state from inside it.
    immediateRetrying(db, () => {
      db.prepare('UPDATE agent_sources SET state = NULL WHERE session_id IS NULL AND updated_wall_ms >= ? AND state IS NOT NULL').run(from)
      db.prepare('UPDATE agent_sources SET updated_wall_ms = ? WHERE session_id IS NULL AND updated_wall_ms >= ? AND updated_wall_ms < ?').run(to, from, to)
    })
  }
  return n
}

function runSession(db: Database.Database, tombstoneId: number, row: PlanRow, app: string | null, from: number, to: number, removeRows: (del: Database.Statement, rows: readonly { id: number }[]) => number): number {
  const { agent, session_id: session } = row
  const spans = JSON.parse(row.spans) as Span[]
  let n = 0
  const events = db.prepare('SELECT id FROM agent_events WHERE agent = ? AND session_id = ? AND wall_ms >= ? AND wall_ms < ? LIMIT 500')
  const turns = db.prepare('SELECT id FROM agent_turns WHERE agent = ? AND session_id = ? AND start_wall_ms >= ? AND start_wall_ms < ? LIMIT 500')
  const delEvent = db.prepare('DELETE FROM agent_events WHERE id = ?')
  const delTurn = db.prepare('DELETE FROM agent_turns WHERE id = ?')
  for (const [a, b] of spans) {
    for (let ids = events.all(agent, session, a, b) as { id: number }[]; ids.length > 0; ids = events.all(agent, session, a, b) as { id: number }[]) n += removeRows(delEvent, ids)
    for (let ids = turns.all(agent, session, a, b) as { id: number }[]; ids.length > 0; ids = turns.all(agent, session, a, b) as { id: number }[]) n += removeRows(delTurn, ids)
  }
  const first = spans[0]![0]
  immediateRetrying(db, () => {
    // Work begun before the deleted time and running on into it ends where that time begins.
    if (first !== Number.MIN_SAFE_INTEGER) {
      const crossing = db.prepare('SELECT id, max(last_activity_wall_ms, coalesce(end_wall_ms, 0)) AS last FROM agent_turns WHERE agent = ? AND session_id = ? AND start_wall_ms < ? AND (last_activity_wall_ms > ? OR end_wall_ms > ?)').all(agent, session, from, first, first) as { id: number; last: number }[]
      const cut = db.prepare(`UPDATE agent_turns SET last_activity_wall_ms = min(last_activity_wall_ms, @at), end_wall_ms = CASE WHEN end_wall_ms > @at THEN @at ELSE end_wall_ms END, end_state = ${CUT_END_STATE('@at')} WHERE id = @id`)
      for (const t of crossing) {
        const at = spans.find(([a]) => a < t.last)?.[0]
        if (at !== undefined) n += cut.run({ id: t.id, at, to }).changes
      }
      const waits = db.prepare('SELECT id, end_wall_ms AS last FROM agent_events WHERE agent = ? AND session_id = ? AND wall_ms < ? AND end_wall_ms > ?').all(agent, session, from, first) as { id: number; last: number }[]
      for (const w of waits) {
        const at = spans.find(([a]) => a < w.last)?.[0]
        if (at !== undefined) n += db.prepare('UPDATE agent_events SET end_wall_ms = ? WHERE id = ? AND end_wall_ms > ?').run(at, w.id, at).changes
      }
    }
    n += tidySession(db, agent, session, app, from, to)
    forgetAgentTime(db, agent, session, from, to, app, row.removes === 1)
    db.prepare('DELETE FROM deletion_agent WHERE tombstone_id = ? AND agent = ? AND session_id = ?').run(tombstoneId, agent, session)
  })
  return n
}

// A session keeps only the span of the turns it has left. With none: deleting an app removes it, and a range removes
// it if it began inside, or else ends it where the range begins.
function tidySession(db: Database.Database, agent: Agent, session: string, app: string | null, from: number, to: number): number {
  const own = 't.agent = agent_sessions.agent AND t.session_id = agent_sessions.session_id'
  const args = { agent, session, from, to }
  const none = `NOT EXISTS (SELECT 1 FROM agent_turns t WHERE ${own})`
  let n = db.prepare(`DELETE FROM agent_sessions WHERE agent = @agent AND session_id = @session AND ${none} ${app === null ? 'AND first_wall_ms >= @from AND first_wall_ms < @to' : ''}`).run(args).changes
  if (app === null) n += db.prepare(`UPDATE agent_sessions SET last_wall_ms = @from WHERE agent = @agent AND session_id = @session AND ${none} AND first_wall_ms < @from AND last_wall_ms > @from`).run(args).changes
  db.prepare(
    `UPDATE agent_sessions SET
       first_wall_ms = (SELECT min(start_wall_ms) FROM agent_turns t WHERE ${own}),
       last_wall_ms = (SELECT max(max(last_activity_wall_ms, coalesce(end_wall_ms, 0))) FROM agent_turns t WHERE ${own})
     WHERE agent = @agent AND session_id = @session AND NOT ${none}`,
  ).run(args)
  return n
}

/**
 * After a deletion of [from, to) has removed a session's records (`removed`): a session with nothing left keeps no
 * app, log path or read position; the deletion's tombstones keep its logs from being imported again. Otherwise the
 * session keeps no app it was seen in from inside the range (with `app`, only that app), though the app in force at
 * `to` holds from `to`, and its logs keep no parser state, nor a read time inside the range.
 */
export function forgetAgentTime(db: Database.Database, agent: Agent, session: string, from: number, to: number, app: string | null, removed: boolean): void {
  const args = { agent, session, from, to, app }
  const hosts = hasTable(db, 'agent_hosts')
  const left = db
    .prepare(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM agent_sessions WHERE agent = @agent AND (session_id = @session OR parent_session_id = @session))
         OR EXISTS (SELECT 1 FROM agent_turns WHERE agent = @agent AND session_id = @session) OR EXISTS (SELECT 1 FROM agent_events WHERE agent = @agent AND session_id = @session)`,
    )
    .get(args)
  if (removed && left === undefined) {
    if (hosts) db.prepare('DELETE FROM agent_hosts WHERE agent = @agent AND session_id = @session').run(args)
    db.prepare('DELETE FROM agent_sources WHERE agent = @agent AND session_id = @session').run(args)
    return
  }
  if (hosts) {
    const match = app === null ? '1' : 'lower(app_id) = @app'
    const inForce = db.prepare('SELECT * FROM agent_hosts WHERE agent = @agent AND session_id = @session AND from_wall_ms <= @to ORDER BY from_wall_ms DESC, id DESC LIMIT 1').get(args) as
      | { app_id: string | null; app_name: string | null; app_path: string | null; basis: string; from_wall_ms: number }
      | undefined
    db.prepare(`DELETE FROM agent_hosts WHERE agent = @agent AND session_id = @session AND from_wall_ms >= @from AND from_wall_ms < @to AND ${match}`).run(args)
    if (inForce && inForce.from_wall_ms >= from && inForce.from_wall_ms < to && (app === null || inForce.app_id?.toLowerCase() === app)) {
      db.prepare('INSERT INTO agent_hosts (agent, session_id, app_id, app_name, app_path, basis, from_wall_ms) VALUES (@agent, @session, @app_id, @app_name, @app_path, @basis, @to)').run({ ...inForce, agent, session, to })
    }
  }
  db.prepare('UPDATE agent_sources SET state = NULL, updated_wall_ms = CASE WHEN updated_wall_ms >= @from AND updated_wall_ms < @to THEN @to ELSE updated_wall_ms END WHERE agent = @agent AND session_id = @session').run(args)
}
