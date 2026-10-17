import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { applyMigrations } from '../../storage/migrations.ts'
import { ChangeWatcher, SIGNAL_FILE } from '../../storage/changes.ts'
import { writeFileSync } from 'node:fs'
import { DB_FILE } from '../../capture/store.ts'
import { rig as open, T0 } from './support.ts'

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

test('a watcher reconciles the log at start even with no signal, and retries until the signalled change is visible', async () => {
  const s = open()
  const reader = new Database(path.join(s.dir, DB_FILE), { readonly: true })
  const seen: number[] = []
  const w = new ChangeWatcher(reader, s.dir, (c) => seen.push(c.seq), 0)
  // Written without a signal (as if the signal write was lost), before the watcher starts.
  s.storage.db.prepare(`INSERT INTO change_log (at_wall_ms, kind, payload) VALUES (1, 'setting', '{}')`).run()
  w.start()
  assert.deepEqual(seen, [1], 'reconciled at start')
  // A signal that runs ahead of what this reader can see yet.
  writeFileSync(path.join(s.dir, SIGNAL_FILE), '2')
  // The OS event can be slow under load; deliver it directly, since the retry is what is under test.
  w.onFsEvent(SIGNAL_FILE)
  await new Promise((r) => setTimeout(r, 150))
  s.storage.db.prepare(`INSERT INTO change_log (at_wall_ms, kind, payload) VALUES (2, 'setting', '{}')`).run()
  const t0 = Date.now()
  while (seen.length < 2 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(seen, [1, 2], 'retried until the required change arrived')
  w.stop()
  reader.close()
  s.close()
})

test('a watcher reacts to the signal however the platform names the rename', () => {
  const s = open()
  const reader = new Database(path.join(s.dir, DB_FILE), { readonly: true })
  const seen: number[] = []
  const w = new ChangeWatcher(reader, s.dir, (c) => seen.push(c.seq), 0)
  s.storage.db.prepare(`INSERT INTO change_log (at_wall_ms, kind, payload) VALUES (1, 'setting', '{}')`).run()
  w.onFsEvent(`${SIGNAL_FILE}.tmp`)
  assert.deepEqual(seen, [1])
  w.stop()
  reader.close()
  s.close()
})

test('retention announces what it removed, and a reader behind the pruned log is told to refresh fully', async () => {
  const s = open()
  const reader = new Database(path.join(s.dir, DB_FILE), { readonly: true })
  const seen: { kind: string; payload: Record<string, unknown> }[] = []
  let resets = 0
  const w = new ChangeWatcher(reader, s.dir, (c) => seen.push(c), 0, { onReset: () => resets++ })
  s.storage.setSetting('a', 1)
  s.storage.writeHour({ start_wall_ms: T0, tz: 'Africa/Kigali', status: 'facts' }, s.storage.hourBasis(T0))
  s.clock.t = T0 + 30 * 86_400_000
  s.storage.setRetentionDays(7)
  s.storage.stop()
  const local: Record<string, unknown>[] = []
  s.storage.bus.on((c) => local.push(c.payload))
  await s.storage.prune()
  assert.ok(local.some((p) => p.pruned === true), `the removal is announced: ${JSON.stringify(local)}`)
  w.catchUp()
  assert.equal(resets, 1, 'the reader learns it missed pruned announcements')
  assert.ok(seen.some((c) => c.payload.pruned === true))
  assert.ok(!seen.some((c) => c.kind === 'hour'), 'pruned announcements are not replayed')
  w.stop()
  reader.close()
  s.close()
})
