// The agent part of a deletion. Its plan is written in the deletion's fence, with the tombstone, before anything
// changes: every session it touches. The worker carries the plan out one session at a time and crosses each off in the
// transaction that finishes it, so a run that resumes after a crash works from the plan, never from rows an earlier run
// already changed. What each session keeps is decided as admission decides it (removeInside, settleRange).
import type Database from 'better-sqlite3'
import { dbHostLookup, descendants, removeInside, resolveHost, settleRange, type HostLookup, type RemoveRows } from '../capture/agents/gate.ts'
import type { Agent } from '../capture/agents/types.ts'
import { immediateRetrying } from './tx.ts'

interface PlanRow {
  agent: Agent
  session_id: string
}

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
 * seen from inside it or a log read since it began. An app: every session that ran in it at some time inside the range,
 * or whose session above it did, and every session below those at any depth, whatever app it ran in; each gets the
 * app's tombstone (the app and the range) here too.
 */
export function planAgentDeletion(db: Database.Database, tombstoneId: number, app: string | null, from: number, to: number): void {
  if (!hasTable(db, 'agent_turns')) return
  const hosts = hasTable(db, 'agent_hosts')
  const look = hosts ? dbHostLookup(db) : noHosts(db)
  const insert = db.prepare('INSERT OR IGNORE INTO deletion_agent (tombstone_id, agent, session_id, spans, removes, depth) VALUES (?, ?, ?, ?, 1, ?)')
  const add = (agent: Agent, session: string) => insert.run(tombstoneId, agent, session, JSON.stringify([[from, to]]), ancestors(look, agent, session).length)
  if (app === null) {
    const touched = db
      .prepare(
        `SELECT agent, session_id FROM agent_turns WHERE start_wall_ms >= @from AND start_wall_ms < @to
         UNION SELECT agent, session_id FROM agent_events WHERE wall_ms >= @from AND wall_ms < @to
         UNION SELECT agent, session_id FROM agent_turns WHERE start_wall_ms < @from AND (last_activity_wall_ms > @from OR end_wall_ms > @from)
         UNION SELECT agent, session_id FROM agent_events WHERE wall_ms < @from AND end_wall_ms > @from
         UNION SELECT agent, session_id FROM agent_sources WHERE session_id IS NOT NULL AND updated_wall_ms >= @from
         ${hosts ? 'UNION SELECT agent, session_id FROM agent_hosts WHERE from_wall_ms >= @from AND from_wall_ms < @to' : ''}`,
      )
      .all({ from, to }) as { agent: Agent; session_id: string }[]
    for (const s of touched) add(s.agent, s.session_id)
    return
  }
  if (!hosts) return
  const moves = db.prepare('SELECT from_wall_ms FROM agent_hosts WHERE agent = ? AND session_id = ? AND from_wall_ms > ? AND from_wall_ms < ?').pluck()
  // The app a session resolves to changes only where it or a session above it has a span of its own.
  const inApp = (agent: Agent, session: string) =>
    [from, ...[session, ...ancestors(look, agent, session)].flatMap((s) => moves.all(agent, s, from, to) as number[])].some((at) => resolveHost(look, agent, session, at)?.app_id?.toLowerCase() === app)
  const reached = new Map<string, { agent: Agent; session: string }>()
  for (const s of db.prepare('SELECT DISTINCT agent, session_id FROM agent_hosts WHERE lower(app_id) = ?').all(app) as { agent: Agent; session_id: string }[]) {
    for (const x of [s.session_id, ...descendants(db, s.agent, s.session_id)]) {
      if (reached.has(`${s.agent}\n${x}`) || !inApp(s.agent, x)) continue
      for (const y of [x, ...descendants(db, s.agent, x)]) reached.set(`${s.agent}\n${y}`, { agent: s.agent, session: y })
    }
  }
  const tombstone = db.prepare('INSERT OR IGNORE INTO agent_deleted_spans (agent, session_id, app_id, from_wall_ms, to_wall_ms) VALUES (?, ?, ?, ?, ?)')
  for (const { agent, session } of reached.values()) {
    add(agent, session)
    // Only what the deletion request holds, the app and the range: when the session was in the app inside it is part
    // of what was deleted. So the session's records anywhere in the range are refused, whatever app they resolve to.
    tombstone.run(agent, session, app, from, to)
  }
}

/** Carries out a deletion's agent plan; safe to run again after a crash at any point. Returns the records changed. */
export function runAgentDeletion(db: Database.Database, tombstoneId: number, app: string | null, from: number, to: number, removeRows: RemoveRows): number {
  if (!hasTable(db, 'deletion_agent') || !hasTable(db, 'agent_turns')) return 0
  const next = db.prepare('SELECT agent, session_id FROM deletion_agent WHERE tombstone_id = ? ORDER BY depth DESC, agent, session_id LIMIT 1')
  let n = 0
  for (let row = next.get(tombstoneId) as PlanRow | undefined; row; row = next.get(tombstoneId) as PlanRow | undefined) {
    const { agent, session_id: session } = row
    n += removeInside(db, agent, session, from, to, removeRows)
    n += immediateRetrying(db, () => {
      const changed = settleRange(db, agent, session, from, to)
      db.prepare('DELETE FROM deletion_agent WHERE tombstone_id = ? AND agent = ? AND session_id = ?').run(tombstoneId, agent, session)
      return changed
    })
  }
  if (app === null) {
    // A log with no session of its own read since the range began may have been read from inside it: no row names it,
    // and the reader reads it again whole, under the range's tombstone.
    immediateRetrying(db, () => db.prepare('DELETE FROM agent_sources WHERE session_id IS NULL AND updated_wall_ms >= ?').run(from))
  }
  return n
}
