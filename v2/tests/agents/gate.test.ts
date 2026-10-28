// Every agent row passes the same gate: records, the apps sessions ran in, parent links and log read positions, read
// live or merged by the first read, across batches, appends and depths of subagents.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { backfill, listLogs, mergeStaging, runChild, stopBackfills } from '../../capture/agents/backfill.ts'
import { DB_FILE } from '../../capture/store.ts'
import { AgentReader, homeRoots } from '../../capture/agents/reader.ts'
import { AgentStore, STAGING_FILE } from '../../capture/agents/store.ts'
import { emptyCounts, type AgentRecord } from '../../capture/agents/types.ts'
import { HOUR, MIN, rig, T0 } from '../storage/support.ts'
import { claude, claudeCtx, codex, codexCtx, run, tmp } from './fixtures.ts'
import { CodexParser } from '../../capture/agents/codex.ts'
import { forgetRange } from '../../capture/agents/gate.ts'

type Rig = ReturnType<typeof rig>

const ghostty = { app_id: 'com.mitchellh.ghostty', name: 'Ghostty', path: '/Applications/Ghostty.app' }
const vscode = { app_id: 'com.microsoft.VSCode', name: 'Code', path: '/Applications/Visual Studio Code.app' }

function policy(r: Rig) {
  return {
    withheld: () => r.storage.withheld(),
    hostAllowed: (h: Parameters<Rig['storage']['agentHostAllowed']>[0], at: number) => r.storage.agentHostAllowed(h, at),
    hostExcluded: (h: Parameters<Rig['storage']['excludesAgentHost']>[0]) => r.storage.excludesAgentHost(h),
    hostExcludedAt: (h: Parameters<Rig['storage']['agentHostExcludedAt']>[0], at: number) => r.storage.agentHostExcludedAt(h, at),
    hostRefused: (h: Parameters<Rig['storage']['agentHostRefused']>[0]) => r.storage.agentHostRefused(h),
    appDeleted: (app: string) => r.storage.agentAppDeleted(app),
  }
}

function setup() {
  const r = rig()
  // The logs come from macOS, where the Claude and Codex apps name themselves as the client.
  const agents = Object.assign(new AgentStore(r.store.database, () => r.clock.t), policy(r), { platform: 'darwin' as const })
  return { r, agents }
}

async function merge(r: Rig, staging: string): Promise<void> {
  await mergeStaging(r.store.database, staging, policy(r))
}

const session = (s: string, at: number, parent: string | null = null, client: string | null = 'cli'): AgentRecord => ({ t: 'session', session: s, origin: parent ? 'subagent' : 'interactive', parent, client, dir: '/w', branch: null, at })
const turn = (s: string, key: string, at: number): AgentRecord[] => [
  { t: 'turn', key, session: s, dir: '/w', branch: null, opener: 'user', start: at, replayed: false },
  { t: 'user', key: `${key}:u`, session: s, turn: key, act: 'prompt', basis: 'marked', at },
  { t: 'end', key, state: 'completed', at: at + 1000 },
]

const count = (r: Rig, table: string, s: string) => r.q<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE session_id = ?`, s)[0]!.n
const kept = (r: Rig, s: string) => ['agent_sessions', 'agent_turns', 'agent_events', 'agent_hosts', 'agent_sources'].map((t) => count(r, t, s))
const turns = (r: Rig, s: string) => r.q<{ turn_key: string }>('SELECT turn_key FROM agent_turns WHERE session_id = ? ORDER BY start_wall_ms', s).map((x) => x.turn_key)
const hosts = (r: Rig, s: string) => r.q('SELECT app_id, basis, from_wall_ms FROM agent_hosts WHERE session_id = ? ORDER BY from_wall_ms', s)

test('a subagent of a deleted session is refused past the batch that named its parent: the next flush and a later append', async () => {
  const { r, agents } = setup()
  const home = tmp()
  const parent = 'f1a0c3d2-0000-4000-8000-000000000001'
  assert.equal(await r.storage.deleteAgentSession('claude_code', parent), true)
  const sub = claudeCtx({ session: parent, agentId: 'a1' })
  const file = path.join(home, '.claude', 'projects', '-w', parent, 'subagents', 'agent-a1.jsonl')
  mkdirSync(path.dirname(file), { recursive: true })
  const pairs = (from: number, n: number) => Array.from({ length: n }, (_, i) => [claude.prompt(sub, T0 + (from + i) * 2000, `p${i}`), claude.assistant(sub, T0 + (from + i) * 2000 + 1000, 'end_turn')]).flat().map((l) => `${l}\n`).join('')
  // Several read chunks, each past the reader's 2,000-record flush, so only the first batch has the session record
  // that names the parent.
  writeFileSync(file, pairs(0, 2500))
  const batches: number[] = []
  const apply = agents.apply.bind(agents)
  agents.apply = (...a: Parameters<typeof apply>) => (batches.push(a[1].length), apply(...a))
  const reader = new AgentReader(agents, homeRoots(home, {}), { reconcileMs: 3_600_000, followUpMs: 3_600_000, coalesceMs: 20 })
  await reader.start()
  assert.ok(batches.length >= 3 && batches.every((n) => n >= 2000 || n === batches.at(-1)), `the log is read in several batches (${batches.join(', ')})`)
  assert.deepEqual(kept(r, 'a1'), [0, 0, 0, 0, 0], 'nothing of the subagent is kept from any batch')
  appendFileSync(file, pairs(2500, 3))
  await new Promise((res) => setTimeout(res, 200))
  await reader.settle()
  await reader.stop()
  assert.deepEqual(kept(r, 'a1'), [0, 0, 0, 0, 0], 'nor from what is appended later')
  r.close()
})

test("a deletion reaches a subagent's own subagent read before it, and the subagent's later batches, though neither link to it was stored", async () => {
  const { r, agents } = setup()
  agents.recordHost('claude_code', 'p', ghostty, 'responsible', T0)
  agents.apply('claude_code', [session('p', T0 + MIN), ...turn('p', 'p1', T0 + MIN)])
  r.clock.t = T0 + 10 * MIN
  await r.storage.deleteSource('com.mitchellh.ghostty').done
  agents.apply('claude_code', [session('g', T0 + 2 * MIN, 'c'), ...turn('g', 'g1', T0 + 2 * MIN)])
  agents.apply('claude_code', [session('c', T0 + 3 * MIN, 'p')])
  assert.deepEqual(turns(r, 'g'), [], 'the deletion reaches the subagent below, once the session between is read')
  agents.apply('claude_code', turn('c', 'c1', T0 + 4 * MIN))
  agents.apply('claude_code', turn('g', 'g2', T0 + 5 * MIN))
  assert.deepEqual([turns(r, 'c'), turns(r, 'g')], [[], []], 'later batches with no session record are refused too')
  r.clock.t = T0 + 20 * MIN
  agents.apply('claude_code', turn('c', 'c2', T0 + 15 * MIN))
  assert.deepEqual(turns(r, 'c'), ['c2'], 'what the subagent does after the deleted range is kept')
  r.close()
})

test('a session first read after its app was deleted keeps no app or time from the deleted range: traced, named by its log, or run under a deleted session', async () => {
  const { r, agents } = setup()
  agents.recordHost('claude_code', 'p', ghostty, 'responsible', T0)
  agents.apply('claude_code', [session('p', T0 + MIN), ...turn('p', 'p1', T0 + 12 * MIN)])
  r.clock.t = T0 + HOUR
  const range = { from_wall_ms: T0 + 10 * MIN, to_wall_ms: T0 + 20 * MIN }
  await r.storage.deleteSource('com.mitchellh.ghostty', range).done
  await r.storage.deleteSource('com.anthropic.claudefordesktop', range).done
  agents.recordHost('claude_code', 'late', ghostty, 'responsible', T0 + 12 * MIN)
  agents.apply('claude_code', [session('late', T0 + 12 * MIN), ...turn('late', 'l1', T0 + 12 * MIN)])
  agents.apply('claude_code', [session('desk', T0 + 12 * MIN, null, 'claude-desktop'), { t: 'client', session: 'desk', client: 'claude-desktop', at: T0 + 12 * MIN }, ...turn('desk', 'd1', T0 + 12 * MIN)])
  agents.recordHost('claude_code', 'c', vscode, 'responsible', T0 + 12 * MIN)
  agents.apply('claude_code', [session('c', T0 + 12 * MIN, 'p'), ...turn('c', 'c1', T0 + 12 * MIN)])
  for (const s of ['late', 'desk', 'c']) assert.deepEqual([hosts(r, s), turns(r, s)], [[], []], `${s} keeps no app, time or turn`)
  r.close()
})

test('the first read merges no app or time of a session from an app deletion it falls in', async () => {
  const { r } = setup()
  r.clock.t = T0 + HOUR
  await r.storage.deleteSource('com.mitchellh.ghostty', { from_wall_ms: T0 + 10 * MIN, to_wall_ms: T0 + 20 * MIN }).done
  const staging = path.join(r.dir, 'staging-late-host.sqlite')
  const db = new Database(staging)
  const s = new AgentStore(db)
  s.recordHost('claude_code', 'late', ghostty, 'responsible', T0 + 12 * MIN)
  s.apply('claude_code', [session('late', T0 + 12 * MIN), ...turn('late', 'l1', T0 + 12 * MIN)])
  db.close()
  await merge(r, staging)
  assert.deepEqual([hosts(r, 'late'), turns(r, 'late')], [[], []])
  r.close()
})

test('a session first read after an exclusion began keeps what it did in the app before then, read live or by the first read', async () => {
  for (const firstRead of [false, true]) {
    const { r, agents } = setup()
    r.clock.t = T0 + 100 * MIN
    r.storage.addExclusion({ match: 'app_id', value: 'com.mitchellh.ghostty', label: 'Ghostty' })
    r.clock.t = T0 + 120 * MIN
    const records = [session('s', T0 + 50 * MIN), ...turn('s', 'before', T0 + 50 * MIN), ...turn('s', 'during', T0 + 110 * MIN)]
    if (firstRead) {
      const staging = path.join(r.dir, 'staging-exclusion.sqlite')
      const db = new Database(staging)
      const s = new AgentStore(db)
      s.recordHost('claude_code', 's', ghostty, 'responsible', T0 + 50 * MIN)
      s.apply('claude_code', records)
      db.close()
      await merge(r, staging)
    } else {
      agents.recordHost('claude_code', 's', ghostty, 'responsible', T0 + 50 * MIN)
      agents.apply('claude_code', records)
    }
    const how = firstRead ? 'by the first read' : 'live'
    assert.deepEqual(turns(r, 's'), ['before'], `the turn from before the exclusion is kept, the one during it is not (${how})`)
    r.close()
  }
})

test('the first read lets capture run between the sessions it merges', async () => {
  const { r } = setup()
  const staging = path.join(r.dir, 'staging-yield.sqlite')
  const db = new Database(staging)
  const s = new AgentStore(db)
  for (const id of ['a', 'b', 'c']) s.apply('claude_code', [session(id, T0), ...turn(id, `${id}1`, T0)])
  db.close()
  const merged: number[] = []
  const merging = merge(r, staging)
  setImmediate(() => merged.push(r.q<{ n: number }>('SELECT count(*) AS n FROM agent_sessions')[0]!.n))
  await merging
  assert.ok(merged.length === 1 && merged[0]! > 0 && merged[0]! < 3, `capture ran with ${merged[0]} of 3 sessions merged`)
  assert.equal(r.q<{ n: number }>('SELECT count(*) AS n FROM agent_sessions')[0]!.n, 3)
  r.close()
})

test('rows the gate removes from what a session already stored are scrubbed from the files', async () => {
  const { r, agents } = setup()
  let scrubs = 0
  agents.onRemoved = () => void scrubs++
  assert.equal(await r.storage.deleteAgentSession('claude_code', 'p'), true)
  agents.apply('claude_code', [session('g', T0 + 2 * MIN, 'c'), ...turn('g', 'g1', T0 + 2 * MIN)])
  assert.equal(scrubs, 0)
  agents.apply('claude_code', [session('c', T0 + 3 * MIN, 'p')])
  assert.deepEqual([turns(r, 'g'), scrubs], [[], 1], 'a subagent stored before its parent was known to be deleted goes, and the files are scrubbed of it')
  assert.notEqual(r.store.meta('page_scrub_pending'), null)
  r.close()
})

test('a session an app deletion reaches only when its app is traced later leaves no parser state, and the files are scrubbed of it', async () => {
  const { r, agents } = setup()
  let scrubs = 0
  agents.onRemoved = () => void scrubs++
  r.clock.t = T0 + 15 * MIN
  agents.apply('claude_code', [session('s', T0)], { path: '/logs/s.jsonl', agent: 'claude_code', root: '/logs', session: 's', dev: '1', ino: '2', offset: 10, size: 10, state: '{"dir":"/w/secret-folder"}', turnless: false, counts: { lines: 1, bad: 0, unknown: 0, recognized: 1, turns: 0, orphan: 0 } })
  r.clock.t = T0 + HOUR
  await r.storage.deleteSource('com.mitchellh.ghostty', { from_wall_ms: T0 + 10 * MIN, to_wall_ms: T0 + 20 * MIN }).purged
  assert.equal(r.store.meta('page_scrub_pending'), null)
  agents.recordHost('claude_code', 's', ghostty, 'responsible', T0 + 15 * MIN)
  assert.deepEqual(r.q('SELECT state, updated_wall_ms FROM agent_sources'), [{ state: null, updated_wall_ms: T0 + 20 * MIN }])
  assert.equal(scrubs, 1)
  assert.notEqual(r.store.meta('page_scrub_pending'), null)
  r.close()
})

test("a fork's copy of a deleted session's turns is not written again, under any session, while the fork's own work is", async () => {
  for (const how of ['session', 'app'] as const) {
    const { r, agents } = setup()
    const k = '0b7f1c2e-1111-4a2b-8c3d-4e5f60718293'
    agents.recordHost('codex', 's', ghostty, 'responsible', T0)
    agents.apply('codex', [session('s', T0 + MIN), ...turn('s', k, T0 + MIN)])
    r.clock.t = T0 + 10 * MIN
    if (how === 'session') assert.equal(await r.storage.deleteAgentSession('codex', 's'), true)
    else await r.storage.deleteSource('com.mitchellh.ghostty', { from_wall_ms: T0, to_wall_ms: T0 + 10 * MIN }).done
    agents.recordHost('codex', 'f', vscode, 'responsible', T0)
    const copied: AgentRecord[] = [
      { t: 'turn', key: k, session: 'f', dir: '/w', branch: null, opener: 'user', start: T0 + MIN, replayed: true },
      { t: 'user', key: `${k}:u`, session: 'f', turn: k, act: 'prompt', basis: 'marked', at: T0 + MIN },
    ]
    agents.apply('codex', [session('f', T0 + 12 * MIN), ...copied, ...turn('f', 'f-own', T0 + 12 * MIN)])
    assert.deepEqual(r.q<{ turn_key: string }>('SELECT turn_key FROM agent_turns ORDER BY turn_key').map((x) => x.turn_key), ['f-own'], how)
    assert.deepEqual(r.q<{ event_key: string }>('SELECT event_key FROM agent_events ORDER BY event_key').map((x) => x.event_key), ['f-own:u'], how)
    r.close()
  }
})

test('a log read keeps no parser state from lines written in refused time, though they made no record', async () => {
  const { r, agents } = setup()
  const home = tmp()
  const c = claudeCtx()
  const file = path.join(home, '.claude', 'projects', '-w', `${c.session}.jsonl`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, [claude.prompt(c, T0, 'go'), claude.assistant(c, T0 + 1000, 'end_turn')].map((l) => `${l}\n`).join(''))
  const reader = new AgentReader(agents, homeRoots(home, {}), { reconcileMs: 3_600_000, followUpMs: 3_600_000, coalesceMs: 20 })
  await reader.start()
  const state = () => r.q<{ state: string | null }>('SELECT state FROM agent_sources')[0]?.state ?? null
  assert.notEqual(state(), null)
  r.clock.t = T0 + 10 * MIN
  r.storage.pause(T0 + 20 * MIN)
  appendFileSync(file, `${claude.queue(c, T0 + 15 * MIN, 'enqueue', 'a message queued while paused')}\n`)
  await new Promise((res) => setTimeout(res, 200))
  await reader.settle()
  await reader.stop()
  assert.equal(state(), null, 'the queued message, from inside the pause, leaves no trace in the saved parser state')
  r.close()
})

test("the first read's staging copy never holds a deleted session or one in an excluded app", async () => {
  const { r } = setup()
  const home = tmp()
  const gone = claudeCtx()
  const desk = claudeCtx({ entrypoint: 'claude-desktop' })
  const kept = claudeCtx()
  const dir = path.join(home, '.claude', 'projects', '-w')
  mkdirSync(dir, { recursive: true })
  for (const c of [gone, desk, kept]) writeFileSync(path.join(dir, `${c.session}.jsonl`), [claude.prompt(c, T0, 'go'), claude.assistant(c, T0 + 1000, 'end_turn')].map((l) => `${l}\n`).join(''))
  const roots = homeRoots(home, {})
  const read = async (name: string) => {
    r.store.flush()
    const staging = path.join(r.dir, name)
    assert.ok(await runChild(staging, roots, await listLogs(roots), 4 << 20, () => {}, path.join(r.dir, DB_FILE)))
    const db = new Database(staging, { readonly: true })
    const named = (s: string) => ['agent_sessions', 'agent_turns', 'agent_events', 'agent_sources'].map((t) => (db.prepare(`SELECT count(*) AS n FROM ${t} WHERE session_id = ?`).get(s) as { n: number }).n)
    const out = { gone: named(gone.session), desk: named(desk.session), kept: named(kept.session), apps: db.prepare('SELECT app_id FROM agent_hosts WHERE app_id IS NOT NULL').all() }
    db.close()
    return out
  }
  assert.equal(await r.storage.deleteAgentSession('claude_code', gone.session), true)
  const deleted = await read('staging-deleted.sqlite')
  assert.deepEqual(deleted.gone, [0, 0, 0, 0], 'the deleted session')
  assert.deepEqual(deleted.kept, [1, 1, 1, 1], 'while another session is read')
  r.storage.addExclusion({ match: 'app_id', value: 'com.anthropic.claudefordesktop', label: 'Claude' })
  const excluded = await read('staging-excluded.sqlite')
  assert.deepEqual(excluded.desk, [0, 0, 0, 0], 'the session in the excluded app')
  assert.deepEqual(excluded.apps, [], 'nor is the excluded app named')
  r.close()
})

test("a Claude Code subagent's log keeps its read position and parser state, so a reply read later ends the turn it answers", async () => {
  const { r, agents } = setup()
  const home = tmp()
  const parent = 'f1a0c3d2-0000-4000-8000-0000000000aa'
  // As Claude Code writes them: the file is named agent-<id>, the records carry the id alone.
  const sub = claudeCtx({ session: parent, agentId: 'a7' })
  const file = path.join(home, '.claude', 'projects', '-w', parent, 'subagents', 'agent-a7.jsonl')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${claude.prompt(sub, T0, 'look into it', { uuid: 'sub-p1' })}\n`)
  const reader = new AgentReader(agents, homeRoots(home, {}), { reconcileMs: 3_600_000, followUpMs: 3_600_000, coalesceMs: 20 })
  await reader.start()
  await reader.stop()
  assert.equal(r.q<{ n: number }>(`SELECT count(*) AS n FROM agent_sources WHERE session_id = 'a7'`)[0]!.n, 1, 'the log is named by the session its records belong to')
  appendFileSync(file, `${claude.assistant(sub, T0 + 5000, 'end_turn')}\n${claude.system(sub, T0 + 5100, 'turn_duration')}\n`)
  const again = new AgentReader(agents, homeRoots(home, {}), { reconcileMs: 3_600_000, followUpMs: 3_600_000, coalesceMs: 20 })
  await again.start()
  await again.stop()
  assert.deepEqual(r.q('SELECT turn_key, end_state, end_wall_ms FROM agent_turns'), [{ turn_key: 'sub-p1', end_state: 'completed', end_wall_ms: T0 + 5100 }])
  r.close()
})

test('parser state refused in one batch of a read is not written back by a later batch of it', async () => {
  const { r, agents } = setup()
  const home = tmp()
  const c = claudeCtx()
  const file = path.join(home, '.claude', 'projects', '-w', `${c.session}.jsonl`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${claude.prompt(c, T0, 'go')}\n${claude.assistant(c, T0 + 1000, 'end_turn')}\n`)
  const batches: number[][] = []
  const apply = agents.apply.bind(agents)
  agents.apply = (...a: Parameters<typeof apply>) => (batches.push(a[1].map((x) => ('at' in x && typeof x.at === 'number' ? x.at : 'start' in x ? x.start : 0))), apply(...a))
  const read = async () => {
    const reader = new AgentReader(agents, homeRoots(home, {}), { reconcileMs: 3_600_000, followUpMs: 3_600_000, coalesceMs: 20 })
    await reader.start()
    await reader.stop()
  }
  await read()
  r.clock.t = T0 + 10 * MIN
  r.storage.pause(T0 + 20 * MIN)
  r.clock.t = T0 + 30 * MIN
  // Lines from inside the pause fill exactly two read chunks, so the batches that hold them end there; the lines after
  // the pause are a batch of their own.
  const paused = [`${claude.queue(c, T0 + 15 * MIN, 'enqueue', 'queued while paused')}\n`]
  for (let i = 0; i < 1600; i++) paused.push(`${claude.prompt(c, T0 + 15 * MIN + i * 100, `p${i}`)}\n${claude.assistant(c, T0 + 15 * MIN + i * 100 + 50, 'end_turn')}\n`)
  const size = Buffer.byteLength(paused.join(''))
  assert.ok(size < 2 * 1024 * 1024 - 4000, `${size}`)
  paused.push(`${claude.system(c, T0 + 19 * MIN, 'away_summary', { content: 'x'.repeat(2 * 1024 * 1024 - size - 2000) })}\n`)
  const body = paused.join('')
  const pad = 2 * 1024 * 1024 - Buffer.byteLength(body)
  appendFileSync(file, body.replace(/x{1000,}"/, (m) => `${'x'.repeat(m.length - 1 + pad)}"`))
  appendFileSync(file, `${claude.prompt(c, T0 + 25 * MIN, 'after')}\n${claude.assistant(c, T0 + 25 * MIN + 1000, 'end_turn')}\n`)
  batches.length = 0
  await read()
  assert.ok(batches.length >= 3 && batches.at(-1)!.length < 10, `the lines after the pause are a batch of their own (${batches.map((b) => b.length).join(', ')})`)
  const state = r.q<{ state: string | null }>('SELECT state FROM agent_sources')[0]!.state
  assert.ok(state === null || !state.includes(String(T0 + 15 * MIN)), `no state from inside the pause: ${state?.slice(0, 160)}`)
  r.close()
})

test('a deletion made while the reader traces a log keeps it from restoring the parser state it cleared', async () => {
  const { r, agents } = setup()
  const home = tmp()
  const c = claudeCtx({ cwd: '/w/folder-before' })
  const file = path.join(home, '.claude', 'projects', '-w', `${c.session}.jsonl`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${claude.prompt(c, T0, 'go')}\n${claude.queue(c, T0 + 30_000, 'enqueue', 'queued in the deleted range')}\n`)
  let deleteNow = false
  const reader = () =>
    new AgentReader(agents, homeRoots(home, {}), {
      reconcileMs: 3_600_000,
      followUpMs: 3_600_000,
      coalesceMs: 20,
      resolveHost: async () => {
        if (deleteNow) await r.storage.deleteRange(T0 - MIN, T0 + MIN).done
        return null
      },
    })
  const first = reader()
  await first.start()
  await first.stop()
  assert.ok(r.q<{ state: string }>('SELECT state FROM agent_sources')[0]!.state.includes(String(T0 + 30_000)))
  r.clock.t = T0 + 30 * MIN
  appendFileSync(file, `${claude.prompt({ ...c, cwd: '/w/folder-after' }, T0 + 20 * MIN, 'again')}\n`)
  deleteNow = true
  const second = reader()
  await second.start()
  await second.stop()
  const state = r.q<{ state: string | null }>('SELECT state FROM agent_sources')[0]?.state ?? null
  assert.ok(state === null || !state.includes(String(T0 + 30_000)), `the cleared state is not restored: ${state?.slice(0, 160)}`)
  r.close()
})

test("a fork's copy of a turn its source never stored goes with the source's deletion, read before it or after", async () => {
  const k = '0b7f1c2e-2222-4a2b-8c3d-4e5f60718293'
  const copied = (s: string): AgentRecord[] => [
    { t: 'turn', key: k, session: s, dir: '/w', branch: null, opener: 'user', start: T0 + 2 * MIN, replayed: true, source: 'src' },
    { t: 'user', key: `${k}:u1`, session: s, turn: k, act: 'prompt', basis: 'marked', at: T0 + 2 * MIN, source: 'src' },
  ]
  for (const order of ['deleted first', 'fork read first', 'app deletion'] as const) {
    const { r, agents } = setup()
    agents.recordHost('codex', 'src', ghostty, 'responsible', T0)
    agents.apply('codex', [session('src', T0 + MIN), ...turn('src', 'src-a', T0 + MIN)])
    agents.recordHost('codex', 'fork', vscode, 'responsible', T0)
    const del = async () => {
      r.clock.t = T0 + 10 * MIN
      if (order === 'app deletion') await r.storage.deleteSource('com.mitchellh.ghostty', { from_wall_ms: T0, to_wall_ms: T0 + 10 * MIN }).done
      else assert.equal(await r.storage.deleteAgentSession('codex', 'src'), true)
    }
    if (order !== 'fork read first') await del()
    agents.apply('codex', [session('fork', T0 + 12 * MIN), ...copied('fork'), ...turn('fork', 'fork-own', T0 + 12 * MIN)])
    if (order === 'fork read first') await del()
    agents.apply('codex', copied('fork'))
    assert.deepEqual(r.q<{ turn_key: string }>('SELECT turn_key FROM agent_turns ORDER BY turn_key').map((x) => x.turn_key), ['fork-own'], order)
    assert.deepEqual(r.q<{ event_key: string }>('SELECT event_key FROM agent_events ORDER BY event_key').map((x) => x.event_key), ['fork-own:u'], order)
    r.close()
  }
})

test("a deletion made while the first read runs is done only once the first read's staging copy is gone", async () => {
  const { r } = setup()
  r.storage.onDeleted = () => stopBackfills()
  const home = tmp()
  const dir = path.join(home, '.claude', 'projects', '-w')
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < 80; i++) {
    const c = claudeCtx()
    writeFileSync(path.join(dir, `${c.session}.jsonl`), Array.from({ length: 20 }, (_, k) => `${claude.prompt(c, T0 + i * MIN + k * 1000, `p${k}`)}\n${claude.assistant(c, T0 + i * MIN + k * 1000 + 500, 'end_turn')}\n`).join(''))
  }
  const staging = path.join(r.dir, STAGING_FILE)
  const logs: string[] = []
  const running = backfill(r.store.database, r.dir, homeRoots(home, {}), (m) => logs.push(m), 8192, undefined, policy(r))
  const staged = () => {
    if (!existsSync(staging)) return 0
    try {
      const db = new Database(staging, { readonly: true, fileMustExist: true })
      try {
        return (db.prepare('SELECT count(*) AS n FROM agent_turns').get() as { n: number }).n
      } finally {
        db.close()
      }
    } catch {
      return 0
    }
  }
  for (const until = Date.now() + 10_000; staged() === 0; ) {
    assert.ok(Date.now() < until, 'the first read staged something')
    await new Promise((res) => setTimeout(res, 10))
  }
  r.clock.t = T0 + 2 * HOUR
  await r.storage.deleteRange(T0, T0 + 2 * HOUR).done
  assert.equal(existsSync(staging), false, 'no staging copy is left once the deletion is done')
  assert.equal((await running).merged, false)
  assert.equal(r.q<{ n: number }>('SELECT count(*) AS n FROM agent_turns')[0]!.n, 0)
  r.close()
})

test("a fork of a fork's copy of a turn its first source never stored goes with that source's deletion", async () => {
  const { r, agents } = setup()
  const [s, f, g] = [codexCtx(), codexCtx(), codexCtx()]
  const [read, unread, fOwn, gOwn] = ['0b7f1c2e-3333-4a2b-8c3d-4e5f60718201', '0b7f1c2e-3333-4a2b-8c3d-4e5f60718202', '0b7f1c2e-3333-4a2b-8c3d-4e5f60718203', '0b7f1c2e-3333-4a2b-8c3d-4e5f60718204']
  agents.apply('codex', run(new CodexParser(s.id, null), [codex.meta(s, T0), codex.started(T0 + MIN, read, 'composer'), codex.complete(T0 + 2 * MIN, read, T0 + MIN)]))
  r.clock.t = T0 + 30 * MIN
  assert.equal(await r.storage.deleteAgentSession('codex', s.id), true)
  agents.apply('codex', run(new CodexParser(g.id, null), [
    codex.meta(g, T0 + 40 * MIN, { forkedFrom: f.id }),
    codex.meta(f, T0 + 40 * MIN, { forkedFrom: s.id, started: T0 + 20 * MIN }),
    codex.meta(s, T0 + 40 * MIN, { started: T0 }),
    codex.started(T0 + 40 * MIN, unread, 'composer', T0 + 5 * MIN),
    codex.complete(T0 + 40 * MIN, unread, T0 + 5 * MIN, T0 + 6 * MIN),
    codex.started(T0 + 40 * MIN, fOwn, 'composer', T0 + 21 * MIN),
    codex.complete(T0 + 40 * MIN, fOwn, T0 + 21 * MIN, T0 + 22 * MIN),
    codex.started(T0 + 41 * MIN, gOwn, 'composer'),
    codex.complete(T0 + 42 * MIN, gOwn, T0 + 41 * MIN),
  ]))
  assert.deepEqual(r.q<{ turn_key: string }>('SELECT turn_key FROM agent_turns ORDER BY start_wall_ms').map((x) => x.turn_key), [fOwn, gOwn])
  r.close()
})

test("an app deletion cuts a fork's copy of a turn that runs into it, and reading the copy again keeps it cut", async () => {
  const { r, agents } = setup()
  const k = '0b7f1c2e-4444-4a2b-8c3d-4e5f60718201'
  agents.recordHost('codex', 'src', ghostty, 'responsible', T0)
  agents.apply('codex', [session('src', T0), ...turn('src', 'src-a', T0)])
  agents.recordHost('codex', 'fork', vscode, 'responsible', T0)
  const copied: AgentRecord[] = [
    session('fork', T0 + 30 * MIN),
    { t: 'turn', key: k, session: 'fork', dir: '/w', branch: null, opener: 'user', start: T0 + 5 * MIN, replayed: true, source: 'src' },
    { t: 'end', key: k, state: 'completed', at: T0 + 15 * MIN },
  ]
  agents.apply('codex', copied)
  r.clock.t = T0 + 40 * MIN
  await r.storage.deleteSource('com.mitchellh.ghostty', { from_wall_ms: T0 + 10 * MIN, to_wall_ms: T0 + 20 * MIN }).done
  const copy = () => r.q<{ end_wall_ms: number | null; last_activity_wall_ms: number }>('SELECT end_wall_ms, last_activity_wall_ms FROM agent_turns WHERE turn_key = ?', k)[0]!
  assert.ok((copy().end_wall_ms ?? 0) <= T0 + 10 * MIN, `the copy ends where the deleted range begins: ${copy().end_wall_ms}`)
  agents.apply('codex', copied)
  assert.ok((copy().end_wall_ms ?? 0) <= T0 + 10 * MIN, `reading the copy again keeps it cut: ${copy().end_wall_ms}`)
  r.close()
})

test("a fork's log keeps no parser state once the session its copies came from is deleted, whole or by its app", async () => {
  for (const order of ['session', 'session, original read first', 'app, copy inside', 'app, original read first', 'app, copy crossing', 'app, original read first, crossing'] as const) {
    const { r, agents } = setup()
    const k = '0b7f1c2e-5555-4a2b-8c3d-4e5f60718201'
    agents.recordHost('codex', 'src', ghostty, 'responsible', T0)
    const first = order.includes('original read first')
    const at = order.endsWith('crossing') ? T0 + 5 * MIN : T0 + 12 * MIN
    const original = first ? turn('src', k, at).map((x) => (x.t === 'end' ? { ...x, at: T0 + 15 * MIN } : x)) : turn('src', 'src-a', T0)
    agents.apply('codex', [session('src', T0), ...original])
    agents.recordHost('codex', 'fork', vscode, 'responsible', T0)
    const start = at
    const log = { path: '/logs/fork.jsonl', agent: 'codex' as const, root: '/logs', session: 'fork', dev: '1', ino: '2', offset: 10, size: 10, state: `{"turn":{"key":"${k}","start":${start}}}`, turnless: false, counts: emptyCounts() }
    agents.apply('codex', [session('fork', T0 + 30 * MIN), { t: 'turn', key: k, session: 'fork', dir: '/w', branch: null, opener: 'user', start, replayed: true, source: 'src' }, { t: 'activity', key: k, session: 'fork', at: T0 + 15 * MIN }], log)
    assert.ok(r.q<{ state: string | null }>('SELECT state FROM agent_sources')[0]!.state?.includes(k), order)
    r.clock.t = T0 + 40 * MIN
    if (order.startsWith('session')) assert.equal(await r.storage.deleteAgentSession('codex', 'src'), true)
    else await r.storage.deleteSource('com.mitchellh.ghostty', { from_wall_ms: T0 + 10 * MIN, to_wall_ms: T0 + 20 * MIN }).done
    assert.deepEqual(r.q('SELECT session_id, state FROM agent_sources'), [{ session_id: 'fork', state: null }], order)
    r.close()
  }
})

test('a deletion that clears parser state while a read waits on its log is not undone by that read', async () => {
  const { r, agents } = setup()
  const home = tmp()
  const c = claudeCtx()
  const file = path.join(home, '.claude', 'projects', '-w', `${c.session}.jsonl`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${claude.prompt(c, T0, 'go')}\n${claude.queue(c, T0 + 30_000, 'enqueue', 'queued in the deleted range')}\n`)
  const read = async () => {
    const reader = new AgentReader(agents, homeRoots(home, {}), { reconcileMs: 3_600_000, followUpMs: 3_600_000, coalesceMs: 20 })
    await reader.start()
    await reader.stop()
  }
  await read()
  assert.ok(r.q<{ state: string }>('SELECT state FROM agent_sources')[0]!.state.includes(String(T0 + 30_000)))
  r.clock.t = T0 + 30 * MIN
  appendFileSync(file, `${claude.prompt(c, T0 + 20 * MIN, 'again')}\n`)
  // The parser is built from the stored state; the deletion's cleanup commits before the read reaches its first batch.
  const key = agents.fingerprintKey.bind(agents)
  agents.fingerprintKey = () => {
    agents.fingerprintKey = key
    forgetRange(r.store.database, 'claude_code', c.session, T0 - MIN, T0 + MIN)
    return key()
  }
  await read()
  const state = r.q<{ state: string | null }>('SELECT state FROM agent_sources')[0]?.state ?? null
  assert.ok(state === null || !state.includes(String(T0 + 30_000)), `the cleared state is not restored: ${state?.slice(0, 160)}`)
  r.close()
})

test('a turn or wait does not stretch across a pause or past exclusion of the app it ran in', async () => {
  for (const by of ['pause', 'exclusion'] as const) {
    const { r, agents } = setup()
    agents.recordHost('codex', 's', ghostty, 'responsible', T0)
    agents.apply('codex', [session('s', T0), { t: 'turn', key: 'k', session: 's', dir: '/w', branch: null, opener: 'user', start: T0 + MIN, replayed: false }, { t: 'activity', key: 'k', session: 's', at: T0 + 5 * MIN }])
    r.clock.t = T0 + 10 * MIN
    if (by === 'pause') r.storage.pauseApp('com.mitchellh.ghostty', T0 + 20 * MIN)
    else r.storage.addExclusion({ match: 'app_id', value: 'com.mitchellh.ghostty', label: 'Ghostty' })
    r.clock.t = T0 + 20 * MIN
    if (by === 'exclusion') r.storage.removeExclusion('app_id', 'com.mitchellh.ghostty')
    r.clock.t = T0 + 30 * MIN
    agents.apply('codex', [{ t: 'activity', key: 'k', session: 's', at: T0 + 25 * MIN }, { t: 'wait', key: 'w', session: 's', turn: 'k', reason: 'api_error', start: T0 + 6 * MIN, end: T0 + 25 * MIN }])
    assert.deepEqual(r.q('SELECT last_activity_wall_ms AS last FROM agent_turns'), [{ last: T0 + 5 * MIN }], by)
    assert.deepEqual(r.q('SELECT end_wall_ms AS e FROM agent_events WHERE event_key = ?', 'w'), [{ e: T0 + 10 * MIN }], by)
    r.close()
  }
})

test('a log read keeps no parser state from lines written while the app it ran in was excluded, though they made no record', async () => {
  const { r, agents } = setup()
  const home = tmp()
  const c = claudeCtx()
  const file = path.join(home, '.claude', 'projects', '-w', `${c.session}.jsonl`)
  mkdirSync(path.dirname(file), { recursive: true })
  agents.recordHost('claude_code', c.session, ghostty, 'responsible', T0)
  r.clock.t = T0 + 10 * MIN
  r.storage.addExclusion({ match: 'app_id', value: 'com.mitchellh.ghostty', label: 'Ghostty' })
  r.clock.t = T0 + 20 * MIN
  r.storage.removeExclusion('app_id', 'com.mitchellh.ghostty')
  r.clock.t = T0 + 30 * MIN
  writeFileSync(file, [claude.prompt(c, T0, 'go'), claude.assistant(c, T0 + 1000, 'end_turn'), claude.queue(c, T0 + 15 * MIN, 'enqueue', 'queued while excluded'), claude.system(c, T0 + 25 * MIN, 'away_summary', { content: 'x' })].map((l) => `${l}\n`).join(''))
  const reader = new AgentReader(agents, homeRoots(home, {}), { reconcileMs: 3_600_000, followUpMs: 3_600_000, coalesceMs: 20 })
  await reader.start()
  await reader.stop()
  const state = r.q<{ state: string | null }>('SELECT state FROM agent_sources')[0]?.state ?? null
  assert.ok(state === null || !state.includes(String(T0 + 15 * MIN)), `no state from while the app was excluded: ${state?.slice(0, 160)}`)
  r.close()
})

test("a deletion is announced done and purged only once the first read's staging copy is gone", async () => {
  const { r } = setup()
  let release!: () => void
  r.storage.onDeleted = () => new Promise<void>((res) => (release = res))
  r.clock.t = T0 + 2 * HOUR
  const h = r.storage.deleteRange(T0, T0 + HOUR)
  const row = () => r.q<{ state: string; announced: string | null }>('SELECT state, announced FROM deletions WHERE id = ?', h.tombstone)[0]!
  for (const until = Date.now() + 10_000; row().state === 'pending'; ) {
    assert.ok(Date.now() < until, 'the deletion ran')
    await new Promise((res) => setTimeout(res, 10))
  }
  await new Promise((res) => setTimeout(res, 100))
  assert.equal(row().announced, null, 'nothing is announced while the staging copy may still hold what was deleted')
  release()
  await h.done
  await h.purged
  assert.equal(row().announced, 'purged')
  r.close()
})
