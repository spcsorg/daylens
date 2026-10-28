import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import path from 'node:path'
import { AgentStore } from '../../capture/agents/store.ts'
import { DB_FILE } from '../../capture/store.ts'
import { DeletedMaterialError, StaleHourError } from '../../storage/index.ts'
import { app, focus, resetSeq } from '../support/lines.ts'
import { HOUR, MIN, rig, T0 } from './support.ts'

const editor = app('com.example.editor', { name: 'Editor' })
const term = app('com.example.term', { name: 'Term' })

function obsId(r: ReturnType<typeof rig>, title: string): number {
  return r.q<{ id: number }>('SELECT id FROM observations WHERE title = ?', title)[0]!.id
}

test('an hour cites its observations, and deleting the app of one it cites clears the hour', async () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'plan.md', T0 + 5 * MIN, 'app_changed'))
  r.feed(focus(term, 'make', T0 + 20 * MIN, 'app_changed'))
  r.clock.t = T0 + 2 * HOUR
  const cited = obsId(r, 'plan.md')
  const h = r.storage.writeHour({ start_wall_ms: T0, tz: 'Africa/Johannesburg', status: 'written', title: 'Wrote the plan', observations: [cited], writer: 'm' }, r.storage.hourBasis(T0))
  assert.deepEqual(h.observations, [cited])
  assert.deepEqual(h.sources, [{ app_id: 'com.example.editor' }])

  await r.storage.deleteSource('com.example.editor').done
  const after = r.storage.hour(h.id)!
  assert.deepEqual([after.title, after.status, after.needs_rewrite, after.observations], [null, 'facts', true, []])
  r.close()
})

test('an hour citing an observation or agent session that is not recorded is refused', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'plan.md', T0 + 5 * MIN, 'app_changed'))
  r.clock.t = T0 + 2 * HOUR
  const basis = r.storage.hourBasis(T0)
  assert.throws(() => r.storage.writeHour({ start_wall_ms: T0, tz: 'z', status: 'written', title: 'x', observations: [987_654] }, basis), DeletedMaterialError)
  assert.throws(() => r.storage.writeHour({ start_wall_ms: T0, tz: 'z', status: 'written', title: 'x', sources: [{ agent: 'codex' }] }, basis), DeletedMaterialError)
  r.close()
})

test('deleting an agent session clears every hour that draws on it and no other', async () => {
  resetSeq()
  const r = rig()
  new AgentStore(r.store.database).apply('codex', [
    { t: 'session', session: 's1', origin: 'interactive', parent: null, client: null, dir: '/code/alpha', branch: null, at: T0 + 10 * MIN },
    { t: 'session', session: 's2', origin: 'interactive', parent: null, client: null, dir: '/code/beta', branch: null, at: T0 + HOUR + 10 * MIN },
  ])
  r.clock.t = T0 + 3 * HOUR
  const a = r.storage.writeHour({ start_wall_ms: T0, tz: 'z', status: 'written', title: 'Alpha with Codex', sources: [{ agent: 'codex', session: 's1' }] }, r.storage.hourBasis(T0))
  const b = r.storage.writeHour({ start_wall_ms: T0 + HOUR, tz: 'z', status: 'written', title: 'Beta with Codex', sources: [{ agent: 'codex', session: 's2' }] }, r.storage.hourBasis(T0 + HOUR))
  await r.storage.deleteAgentSession('codex', 's1')
  assert.deepEqual([r.storage.hour(a.id)!.title, r.storage.hour(a.id)!.sources], [null, []])
  assert.equal(r.storage.hour(b.id)!.title, 'Beta with Codex')
  assert.equal(r.storage.search('Alpha').length, 0)
  assert.throws(() => r.storage.writeHour({ start_wall_ms: T0, tz: 'z', status: 'written', title: 'again', sources: [{ agent: 'codex', session: 's1' }] }, r.storage.hourBasis(T0)), DeletedMaterialError)
  r.close()
})

test('deleting an agent session takes the titles of threads linked to the hours it clears, and the reads of those hours', async () => {
  resetSeq()
  const r = rig()
  new AgentStore(r.store.database).apply('codex', [{ t: 'session', session: 's1', origin: 'interactive', parent: null, client: null, dir: '/code/alpha', branch: null, at: T0 + 10 * MIN }])
  r.clock.t = T0 + 3 * HOUR
  const a = r.storage.writeHour({ start_wall_ms: T0, tz: 'z', status: 'written', title: 'Alpha with Codex', sources: [{ agent: 'codex', session: 's1' }] }, r.storage.hourBasis(T0))
  const b = r.storage.writeHour({ start_wall_ms: T0 + HOUR, tz: 'z', status: 'written', title: 'Beta' }, r.storage.hourBasis(T0 + HOUR))
  const thread = r.storage.createThread('Project Alpha', [a.id, b.id])
  r.storage.recordAssistantRead({ assistant: 'mcp', tool: 'getDaySummary', from_wall_ms: T0, to_wall_ms: T0 + HOUR, query: 'alpha', hours: [a.id] })
  await r.storage.deleteAgentSession('codex', 's1')
  assert.deepEqual(r.storage.threadsForHour(b.id), [{ id: thread, title: '' }])
  assert.deepEqual(r.q('SELECT needs_rewrite FROM threads'), [{ needs_rewrite: 1 }])
  assert.deepEqual(r.q('SELECT id FROM assistant_reads'), [])
  r.close()
})

test('deleting an agent session clears the hours that cite its subagents, at any depth', async () => {
  resetSeq()
  const r = rig()
  new AgentStore(r.store.database).apply('claude_code', [
    { t: 'session', session: 'p', origin: 'interactive', parent: null, client: null, dir: '/code/alpha', branch: null, at: T0 + 5 * MIN },
    { t: 'session', session: 'c', origin: 'interactive', parent: 'p', client: null, dir: '/code/alpha', branch: null, at: T0 + 10 * MIN },
    { t: 'session', session: 'g', origin: 'interactive', parent: 'c', client: null, dir: '/code/alpha', branch: null, at: T0 + HOUR + 10 * MIN },
  ])
  r.clock.t = T0 + 3 * HOUR
  const a = r.storage.writeHour({ start_wall_ms: T0, tz: 'z', status: 'written', title: 'Subagent task', sources: [{ agent: 'claude_code', session: 'c' }] }, r.storage.hourBasis(T0))
  const b = r.storage.writeHour({ start_wall_ms: T0 + HOUR, tz: 'z', status: 'written', title: 'Nested subagent task', sources: [{ agent: 'claude_code', session: 'g' }] }, r.storage.hourBasis(T0 + HOUR))
  assert.equal(await r.storage.deleteAgentSession('claude_code', 'p'), true)
  assert.deepEqual([r.storage.hour(a.id)!.title, r.storage.hour(a.id)!.sources], [null, []])
  assert.deepEqual([r.storage.hour(b.id)!.title, r.storage.hour(b.id)!.sources], [null, []])
  assert.equal(r.storage.search('subagent').length, 0)
  r.close()
})

test('deleting the app an agent session ran in clears the hours that cite only that session', async () => {
  resetSeq()
  const r = rig()
  const agents = new AgentStore(r.store.database, () => r.clock.t)
  agents.withheld = () => r.storage.withheld()
  agents.recordHost('codex', 's1', { app_id: 'com.example.term', name: 'Term', path: '/Applications/Term.app' }, 'responsible', T0)
  r.clock.t = T0 + 30 * MIN
  agents.apply('codex', [
    { t: 'session', session: 's1', origin: 'interactive', parent: null, client: null, dir: '/code/alpha', branch: null, at: T0 + 10 * MIN },
    { t: 'turn', key: 'k1', session: 's1', dir: '/code/alpha', branch: null, opener: 'user', start: T0 + 10 * MIN, replayed: false },
    { t: 'end', key: 'k1', state: 'completed', at: T0 + 20 * MIN },
  ])
  r.clock.t = T0 + 2 * HOUR
  const h = r.storage.writeHour({ start_wall_ms: T0, tz: 'z', status: 'written', title: 'Alpha with Codex', sources: [{ agent: 'codex', session: 's1' }] }, r.storage.hourBasis(T0))
  await r.storage.deleteSource('com.example.term').done
  assert.deepEqual([r.storage.hour(h.id)!.title, r.storage.hour(h.id)!.status], [null, 'facts'])
  assert.equal(r.storage.search('Alpha').length, 0)
  r.close()
})

test("deleting an agent session clears the hours citing a fork only where the fork held the session's copied records", async () => {
  for (const how of ['session', 'app'] as const) {
    resetSeq()
    const r = rig()
    const agents = new AgentStore(r.store.database, () => r.clock.t)
    agents.withheld = () => r.storage.withheld()
    agents.recordHost('codex', 'src', { app_id: 'com.example.term', name: 'Term', path: '/Applications/Term.app' }, 'responsible', T0)
    agents.recordHost('codex', 'fork', { app_id: 'com.example.editor', name: 'Editor', path: '/Applications/Editor.app' }, 'responsible', T0)
    r.clock.t = T0 + 3 * HOUR
    agents.apply('codex', [
      { t: 'session', session: 'src', origin: 'interactive', parent: null, client: null, dir: '/code/alpha', branch: null, at: T0 + 5 * MIN },
      { t: 'turn', key: 'k1', session: 'src', dir: '/code/alpha', branch: null, opener: 'user', start: T0 + 5 * MIN, replayed: false },
      { t: 'end', key: 'k1', state: 'completed', at: T0 + 10 * MIN },
      { t: 'session', session: 'fork', origin: 'interactive', parent: null, client: null, dir: '/code/alpha', branch: null, at: T0 + 20 * MIN },
      // A copy of a turn its source never stored: the fork holds the only row of it.
      { t: 'turn', key: 'k0', session: 'fork', dir: '/code/alpha', branch: null, opener: 'user', start: T0 + 2 * MIN, replayed: true, source: 'src' },
      { t: 'turn', key: 'k2', session: 'fork', dir: '/code/alpha', branch: null, opener: 'user', start: T0 + HOUR + 5 * MIN, replayed: false },
      { t: 'end', key: 'k2', state: 'completed', at: T0 + HOUR + 10 * MIN },
    ])
    const copied = r.storage.writeHour({ start_wall_ms: T0, tz: 'z', status: 'written', title: 'Alpha in the fork', sources: [{ agent: 'codex', session: 'fork' }] }, r.storage.hourBasis(T0))
    const own = r.storage.writeHour({ start_wall_ms: T0 + HOUR, tz: 'z', status: 'written', title: 'Beta in the fork', sources: [{ agent: 'codex', session: 'fork' }] }, r.storage.hourBasis(T0 + HOUR))
    if (how === 'session') assert.equal(await r.storage.deleteAgentSession('codex', 'src'), true)
    else await r.storage.deleteSource('com.example.term').done
    assert.deepEqual([r.storage.hour(copied.id)!.title, r.storage.hour(copied.id)!.status], [null, 'facts'], how)
    assert.equal(r.storage.hour(own.id)!.title, 'Beta in the fork', how)
    r.close()
  }
})

test('a session the gate removes once its deleted parent is known takes the hours that cite it', async () => {
  for (const how of ['session', 'app'] as const) {
    resetSeq()
    const r = rig()
    const agents = new AgentStore(r.store.database, () => r.clock.t)
    agents.withheld = () => r.storage.withheld()
    agents.appDeleted = (app) => r.storage.agentAppDeleted(app)
    agents.recordHost('codex', 'p', { app_id: 'com.example.term', name: 'Term', path: '/Applications/Term.app' }, 'responsible', T0)
    r.clock.t = T0 + 3 * HOUR
    agents.apply('codex', [
      { t: 'session', session: 'p', origin: 'interactive', parent: null, client: null, dir: '/code/alpha', branch: null, at: T0 + 5 * MIN },
      { t: 'session', session: 'g', origin: 'subagent', parent: 'c', client: null, dir: '/code/alpha', branch: null, at: T0 + 10 * MIN },
      { t: 'turn', key: 'kg', session: 'g', dir: '/code/alpha', branch: null, opener: 'user', start: T0 + 10 * MIN, replayed: false },
      { t: 'end', key: 'kg', state: 'completed', at: T0 + 20 * MIN },
    ])
    const h = r.storage.writeHour({ start_wall_ms: T0, tz: 'z', status: 'written', title: 'Alpha subagent', sources: [{ agent: 'codex', session: 'g' }] }, r.storage.hourBasis(T0))
    if (how === 'session') await r.storage.deleteAgentSession('codex', 'p')
    else await r.storage.deleteSource('com.example.term').done
    assert.equal(r.storage.hour(h.id)!.title, 'Alpha subagent', `${how}: the link to the deleted session is not known yet`)
    agents.apply('codex', [{ t: 'session', session: 'c', origin: 'subagent', parent: 'p', client: null, dir: '/code/alpha', branch: null, at: T0 + 8 * MIN }])
    assert.equal(r.q('SELECT 1 FROM agent_turns WHERE session_id = ?', 'g').length, 0, `${how}: the gate removed the subagent's records`)
    assert.deepEqual([r.storage.hour(h.id)!.title, r.storage.hour(h.id)!.status], [null, 'facts'], how)
    assert.equal(r.storage.search('subagent').length, 0, how)
    r.close()
  }
})

test('an hour whose packet was built before agent records it drew on were deleted is not written', async () => {
  resetSeq()
  const r = rig()
  r.clock.t = T0 + 3 * HOUR
  new AgentStore(r.store.database, () => r.clock.t).apply('codex', [
    { t: 'session', session: 'src', origin: 'interactive', parent: null, client: null, dir: '/code/alpha', branch: null, at: T0 + 5 * MIN },
    { t: 'session', session: 'fork', origin: 'interactive', parent: null, client: null, dir: '/code/alpha', branch: null, at: T0 + 20 * MIN },
    { t: 'turn', key: 'k0', session: 'fork', dir: '/code/alpha', branch: null, opener: 'user', start: T0 + 2 * MIN, replayed: true, source: 'src' },
  ])
  const basis = r.storage.hourBasis(T0)
  await r.storage.deleteAgentSession('codex', 'src')
  assert.throws(() => r.storage.writeHour({ start_wall_ms: T0, tz: 'z', status: 'written', title: 'Alpha in the fork', sources: [{ agent: 'codex', session: 'fork' }] }, basis), StaleHourError)
  assert.equal(r.storage.writeHour({ start_wall_ms: T0, tz: 'z', status: 'facts' }, r.storage.hourBasis(T0)).status, 'facts', 'a basis taken after the deletion writes')
  r.close()
})

test('a session deletion that drops as many app-deletion tombstones as it adds still refuses an older packet', async () => {
  resetSeq()
  const r = rig()
  const agents = new AgentStore(r.store.database, () => r.clock.t)
  agents.withheld = () => r.storage.withheld()
  agents.recordHost('codex', 'src', { app_id: 'com.example.term', name: 'Term', path: '/Applications/Term.app' }, 'responsible', T0)
  r.clock.t = T0 + 3 * HOUR
  agents.apply('codex', [
    { t: 'session', session: 'src', origin: 'interactive', parent: null, client: null, dir: '/code/alpha', branch: null, at: T0 + 5 * MIN },
    { t: 'session', session: 'fork', origin: 'interactive', parent: null, client: null, dir: '/code/alpha', branch: null, at: T0 + 20 * MIN },
    { t: 'turn', key: 'k0', session: 'fork', dir: '/code/alpha', branch: null, opener: 'user', start: T0 + 2 * MIN, replayed: true, source: 'src' },
  ])
  for (const from of [T0 + 2 * HOUR, T0 + 2 * HOUR + 5 * MIN]) await r.storage.deleteSource('com.example.term', { from_wall_ms: from, to_wall_ms: from + MIN }).done
  assert.equal(r.q('SELECT 1 FROM agent_deleted_spans WHERE session_id = ?', 'src').length, 2)
  const basis = r.storage.hourBasis(T0)
  await r.storage.deleteAgentSession('codex', 'src')
  assert.throws(() => r.storage.writeHour({ start_wall_ms: T0, tz: 'z', status: 'written', title: 'Alpha in the fork', sources: [{ agent: 'codex', session: 'fork' }] }, basis), StaleHourError)
  r.close()
})

test('a version 4 database upgrades to 5 and its hours cite no observations until rewritten', () => {
  const r = rig()
  const h = r.storage.writeHour({ start_wall_ms: T0, tz: 'z', status: 'written', title: 'Before' }, r.storage.hourBasis(T0))
  r.close()
  const db = new Database(path.join(r.dir, DB_FILE))
  db.exec(`ALTER TABLE hours DROP COLUMN observations; DELETE FROM migrations WHERE name = 'hour_observations'; UPDATE meta SET value = '4' WHERE key = 'schema_version'`)
  db.close()
  const again = rig(r.dir)
  assert.equal(again.store.meta('schema_version'), '5')
  assert.deepEqual([again.storage.hour(h.id)!.title, again.storage.hour(h.id)!.observations], ['Before', []])
  again.close()
})
