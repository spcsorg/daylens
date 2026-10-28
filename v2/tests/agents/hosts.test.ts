import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { backfill, mergeStaging } from '../../capture/agents/backfill.ts'
import { ClaudeParser } from '../../capture/agents/claude.ts'
import { AgentReader, homeRoots } from '../../capture/agents/reader.ts'
import { AgentStore, agentDeletedSessionsMigration, agentDeletedSpansAppMigration, agentDeletedSpansMigration, agentHostsMigration, agentSessionsMigration, agentSourcesTurnlessMigration, applyMigrations } from '../../capture/agents/store.ts'
import { emptyCounts, type AgentRecord } from '../../capture/agents/types.ts'
import { rig, MIN, T0 } from '../storage/support.ts'
import { claude, claudeCtx, of, run, tmp } from './fixtures.ts'

const ghostty = { app_id: 'com.mitchellh.ghostty', name: 'Ghostty', path: '/Applications/Ghostty.app' }
const vscode = { app_id: 'com.microsoft.VSCode', name: 'Code', path: '/Applications/Visual Studio Code.app' }

function setup() {
  const r = rig()
  // The logs come from macOS, where the Claude and Codex apps name themselves as the client.
  const agents = Object.assign(new AgentStore(r.store.database, () => r.clock.t), r.storage.agentPolicy(), { platform: 'darwin' as const })
  const turn = (session: string, key: string, at: number): AgentRecord[] => [
    { t: 'session', session, origin: 'interactive', parent: null, client: 'cli', dir: '/w', branch: null, at },
    { t: 'turn', key, session, dir: '/w', branch: null, opener: 'user', start: at, replayed: false },
    { t: 'user', key: `${key}:u`, session, turn: key, act: 'prompt', basis: 'marked', at },
    { t: 'end', key, state: 'completed', at: at + 1000 },
  ]
  const turns = (session: string) => r.q<{ turn_key: string }>('SELECT turn_key FROM agent_turns WHERE session_id = ? ORDER BY start_wall_ms', session).map((x) => x.turn_key)
  return { r, agents, turn, turns }
}

test('excluding an app stops recording the agent sessions known to run in it, from then on', () => {
  const { r, agents, turn, turns } = setup()
  agents.recordHost('claude_code', 's1', ghostty, 'responsible', T0)
  agents.recordHost('claude_code', 's2', vscode, 'parent', T0)
  agents.apply('claude_code', turn('s1', 's1a', T0 + MIN))
  r.clock.t = T0 + 2 * MIN
  r.storage.addExclusion({ match: 'app_id', value: 'com.mitchellh.ghostty', label: 'Ghostty' })
  agents.apply('claude_code', [...turn('s1', 's1b', T0 + 5 * MIN), ...turn('s2', 's2a', T0 + 5 * MIN)])
  assert.deepEqual(turns('s1'), ['s1a'], 'what was recorded before stays; nothing after')
  assert.deepEqual(turns('s2'), ['s2a'])
  assert.equal(r.q<{ n: number }>(`SELECT count(*) AS n FROM agent_events WHERE session_id = 's1'`)[0]!.n, 1)
  r.close()
})

test('while an app that could host a session is excluded, a session whose app is not known is not recorded', () => {
  const { r, agents, turn, turns } = setup()
  agents.apply('claude_code', turn('u', 'u1', T0 + MIN))
  r.storage.addExclusion({ match: 'app_id', value: 'com.microsoft.excel', label: 'Excel' })
  agents.apply('claude_code', turn('u', 'u2', T0 + 2 * MIN))
  assert.deepEqual(turns('u'), ['u1', 'u2'], 'an app that runs no agent sessions changes nothing')
  r.storage.addExclusion({ match: 'app_id', value: 'com.mitchellh.ghostty', label: 'Ghostty' })
  agents.apply('claude_code', turn('u', 'u3', T0 + 3 * MIN))
  r.storage.removeExclusion('app_id', 'com.mitchellh.ghostty')
  agents.recordHost('codex', 'other', { app_id: 'com.example.term', name: 'Term', path: null }, 'parent', T0)
  r.storage.addExclusion({ match: 'app_id', value: 'com.example.term', label: 'Term' })
  agents.apply('claude_code', turn('u', 'u4', T0 + 4 * MIN))
  r.storage.removeExclusion('app_id', 'com.example.term')
  agents.apply('claude_code', turn('u', 'u5', T0 + 5 * MIN))
  assert.deepEqual(turns('u'), ['u1', 'u2', 'u5'], 'a known terminal, or an app seen hosting a session, holds unknown sessions back')
  r.close()
})

test('deleting an app removes the sessions known to have run in it, for the range asked, and offers the unknown ones', async () => {
  const { r, agents, turn, turns } = setup()
  agents.recordHost('claude_code', 's1', ghostty, 'responsible', T0)
  agents.apply('claude_code', [...turn('s1', 's1a', T0 + MIN), ...turn('s1', 's1b', T0 + 2 * MIN)])
  agents.apply('claude_code', [{ t: 'client', session: 's3', client: 'claude-desktop', at: T0 }, ...turn('s3', 's3a', T0 + 5 * MIN)])
  agents.recordHost('claude_code', 's3', ghostty, 'responsible', T0 + 10 * MIN)
  agents.apply('claude_code', turn('s3', 's3b', T0 + 12 * MIN))
  agents.apply('claude_code', turn('u', 'u1', T0 + 4 * MIN))
  r.clock.t = T0 + 20 * MIN
  const handle = r.storage.deleteSource('com.mitchellh.ghostty')
  assert.deepEqual(handle.unknownAgentSessions, [{ agent: 'claude_code', session_id: 'u' }])
  await handle.done
  assert.deepEqual(turns('s1'), [])
  assert.deepEqual(r.q(`SELECT session_id FROM agent_sessions WHERE session_id = 's1'`), [])
  assert.deepEqual(turns('s3'), [], 'a session that ran in the app loses everything in the range, whatever app it ran in')
  assert.deepEqual(turns('u'), ['u1'], 'a session whose app is not known is not deleted by default')
  agents.apply('claude_code', turn('s1', 's1a', T0 + MIN))
  assert.deepEqual(turns('s1'), [], 'reading the log again does not bring it back')
  assert.equal(await r.storage.deleteAgentSession('claude_code', 'u'), true)
  assert.deepEqual(turns('u'), [])
  r.close()
})

test('a session resumed in another app moves to it, and an unknown client never hides a traced app', () => {
  const { r, agents } = setup()
  agents.apply('claude_code', [{ t: 'session', session: 's', origin: 'interactive', parent: null, client: 'claude-desktop', dir: '/w', branch: null, at: T0 }, { t: 'client', session: 's', client: 'claude-desktop', at: T0 }])
  agents.apply('claude_code', [{ t: 'client', session: 's', client: 'cli', at: T0 + 10 * MIN }])
  assert.equal(agents.hostAt('claude_code', 's', T0 + MIN)?.app_id, 'com.anthropic.claudefordesktop')
  assert.equal(agents.hostAt('claude_code', 's', T0 + 11 * MIN), null, 'the CLI does not say which app')
  agents.recordHost('claude_code', 's', ghostty, 'responsible', T0 + 12 * MIN)
  agents.apply('claude_code', [{ t: 'client', session: 's', client: 'cli', at: T0 + 13 * MIN }])
  assert.equal(agents.hostAt('claude_code', 's', T0 + 14 * MIN)?.app_id, 'com.mitchellh.ghostty')
  agents.apply('claude_code', [{ t: 'session', session: 'sub', origin: 'subagent', parent: 's', client: null, dir: null, branch: null, at: T0 + 15 * MIN }])
  assert.equal(agents.hostAt('claude_code', 'sub', T0 + 15 * MIN)?.app_id, 'com.mitchellh.ghostty', 'a subagent runs where its parent does')
  r.close()
})

test("the Claude parser reports the client a session runs in, and again when it is resumed elsewhere", () => {
  const desktop = claudeCtx({ entrypoint: 'claude-desktop' })
  const cli = { ...desktop, entrypoint: 'cli' }
  const t = Date.now()
  const recs = run(new ClaudeParser(desktop.session, null, null), [
    claude.prompt(desktop, t, 'a', { uuid: 'a' }),
    claude.assistant(desktop, t + 1000, 'end_turn'),
    claude.prompt(cli, t + 60_000, 'b', { uuid: 'b' }),
    claude.assistant(cli, t + 61_000, 'end_turn'),
  ])
  assert.deepEqual(of(recs, 'client').map((c) => [c.client, c.at - t]), [['claude-desktop', 0], ['cli', 60_000]])
})

test('a log read live is traced to the app it runs in, and nothing is kept from a session in an excluded app', async () => {
  const { r, agents } = setup()
  const home = tmp()
  const c = claudeCtx()
  const dir = path.join(home, '.claude', 'projects', '-w')
  mkdirSync(dir, { recursive: true })
  const now = Date.now()
  writeFileSync(path.join(dir, `${c.session}.jsonl`), [claude.prompt(c, now, 'hi', { uuid: 'p1' }), claude.assistant(c, now + 1000, 'end_turn')].map((l) => l + '\n').join(''))
  r.storage.addExclusion({ match: 'app_id', value: 'com.mitchellh.ghostty', label: 'Ghostty' })
  const traced: string[] = []
  const reader = new AgentReader(agents, homeRoots(home, {}), {
    reconcileMs: 3_600_000,
    followUpMs: 3_600_000,
    coalesceMs: 20,
    resolveHost: async (_agent, session) => {
      traced.push(session)
      return { app: ghostty, basis: 'responsible' }
    },
  })
  await reader.start()
  await reader.stop()
  assert.deepEqual(traced, [c.session])
  assert.deepEqual(r.q(`SELECT app_id, app_name, app_path, basis FROM agent_hosts WHERE session_id = ?`, c.session), [], 'a session with nothing kept is not named by where it ran')
  assert.equal(r.q<{ n: number }>('SELECT count(*) AS n FROM agent_turns WHERE session_id = ?', c.session)[0]!.n, 0)
  r.close()
})

test('the first read merges nothing a session did in an excluded app', async () => {
  const { r, agents } = setup()
  const home = tmp()
  const desktop = claudeCtx({ entrypoint: 'claude-desktop' })
  const terminal = claudeCtx()
  const dir = path.join(home, '.claude', 'projects', '-w')
  mkdirSync(dir, { recursive: true })
  for (const c of [desktop, terminal]) writeFileSync(path.join(dir, `${c.session}.jsonl`), [claude.prompt(c, T0, 'hi', { uuid: `${c.session}p` }), claude.assistant(c, T0 + 1000, 'end_turn')].map((l) => l + '\n').join(''))
  r.storage.addExclusion({ match: 'app_id', value: 'com.anthropic.claudefordesktop', label: 'Claude' })
  let merged = false
  const reader = new AgentReader(agents, homeRoots(home, {}), {
    reconcileMs: 3_600_000,
    followUpMs: 3_600_000,
    coalesceMs: 20,
    backfill: async (roots) => (merged = (await backfill(r.store.database, r.dir, roots, () => {}, undefined, undefined, r.storage.agentPolicy(), 'darwin')).merged),
  })
  await reader.start()
  await reader.stop()
  assert.ok(merged)
  const count = (s: string) => r.q<{ n: number }>('SELECT count(*) AS n FROM agent_turns WHERE session_id = ?', s)[0]!.n
  assert.equal(count(desktop.session), 0, 'the Claude app is excluded')
  assert.equal(count(terminal.session), 0, 'an app that runs agent sessions is excluded, and this one does not say which app it ran in')
  assert.deepEqual(r.q('SELECT app_id, app_name, app_path, basis FROM agent_hosts WHERE session_id = ?', desktop.session), [{ app_id: null, app_name: null, app_path: null, basis: 'excluded' }], 'the excluded app is not named')
  r.close()
})

test('deleting a session removes the apps it ran in and its logs\' read positions, and nothing adds them back', () => {
  const { r, agents, turn } = setup()
  const source = { path: '/logs/s.jsonl', agent: 'claude_code' as const, root: '/logs', session: 's', dev: '1', ino: '2', offset: 10, size: 10, state: '{}', turnless: false, counts: emptyCounts() }
  agents.apply('claude_code', [{ t: 'client', session: 's', client: 'claude-desktop', at: T0 }, ...turn('s', 's1', T0 + MIN)], source)
  agents.recordHost('claude_code', 's', ghostty, 'responsible', T0 + 2 * MIN)
  const left = () => ['agent_hosts', 'agent_sources'].map((t) => r.q<{ n: number }>(`SELECT count(*) AS n FROM ${t} WHERE session_id = 's'`)[0]!.n)
  assert.deepEqual(left(), [2, 1])
  agents.deleteSession('claude_code', 's')
  assert.deepEqual(left(), [0, 0], 'no app, path or read position of a deleted session is kept')
  agents.apply('claude_code', [{ t: 'client', session: 's', client: 'claude-desktop', at: T0 + 3 * MIN }])
  agents.recordHost('claude_code', 's', ghostty, 'responsible', T0 + 4 * MIN)
  assert.deepEqual(left(), [0, 0], 'a client record or a traced app adds nothing to a deleted session')
  r.close()
})

test('an excluded app is never named for a session, and the session and sessions of unknown apps stay out', () => {
  const { r, agents, turn, turns } = setup()
  const term = { app_id: 'com.example.term', name: 'Term', path: '/Applications/Term.app' }
  r.storage.addExclusion({ match: 'app_id', value: 'com.example.term', label: 'Term' })
  agents.recordHost('claude_code', 's', term, 'responsible', T0)
  agents.apply('claude_code', [...turn('s', 's1', T0 + MIN), ...turn('u', 'u1', T0 + MIN)])
  assert.deepEqual(r.q('SELECT app_id, app_name, app_path, basis FROM agent_hosts'), [{ app_id: null, app_name: null, app_path: null, basis: 'excluded' }])
  assert.deepEqual(turns('s'), [])
  assert.deepEqual(turns('u'), [], 'the excluded app is known to run sessions, so a session whose app is not known may run in it')
  r.storage.removeExclusion('app_id', 'com.example.term')
  agents.recordHost('claude_code', 's', term, 'responsible', T0 + 5 * MIN)
  agents.apply('claude_code', turn('s', 's2', T0 + 6 * MIN))
  assert.deepEqual(turns('s'), ['s2'], 'once the app is no longer excluded, the session is recorded from when it is traced there again')
  r.close()
})

// A session, its subagent and the subagent's own subagent; only the first has an app of its own.
const chain = (at: number, tag = ''): AgentRecord[] => [
  { t: 'session', session: `p${tag}`, origin: 'interactive', parent: null, client: 'cli', dir: '/w', branch: null, at },
  { t: 'turn', key: `p${tag}:${at}`, session: `p${tag}`, dir: '/w', branch: null, opener: 'user', start: at, replayed: false },
  { t: 'session', session: `c${tag}`, origin: 'subagent', parent: `p${tag}`, client: null, dir: '/w', branch: null, at },
  { t: 'turn', key: `c${tag}:${at}`, session: `c${tag}`, dir: '/w', branch: null, opener: 'agent', start: at, replayed: false },
  { t: 'session', session: `g${tag}`, origin: 'subagent', parent: `c${tag}`, client: null, dir: '/w', branch: null, at },
  { t: 'turn', key: `g${tag}:${at}`, session: `g${tag}`, dir: '/w', branch: null, opener: 'agent', start: at, replayed: false },
]
const keys = (r: ReturnType<typeof setup>['r']) => r.q<{ turn_key: string }>('SELECT turn_key FROM agent_turns ORDER BY session_id, start_wall_ms').map((x) => x.turn_key)

test('read live, a subagent and its own subagent run where the session that started them does', () => {
  const { r, agents, turn } = setup()
  r.storage.addExclusion({ match: 'app_id', value: 'com.googlecode.iterm2', label: 'iTerm' })
  agents.recordHost('claude_code', 'p', ghostty, 'responsible', T0)
  agents.apply('claude_code', [...chain(T0 + MIN), ...turn('u', 'u1', T0 + MIN)])
  assert.deepEqual(keys(r), [`c:${T0 + MIN}`, `g:${T0 + MIN}`, `p:${T0 + MIN}`], 'the chain is in Ghostty, which is kept; the session of an unknown app is not')
  assert.equal(agents.hostAt('claude_code', 'g', T0 + MIN)?.app_id, 'com.mitchellh.ghostty')
  r.storage.addExclusion({ match: 'app_id', value: 'com.mitchellh.ghostty', label: 'Ghostty' })
  agents.apply('claude_code', chain(T0 + 2 * MIN))
  assert.deepEqual(keys(r), [`c:${T0 + MIN}`, `g:${T0 + MIN}`, `p:${T0 + MIN}`], 'once Ghostty is excluded, nothing of the chain is recorded')
  r.close()
})

test('the first read judges a subagent and its own subagent by the app of the session that started them, and an unknown app by the apps it merged', async () => {
  const { r, turn } = setup()
  r.storage.addExclusion({ match: 'app_id', value: 'com.googlecode.iterm2', label: 'iTerm' })
  const staging = path.join(r.dir, 'staging-chain.sqlite')
  const db = new Database(staging)
  const s = new AgentStore(db)
  s.recordHost('claude_code', 'p', ghostty, 'responsible', T0)
  s.apply('claude_code', [...chain(T0 + MIN), ...turn('u', 'u1', T0 + MIN)])
  db.close()
  const agents = new AgentStore(r.store.database, () => r.clock.t)
  await mergeStaging(r.store.database, staging, r.storage.agentPolicy())
  assert.deepEqual(keys(r), [`c:${T0 + MIN}`, `g:${T0 + MIN}`, `p:${T0 + MIN}`])
  assert.equal(agents.hostAt('claude_code', 'g', T0 + MIN)?.app_id, 'com.mitchellh.ghostty')
  r.close()

  const { r: r2, turn: turn2 } = setup()
  r2.storage.addExclusion({ match: 'app_id', value: 'com.example.term', label: 'Term' })
  const staging2 = path.join(r2.dir, 'staging-term.sqlite')
  const db2 = new Database(staging2)
  const s2 = new AgentStore(db2)
  s2.recordHost('claude_code', 't', { app_id: 'com.example.term', name: 'Term', path: null }, 'responsible', T0)
  s2.apply('claude_code', [...turn2('t', 't1', T0 + MIN), ...turn2('u', 'u1', T0 + MIN)])
  db2.close()
  await mergeStaging(r2.store.database, staging2, r2.storage.agentPolicy())
  assert.deepEqual(keys(r2), [], 'the merge finds an excluded app running sessions, so a session whose app is not known is held back')
  r2.close()
})

test('deleting an app reaches a subagent and its own subagent, and a subagent that ran in another app with its own subagent', async () => {
  const { r, agents } = setup()
  agents.recordHost('claude_code', 'p', ghostty, 'responsible', T0)
  agents.apply('claude_code', chain(T0 + MIN))
  agents.recordHost('claude_code', 'c2', vscode, 'responsible', T0)
  agents.apply('claude_code', [
    { t: 'session', session: 'c2', origin: 'subagent', parent: 'p', client: null, dir: '/w', branch: null, at: T0 + MIN },
    { t: 'turn', key: 'c2', session: 'c2', dir: '/w', branch: null, opener: 'agent', start: T0 + MIN, replayed: false },
    { t: 'session', session: 'g2', origin: 'subagent', parent: 'c2', client: null, dir: '/w', branch: null, at: T0 + MIN },
    { t: 'turn', key: 'g2', session: 'g2', dir: '/w', branch: null, opener: 'agent', start: T0 + MIN, replayed: false },
  ])
  assert.equal(keys(r).length, 5)
  r.clock.t = T0 + 10 * MIN
  await r.storage.deleteSource('com.mitchellh.ghostty').done
  assert.deepEqual(keys(r), [], 'every session below one the deletion reached is reached, whatever app it ran in')
  assert.deepEqual(r.q<{ session_id: string }>('SELECT session_id FROM agent_sessions ORDER BY session_id').map((x) => x.session_id), [])
  assert.deepEqual(r.q('SELECT session_id FROM agent_deleted_spans ORDER BY session_id').map((x) => (x as { session_id: string }).session_id), ['c', 'c2', 'g', 'g2', 'p'])
  r.close()
})

test('deleting an app across all time deletes the past only: what the app and its sessions do afterwards is recorded, unless the app is excluded', async () => {
  const { r, agents, turn, turns } = setup()
  const obs = (t: number, title: string) => r.store.insertObservation({
    run: 'r', seq: 0, boot: 'b', platform: 'macos', source: 's', kind: 'focus', event_wall_ms: t, event_mono_us: t * 1000, tz: 'Example/Town', tz_offset_min: -300,
    app_id: 'com.mitchellh.ghostty', app_name: 'Ghostty', app_path: '/Applications/Ghostty.app', pid: 1, window: 'w', title, title_raw: null, title_state: 'ok', state: 'ok', detail: null,
  })
  const titles = () => r.q<{ title: string }>(`SELECT title FROM observations WHERE app_id = 'com.mitchellh.ghostty' ORDER BY event_wall_ms`).map((x) => x.title)
  agents.recordHost('claude_code', 's', ghostty, 'responsible', T0)
  obs(T0 + MIN, 'before')
  agents.apply('claude_code', turn('s', 's1', T0 + MIN))
  r.clock.t = T0 + 10 * MIN
  const handle = r.storage.deleteSource('com.mitchellh.ghostty')
  await handle.done
  assert.deepEqual(r.q('SELECT from_wall_ms, to_wall_ms FROM deletions'), [{ from_wall_ms: null, to_wall_ms: T0 + 10 * MIN }], 'the tombstone ends when the app was deleted')
  assert.deepEqual([titles(), turns('s')], [[], []])

  obs(T0 + 2 * MIN, 'before, read again')
  agents.apply('claude_code', turn('s', 's1', T0 + MIN))
  assert.deepEqual([titles(), turns('s')], [[], []], 'the past is never imported again')

  r.clock.t = T0 + 11 * MIN
  obs(T0 + 11 * MIN, 'after')
  agents.apply('claude_code', turn('s', 's2', T0 + 11 * MIN))
  assert.deepEqual([titles(), turns('s')], [['after'], ['s2']], 'what the app and its session do afterwards is recorded')

  r.storage.addExclusion({ match: 'app_id', value: 'com.mitchellh.ghostty', label: 'Ghostty' })
  agents.apply('claude_code', turn('s', 's3', T0 + 12 * MIN))
  assert.deepEqual(turns('s'), ['s2'], 'once excluded, its sessions are not')
  r.close()
})

test('deleting an app for a range cuts agent work that ran in it from before the range began', async () => {
  const { r, agents } = setup()
  const H = 60 * MIN
  agents.recordHost('claude_code', 's', ghostty, 'responsible', T0)
  agents.apply('claude_code', [
    { t: 'session', session: 's', origin: 'interactive', parent: null, client: 'cli', dir: '/w', branch: null, at: T0 + H - 5 * MIN },
    { t: 'turn', key: 'k', session: 's', dir: '/w', branch: null, opener: 'user', start: T0 + H - 5 * MIN, replayed: false },
    { t: 'wait', key: 'w', session: 's', turn: 'k', reason: 'question', start: T0 + H - 2 * MIN, end: T0 + H + 5 * MIN },
    { t: 'activity', key: 'k', session: 's', at: T0 + H + 14 * MIN },
    { t: 'end', key: 'k', state: 'completed', at: T0 + H + 15 * MIN },
  ])
  r.clock.t = T0 + 2 * H
  await r.storage.deleteSource('com.mitchellh.ghostty', { from_wall_ms: T0 + H, to_wall_ms: T0 + H + 30 * MIN }).done
  assert.deepEqual(r.q('SELECT start_wall_ms, last_activity_wall_ms, end_wall_ms FROM agent_turns'), [{ start_wall_ms: T0 + H - 5 * MIN, last_activity_wall_ms: T0 + H, end_wall_ms: T0 + H }])
  assert.deepEqual(r.q('SELECT wall_ms, end_wall_ms FROM agent_events WHERE kind = ?', 'wait'), [{ wall_ms: T0 + H - 2 * MIN, end_wall_ms: T0 + H }])
  assert.deepEqual(r.q('SELECT first_wall_ms, last_wall_ms FROM agent_sessions'), [{ first_wall_ms: T0 + H - 5 * MIN, last_wall_ms: T0 + H }])
  r.close()
})

test('deleting an app for a range leaves no app, log path or read time from it, and no copy of the logs brings its work back', async () => {
  const { r, agents, turn, turns } = setup()
  const H = 60 * MIN
  const log = (session: string) => ({ path: `/logs/${session}.jsonl`, agent: 'claude_code' as const, root: '/logs', session, dev: '1', ino: session, offset: 10, size: 10, state: '{"dir":"/w"}', turnless: false, counts: emptyCounts() })
  agents.apply('claude_code', [{ t: 'client', session: 's', client: 'claude-desktop', at: T0 }, ...turn('s', 'a', T0 + MIN)])
  agents.recordHost('claude_code', 's', ghostty, 'responsible', T0 + H + 5 * MIN)
  agents.recordHost('claude_code', 'u', ghostty, 'responsible', T0 + H + MIN)
  r.clock.t = T0 + H + 20 * MIN
  agents.apply('claude_code', turn('s', 'b', T0 + H + 10 * MIN), log('s'))
  agents.apply('claude_code', turn('u', 'u1', T0 + H + 2 * MIN), log('u'))
  r.clock.t = T0 + 2 * H
  await r.storage.deleteSource('com.mitchellh.ghostty', { from_wall_ms: T0 + H, to_wall_ms: T0 + H + 30 * MIN }).done
  assert.deepEqual([turns('s'), turns('u')], [['a'], []])
  assert.deepEqual(r.q('SELECT last_wall_ms FROM agent_sessions'), [{ last_wall_ms: T0 + MIN + 1000 }], "the surviving session's span ends with the work it keeps")
  assert.deepEqual(r.q('SELECT session_id, app_id, from_wall_ms FROM agent_hosts ORDER BY from_wall_ms'), [
    { session_id: 's', app_id: 'com.anthropic.claudefordesktop', from_wall_ms: T0 },
    { session_id: 's', app_id: 'com.mitchellh.ghostty', from_wall_ms: T0 + H + 30 * MIN },
  ])
  assert.deepEqual(r.q('SELECT session_id, state, updated_wall_ms FROM agent_sources'), [{ session_id: 's', state: null, updated_wall_ms: T0 + H + 30 * MIN }])
  agents.apply('claude_code', [...turn('s', 'b', T0 + H + 10 * MIN), ...turn('u', 'u1', T0 + H + 2 * MIN)])
  assert.deepEqual([turns('s'), turns('u')], [['a'], []], 'reading the logs again brings nothing back, though the app the session then seems to be in is kept')
  const staging = path.join(r.dir, 'staging-app-range.sqlite')
  const db = new Database(staging)
  const s = new AgentStore(db)
  s.recordHost('claude_code', 'u', ghostty, 'responsible', T0 + H + MIN)
  s.apply('claude_code', [...turn('s', 'b', T0 + H + 10 * MIN), ...turn('u', 'u1', T0 + H + 2 * MIN)], log('u'))
  db.close()
  await mergeStaging(r.store.database, staging, r.storage.agentPolicy())
  assert.deepEqual([turns('s'), turns('u')], [['a'], []], 'nor does the first read of a copy of them')
  assert.deepEqual(r.q('SELECT count(*) AS n FROM agent_hosts WHERE from_wall_ms >= ? AND from_wall_ms < ?', T0 + H, T0 + H + 30 * MIN), [{ n: 0 }])
  assert.deepEqual(r.q('SELECT * FROM agent_sources WHERE session_id = ?', 'u'), [], 'nor names its log')
  r.close()
})

test('a session in an excluded app leaves no log path or read position, read live or by the first read, and its log is not read again from the start', async () => {
  const { r, agents } = setup()
  const home = tmp()
  const c = claudeCtx()
  const desktop = claudeCtx({ entrypoint: 'claude-desktop' })
  const dir = path.join(home, '.claude', 'projects', '-w-private-project')
  mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const lines = (x: typeof c, at: number, uuid: string) => [claude.prompt(x, at, 'hi', { uuid }), claude.assistant(x, at + 1000, 'end_turn')].map((l) => l + '\n').join('')
  writeFileSync(path.join(dir, `${desktop.session}.jsonl`), lines(desktop, now, 'd1'))
  r.storage.addExclusion({ match: 'app_id', value: 'com.anthropic.claudefordesktop', label: 'Claude' })
  r.storage.addExclusion({ match: 'app_id', value: 'com.mitchellh.ghostty', label: 'Ghostty' })
  const reader = new AgentReader(agents, homeRoots(home, {}), {
    reconcileMs: 3_600_000,
    followUpMs: 3_600_000,
    coalesceMs: 20,
    backfill: async (roots) => (await backfill(r.store.database, r.dir, roots, () => {}, undefined, undefined, r.storage.agentPolicy(), 'darwin')).merged,
    resolveHost: async () => ({ app: ghostty, basis: 'responsible' }),
  })
  await reader.start()
  assert.deepEqual(r.q('SELECT path FROM agent_sources'), [], 'the first read keeps no log of the excluded Claude app')
  const file = path.join(dir, `${c.session}.jsonl`)
  writeFileSync(file, lines(c, now, 'p1'))
  await new Promise((res) => setTimeout(res, 200))
  await reader.settle()
  assert.deepEqual(r.q('SELECT path FROM agent_sources'), [], 'nor does a live read of a session in excluded Ghostty')
  const before = reader.stats.bytesRead
  const more = lines(c, now + 5000, 'p2')
  appendFileSync(file, more)
  await new Promise((res) => setTimeout(res, 200))
  await reader.settle()
  await reader.stop()
  assert.equal(reader.stats.bytesRead - before, Buffer.byteLength(more), 'only what was appended is read')
  assert.deepEqual(r.q('SELECT path FROM agent_sources'), [])
  assert.equal(r.q<{ n: number }>('SELECT count(*) AS n FROM agent_turns')[0]!.n, 0)
  r.close()
})

test('excluding an app a tracked session runs in forgets its log, and what it wrote while excluded stays out once included again', async () => {
  const { r, agents, turn, turns } = setup()
  const log = { path: '/logs/s.jsonl', agent: 'claude_code' as const, root: '/logs', session: 's', dev: '1', ino: '2', offset: 10, size: 10, state: '{"dir":"/w"}', turnless: false, counts: emptyCounts() }
  agents.recordHost('claude_code', 's', ghostty, 'responsible', T0)
  agents.apply('claude_code', turn('s', 's1', T0 + MIN), log)
  assert.equal(r.q('SELECT path FROM agent_sources').length, 1)
  r.clock.t = T0 + 2 * MIN
  r.storage.addExclusion({ match: 'app_id', value: 'com.mitchellh.ghostty', label: 'Ghostty' })
  assert.deepEqual(r.q('SELECT path FROM agent_sources'), [], 'no log path or parser state of a session in the app is kept')
  agents.apply('claude_code', turn('s', 's2', T0 + 3 * MIN), { ...log, offset: 20, size: 20 })
  assert.deepEqual(r.q('SELECT path FROM agent_sources'), [])
  r.clock.t = T0 + 5 * MIN
  r.storage.removeExclusion('app_id', 'com.mitchellh.ghostty')
  agents.recordHost('claude_code', 's', ghostty, 'responsible', T0 + 6 * MIN)
  agents.apply('claude_code', [...turn('s', 's2', T0 + 3 * MIN), ...turn('s', 's3', T0 + 7 * MIN)], { ...log, offset: 30, size: 30 })
  assert.deepEqual(turns('s'), ['s1', 's3'], 'what the session did while its app was excluded is not recorded when its log is read again')
  const staging = path.join(r.dir, 'staging-excluded-then.sqlite')
  const db = new Database(staging)
  new AgentStore(db).apply('claude_code', [...turn('s', 's2', T0 + 3 * MIN), ...turn('u', 'u1', T0 + 3 * MIN), ...turn('u', 'u2', T0 + 8 * MIN)])
  db.close()
  await mergeStaging(r.store.database, staging, r.storage.agentPolicy())
  assert.deepEqual([turns('s'), turns('u')], [['s1', 's3'], ['u2']], 'nor by the first read, for its app or one not known while Ghostty was excluded')
  r.close()
})

test("deleting an app removes and refuses a session's records anywhere in the deleted range, whatever app they resolve to, and keeps no time it moved", async () => {
  const { r, agents, turn, turns } = setup()
  const H = 60 * MIN
  agents.apply('claude_code', [{ t: 'client', session: 's', client: 'claude-desktop', at: T0 }, ...turn('s', 'd1', T0 + 10 * MIN)])
  agents.recordHost('claude_code', 's', ghostty, 'responsible', T0 + H)
  agents.apply('claude_code', turn('s', 'g1', T0 + H + 10 * MIN))
  r.clock.t = T0 + 2 * H
  await r.storage.deleteSource('com.mitchellh.ghostty').done
  assert.deepEqual(r.q('SELECT app_id, from_wall_ms, to_wall_ms FROM agent_deleted_spans'), [{ app_id: 'com.mitchellh.ghostty', from_wall_ms: Number.MIN_SAFE_INTEGER, to_wall_ms: T0 + 2 * H }], 'the tombstone holds the app and the range the deletion was asked for, not when the session moved')
  agents.apply('claude_code', [...turn('s', 'd2', T0 + 30 * MIN), ...turn('s', 'g1', T0 + H + 10 * MIN), ...turn('s', 'g2', T0 + H + 40 * MIN)])
  assert.deepEqual(turns('s'), [], 'a turn from the Claude app inside the range goes, kept or read late')
  const staging = path.join(r.dir, 'staging-late.sqlite')
  const db = new Database(staging)
  new AgentStore(db).apply('claude_code', [...turn('s', 'd3', T0 + 40 * MIN), ...turn('s', 'g3', T0 + H + 20 * MIN)])
  db.close()
  await mergeStaging(r.store.database, staging, r.storage.agentPolicy())
  assert.deepEqual(turns('s'), [], 'and by the first read')
  r.close()
})

test('an app tombstone that held the times a session spent in the app becomes the range of its deletion', () => {
  const r = rig()
  const db = r.store.database
  applyMigrations(db, [agentSessionsMigration, agentSourcesTurnlessMigration, agentDeletedSessionsMigration, agentHostsMigration, agentDeletedSpansMigration, agentDeletedSpansAppMigration])
  db.prepare(`INSERT INTO deletions (kind, from_wall_ms, to_wall_ms, app_id, site, created_wall_ms, state) VALUES ('source', ?, ?, 'com.mitchellh.ghostty', NULL, ?, 'purged')`).run(T0, T0 + 120 * MIN, T0)
  db.prepare(`INSERT INTO agent_deleted_spans (agent, session_id, app_id, from_wall_ms, to_wall_ms) VALUES ('claude_code', 's', 'com.mitchellh.ghostty', ?, ?), ('claude_code', 's', 'com.mitchellh.ghostty', ?, ?), ('claude_code', 'old', '', 1, 2)`).run(T0 + 30 * MIN, T0 + 40 * MIN, T0 + 70 * MIN, T0 + 80 * MIN)
  new AgentStore(db)
  assert.deepEqual(r.q('SELECT session_id, app_id, from_wall_ms, to_wall_ms FROM agent_deleted_spans ORDER BY session_id'), [
    { session_id: 'old', app_id: '', from_wall_ms: 1, to_wall_ms: 2 },
    { session_id: 's', app_id: 'com.mitchellh.ghostty', from_wall_ms: T0, to_wall_ms: T0 + 120 * MIN },
  ])
  r.close()
})
test('an old app tombstone inside nested deletions of the app becomes the narrowest of them, never a wider one that did not reach it', () => {
  const r = rig()
  const db = r.store.database
  applyMigrations(db, [agentSessionsMigration, agentSourcesTurnlessMigration, agentDeletedSessionsMigration, agentHostsMigration, agentDeletedSpansMigration, agentDeletedSpansAppMigration])
  const del = db.prepare(`INSERT INTO deletions (kind, from_wall_ms, to_wall_ms, app_id, site, created_wall_ms, state) VALUES ('source', ?, ?, 'com.mitchellh.ghostty', NULL, ?, 'purged')`)
  del.run(T0, T0 + 100 * MIN, T0)
  del.run(T0 + 20 * MIN, T0 + 30 * MIN, T0)
  const span = db.prepare(`INSERT INTO agent_deleted_spans (agent, session_id, app_id, from_wall_ms, to_wall_ms) VALUES ('claude_code', ?, 'com.mitchellh.ghostty', ?, ?)`)
  span.run('s', T0 + 22 * MIN, T0 + 28 * MIN)
  span.run('w', T0 + 40 * MIN, T0 + 50 * MIN)
  new AgentStore(db)
  assert.deepEqual(r.q('SELECT session_id, from_wall_ms, to_wall_ms FROM agent_deleted_spans ORDER BY session_id'), [
    { session_id: 's', from_wall_ms: T0 + 20 * MIN, to_wall_ms: T0 + 30 * MIN },
    { session_id: 'w', from_wall_ms: T0, to_wall_ms: T0 + 100 * MIN },
  ])
  r.close()
})

test("a subagent read for the first time after its parent's app was deleted, or its parent deleted, is refused", async () => {
  const { r, agents, turn, turns } = setup()
  const sub = (session: string, parent: string, key: string, at: number): AgentRecord[] => [
    { t: 'session', session, origin: 'subagent', parent, client: null, dir: '/w', branch: null, at },
    { t: 'turn', key, session, dir: '/w', branch: null, opener: 'agent', start: at, replayed: false },
  ]
  agents.recordHost('claude_code', 'p', ghostty, 'responsible', T0)
  agents.apply('claude_code', turn('p', 'p1', T0 + MIN))
  agents.recordHost('claude_code', 'q', vscode, 'responsible', T0)
  agents.apply('claude_code', turn('q', 'q1', T0 + MIN))
  r.clock.t = T0 + 10 * MIN
  await r.storage.deleteSource('com.mitchellh.ghostty').done
  assert.equal(await r.storage.deleteAgentSession('claude_code', 'q'), true)
  agents.recordHost('claude_code', 'o', vscode, 'responsible', T0 + 2 * MIN)
  agents.apply('claude_code', [...sub('c', 'p', 'c1', T0 + 2 * MIN), ...sub('g', 'c', 'g1', T0 + 3 * MIN), ...sub('o', 'p', 'o1', T0 + 2 * MIN), ...sub('d', 'q', 'd1', T0 + 2 * MIN)])
  assert.deepEqual([turns('c'), turns('g'), turns('o'), turns('d')], [[], [], [], []], 'the subagent and its own subagent go, as does one with an app of its own, and one of a deleted session')
  const staging = path.join(r.dir, 'staging-sub.sqlite')
  const db = new Database(staging)
  new AgentStore(db).apply('claude_code', [...sub('c2', 'p', 'c21', T0 + 4 * MIN), ...sub('d2', 'q', 'd21', T0 + 4 * MIN)])
  db.close()
  await mergeStaging(r.store.database, staging, r.storage.agentPolicy())
  assert.deepEqual([turns('c2'), turns('d2')], [[], []], 'nor by the first read')
  r.close()
})

test('a record from before an exclusion began, read while it is in force, is kept, and the reader does not skip it later', () => {
  const { r, agents, turn, turns } = setup()
  const log = { path: '/logs/s.jsonl', agent: 'claude_code' as const, root: '/logs', session: 's', dev: '1', ino: '2', offset: 10, size: 10, state: null, turnless: false, counts: emptyCounts() }
  agents.recordHost('claude_code', 's', ghostty, 'responsible', T0)
  agents.apply('claude_code', turn('s', 's1', T0 + MIN), log)
  r.clock.t = T0 + 10 * MIN
  r.storage.addExclusion({ match: 'app_id', value: 'com.mitchellh.ghostty', label: 'Ghostty' })
  agents.apply('claude_code', [...turn('s', 's2', T0 + 5 * MIN), ...turn('s', 's3', T0 + 12 * MIN)], { ...log, offset: 20, size: 20 })
  assert.deepEqual(turns('s'), ['s1', 's2'], 'the turn from before the exclusion is kept; the one during it is not')
  r.clock.t = T0 + 20 * MIN
  r.storage.removeExclusion('app_id', 'com.mitchellh.ghostty')
  agents.recordHost('claude_code', 's', ghostty, 'responsible', T0 + 21 * MIN)
  agents.apply('claude_code', [...turn('s', 's2', T0 + 5 * MIN), ...turn('s', 's3', T0 + 12 * MIN), ...turn('s', 's4', T0 + 22 * MIN)], { ...log, offset: 30, size: 30 })
  assert.deepEqual(turns('s'), ['s1', 's2', 's4'], 'and a read from any earlier cursor gives the same answer: only time inside the exclusion is left out')
  r.close()
})
