import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import path from 'node:path'
import { AgentStore } from '../../capture/agents/store.ts'
import { DB_FILE } from '../../capture/store.ts'
import { DeletedMaterialError } from '../../storage/index.ts'
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
  const h = r.storage.writeHour({ start_wall_ms: T0, tz: 'Africa/Kigali', status: 'written', title: 'Wrote the plan', observations: [cited], writer: 'm' }, r.storage.hourBasis(T0))
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
