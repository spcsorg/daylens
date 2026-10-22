import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import Database from 'better-sqlite3'
import { mergeStaging } from '../../capture/agents/backfill.ts'
import { AgentStore } from '../../capture/agents/store.ts'
import { emptyCounts } from '../../capture/agents/types.ts'
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
  agents.withheld = () => r.storage.withheld()
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
  mergeStaging(r.store.database, staging, r.storage.withheld())
  assert.deepEqual(rows(r, 'agent_turns').map((t) => t.turn_key), ['kept'])
  assert.deepEqual(rows(r, 'agent_events').map((e) => e.event_key), ['kept-u'])
  assert.deepEqual(rows(r, 'agent_sessions').map((s) => s.session_id), ['s3'])
  r.close()
})

const source = (state: string) => ({ path: '/logs/a.jsonl', agent: 'codex' as const, root: '/logs', session: 's1', dev: '1', ino: '2', offset: 10, size: 10, state, turnless: false, counts: emptyCounts() })

test('a project folder reported during a pause is not recorded on the turn', async () => {
  const r = rig()
  const agents = wired(r)
  agents.apply('codex', [{ t: 'turn', key: 'k', session: 's1', dir: '/code/alpha', branch: null, opener: 'user', start: T0, replayed: false }])
  r.clock.t = T0 + 2 * MIN
  r.storage.pause(null)
  agents.apply('codex', [{ t: 'turn_dir', key: 'k', dir: '/code/private-paused-project', at: T0 + 3 * MIN }])
  assert.deepEqual(rows(r, 'agent_turns').map((t) => t.project_dir), ['/code/alpha'])
  r.close()
})

test('activity after a deleted range does not stretch a cut turn back across it', async () => {
  const r = rig()
  const agents = wired(r)
  agents.apply('claude_code', [{ t: 'turn', key: 'k', session: 's1', dir: null, branch: null, opener: 'user', start: T0, replayed: false }, { t: 'activity', key: 'k', session: 's1', at: T0 + 90 * MIN }])
  r.clock.t = T0 + 3 * HOUR
  await r.storage.deleteRange(T0 + HOUR, T0 + 2 * HOUR).done
  agents.apply('claude_code', [{ t: 'activity', key: 'k', session: 's1', at: T0 + 150 * MIN }, { t: 'end', key: 'k', state: 'completed', at: T0 + 160 * MIN }])
  const [t] = rows(r, 'agent_turns')
  assert.equal(t!.last_activity_wall_ms, T0 + HOUR)
  assert.equal(t!.end_wall_ms, null)
  assert.equal(t!.end_state, 'completed')
  r.close()
})

test('the first read cuts a merged turn where a deleted range begins', async () => {
  const r = rig()
  wired(r)
  r.clock.t = T0 + 3 * HOUR
  await r.storage.deleteRange(T0 + HOUR, T0 + 2 * HOUR).done
  const staging = path.join(r.dir, 'staging-cut.sqlite')
  const db = new Database(staging)
  new AgentStore(db).apply('claude_code', [
    { t: 'turn', key: 'k', session: 's1', dir: null, branch: null, opener: 'user', start: T0, replayed: false },
    { t: 'activity', key: 'k', session: 's1', at: T0 + 90 * MIN },
    { t: 'end', key: 'k', state: 'completed', at: T0 + 100 * MIN },
  ])
  db.close()
  mergeStaging(r.store.database, staging, r.storage.withheld())
  const [t] = rows(r, 'agent_turns')
  assert.equal(t!.last_activity_wall_ms, T0 + HOUR)
  assert.equal(t!.end_wall_ms, null)
  r.close()
})

test('parser state is not kept from a batch with withheld records, and a range deletion clears what was kept', async () => {
  const r = rig()
  const agents = wired(r)
  r.clock.t = T0 + 30 * MIN
  agents.apply('codex', [{ t: 'turn', key: 'k1', session: 's1', dir: null, branch: null, opener: 'user', start: T0, replayed: false }], source('{"dir":"/code/alpha"}'))
  assert.deepEqual(r.q<{ state: string | null }>('SELECT state FROM agent_sources').map((s) => s.state), ['{"dir":"/code/alpha"}'])
  r.storage.pause(null)
  agents.apply('codex', [{ t: 'turn', key: 'k2', session: 's1', dir: null, branch: null, opener: 'user', start: T0 + 40 * MIN, replayed: false }], source('{"dir":"/code/paused"}'))
  assert.deepEqual(r.q<{ state: string | null; offset: number }>('SELECT state, offset FROM agent_sources').map((s) => [s.state, s.offset]), [[null, 10]])
  r.storage.resume()
  r.clock.t = T0 + 50 * MIN
  agents.apply('codex', [], source('{"dir":"/code/after"}'))
  r.clock.t = T0 + 2 * HOUR
  await r.storage.deleteRange(T0 + 45 * MIN, T0 + HOUR).done
  assert.deepEqual(r.q<{ state: string | null }>('SELECT state FROM agent_sources').map((s) => s.state), [null])
  r.close()
})

const ghostty = { app_id: 'com.mitchellh.ghostty', name: 'Ghostty', path: '/Applications/Ghostty.app' }
const logOf = (session: string, state: string | null) => ({ path: `/logs/${session}.jsonl`, agent: 'claude_code' as const, root: '/logs', session, dev: '1', ino: session, offset: 10, size: 10, state, turnless: false, counts: emptyCounts() })

test('deleting everything leaves no app, log path or read position of the agent sessions it removed, and reading the logs again brings none back', async () => {
  const r = rig()
  const agents = new AgentStore(r.store.database, () => r.clock.t)
  agents.withheld = () => r.storage.withheld()
  agents.recordHost('claude_code', 's1', ghostty, 'responsible', T0)
  r.clock.t = T0 + 20 * MIN
  agents.apply('claude_code', turn('k', 's1', T0 + 10 * MIN, T0 + 20 * MIN), logOf('s1', '{"dir":"/code/alpha"}'))
  r.clock.t = T0 + HOUR
  await r.storage.deleteEverything().done
  assert.deepEqual([rows(r, 'agent_hosts'), r.q('SELECT * FROM agent_sources')], [[], []])
  r.clock.t = T0 + HOUR + MIN
  agents.apply('claude_code', turn('k', 's1', T0 + 10 * MIN, T0 + 20 * MIN), logOf('s1', '{"dir":"/code/alpha"}'))
  agents.recordHost('claude_code', 's1', ghostty, 'responsible', T0)
  assert.deepEqual(rows(r, 'agent_turns'), [])
  assert.deepEqual(r.q('SELECT * FROM agent_sources'), [], 'reading a deleted session\'s log again writes no path or read position back')
  assert.deepEqual(r.q('SELECT from_wall_ms FROM agent_hosts'), [{ from_wall_ms: T0 + HOUR }], 'the app it runs in now holds from the deletion on')
  r.close()
})

test('deleting a range leaves a surviving agent session no app it was seen in, nor a read time, from inside the range', async () => {
  const r = rig()
  const agents = new AgentStore(r.store.database, () => r.clock.t)
  agents.withheld = () => r.storage.withheld()
  agents.apply('claude_code', [{ t: 'client', session: 's1', client: 'claude-desktop', at: T0 }, ...turn('a', 's1', T0, T0 + 10 * MIN)])
  agents.recordHost('claude_code', 's1', ghostty, 'responsible', T0 + HOUR + 10 * MIN)
  r.clock.t = T0 + HOUR + 25 * MIN
  agents.apply('claude_code', turn('b', 's1', T0 + HOUR + 10 * MIN, T0 + HOUR + 20 * MIN), logOf('s1', '{"dir":"/code/alpha"}'))
  r.clock.t = T0 + 3 * HOUR
  await r.storage.deleteRange(T0 + HOUR, T0 + 2 * HOUR).done
  assert.deepEqual(rows(r, 'agent_turns').map((t) => t.turn_key), ['a'])
  assert.deepEqual(r.q('SELECT app_id, from_wall_ms FROM agent_hosts ORDER BY from_wall_ms'), [
    { app_id: 'com.anthropic.claudefordesktop', from_wall_ms: T0 },
    { app_id: 'com.mitchellh.ghostty', from_wall_ms: T0 + 2 * HOUR },
  ])
  assert.deepEqual(r.q('SELECT state, updated_wall_ms FROM agent_sources'), [{ state: null, updated_wall_ms: T0 + 2 * HOUR }])
  agents.apply('claude_code', [{ t: 'client', session: 's1', client: 'cli', at: T0 + HOUR + 30 * MIN }])
  assert.equal(r.q<{ n: number }>('SELECT count(*) AS n FROM agent_hosts WHERE from_wall_ms >= ? AND from_wall_ms < ?', T0 + HOUR, T0 + 2 * HOUR)[0]!.n, 0, 'a log read again adds no app inside the range')
  r.close()
})

test('a turn cut by a deletion whose end was deleted says only that it ended, here and when its log is read again', async () => {
  const r = rig()
  const agents = new AgentStore(r.store.database, () => r.clock.t)
  agents.withheld = () => r.storage.withheld()
  agents.apply('claude_code', [...turn('cut', 's1', T0, T0 + 90 * MIN), ...turn('kept', 's1', T0 + 4 * HOUR, T0 + 4 * HOUR + 10 * MIN)])
  agents.apply('claude_code', [{ t: 'turn', key: 'open', session: 's2', dir: null, branch: null, opener: 'user', start: T0, replayed: false }, { t: 'activity', key: 'open', session: 's2', at: T0 + 70 * MIN }])
  r.clock.t = T0 + 5 * HOUR
  await r.storage.deleteRange(T0 + HOUR, T0 + 2 * HOUR).done
  const states = () => r.q<{ turn_key: string; end_state: string | null; end_wall_ms: number | null }>('SELECT turn_key, end_state, end_wall_ms FROM agent_turns ORDER BY turn_key')
  assert.deepEqual(states(), [
    { turn_key: 'cut', end_state: 'missing', end_wall_ms: T0 + HOUR },
    { turn_key: 'kept', end_state: 'completed', end_wall_ms: T0 + 4 * HOUR + 10 * MIN },
    { turn_key: 'open', end_state: null, end_wall_ms: null },
  ])
  agents.apply('claude_code', [{ t: 'end', key: 'open', state: 'failed', at: T0 + 80 * MIN }])
  assert.deepEqual(states()[2], { turn_key: 'open', end_state: 'missing', end_wall_ms: null }, 'an end read inside the deleted range does not say how the turn ended')
  const staging = path.join(r.dir, 'staging-end.sqlite')
  const db = new Database(staging)
  new AgentStore(db).apply('codex', [{ t: 'turn', key: 'm', session: 's3', dir: null, branch: null, opener: 'user', start: T0, replayed: false }, { t: 'end', key: 'm', state: 'aborted', at: T0 + 80 * MIN }])
  db.close()
  mergeStaging(r.store.database, staging, r.storage.withheld())
  assert.deepEqual(r.q('SELECT end_state, end_wall_ms FROM agent_turns WHERE turn_key = ?', 'm'), [{ end_state: 'missing', end_wall_ms: null }], 'nor does the first read')
  r.close()
})
