import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { backfill, mergeStaging } from '../../capture/agents/backfill.ts'
import { ClaudeParser } from '../../capture/agents/claude.ts'
import { AgentReader, homeRoots } from '../../capture/agents/reader.ts'
import { AgentStore } from '../../capture/agents/store.ts'
import { emptyCounts, type AgentRecord } from '../../capture/agents/types.ts'
import { rig, MIN, T0 } from '../storage/support.ts'
import { claude, claudeCtx, of, run, tmp } from './fixtures.ts'

const ghostty = { app_id: 'com.mitchellh.ghostty', name: 'Ghostty', path: '/Applications/Ghostty.app' }
const vscode = { app_id: 'com.microsoft.VSCode', name: 'Code', path: '/Applications/Visual Studio Code.app' }

function setup() {
  const r = rig()
  const agents = new AgentStore(r.store.database, () => r.clock.t)
  agents.withheld = () => r.storage.withheld()
  agents.hostAllowed = (host, at) => r.storage.agentHostAllowed(host, at)
  agents.hostExcluded = (host) => r.storage.excludesAgentHost(host)
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

test('deleting an app removes the sessions known to have run in it, for that time only, and offers the unknown ones', async () => {
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
  assert.deepEqual(turns('s3'), ['s3a'], 'the part resumed in the Claude app stays')
  assert.deepEqual(turns('u'), ['u1'], 'a session whose app is not known is not deleted by default')
  agents.apply('claude_code', turn('s1', 's1a', T0 + MIN))
  assert.deepEqual(turns('s1'), [], 'reading the log again does not bring it back')
  assert.equal(await r.storage.deleteAgentSession('claude_code', 'u'), true)
  assert.deepEqual(turns('u'), [])
  r.close()
})

test('a session resumed in another app moves to it, and an unknown client never hides a traced app', () => {
  const { r, agents } = setup()
  agents.apply('claude_code', [{ t: 'client', session: 's', client: 'claude-desktop', at: T0 }])
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
  assert.deepEqual(r.q(`SELECT app_id, app_name, app_path, basis FROM agent_hosts WHERE session_id = ?`, c.session), [{ app_id: null, app_name: null, app_path: null, basis: 'excluded' }])
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
    backfill: async (roots) => (merged = (await backfill(r.store.database, r.dir, roots, () => {}, undefined, undefined, () => r.storage.withheld(), agents)).merged),
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
  mergeStaging(r.store.database, staging, r.storage.withheld(), { hostAllowed: (h, at) => r.storage.agentHostAllowed(h, at), hostExcluded: (h) => r.storage.excludesAgentHost(h) })
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
  mergeStaging(r2.store.database, staging2, r2.storage.withheld(), { hostAllowed: (h, at) => r2.storage.agentHostAllowed(h, at), hostExcluded: (h) => r2.storage.excludesAgentHost(h) })
  assert.deepEqual(keys(r2), [], 'the merge finds an excluded app running sessions, so a session whose app is not known is held back')
  r2.close()
})

test('deleting an app reaches a subagent and its own subagent, but not a subagent that ran in another app, nor its subagent', async () => {
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
  assert.deepEqual(keys(r), ['c2', 'g2'])
  assert.deepEqual(r.q<{ session_id: string }>('SELECT session_id FROM agent_sessions ORDER BY session_id').map((x) => x.session_id), ['c2', 'g2'])
  r.close()
})
