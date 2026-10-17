import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { applyMigrations } from '../../storage/migrations.ts'
import { DB_FILE } from '../../capture/store.ts'
import { rig as open } from './support.ts'

test('named migrations apply once and are recorded by name', () => {
  const db = new Database(':memory:')
  let runs = 0
  const m = [{ name: 'a_table', up: (d: Database.Database) => { runs++; d.exec('CREATE TABLE a (x)') } }]
  assert.deepEqual(applyMigrations(db, m), ['a_table'])
  assert.deepEqual(applyMigrations(db, m), [], 'a second run applies nothing')
  assert.equal(runs, 1)
  assert.deepEqual(db.prepare('SELECT name FROM migrations').all(), [{ name: 'a_table' }])
})

test('a change is announced in-process only after its write commits; a failed write announces nothing', () => {
  const s = open()
  const seen: string[] = []
  s.storage.bus.on((c: { seq: number; kind: string }) => seen.push(`${c.seq}:${c.kind}`))
  s.storage.bus.commit('setting', { key: 'k' }, () => s.storage.db.exec("CREATE TABLE IF NOT EXISTS t (x); INSERT INTO t VALUES (1)"))
  assert.throws(() => s.storage.bus.commit('setting', { key: 'boom' }, () => { s.storage.db.exec('INSERT INTO t VALUES (2)'); throw new Error('boom') }))
  assert.deepEqual(seen, ['1:setting'])
  assert.deepEqual(s.storage.db.prepare('SELECT x FROM t').all(), [{ x: 1 }], 'the failed write rolled back')
  assert.equal((s.storage.db.prepare('SELECT count(*) AS c FROM change_log').get() as { c: number }).c, 1)
  s.close()
})

test('another process follows announcements through the signal file without polling', async () => {
  const s = open()
  const reader = fileURLToPath(new URL('./watchReader.ts', import.meta.url))
  const child = spawn(process.execPath, [reader, s.dir, path.join(s.dir, DB_FILE)], { stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d))
  await new Promise((r) => setTimeout(r, 600))
  const t0 = Date.now()
  s.storage.bus.commit('correction', { hour: 1 }, () => {})
  s.storage.bus.commit('deletion', { id: 1 }, () => {})
  while (!out.includes('deletion') && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20))
  const latency = Date.now() - t0
  child.kill()
  assert.match(out, /correction[\s\S]*deletion/)
  assert.ok(latency < 1000, `seen in ${latency} ms`)
  s.close()
})
