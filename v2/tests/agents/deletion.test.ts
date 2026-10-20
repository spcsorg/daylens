import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import Database from 'better-sqlite3'
import { mergeStaging } from '../../capture/agents/backfill.ts'
import { AgentStore } from '../../capture/agents/store.ts'
import type { AgentRecord } from '../../capture/agents/types.ts'
import { HOUR, MIN, rig, T0 } from '../storage/support.ts'

// A turn of agent work: session, turn start, a person's message, activity, an end.
function turn(key: string, session: string, start: number, end: number): AgentRecord[] {
  return [
    { t: 'session', session, origin: 'interactive', parent: null, client: null, dir: '/code/alpha', branch: 'main', at: start },
    { t: 'turn', key, session, dir: '/code/alpha', branch: 'main', opener: 'user', start, replayed: false },
    { t: 'user', key: `${key}-u`, session, turn: key, act: 'prompt', basis: 'marked', at: start },
    { t: 'activity', key, session, at: end - MIN },
    { t: 'end', key, state: 'completed', at: end },
  ]
}

function wired(r: ReturnType<typeof rig>): AgentStore {
  const agents = new AgentStore(r.store.database)
  agents.admit = (at) => r.storage.admitsTime(at)
  return agents
}

const rows = (r: ReturnType<typeof rig>, table: string) => r.q<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY id`)

test('deleting a range removes agent work that began inside it and cuts work that crosses its start', async () => {
  const r = rig()
  const agents = wired(r)
  agents.apply('claude_code', [...turn('before', 's1', T0, T0 + 90 * MIN), ...turn('inside', 's1', T0 + 2 * HOUR, T0 + 2 * HOUR + 20 * MIN), ...turn('after', 's2', T0 + 4 * HOUR, T0 + 4 * HOUR + 10 * MIN)])
  r.clock.t = T0 + 5 * HOUR
  const result = await r.storage.deleteRange(T0 + HOUR, T0 + 3 * HOUR).done
  assert.ok(result.agentRecords > 0)
  assert.deepEqual(rows(r, 'agent_turns').map((t) => [t.turn_key, t.start_wall_ms, t.last_activity_wall_ms, t.end_wall_ms]), [
    ['before', T0, T0 + HOUR, T0 + HOUR],
    ['after', T0 + 4 * HOUR, T0 + 4 * HOUR + 9 * MIN, T0 + 4 * HOUR + 10 * MIN],
  ])
  assert.deepEqual(rows(r, 'agent_events').map((e) => e.event_key), ['before-u', 'after-u'])
  assert.deepEqual(rows(r, 'agent_sessions').map((s) => [s.session_id, s.first_wall_ms, s.last_wall_ms]), [
    ['s1', T0, T0 + HOUR],
    ['s2', T0 + 4 * HOUR, T0 + 4 * HOUR + 9 * MIN],
  ])
  r.close()
})

test('agent work during a pause or inside a deleted range is never recorded, including when its log is read again', async () => {
  const r = rig()
  const agents = wired(r)
  r.clock.t = T0 + 3 * HOUR
  await r.storage.deleteRange(T0, T0 + HOUR).done
  r.storage.pause(T0 + 3 * HOUR + 30 * MIN)
  const records = [...turn('deleted', 's1', T0 + 10 * MIN, T0 + 20 * MIN), ...turn('paused', 's2', T0 + 3 * HOUR + 5 * MIN, T0 + 3 * HOUR + 15 * MIN), ...turn('kept', 's3', T0 + 2 * HOUR, T0 + 2 * HOUR + 5 * MIN)]
  agents.apply('claude_code', records)
  agents.apply('claude_code', records)
  assert.deepEqual(rows(r, 'agent_turns').map((t) => t.turn_key), ['kept'])
  assert.deepEqual(rows(r, 'agent_events').map((e) => e.event_key), ['kept-u'])
  assert.deepEqual(rows(r, 'agent_sessions').map((s) => s.session_id), ['s3'])
  r.close()
})

test('retention removes agent work older than the cutoff', async () => {
  const r = rig()
  const agents = wired(r)
  agents.apply('codex', [...turn('old', 's1', T0, T0 + 10 * MIN), ...turn('new', 's2', T0 + 3 * 24 * HOUR, T0 + 3 * 24 * HOUR + 10 * MIN)])
  r.clock.t = T0 + 3 * 24 * HOUR + HOUR
  r.storage.setRetentionDays(1)
  await r.storage.prune()
  assert.deepEqual(rows(r, 'agent_turns').map((t) => t.turn_key), ['new'])
  assert.deepEqual(rows(r, 'agent_events').map((e) => e.event_key), ['new-u'])
  assert.deepEqual(rows(r, 'agent_sessions').map((s) => s.session_id), ['s2'])
  r.close()
})

test('the first read merges no agent work from a deleted range or a pause', async () => {
  const r = rig()
  wired(r)
  r.clock.t = T0 + 3 * HOUR
  await r.storage.deleteRange(T0, T0 + HOUR).done
  r.storage.pause(T0 + 3 * HOUR + 30 * MIN)
  const staging = path.join(r.dir, 'staging-test.sqlite')
  const db = new Database(staging)
  new AgentStore(db).apply('codex', [...turn('deleted', 's1', T0 + 10 * MIN, T0 + 20 * MIN), ...turn('paused', 's2', T0 + 3 * HOUR + 5 * MIN, T0 + 3 * HOUR + 15 * MIN), ...turn('kept', 's3', T0 + 2 * HOUR, T0 + 2 * HOUR + 5 * MIN)])
  db.close()
  mergeStaging(r.store.database, staging, (at) => r.storage.admitsTime(at))
  assert.deepEqual(rows(r, 'agent_turns').map((t) => t.turn_key), ['kept'])
  assert.deepEqual(rows(r, 'agent_events').map((e) => e.event_key), ['kept-u'])
  assert.deepEqual(rows(r, 'agent_sessions').map((s) => s.session_id), ['s3'])
  r.close()
})
