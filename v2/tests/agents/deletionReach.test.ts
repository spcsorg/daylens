// A deletion removes from each session it reaches exactly what admission then refuses: everything inside the range,
// whatever app it ran in, with work crossing into the range cut at its start, and nothing that names the session left
// once it has nothing of its own.
import { test } from 'node:test'
import { copyFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import assert from 'node:assert/strict'
import { AgentStore, deleteAgentSession } from '../../capture/agents/store.ts'
import { DB_FILE } from '../../capture/store.ts'
import { emptyCounts, type AgentRecord } from '../../capture/agents/types.ts'
import { diskContains, HOUR, MIN, rig, T0, tmpDir } from '../storage/support.ts'

type Rig = ReturnType<typeof rig>

const ghostty = { app_id: 'com.mitchellh.ghostty', name: 'Ghostty', path: '/Applications/Ghostty.app' }
const claudeApp = { app_id: 'com.anthropic.claudefordesktop', name: null, path: null }

function setup() {
  const r = rig()
  const agents = Object.assign(new AgentStore(r.store.database, () => r.clock.t), {
    withheld: () => r.storage.withheld(),
    hostAllowed: (h: Parameters<Rig['storage']['agentHostAllowed']>[0], at: number) => r.storage.agentHostAllowed(h, at),
    hostExcluded: (h: Parameters<Rig['storage']['excludesAgentHost']>[0]) => r.storage.excludesAgentHost(h),
    hostExcludedAt: (h: Parameters<Rig['storage']['agentHostExcludedAt']>[0], at: number) => r.storage.agentHostExcludedAt(h, at),
    hostRefused: (h: Parameters<Rig['storage']['agentHostRefused']>[0]) => r.storage.agentHostRefused(h),
    appDeleted: (app: string) => r.storage.agentAppDeleted(app),
  })
  return { r, agents }
}

const session = (s: string, at: number, parent: string | null = null): AgentRecord => ({ t: 'session', session: s, origin: parent ? 'subagent' : 'interactive', parent, client: 'cli', dir: '/w', branch: null, at })
const work = (s: string, key: string, start: number, last: number): AgentRecord[] => [
  { t: 'turn', key, session: s, dir: '/w', branch: null, opener: 'user', start, replayed: false },
  { t: 'user', key: `${key}:u`, session: s, turn: key, act: 'prompt', basis: 'marked', at: start },
  { t: 'activity', key, session: s, at: last },
  { t: 'end', key, state: 'completed', at: last },
]
const log = (s: string) => ({ path: `/logs/${s}.jsonl`, agent: 'claude_code' as const, root: '/logs', session: s, dev: '1', ino: s, offset: 10, size: 10, state: '{"dir":"/w"}', turnless: false, counts: emptyCounts() })
const turns = (r: Rig, s: string) => r.q('SELECT turn_key, start_wall_ms, last_activity_wall_ms, end_wall_ms FROM agent_turns WHERE session_id = ? ORDER BY start_wall_ms', s)
const named = (r: Rig, table: string, s: string) => r.q(`SELECT * FROM ${table} WHERE session_id = ?`, s)

// The Claude app for 20 minutes, Ghostty for 20, then the Claude app again.
function moves(agents: AgentStore): void {
  agents.recordHost('claude_code', 's', claudeApp, 'log', T0)
  agents.recordHost('claude_code', 's', ghostty, 'responsible', T0 + 20 * MIN)
  agents.recordHost('claude_code', 's', claudeApp, 'log', T0 + 40 * MIN)
}

test('an app deletion removes the work of a session that ran in the app from anywhere in the range, not only from its time in the app', async () => {
  for (const range of [{ from_wall_ms: T0, to_wall_ms: T0 + 100 * MIN }, undefined]) {
    const { r, agents } = setup()
    moves(agents)
    agents.apply('claude_code', [session('s', T0 - 10 * MIN), ...work('s', 'k', T0 + 10 * MIN, T0 + 30 * MIN)])
    r.clock.t = T0 + 100 * MIN
    await r.storage.deleteSource('com.mitchellh.ghostty', range).done
    const how = range ? 'for a range' : 'across all time'
    assert.deepEqual(turns(r, 's'), [], `a turn begun in the Claude app that ran on while the session was in Ghostty goes (${how})`)
    assert.deepEqual(r.q('SELECT event_key FROM agent_events WHERE session_id = ?', 's'), [], how)
    r.close()
  }
})

test('an app deletion keeps no time a reached session moved between apps inside the range', async () => {
  const { r, agents } = setup()
  moves(agents)
  agents.apply('claude_code', [session('s', T0 - 10 * MIN), ...work('s', 'early', T0 - 10 * MIN, T0 - 5 * MIN), ...work('s', 'late', T0 + 110 * MIN, T0 + 115 * MIN)])
  r.clock.t = T0 + 2 * HOUR
  await r.storage.deleteSource('com.mitchellh.ghostty', { from_wall_ms: T0, to_wall_ms: T0 + 100 * MIN }).done
  assert.deepEqual(r.q('SELECT app_id, from_wall_ms FROM agent_hosts WHERE session_id = ?', 's'), [{ app_id: claudeApp.app_id, from_wall_ms: T0 + 100 * MIN }], 'the app in force at the end of the range holds from there')
  r.close()
})

test('deleting a range leaves no log row for a session left with nothing, though the session had no turn or event', async () => {
  const { r, agents } = setup()
  r.clock.t = T0 + HOUR + 5 * MIN
  agents.apply('claude_code', [session('s', T0 + HOUR + 5 * MIN)], log('s'))
  assert.equal(named(r, 'agent_sources', 's').length, 1)
  r.clock.t = T0 + 2 * HOUR
  await r.storage.deleteRange(T0 + HOUR, T0 + HOUR + 30 * MIN).done
  assert.deepEqual([named(r, 'agent_sessions', 's'), named(r, 'agent_sources', 's')], [[], []])
  r.close()
})

test('a deletion that reaches sessions whose parents form a loop leaves neither of them a log row or an app', async () => {
  const { r, agents } = setup()
  for (const s of ['a', 'b']) agents.recordHost('claude_code', s, ghostty, 'responsible', T0)
  r.clock.t = T0 + HOUR + 10 * MIN
  agents.apply('claude_code', [session('a', T0 + HOUR + 5 * MIN, 'b'), ...work('a', 'a1', T0 + HOUR + 5 * MIN, T0 + HOUR + 6 * MIN)], log('a'))
  agents.apply('claude_code', [session('b', T0 + HOUR + 6 * MIN, 'a'), ...work('b', 'b1', T0 + HOUR + 6 * MIN, T0 + HOUR + 7 * MIN)], log('b'))
  r.clock.t = T0 + 2 * HOUR
  await r.storage.deleteRange(T0 + HOUR, T0 + HOUR + 30 * MIN).done
  for (const s of ['a', 'b']) assert.deepEqual([named(r, 'agent_sources', s), named(r, 'agent_hosts', s)], [[], []], s)
  assert.deepEqual(r.q('SELECT count(*) AS n FROM deletion_agent'), [{ n: 0 }])
  r.close()
})

test('a session deletion that commits and then stops before its purge is purged at the next start', async () => {
  const { r, agents } = setup()
  const canary = 'canary-session-dir-5d1e'
  agents.apply('claude_code', [{ t: 'session', session: 's', origin: 'interactive', parent: null, client: 'cli', dir: `/w/${canary}`, branch: null, at: T0 }, ...work('s', 'k', T0, T0 + MIN)])
  r.store.flush()
  // The deletion's own transaction, without the purge the storage call runs after it; then the files as a crash leaves them.
  deleteAgentSession(r.store.database, 'claude_code', 's', r.clock.t)
  const crashed = tmpDir()
  for (const f of readdirSync(r.dir)) if (f.startsWith(DB_FILE)) copyFileSync(path.join(r.dir, f), path.join(crashed, f))
  r.close()
  assert.notDeepEqual(diskContains(crashed, canary), [], 'the deleted text is still on disk when the run stops')
  const again = rig(crashed)
  assert.notEqual(again.store.meta('page_scrub_pending'), null)
  again.storage.start()
  assert.equal(await again.store.retryScrub(), true)
  assert.equal(again.store.meta('page_scrub_pending'), null, 'the scrub the deletion owed ran at start')
  assert.deepEqual(diskContains(crashed, canary), [])
  again.close()
})

test('deleting a range, or everything, leaves no row of a log read since it began whose session is not known', async () => {
  for (const everything of [false, true]) {
    const { r, agents } = setup()
    r.clock.t = T0 + HOUR + 5 * MIN
    agents.apply('codex', [], { ...log('x'), agent: 'codex', session: null })
    r.clock.t = T0 - HOUR
    agents.apply('codex', [], { ...log('before'), agent: 'codex', session: null })
    r.clock.t = T0 + 2 * HOUR
    await (everything ? r.storage.deleteEverything() : r.storage.deleteRange(T0 + HOUR, T0 + HOUR + 30 * MIN)).done
    assert.deepEqual(r.q<{ path: string }>('SELECT path FROM agent_sources ORDER BY path').map((x) => x.path), everything ? [] : ['/logs/before.jsonl'], everything ? 'everything' : 'a range')
    r.close()
  }
})

test('deleting everything removes what is stored whatever its time, nothing of it comes back, and what follows is recorded', async () => {
  const { r, agents } = setup()
  const now = T0 + 10 * HOUR
  const obs = (seq: number, t: number, title: string) => ({
    run: 'run-1', seq, boot: 'b', platform: 'macos', source: 's', kind: 'focus', event_wall_ms: t, event_mono_us: t * 1000, tz: 'UTC', tz_offset_min: 0,
    app_id: 'com.example.editor', app_name: 'Editor', app_path: '/Applications/Editor.app', pid: 1, window: 'w', title, title_raw: null, title_state: 'ok', state: 'ok', detail: null,
  } as const)
  // Before 1970, an ordinary time, and after the clock was set back: dated two hours after the deletion.
  const old = [obs(1, -5 * MIN, 'before-epoch'), obs(2, T0, 'ordinary'), obs(3, now + 2 * HOUR, 'clock-ahead')]
  for (const o of old) r.store.insertObservation(o)
  const records = (s: string, at: number) => [session(s, at), ...work(s, `${s}-1`, at, at + MIN)]
  const logs = { pre: -5 * MIN, past: T0, ahead: now + 2 * HOUR }
  for (const [s, at] of Object.entries(logs)) agents.apply('claude_code', records(s, at), log(s))
  agents.recordHost('claude_code', 'ahead', ghostty, 'responsible', now + 2 * HOUR)
  const left = () => ['observations', 'agent_sessions', 'agent_turns', 'agent_events', 'agent_hosts', 'agent_sources'].map((t) => r.q<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)[0]!.n)
  assert.deepEqual(left(), [3, 3, 3, 3, 1, 3])
  r.clock.t = now
  await r.storage.deleteEverything().done
  assert.deepEqual(left(), [0, 0, 0, 0, 0, 0], 'nothing stored before the deletion is left, whatever its time')
  assert.equal(r.storage.importObservations(old).imported, 0, 'an import of the deleted observations brings none back')
  for (const [s, at] of Object.entries(logs)) agents.apply('claude_code', records(s, at), log(s))
  agents.recordHost('claude_code', 'ahead', ghostty, 'responsible', now + 2 * HOUR)
  assert.deepEqual(left(), [0, 0, 0, 0, 0, 0], 'reading the logs again brings none back')
  r.store.insertObservation(obs(4, now + MIN, 'after'))
  agents.apply('claude_code', [...records('new', now + MIN), ...work('ahead', 'ahead-2', now + 3 * MIN, now + 4 * MIN)], log('new'))
  assert.deepEqual(r.q('SELECT title FROM observations'), [{ title: 'after' }], 'capture after the deletion is recorded')
  assert.deepEqual(r.q<{ turn_key: string }>('SELECT turn_key FROM agent_turns ORDER BY turn_key').map((x) => x.turn_key), ['ahead-2', 'new-1'], 'as is agent work after it, in a new session or one with deleted work dated ahead')
  r.close()
})

test('a session deleting everything removed though dated after it does not come back when an earlier deletion had moved its start', async () => {
  const { r, agents } = setup()
  r.clock.t = T0 + 40 * MIN
  agents.apply('claude_code', [session('s', T0 + 20 * MIN), ...work('s', 'a', T0 + 25 * MIN, T0 + 25 * MIN + 1000), ...work('s', 'b', T0 + 30 * MIN, T0 + 30 * MIN + 1000)], log('s'))
  await r.storage.deleteRange(T0 + 25 * MIN, T0 + 26 * MIN).done
  assert.deepEqual(r.q('SELECT first_wall_ms FROM agent_sessions'), [{ first_wall_ms: T0 + 30 * MIN }], 'the range deletion moved the session start to its first turn left')
  // The clock is set back, then everything is deleted: the session and its turn are dated after the deletion.
  r.clock.t = T0 + 10 * MIN
  await r.storage.deleteEverything().done
  agents.apply('claude_code', [session('s', T0 + 20 * MIN), ...work('s', 'b', T0 + 30 * MIN, T0 + 30 * MIN + 1000)], log('s'))
  assert.deepEqual(['agent_sessions', 'agent_turns', 'agent_sources'].map((t) => r.q(`SELECT count(*) AS n FROM ${t}`)[0]), [{ n: 0 }, { n: 0 }, { n: 0 }])
  r.close()
})

test("a session deletion whose checkpoint a reader holds up still owes it, to a retry and to the next start", async () => {
  const { r, agents } = setup()
  const canary = 'canary-session-dir-8b2f'
  agents.apply('claude_code', [{ t: 'session', session: 's', origin: 'interactive', parent: null, client: 'cli', dir: `/w/${canary}`, branch: null, at: T0 }, ...work('s', 'k', T0, T0 + MIN)])
  r.store.flush()
  const reader = new Database(path.join(r.dir, DB_FILE), { readonly: true })
  reader.prepare('BEGIN').run()
  reader.prepare('SELECT count(*) FROM agent_sessions').get()
  assert.equal(await r.storage.deleteAgentSession('claude_code', 's'), false, 'not purged while the reader holds the old pages')
  assert.equal(await r.store.retryScrub(), false, 'a retry while the reader still holds them is not purged either')
  const crashed = tmpDir()
  for (const f of readdirSync(r.dir)) if (f.startsWith(DB_FILE)) copyFileSync(path.join(r.dir, f), path.join(crashed, f))
  reader.prepare('COMMIT').run()
  reader.close()
  assert.equal(await r.store.retryScrub(), true)
  assert.deepEqual(diskContains(r.dir, canary), [])
  r.close()
  const again = rig(crashed)
  assert.equal(again.store.scrubOwed(), true, 'a run that stops here leaves the purge owed')
  again.storage.start()
  assert.equal(await again.store.retryScrub(), true)
  assert.deepEqual(diskContains(crashed, canary), [])
  again.close()
})
