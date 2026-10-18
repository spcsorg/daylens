import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { backfill, listLogs, runChild } from '../../capture/agents/backfill.ts'
import { AgentReader, classifyFile, homeRoots, type AgentRoot } from '../../capture/agents/reader.ts'
import { AgentStore, agentSessionsMigration, applyMigrations, summarizeHealth } from '../../capture/agents/store.ts'
import { Store } from '../../capture/store.ts'
import { claude, claudeCtx, codex, codexCtx, sec, tmp } from './fixtures.ts'

interface Rig {
  home: string
  data: string
  store: Store
  agents: AgentStore
  roots: AgentRoot[]
  reader: (opts?: ConstructorParameters<typeof AgentReader>[2]) => AgentReader
  count: (sql: string, ...p: unknown[]) => number
}

function rig(): Rig {
  const home = tmp()
  const data = tmp()
  const store = new Store(data)
  const agents = new AgentStore(store.database)
  const roots = homeRoots(home, {})
  return {
    home,
    data,
    store,
    agents,
    roots,
    reader: (opts = {}) => new AgentReader(agents, roots, { reconcileMs: 3_600_000, followUpMs: 3_600_000, coalesceMs: 20, ...opts }),
    count: (sql, ...p) => (store.query<{ n: number }>(sql, ...p)[0]?.n ?? 0),
  }
}

function claudeFile(home: string, c: { session: string }, project = '-home-me-code-project-alpha'): string {
  const dir = path.join(home, '.claude', 'projects', project)
  mkdirSync(dir, { recursive: true })
  return path.join(dir, `${c.session}.jsonl`)
}

function codexFile(home: string, c: { id: string }): string {
  const dir = path.join(home, '.codex', 'sessions', '2026', '10', '14')
  mkdirSync(dir, { recursive: true })
  return path.join(dir, `rollout-2026-10-14T20-00-00-${c.id}.jsonl`)
}

const lines = (...ls: string[]) => ls.map((l) => `${l}\n`).join('')

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting for the reader')
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('only complete lines are read, and each later read starts where the last one stopped', async () => {
  const r = rig()
  const c = claudeCtx()
  const file = claudeFile(r.home, c)
  const first = lines(claude.prompt(c, sec(0), 'go', { uuid: 'p1' }), claude.assistant(c, sec(5), 'tool_use', { tools: [{ id: 't', name: 'Bash' }] }))
  const finish = claude.assistant(c, sec(40), 'end_turn')
  writeFileSync(file, first + finish.slice(0, 50))
  // A file watcher can miss a write made while it starts; the one follow-up check catches it.
  const reader = r.reader({ followUpMs: 200 })
  await reader.start()
  assert.equal(r.count('SELECT count(*) AS n FROM agent_turns WHERE end_state IS NULL'), 1)
  assert.equal(r.agents.source(file)!.offset, Buffer.byteLength(first))
  const before = reader.stats.bytesRead
  appendFileSync(file, `${finish.slice(50)}\n${claude.system(c, sec(41), 'turn_duration')}\n`)
  await waitFor(() => r.count(`SELECT count(*) AS n FROM agent_turns WHERE end_state = 'completed'`) === 1)
  // The second read covers the partial line and what followed it, nothing earlier.
  assert.equal(reader.stats.bytesRead - before, readFileSync(file).length - Buffer.byteLength(first))
  await reader.stop()
  assert.equal(r.store.query<{ last_activity_wall_ms: number }>('SELECT last_activity_wall_ms FROM agent_turns')[0]!.last_activity_wall_ms, sec(40))
  r.store.close()
})

test('a watched folder is never listed again; only the follow-up check after start looks at it', async () => {
  const r = rig()
  const c = codexCtx()
  const file = codexFile(r.home, c)
  writeFileSync(file, lines(codex.meta(c, sec(0))))
  const reader = r.reader({ reconcileMs: 50, followUpMs: 3_600_000 })
  await reader.start()
  // The Claude Code and archive folders do not exist, so the timer keeps looking for them; the watched one is left alone.
  const listed = reader.stats.listings
  assert.equal(listed, 1)
  await new Promise((res) => setTimeout(res, 400))
  assert.equal(reader.stats.listings, listed)
  await reader.stop()
  r.store.close()
})

test('reading is driven by file events, not by rescanning folders', async () => {
  const r = rig()
  const c = codexCtx()
  const file = codexFile(r.home, c)
  writeFileSync(file, lines(codex.meta(c, sec(0))))
  const reader = r.reader({ reconcileMs: 3_600_000 })
  await reader.start()
  // File events start flowing shortly after the watcher is created.
  await new Promise((res) => setTimeout(res, 300))
  const reads = reader.stats.filesRead
  appendFileSync(file, lines(codex.started(sec(1), 't', 'composer'), codex.userItem(sec(1), 'go', ['user.text'])))
  await waitFor(() => r.count('SELECT count(*) AS n FROM agent_events') === 1)
  assert.equal(reader.stats.filesRead, reads + 1)
  // A new session file appearing is noticed the same way.
  const c2 = codexCtx()
  writeFileSync(codexFile(r.home, c2), lines(codex.meta(c2, sec(10))))
  await waitFor(() => r.count('SELECT count(*) AS n FROM agent_sessions') === 2)
  await reader.stop()
  r.store.close()
})

test('a session Codex archives keeps its read position, and its compressed copy is not read again', async () => {
  const r = rig()
  const c = codexCtx()
  const file = codexFile(r.home, c)
  const body = lines(codex.meta(c, sec(0)), codex.started(sec(1), 't', 'composer'), codex.userItem(sec(1), 'go', ['user.text']), codex.complete(sec(9), 't', sec(1), sec(9)))
  writeFileSync(file, body)
  const reader = r.reader()
  await reader.start()
  const archive = path.join(r.home, '.codex', 'archived_sessions')
  mkdirSync(archive, { recursive: true })
  const moved = path.join(archive, path.basename(file))
  renameSync(file, moved)
  await reader.stop()
  const again = r.reader()
  await again.start()
  assert.equal(again.stats.bytesRead, 0)
  assert.equal(r.agents.source(moved)!.offset, Buffer.byteLength(body))
  // Later the archive is compressed and the plain file removed: nothing new to read.
  writeFileSync(`${moved}.zst`, zlib.zstdCompressSync(Buffer.from(body)))
  rmSync(moved)
  await again.stop()
  const third = r.reader()
  await third.start()
  assert.equal(third.stats.bytesRead, 0)
  // A compressed session never seen before is read once.
  const old = codexCtx()
  const oldBody = lines(codex.meta(old, sec(-9000)), codex.started(sec(-8999), 'old', 'composer'), codex.userItem(sec(-8999), 'older work', ['user.text']), codex.complete(sec(-8000), 'old', sec(-8999), sec(-8000)))
  writeFileSync(path.join(archive, `rollout-2026-04-01T10-00-00-${old.id}.jsonl.zst`), zlib.zstdCompressSync(Buffer.from(oldBody)))
  await third.stop()
  const fourth = r.reader()
  await fourth.start()
  assert.equal(r.count('SELECT count(*) AS n FROM agent_turns'), 2)
  assert.equal(r.count('SELECT count(*) AS n FROM agent_events'), 2)
  await fourth.stop()
  r.store.close()
})

test('a rewritten or truncated log is read again without duplicating anything', async () => {
  const r = rig()
  const c = claudeCtx()
  const file = claudeFile(r.home, c)
  const body = lines(claude.prompt(c, sec(0), 'go', { uuid: 'p1' }), claude.assistant(c, sec(3), 'end_turn'), claude.prompt(c, sec(10), 'more', { uuid: 'p2' }), claude.assistant(c, sec(12), 'end_turn'))
  writeFileSync(file, body)
  const reader = r.reader()
  await reader.start()
  await reader.stop()
  writeFileSync(file, lines(claude.prompt(c, sec(0), 'go', { uuid: 'p1' }), claude.assistant(c, sec(3), 'end_turn')))
  const again = r.reader()
  await again.start()
  await again.stop()
  assert.equal(r.count('SELECT count(*) AS n FROM agent_turns'), 2)
  assert.equal(r.count('SELECT count(*) AS n FROM agent_events'), 2)
  r.store.close()
})

test('a Codex completed-message copy after bookkeeping is deduplicated across reader restarts', async () => {
  const r = rig()
  const c = codexCtx()
  const file = codexFile(r.home, c)
  writeFileSync(file, lines(codex.meta(c, sec(0)), codex.started(sec(1), 't', 'composer'), codex.userItem(sec(1), 'go', ['user.text']), codex.assistant(sec(5)), codex.userItem(sec(9), 'also this', ['user.text']), codex.tokens(sec(10)), codex.tokens(sec(11))))
  const first = r.reader()
  await first.start()
  await first.stop()
  r.store.close()
  appendFileSync(file, lines(codex.userCompleted(sec(12), 't', 'also this', 'client-9'), codex.complete(sec(20), 't', sec(1), sec(20))))
  const store = new Store(r.data)
  const second = new AgentReader(new AgentStore(store.database), r.roots)
  try {
    await second.start()
    assert.deepEqual(store.query("SELECT detail, wall_ms FROM agent_events WHERE kind = 'user' ORDER BY wall_ms"), [{ detail: 'prompt', wall_ms: sec(1) }, { detail: 'steer', wall_ms: sec(9) }])
  } finally {
    await second.stop()
    store.close()
  }
})

test('a restart in the middle of a turn continues that turn', async () => {
  const r = rig()
  const c = claudeCtx()
  const file = claudeFile(r.home, c)
  writeFileSync(file, lines(claude.prompt(c, sec(0), 'go', { uuid: 'p1' }), claude.assistant(c, sec(5), 'tool_use', { tools: [{ id: 't', name: 'Bash' }] })))
  const reader = r.reader()
  await reader.start()
  await reader.stop()
  appendFileSync(file, lines(claude.toolResult(c, sec(300), 't', 'ok'), claude.assistant(c, sec(310), 'end_turn'), claude.system(c, sec(311), 'turn_duration')))
  const again = r.reader()
  await again.start()
  await again.stop()
  assert.deepEqual(r.store.query('SELECT turn_key, start_wall_ms, last_activity_wall_ms, end_state FROM agent_turns'), [
    { turn_key: 'p1', start_wall_ms: sec(0), last_activity_wall_ms: sec(310), end_state: 'completed' },
  ])
  r.store.close()
})

test('the same turn in two files (a resumed copy, an import read first) is one row, and the live copy wins', async () => {
  const r = rig()
  const c = codexCtx()
  const fork = codexCtx()
  // The fork's file is read first; it carries a replayed copy of the parent's turn.
  writeFileSync(
    codexFile(r.home, fork),
    lines(codex.meta(fork, sec(100), { forkedFrom: c.id }), codex.meta(c, sec(100)), codex.started(sec(100), 'pt', 'composer', sec(0)), codex.complete(sec(100), 'pt', sec(0), sec(50))),
  )
  const reader = r.reader()
  await reader.start()
  writeFileSync(codexFile(r.home, c), lines(codex.meta(c, sec(0)), codex.started(sec(0), 'pt', 'composer'), codex.userItem(sec(0), 'go', ['user.text']), codex.assistant(sec(40)), codex.complete(sec(50), 'pt', sec(0), sec(50))))
  await waitFor(() => r.count('SELECT count(*) AS n FROM agent_turns WHERE replayed = 0') === 1)
  await reader.stop()
  assert.deepEqual(r.store.query('SELECT session_id, replayed, start_wall_ms, last_activity_wall_ms, end_wall_ms FROM agent_turns'), [
    { session_id: c.id, replayed: 0, start_wall_ms: sec(0), last_activity_wall_ms: sec(40), end_wall_ms: sec(50) },
  ])
  r.store.close()
})

test('health says when logs are missing, unreadable, or no longer understood, and when they recover', async () => {
  const r = rig()
  const reader = r.reader()
  await reader.start()
  await reader.stop()
  assert.deepEqual(r.agents.health().map((h) => h.state), ['not_found', 'not_found', 'not_found'])

  const c = claudeCtx()
  const file = claudeFile(r.home, c)
  writeFileSync(file, lines(claude.prompt(c, sec(0), 'go'), '{"type":"user","message":{"role":"us'))
  const second = r.reader()
  await second.start()
  const health = () => r.agents.health().find((h) => h.agent === 'claude_code')!
  assert.equal(health().state, 'degraded')
  assert.equal(health().reason, 'unreadable_lines')
  appendFileSync(file, lines(claude.assistant(c, sec(3), 'end_turn')))
  await waitFor(() => health().state === 'ok')

  // Codex has no logs at all here, Claude Code is fine: Settings shows each agent on its own.
  assert.deepEqual(summarizeHealth(r.agents.health()).map((h) => [h.agent, h.state]), [
    ['claude_code', 'ok'],
    ['codex', 'not_found'],
  ])

  // A format that changed completely: valid lines, none of them recognized.
  appendFileSync(file, lines(JSON.stringify({ type: 'v99-record', at: 1 }), JSON.stringify({ type: 'v99-turn', at: 2 })))
  await waitFor(() => health().state === 'degraded')
  assert.equal(health().reason, 'unrecognized_format')
  assert.equal(summarizeHealth(r.agents.health()).find((h) => h.agent === 'claude_code')!.state, 'degraded')
  await second.stop()

  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const codexRoot = path.join(r.home, '.codex', 'sessions')
    mkdirSync(codexRoot, { recursive: true })
    chmodSync(codexRoot, 0o000)
    const third = r.reader()
    await third.start()
    await third.stop()
    chmodSync(codexRoot, 0o755)
    assert.equal(r.agents.health().find((h) => h.root === codexRoot)!.state, 'unreadable')
  }
  r.store.close()
})

test('the first read of a history runs in a child process and lands exactly as an in-process read would', async () => {
  const build = (home: string) => {
    const c = claudeCtx({ session: '11111111-1111-4111-8111-111111111111' })
    writeFileSync(claudeFile(home, c), lines(claude.prompt(c, sec(0), 'go', { uuid: 'p1' }), claude.assistant(c, sec(9), 'end_turn')))
    const x = codexCtx({ id: '22222222-2222-4222-8222-222222222222' })
    writeFileSync(codexFile(home, x), lines(codex.meta(x, sec(0)), codex.started(sec(1), 't', 'composer'), codex.userItem(sec(1), 'go', ['user.text']), codex.complete(sec(5), 't', sec(1), sec(5))))
  }
  const a = rig()
  build(a.home)
  let merged = false
  const viaChild = a.reader({ backfill: async (roots) => (merged = (await backfill(a.store.database, a.data, roots, () => {})).merged) })
  await viaChild.start()
  await viaChild.stop()
  assert.equal(merged, true)
  assert.equal(viaChild.stats.bytesRead, 0, 'the service itself read nothing')
  assert.ok(!readdirSync(a.data).some((f) => f.startsWith('agent-backfill')), 'the staging database is removed')

  const b = rig()
  build(b.home)
  const inProcess = b.reader()
  await inProcess.start()
  await inProcess.stop()
  const rows = (s: Store) => s.query('SELECT agent, turn_key, start_wall_ms, last_activity_wall_ms, end_state FROM agent_turns ORDER BY turn_key')
  assert.deepEqual(rows(a.store), rows(b.store))
  assert.equal(a.count('SELECT count(*) AS n FROM agent_sources'), 2)
  a.store.close()
  b.store.close()
})

test('settling with nothing to read returns at once, with empty session folders present', async () => {
  const r = rig()
  mkdirSync(path.join(r.home, '.claude', 'projects', '-empty-project'), { recursive: true })
  mkdirSync(path.join(r.home, '.codex', 'sessions', '2026', '10', '17'), { recursive: true })
  const reader = r.reader()
  await reader.start()
  const settled = await Promise.race([reader.settle().then(() => true), new Promise((res) => setTimeout(() => res(false), 2000))])
  assert.equal(settled, true)
  await reader.stop()
  r.store.close()
})

test('a project folder moved into the watched folder is read', async () => {
  const r = rig()
  const c = claudeCtx()
  mkdirSync(path.join(r.home, '.claude', 'projects'), { recursive: true })
  const outside = path.join(r.home, 'elsewhere', '-home-me-code-moved')
  mkdirSync(outside, { recursive: true })
  writeFileSync(path.join(outside, `${c.session}.jsonl`), lines(claude.prompt(c, sec(0), 'go', { uuid: 'mv1' }), claude.assistant(c, sec(5), 'end_turn')))
  const reader = r.reader()
  await reader.start()
  await new Promise((res) => setTimeout(res, 300))
  renameSync(outside, path.join(r.home, '.claude', 'projects', '-home-me-code-moved'))
  await waitFor(() => r.count(`SELECT count(*) AS n FROM agent_turns WHERE turn_key = 'mv1'`) === 1)
  await reader.stop()
  r.store.close()
})

test('renamed turn events are reported as degraded, never as a healthy quiet log', async () => {
  const r = rig()
  const c = codexCtx()
  const renamed = (at: number, kind: string, turn: string) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type: kind, turn_id: turn } })
  writeFileSync(
    codexFile(r.home, c),
    lines(
      codex.meta(c, sec(0)),
      renamed(sec(1), 'turn_began', 't1'),
      codex.userItem(sec(1), 'go', ['user.text']),
      codex.assistant(sec(5)),
      renamed(sec(9), 'turn_finished', 't1'),
    ),
  )
  const reader = r.reader()
  await reader.start()
  await reader.stop()
  assert.equal(r.count('SELECT count(*) AS n FROM agent_turns'), 0)
  const h = r.agents.health().find((x) => x.agent === 'codex' && x.root.endsWith('sessions') && !x.root.endsWith('archived_sessions'))!
  assert.deepEqual([h.state, h.reason], ['degraded', 'turns_unrecognized'])
  r.store.close()
})

test('a renamed start with a recognized completion is reported as degraded', async () => {
  const r = rig()
  const c = codexCtx()
  const renamed = (at: number, kind: string, turn: string) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type: kind, turn_id: turn } })
  writeFileSync(
    codexFile(r.home, c),
    lines(
      codex.meta(c, sec(0)),
      renamed(sec(1), 'turn_began', 't1'),
      codex.userItem(sec(1), 'go', ['user.text']),
      codex.assistant(sec(5)),
      codex.complete(sec(9), 't1', sec(1), sec(9)),
    ),
  )
  const reader = r.reader()
  await reader.start()
  await reader.stop()
  assert.equal(r.count('SELECT count(*) AS n FROM agent_turns'), 0)
  const h = r.agents.health().find((x) => x.agent === 'codex' && x.root.endsWith('sessions') && !x.root.endsWith('archived_sessions'))!
  assert.deepEqual([h.state, h.reason], ['degraded', 'turns_unrecognized'])
  r.store.close()
})

test('the drift check is an indexed lookup whose cost does not grow with the number of logs', (t) => {
  const r = rig()
  const root = r.roots[1]!.dir
  const state = JSON.stringify({ session: 's', origin: 'interactive', dir: '/home/me/code/project-beta', branch: 'main', turn: null, recentUsers: Array.from({ length: 64 }, (_, i) => `${i}`.padStart(16, '0')), _readCounts: { lines: 900, bad: 0, unknown: 3, recognized: 897, turns: 12, orphan: 0 }, _drift: 0 })
  const insert = r.store.database.prepare(`INSERT INTO agent_sources (path, agent, root, session_id, dev, ino, offset, size, state, updated_wall_ms) VALUES (?, 'codex', ?, ?, '1', ?, 10, 10, ?, 0)`)
  const grow = (from: number, to: number) => r.store.database.transaction(() => { for (let i = from; i < to; i++) insert.run(path.join(root, `rollout-${i}.jsonl`), root, `s${i}`, String(i), state) })()
  const perCall = () => {
    for (let i = 0; i < 50; i++) r.agents.hasTurnlessSource(root)
    const t0 = performance.now()
    for (let i = 0; i < 500; i++) r.agents.hasTurnlessSource(root)
    return (performance.now() - t0) / 500
  }
  grow(0, 1_000)
  const small = perCall()
  grow(1_000, 20_000)
  const large = perCall()
  t.diagnostic(JSON.stringify({ rows_1000_ms: small, rows_20000_ms: large }))
  const plan = r.store.database.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM agent_sources WHERE root = ? AND turnless = 1 LIMIT 1').all(root) as { detail: string }[]
  assert.ok(plan.some((p) => p.detail.includes('agent_sources_turnless')), JSON.stringify(plan))
  assert.ok(large < small * 4 + 0.01, `per-call cost grew from ${small} ms to ${large} ms`)
  assert.equal(r.agents.hasTurnlessSource(root), false)
  r.store.close()
})

test('a database read before the drift flag existed keeps its drift', () => {
  const data = tmp()
  const db = new Store(data)
  applyMigrations(db.database, [agentSessionsMigration])
  const insert = db.database.prepare(`INSERT INTO agent_sources (path, agent, root, offset, size, state, updated_wall_ms) VALUES (?, 'codex', '/r', 1, 1, ?, 0)`)
  insert.run('/r/a.jsonl', JSON.stringify({ _readCounts: { lines: 3, bad: 0, unknown: 1, recognized: 2, turns: 0, orphan: 1 } }))
  insert.run('/r/b.jsonl', JSON.stringify({ _readCounts: { lines: 3, bad: 0, unknown: 0, recognized: 3, turns: 1, orphan: 0 } }))
  const agents = new AgentStore(db.database)
  assert.equal(agents.hasTurnlessSource('/r'), true)
  assert.deepEqual(db.query<{ path: string }>('SELECT path FROM agent_sources WHERE turnless = 1').map((x) => x.path), ['/r/a.jsonl'])
  db.close()
})

test('deleting a session removes its rows and any staging copy of the first read', async () => {
  const r = rig()
  const keep = claudeCtx()
  const gone = claudeCtx()
  writeFileSync(claudeFile(r.home, keep), lines(claude.prompt(keep, sec(0), 'keep', { uuid: 'keep' }), claude.assistant(keep, sec(2), 'end_turn')))
  writeFileSync(claudeFile(r.home, gone), lines(claude.prompt(gone, sec(5), 'gone', { uuid: 'gone' }), claude.assistant(gone, sec(7), 'end_turn')))
  const reader = r.reader()
  await reader.start()
  await reader.stop()
  const staging = path.join(r.data, 'agent-backfill.sqlite')
  writeFileSync(staging, 'synthetic staging')
  writeFileSync(`${staging}-wal`, 'synthetic staging')
  r.agents.deleteSession('claude_code', gone.session)
  const left = (table: string) => r.store.query<{ session_id: string }>(`SELECT DISTINCT session_id FROM ${table}`).map((x) => x.session_id)
  for (const table of ['agent_sessions', 'agent_turns', 'agent_events']) assert.ok(!left(table).includes(gone.session), table)
  assert.ok(left('agent_turns').includes(keep.session))
  assert.deepEqual([staging, `${staging}-wal`].filter((f) => existsSync(f)), [])
  const again = r.reader()
  await again.start()
  await again.stop()
  assert.equal(r.count('SELECT count(*) AS n FROM agent_turns WHERE session_id = ?', gone.session), 0, 'a deleted session is not read in again')
  r.store.close()
})

test('the first read uses bounded slices and preserves the same rows as an in-process read', async () => {
  const build = (home: string) => {
    const c = claudeCtx({ session: '33333333-3333-4333-8333-333333333333' })
    const ls: string[] = []
    for (let i = 0; i < 40; i++) {
      ls.push(claude.prompt(c, sec(i * 100), `prompt ${i}`, { uuid: `p${i}` }))
      ls.push(claude.assistant(c, sec(i * 100 + 5), 'tool_use', { tools: [{ id: `t${i}`, name: 'Bash' }] }))
      ls.push(claude.toolResult(c, sec(i * 100 + 9), `t${i}`, 'x'.repeat(4000)))
      ls.push(claude.assistant(c, sec(i * 100 + 20), 'end_turn'))
    }
    writeFileSync(claudeFile(home, c), lines(...ls))
    const x = codexCtx({ id: '44444444-4444-4444-8444-444444444444' })
    writeFileSync(codexFile(home, x), lines(codex.meta(x, sec(0)), codex.started(sec(1), x.id.replace(/4/g, '5'), 'composer'), codex.userItem(sec(1), 'go', ['user.text']), codex.complete(sec(5), x.id.replace(/4/g, '5'), sec(1), sec(5))))
  }
  const a = rig()
  build(a.home)
  let children = 0
  const viaChildren = a.reader({
    backfill: async (roots) => {
      const res = await backfill(a.store.database, a.data, roots, () => {}, 20_000)
      children = res.slices
      return res.merged
    },
  })
  await viaChildren.start()
  await viaChildren.stop()
  assert.ok(children > 3, `the history was read by several children (${children})`)
  const b = rig()
  build(b.home)
  const inProcess = b.reader()
  await inProcess.start()
  await inProcess.stop()
  const rows = (s: Store) => [
    s.query('SELECT agent, turn_key, opened_by, start_wall_ms, last_activity_wall_ms, end_wall_ms, end_state FROM agent_turns ORDER BY turn_key'),
    s.query('SELECT agent, event_key, detail, wall_ms FROM agent_events ORDER BY event_key'),
    s.query<{ path: string; offset: number; size: number }>('SELECT path, offset, size FROM agent_sources ORDER BY path').map((r) => [path.basename(r.path), r.offset, r.size]),
  ]
  assert.deepEqual(rows(a.store), rows(b.store))
  assert.equal(a.count('SELECT count(*) AS n FROM agent_turns'), 41)
  a.store.close()
  b.store.close()
})

test('a first read with no logs at all starts the readers', async () => {
  const r = rig()
  const reader = r.reader({ backfill: async (roots) => (await backfill(r.store.database, r.data, roots, () => {})).merged })
  await reader.start()
  await reader.stop()
  assert.deepEqual(r.agents.health().map((h) => h.state), ['not_found', 'not_found', 'not_found'])
  r.store.close()
})

test('a failed backfill still starts the readers', async () => {
  const r = rig()
  const c = claudeCtx()
  writeFileSync(claudeFile(r.home, c), lines(claude.prompt(c, sec(0), 'go', { uuid: 'bf1' }), claude.assistant(c, sec(3), 'end_turn')))
  const broken = r.reader({
    backfill: async () => {
      throw new Error('boom')
    },
  })
  await broken.start()
  await broken.stop()
  assert.equal(r.count(`SELECT count(*) AS n FROM agent_turns WHERE turn_key = 'bf1'`), 1)
  r.store.close()
})

test('an unfinished last line ends the first read, and is read once its writer finishes it', async () => {
  const r = rig()
  const c = claudeCtx()
  const file = claudeFile(r.home, c)
  const finish = claude.assistant(c, sec(40), 'end_turn')
  writeFileSync(file, lines(claude.prompt(c, sec(0), 'go', { uuid: 'pl1' }), claude.assistant(c, sec(5), 'tool_use', { tools: [{ id: 't', name: 'Bash' }] })) + finish.slice(0, 100))
  const slice = r.reader()
  assert.equal(await slice.readOnly([file], 1 << 20), false, 'partial EOF is not another slice')
  await slice.stop()
  r.store.database.exec('DELETE FROM agent_sources; DELETE FROM agent_turns; DELETE FROM agent_sessions; DELETE FROM agent_events')
  let children = 0
  const reader = r.reader({
    followUpMs: 200,
    backfill: async (roots) => {
      const res = await backfill(r.store.database, r.data, roots, () => {}, 64)
      children = res.slices
      return res.merged
    },
  })
  await reader.start()
  assert.ok(children >= 1 && children < 10, `children: ${children}`)
  appendFileSync(file, `${finish.slice(100)}\n`)
  await waitFor(() => r.store.query<{ n: number }>(`SELECT last_activity_wall_ms AS n FROM agent_turns WHERE turn_key = 'pl1'`)[0]?.n === sec(40))
  await reader.stop()
  r.store.close()
})

test('a line longer than a slice does not read the rest of the history', async () => {
  const r = rig()
  const c = claudeCtx()
  const file = claudeFile(r.home, c)
  writeFileSync(file, lines(claude.prompt(c, sec(0), 'go', { uuid: 'long' }), claude.assistant(c, sec(1), 'tool_use')))
  for (let i = 0; i < 8; i++) appendFileSync(file, lines(claude.toolResult(c, sec(i + 2), `t${i}`, 'x'.repeat(800_000))))
  const reader = r.reader()
  const remaining = await reader.readOnly([file], 64)
  assert.equal(remaining, true)
  assert.ok(reader.stats.bytesRead < 2 << 20, `slice read ${reader.stats.bytesRead} bytes`)
  await reader.stop()
  r.store.close()
})

test('only session logs are read: images, tool output files and metadata beside them are ignored', () => {
  const [cl, cx, ar] = homeRoots('/h', {}) as [AgentRoot, AgentRoot, AgentRoot]
  assert.ok(classifyFile(cl, '/h/.claude/projects/-p/abc.jsonl'))
  assert.deepEqual(classifyFile(cl, '/h/.claude/projects/-p/abc/subagents/agent-1.jsonl'), { session: 'agent-1', parent: 'abc', compressed: false })
  assert.equal(classifyFile(cl, '/h/.claude/projects/-p/abc/subagents/agent-1.meta.json'), null)
  assert.equal(classifyFile(cl, '/h/.claude/projects/-p/abc/tool-results/x.txt'), null)
  assert.equal(classifyFile(cl, '/h/.claude/projects/-p/image.png'), null)
  assert.ok(classifyFile(cx, '/h/.codex/sessions/2026/10/14/rollout-2026-10-14T20-00-00-01a13b95-3a52-7413-be52-f44fba42510c.jsonl'))
  assert.equal(classifyFile(cx, '/h/.codex/sessions/2026/10/14/rollout-x.jsonl.zst'), null)
  assert.equal(classifyFile(ar, '/h/.codex/archived_sessions/rollout-2026-04-01T23-39-00-019d4afc-48c7-7583-bedf-f54e83744001.jsonl.zst')!.session, '019d4afc-48c7-7583-bedf-f54e83744001')
  assert.deepEqual(
    homeRoots('/h', { CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x' }).map((r) => r.dir),
    [path.join('/c', 'projects'), path.join('/x', 'sessions'), path.join('/x', 'archived_sessions')],
  )
})


test('an over-slice unfinished tail is deferred so later logs finish in bounded children', async () => {
  const r = rig()
  const c = claudeCtx()
  const early = claudeFile(r.home, c, '-a')
  const prefix = lines(claude.prompt(c, sec(0), 'go', { uuid: 'tail-prefix' }))
  writeFileSync(early, prefix + 'x'.repeat(4_194_404))
  const later = claudeCtx()
  const last = claudeFile(r.home, later, '-z')
  writeFileSync(last, lines(claude.prompt(later, sec(10), 'later', { uuid: 'later' })))
  const files = await listLogs(r.roots)
  const stage = path.join(r.data, 'probe.sqlite')
  let pending = files
  let remaining = true
  let children = 0
  for (; remaining && children < 5; children++) {
    const slice = await runChild(stage, r.roots, pending, 4 << 20, () => {})
    assert.ok(slice)
    pending = pending.filter((f) => !slice.deferred_files?.includes(f))
    remaining = slice.remaining === true
  }
  assert.equal(remaining, false, 'later logs must finish within five children')
  let backfillChildren = 0
  const reader = r.reader({ backfill: async (roots) => {
    const result = await backfill(r.store.database, r.data, roots, () => {})
    backfillChildren = result.slices
    return result.merged
  } })
  await reader.start()
  await reader.stop()
  assert.ok(backfillChildren <= 3, `children: ${backfillChildren}`)
  assert.equal(r.count("SELECT count(*) AS n FROM agent_turns WHERE turn_key = 'later'"), 1)
  assert.equal(r.agents.source(early)!.offset, Buffer.byteLength(prefix))
  r.store.close()
})

test('a slice with no committed progress stops backfill and logs the live-reader handoff', async () => {
  const r = rig()
  const early = claudeFile(r.home, claudeCtx(), '-a')
  writeFileSync(early, 'x'.repeat(4_194_404))
  const later = claudeFile(r.home, claudeCtx(), '-z')
  const c = claudeCtx()
  writeFileSync(later, lines(claude.prompt(c, sec(10), 'later', { uuid: 'handoff' })))
  const probe = await runChild(path.join(r.data, 'probe.sqlite'), r.roots, await listLogs(r.roots), 4 << 20, () => {})
  assert.equal(probe?.progressed, false, 'child reports committed-offset progress explicitly')
  const logs: string[] = []
  let children = 0
  const reader = r.reader({ backfill: async (roots) => {
    const result = await backfill(r.store.database, r.data, roots, (s) => logs.push(s))
    children = result.slices
    return result.merged
  } })
  await reader.start()
  await reader.stop()
  assert.equal(children, 1)
  assert.ok(logs.some((s) => s.includes('no committed progress') && s.includes('live reader')))
  assert.equal(r.count("SELECT count(*) AS n FROM agent_turns WHERE turn_key = 'handoff'"), 1)
  r.store.close()
})

for (const child of [false, true]) {
  test(`format drift in one session is not masked by a healthy session (backfill=${child})`, async () => {
    const r = rig()
    const good = codexCtx()
    const drift = codexCtx()
    writeFileSync(codexFile(r.home, good), lines(codex.meta(good, sec(0)), codex.started(sec(1), 'good', 'composer'), codex.complete(sec(5), 'good', sec(1), sec(5))))
    writeFileSync(codexFile(r.home, drift), lines(codex.meta(drift, sec(10)), codex.started(sec(11), 'drift', 'composer').replace('task_started', 'renamed_start'), codex.assistant(sec(15))))
    const reader = r.reader(child ? { backfill: async (roots) => (await backfill(r.store.database, r.data, roots, () => {})).merged } : {})
    await reader.start()
    await reader.stop()
    const health = () => r.agents.healthFor('codex', r.roots[1]!.dir)!
    assert.deepEqual([health().state, health().reason], ['degraded', 'turns_unrecognized'])
    appendFileSync(codexFile(r.home, good), lines(codex.started(sec(20), 'good2', 'composer'), codex.complete(sec(25), 'good2', sec(20), sec(25))))
    const again = r.reader()
    await again.start()
    await again.stop()
    assert.equal(health().state, 'degraded', 'a later read of the healthy file cannot hide drift elsewhere')
    r.store.close()
  })

  test(`drift after a valid turn in the same session is not hidden by that turn (backfill=${child})`, async () => {
    const r = rig()
    const good = codexCtx()
    const drift = codexCtx()
    writeFileSync(codexFile(r.home, good), lines(codex.meta(good, sec(0)), codex.started(sec(1), 'good', 'composer'), codex.complete(sec(5), 'good', sec(1), sec(5))))
    const driftFile = codexFile(r.home, drift)
    writeFileSync(
      driftFile,
      lines(
        codex.meta(drift, sec(10)),
        codex.started(sec(11), 'valid', 'composer'),
        codex.complete(sec(15), 'valid', sec(11), sec(15)),
        codex.started(sec(20), 'renamed', 'composer').replace('task_started', 'renamed_start'),
        codex.assistant(sec(25)),
      ),
    )
    const reader = r.reader(child ? { backfill: async (roots) => (await backfill(r.store.database, r.data, roots, () => {})).merged } : {})
    await reader.start()
    await reader.stop()
    assert.equal(r.count('SELECT count(*) AS n FROM agent_turns'), 2)
    const health = () => r.agents.healthFor('codex', r.roots[1]!.dir)!
    assert.deepEqual([health().state, health().reason], ['degraded', 'turns_unrecognized'])
    appendFileSync(driftFile, lines(codex.started(sec(30), 'later', 'composer'), codex.complete(sec(35), 'later', sec(30), sec(35))))
    const again = r.reader()
    await again.start()
    await again.stop()
    assert.equal(health().state, 'ok', 'a recognized turn after the drift clears it')
    r.store.close()
  })

  test(`a command finishing or Codex's own note after a turn ends is not drift (backfill=${child})`, async () => {
    const r = rig()
    const c = codexCtx()
    const note = JSON.stringify({ timestamp: new Date(sec(12)).toISOString(), type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'synthetic note' }] } })
    writeFileSync(
      codexFile(r.home, c),
      lines(
        codex.meta(c, sec(0)),
        codex.started(sec(1), 'cmd', 'composer'),
        codex.complete(sec(5), 'cmd', sec(1), sec(5)),
        codex.itemDone(sec(6), 'cmd', sec(2), sec(6)),
        codex.started(sec(7), 'stopped', 'composer'),
        codex.aborted(sec(11), 'stopped', sec(7)),
        note,
      ),
    )
    const reader = r.reader(child ? { backfill: async (roots) => (await backfill(r.store.database, r.data, roots, () => {})).merged } : {})
    await reader.start()
    await reader.stop()
    assert.equal(r.agents.healthFor('codex', r.roots[1]!.dir)!.state, 'ok')
    r.store.close()
  })

  test(`a renamed-start session with only a recognized completion is degraded (backfill=${child})`, async () => {
    const r = rig()
    const c = codexCtx()
    writeFileSync(codexFile(r.home, c), lines(codex.meta(c, sec(0)), codex.started(sec(1), 'drift', 'composer').replace('task_started', 'renamed_start'), codex.complete(sec(5), 'drift', sec(1), sec(5))))
    const reader = r.reader(child ? { backfill: async (roots) => (await backfill(r.store.database, r.data, roots, () => {})).merged } : {})
    await reader.start()
    await reader.stop()
    const h = r.agents.healthFor('codex', r.roots[1]!.dir)!
    assert.equal(r.count('SELECT count(*) AS n FROM agent_turns'), 0)
    assert.deepEqual([h.state, h.reason], ['degraded', 'turns_unrecognized'])
    r.store.close()
  })
}

test('a compressed archive stops at the decoded slice budget and resumes without losing turns', async () => {
  const r = rig()
  const c = codexCtx()
  const archive = path.join(r.home, '.codex', 'archived_sessions')
  mkdirSync(archive, { recursive: true })
  const file = path.join(archive, `rollout-2026-10-14T20-00-00-${c.id}.jsonl.zst`)
  const body = [codex.meta(c, sec(0))]
  for (let i = 0; i < 80; i++) {
    body.push(codex.started(sec(i * 10 + 1), `slice-${i}`, 'composer'))
    body.push(codex.userItem(sec(i * 10 + 1), `prompt ${i}`, ['user.text']))
    body.push(JSON.stringify({ type: 'response_item', timestamp: new Date(sec(i * 10 + 2)).toISOString(), payload: { type: 'function_call_output', output: 'x'.repeat(i === 1 ? 5 << 20 : 160_000) } }))
    body.push(codex.complete(sec(i * 10 + 3), `slice-${i}`, sec(i * 10 + 1), sec(i * 10 + 3)))
  }
  const decoded = Buffer.from(body.join('\n'))
  writeFileSync(file, zlib.zstdCompressSync(decoded))
  const reader = r.reader()
  try {
    let remaining = true
    let slices = 0
    for (; remaining && slices < 10; slices++) {
      const before = reader.stats.bytesRead
      remaining = await reader.readOnly([file], 4 << 20)
      assert.ok(reader.stats.bytesRead - before <= 4 << 20, `decoded ${reader.stats.bytesRead - before} bytes in one slice`)
    }
    assert.equal(remaining, false)
    assert.ok(slices > 1)
    assert.equal(reader.stats.bytesRead, decoded.length)
    assert.equal(r.count("SELECT count(*) AS n FROM agent_turns WHERE end_state = 'completed'"), 80)
    assert.equal(r.count("SELECT count(*) AS n FROM agent_events WHERE kind = 'user'"), 80)
    assert.equal(r.agents.source(file)!.offset, r.agents.source(file)!.size)
    const data = tmp()
    const batch = new Store(data)
    new AgentStore(batch.database)
    try {
      const result = await backfill(batch.database, data, r.roots, () => {})
      assert.equal(result.children, 1)
      assert.ok(result.slices > 1)
      assert.ok(result.max_slice_bytes <= 4 << 20)
      assert.equal(result.child?.bytes_read, decoded.length)
      assert.equal(batch.query<{ n: number }>("SELECT count(*) AS n FROM agent_turns WHERE end_state = 'completed'")[0]!.n, 80)
    } finally {
      batch.close()
    }
  } finally {
    await reader.stop()
    r.store.close()
  }
})

test('plain slices keep an oversized line in progress without exceeding the byte budget', async () => {
  const r = rig()
  const c = claudeCtx()
  const file = claudeFile(r.home, c)
  const body = lines(claude.prompt(c, sec(0), 'go', { uuid: 'bounded-plain' }), claude.toolResult(c, sec(1), 'big', 'x'.repeat(7 << 20)), claude.assistant(c, sec(2), 'end_turn'), claude.system(c, sec(3), 'turn_duration'))
  writeFileSync(file, body)
  const reader = r.reader()
  try {
    let remaining = true
    for (let i = 0; remaining && i < 5; i++) {
      const before = reader.stats.bytesRead
      remaining = await reader.readOnly([file], 4 << 20)
      assert.ok(reader.stats.bytesRead - before <= 4 << 20, `read ${reader.stats.bytesRead - before} bytes in one slice`)
    }
    assert.equal(remaining, false)
    assert.equal(reader.stats.bytesRead, Buffer.byteLength(body))
    assert.equal(r.count("SELECT count(*) AS n FROM agent_turns WHERE end_state = 'completed'"), 1)
    assert.equal(r.agents.source(file)!.offset, Buffer.byteLength(body))
  } finally {
    await reader.stop()
    r.store.close()
  }
})

test('a complete first line longer than a slice is read in bounded pieces and slicing continues', async () => {
  const r = rig()
  const big = claudeCtx()
  writeFileSync(claudeFile(r.home, big, '-a'), lines(claude.toolResult(big, sec(0), 'big', 'x'.repeat(4_300_000)), claude.prompt(big, sec(1), 'go', { uuid: 'after-big' }), claude.assistant(big, sec(2), 'end_turn')))
  for (let i = 0; i < 6; i++) {
    const c = claudeCtx()
    writeFileSync(claudeFile(r.home, c, `-s${i}`), lines(claude.prompt(c, sec(10 + i), 'small', { uuid: `small${i}` }), claude.assistant(c, sec(11 + i), 'end_turn')))
  }
  const logs: string[] = []
  let result: Awaited<ReturnType<typeof backfill>> | null = null
  const reader = r.reader({ backfill: async (roots) => (result = await backfill(r.store.database, r.data, roots, (s) => logs.push(s))).merged })
  await reader.start()
  await reader.stop()
  assert.ok(result)
  const res = result as Awaited<ReturnType<typeof backfill>>
  assert.ok(res.slices >= 2, `slices: ${res.slices}`)
  assert.ok(res.max_slice_bytes <= 4 << 20, `max slice: ${res.max_slice_bytes}`)
  assert.ok(!logs.some((s) => s.includes('no committed progress')), logs.join('\n'))
  assert.equal(reader.stats.filesRead, 0, 'nothing is left for an unbounded read in this process')
  assert.equal(r.count('SELECT count(*) AS n FROM agent_turns'), 7)
  r.store.close()
})

test('source capture uses emitted JavaScript for its backfill worker', async () => {
  const r = rig()
  const c = claudeCtx()
  writeFileSync(claudeFile(r.home, c), lines(claude.prompt(c, sec(0), 'go', { uuid: 'runtime' }), claude.assistant(c, sec(2), 'end_turn')))
  try {
    const result = await runChild(path.join(r.data, 'runtime.sqlite'), r.roots, await listLogs(r.roots), 4 << 20, () => {})
    assert.ok(result)
    assert.ok(result.entrypoint?.endsWith(path.join('build', 'js', 'capture', 'agents', 'backfillMain.js')), `worker entry point: ${result?.entrypoint}`)
    assert.equal(result.runtime?.node, process.versions.node)
  } finally {
    r.store.close()
  }
})
