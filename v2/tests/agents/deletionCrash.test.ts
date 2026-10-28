// A deletion cut short at every boundary between its transactions, then run again, ends exactly where an uninterrupted
// one does: nothing of the deleted agent work, and none of its apps, log paths or read positions, is left.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import Database from 'better-sqlite3'
import { AgentStore } from '../../capture/agents/store.ts'
import { emptyCounts, type AgentRecord } from '../../capture/agents/types.ts'
import { DB_FILE } from '../../capture/store.ts'
import { Deleter } from '../../storage/deletion.ts'
import { HOUR, MIN, rig, T0, tmpDir } from '../storage/support.ts'

const ghostty = { app_id: 'com.mitchellh.ghostty', name: 'Ghostty', path: '/Applications/Ghostty.app' }
const claudeApp = { app_id: 'com.anthropic.claudefordesktop', name: null, path: null }
const NOW = T0 + 5 * HOUR

function turn(session: string, key: string, start: number, end: number, parent: string | null = null): AgentRecord[] {
  return [
    { t: 'session', session, origin: parent ? 'subagent' : 'interactive', parent, client: null, dir: '/w', branch: null, at: start },
    { t: 'turn', key, session, dir: '/w', branch: null, opener: 'user', start, replayed: false },
    { t: 'user', key: `${key}:u`, session, turn: key, act: 'prompt', basis: 'marked', at: start },
    { t: 'activity', key, session, at: end - 1000 },
    { t: 'end', key, state: 'completed', at: end },
  ]
}
const log = (session: string) => ({ path: `/logs/${session}.jsonl`, agent: 'claude_code' as const, root: '/logs', session, dev: '1', ino: session, offset: 10, size: 10, state: '{"dir":"/w"}', turnless: false, counts: emptyCounts() })

type Kind = 'range' | 'app' | 'everything'

// A parent that moved from the Claude app to Ghostty and back before the range ends, its subagent and their subagent with no app of their own, a
// session wholly in Ghostty inside the range, a turn crossing into it, and a session left untouched.
function scenario(kind: Kind): { dir: string; tombstone: number } {
  const dir = tmpDir()
  const r = rig(dir, { holdDeletions: true })
  const agents = new AgentStore(r.store.database, () => r.clock.t)
  agents.withheld = () => r.storage.withheld()
  agents.recordHost('claude_code', 'p', claudeApp, 'log', T0)
  agents.recordHost('claude_code', 'p', ghostty, 'responsible', T0 + HOUR + 5 * MIN)
  agents.recordHost('claude_code', 'p', claudeApp, 'log', T0 + HOUR + 25 * MIN)
  agents.recordHost('claude_code', 'q', ghostty, 'responsible', T0)
  r.clock.t = T0 + 3 * HOUR
  agents.apply('claude_code', [...turn('p', 'p1', T0 + 10 * MIN, T0 + 20 * MIN), ...turn('p', 'p0', T0 + HOUR - 5 * MIN, T0 + HOUR + 8 * MIN), ...turn('p', 'p2', T0 + HOUR + 10 * MIN, T0 + HOUR + 20 * MIN)], log('p'))
  agents.apply('claude_code', [...turn('c', 'c1', T0 + HOUR + 12 * MIN, T0 + HOUR + 14 * MIN, 'p'), ...turn('c', 'c0', T0 + 20 * MIN, T0 + 25 * MIN, 'p')], log('c'))
  agents.apply('claude_code', turn('g', 'g1', T0 + HOUR + 13 * MIN, T0 + HOUR + 14 * MIN, 'c'), log('g'))
  agents.apply('claude_code', turn('q', 'q1', T0 + HOUR + 15 * MIN, T0 + HOUR + 18 * MIN), log('q'))
  agents.apply('claude_code', turn('k', 'k1', T0 + 4 * HOUR, T0 + 4 * HOUR + 5 * MIN), log('k'))
  // Dated after the deletion: a clock that ran ahead.
  if (kind === 'everything') agents.apply('claude_code', turn('z', 'z1', NOW + HOUR, NOW + HOUR + MIN), log('z'))
  r.clock.t = NOW
  const range = { from_wall_ms: T0 + HOUR, to_wall_ms: T0 + HOUR + 30 * MIN }
  const handle = kind === 'range' ? r.storage.deleteRange(range.from_wall_ms, range.to_wall_ms) : kind === 'app' ? r.storage.deleteSource('com.mitchellh.ghostty', range) : r.storage.deleteEverything()
  r.close()
  return { dir, tombstone: handle.tombstone }
}

// Runs the worker's part, ending it as a crash would before its `crashAt`th transaction; true if it was cut short.
function run(dir: string, tombstone: number, crashAt: number | null): { crashed: boolean; transactions: number } {
  const db = new Database(path.join(dir, DB_FILE))
  db.pragma('secure_delete = ON')
  let n = 0
  const crashing = new Proxy(db, {
    get(target, key) {
      if (key === 'transaction') {
        return (fn: (...a: unknown[]) => unknown) => {
          const tx = target.transaction(fn)
          const counted = (mode: 'deferred' | 'immediate' | 'exclusive' | null) => (...a: unknown[]) => {
            if (++n === crashAt) throw new Error('crash')
            return mode === null ? tx(...a) : tx[mode](...a)
          }
          return Object.assign(counted(null), { deferred: counted('deferred'), immediate: counted('immediate'), exclusive: counted('exclusive') })
        }
      }
      const v = Reflect.get(target, key) as unknown
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  })
  try {
    const deleter = new Deleter(crashing)
    deleter.run(tombstone, NOW)
    assert.equal(deleter.purge(tombstone), true)
    return { crashed: false, transactions: n }
  } catch (err) {
    if ((err as Error).message !== 'crash') throw err
    return { crashed: true, transactions: n }
  } finally {
    db.close()
  }
}

function dump(dir: string): Record<string, unknown[]> {
  const db = new Database(path.join(dir, DB_FILE), { readonly: true })
  try {
    const out: Record<string, unknown[]> = {}
    for (const t of ['agent_sessions', 'agent_turns', 'agent_events', 'agent_hosts', 'agent_sources', 'agent_deleted_spans', 'agent_deleted_records', 'deletion_agent', 'deletion_rows']) {
      const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t) !== undefined
      out[t] = exists ? db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3`).all() : []
    }
    out.deletions = db.prepare('SELECT id, kind, state FROM deletions').all()
    return out
  } finally {
    db.close()
  }
}

const sessions = (d: Record<string, unknown[]>) => (d.agent_sessions as { session_id: string }[]).map((s) => s.session_id).sort()
const turnKeys = (d: Record<string, unknown[]>) => (d.agent_turns as { turn_key: string }[]).map((t) => t.turn_key).sort()
const named = (d: Record<string, unknown[]>, table: string) => [...new Set((d[table] as { session_id: string }[]).map((x) => x.session_id))].sort()

for (const kind of ['range', 'app', 'everything'] as const) {
  test(`a ${kind} deletion cut short before any of its transactions ends, once run again, as one never cut short`, (t) => {
    const clean = scenario(kind)
    const full = run(clean.dir, clean.tombstone, null)
    t.diagnostic(`transactions=${full.transactions}`)
    assert.ok(full.transactions >= 10, `the run has its steps (${full.transactions} transactions)`)
    const expected = dump(clean.dir)
    assert.deepEqual(expected.deletions, [{ id: clean.tombstone, kind: kind === 'app' ? 'source' : 'range', state: 'purged' }])
    assert.deepEqual(expected.deletion_agent, [])
    if (kind === 'everything') {
      for (const table of ['agent_sessions', 'agent_turns', 'agent_events', 'agent_hosts', 'agent_sources']) assert.deepEqual(expected[table], [], table)
    } else {
      assert.deepEqual(turnKeys(expected), ['c0', 'k1', 'p0', 'p1'], 'what began inside the deleted time goes; the crossing turn is cut')
      assert.deepEqual(sessions(expected), ['c', 'k', 'p'])
      assert.deepEqual(named(expected, 'agent_sources'), ['c', 'k', 'p'], 'no log row names a session that is gone')
      assert.ok(!named(expected, 'agent_hosts').includes('q') && !named(expected, 'agent_hosts').includes('g'))
      const p0 = (expected.agent_turns as { turn_key: string; last_activity_wall_ms: number }[]).find((t) => t.turn_key === 'p0')!
      assert.equal(p0.last_activity_wall_ms, T0 + HOUR, 'cut where the deleted range begins, for an app deletion as for a range')
    }
    for (let at = 1; at <= full.transactions; at++) {
      const s = scenario(kind)
      assert.equal(run(s.dir, s.tombstone, at).crashed, true)
      assert.equal(run(s.dir, s.tombstone, null).crashed, false)
      assert.deepEqual(dump(s.dir), expected, `cut short before transaction ${at} of ${full.transactions}`)
    }
  })
}
