import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { Normalizer, Privacy } from '../capture/normalize.ts'
import { assertNotV1, DB_FILE, Store } from '../capture/store.ts'
import { app, focus } from './support/lines.ts'

const T0 = 1_792_130_000_000
const CANARY = 'CANARY-5c1d-browser-title'

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'daylens-v2-store-'))
}

test('the V1 data folders and database files are refused', () => {
  const home = os.homedir()
  for (const dir of [
    path.join(home, 'Library', 'Application Support', 'Daylens'),
    path.join(home, 'Library', 'Application Support', 'DaylensWindows'),
    'C:\\Users\\me\\AppData\\Roaming\\Daylens',
  ]) {
    assert.throws(() => assertNotV1(dir), /refusing V1/, dir)
  }
  const sneaky = tmp()
  writeFileSync(path.join(sneaky, 'daylens.sqlite'), '')
  assert.throws(() => new Store(sneaky), /V1 database/)
  assert.doesNotThrow(() => assertNotV1(path.join(home, 'Library', 'Application Support', 'Daylens V2 Dev')))
})

test('observations, merges and gaps are committed within a flush', () => {
  const dir = tmp()
  const store = new Store(dir, { now: () => T0 + 5 })
  const n = new Normalizer(store, new Privacy(store.exclusions()))
  n.handle(focus(app('com.apple.Terminal'), '⠋ build', T0, 'app_changed'))
  n.handle(focus(app('com.apple.Terminal'), '⠙ build', T0 + 1000))
  n.handle(focus(app('com.1password.1password'), 'vault', T0 + 2000, 'app_changed'))
  n.handle(focus(app('com.apple.Terminal'), 'build', T0 + 3000, 'app_changed'))
  store.close()
  const db = new Database(path.join(dir, DB_FILE), { readonly: true })
  const rows = db.prepare('SELECT title, title_raw, repeat_count, last_seen_wall_ms, recorded_wall_ms FROM observations ORDER BY id').all()
  assert.deepEqual(rows, [
    { title: 'build', title_raw: '⠋ build', repeat_count: 1, last_seen_wall_ms: T0 + 1000, recorded_wall_ms: T0 + 5 },
    { title: 'build', title_raw: null, repeat_count: 0, last_seen_wall_ms: T0 + 3000, recorded_wall_ms: T0 + 5 },
  ])
  const gaps = db.prepare('SELECT reason, scope, start_wall_ms, end_wall_ms FROM capture_gaps').all()
  assert.deepEqual(gaps, [{ reason: 'excluded', scope: 'all', start_wall_ms: T0 + 2000, end_wall_ms: T0 + 3000 }])
  assert.ok((db.prepare('SELECT count(*) AS c FROM exclusions').get() as { c: number }).c >= 10)
  db.close()
})

test('a browser title never reaches the database file or its sidecars', () => {
  const dir = tmp()
  const store = new Store(dir)
  const n = new Normalizer(store, new Privacy(store.exclusions()))
  for (let i = 0; i < 50; i++) {
    n.handle(focus(app('com.google.Chrome'), `${CANARY} ${i}`, T0 + i, i === 0 ? 'app_changed' : 'title_changed'))
    n.handle(focus(app('com.example.Unknown', { identity_state: 'access_denied' }), `${CANARY} unknown ${i}`, T0 + i))
  }
  store.flush()
  for (const f of readdirSync(dir)) {
    assert.ok(!readFileSync(path.join(dir, f)).includes(CANARY), `${f} contains the canary`)
  }
  store.close()
  for (const f of readdirSync(dir)) {
    assert.ok(!readFileSync(path.join(dir, f)).includes(CANARY), `${f} contains the canary after close`)
  }
})

test('previous coverage: a clean stop and a crash are told apart', () => {
  const dir = tmp()
  let now = T0
  const s1 = new Store(dir, { now: () => now })
  s1.markServiceStarted()
  s1.startRun({ v: 1, run: 'r1', seq: 0, boot: 'b', t: { wall_ms: T0, mono_us: 1, tz: 'UTC', tz_offset_min: 0 }, platform: 'macos', source: 'helper', kind: 'hello',
    obs: { helper: 'h', version: '1', pid: 1, os: 'x', permissions: { accessibility: 'granted' }, config: { heartbeat_s: 15, idle_threshold_s: 120, reconcile_s: 60 } } })
  s1.recordHeartbeat({ v: 1, run: 'r1', seq: 1, boot: 'b', t: { wall_ms: T0 + 15_000, mono_us: 2, tz: 'UTC', tz_offset_min: 0 }, platform: 'macos', source: 'helper', kind: 'heartbeat',
    obs: { awake_us: 2, permissions: { accessibility: 'granted' }, titles: 'ok', stall_ms: 0, dropped: 0 } })
  s1.close()
  const crashed = new Store(dir)
  assert.deepEqual(crashed.previousCoverage(), { endWallMs: T0 + 15_000, clean: false })
  crashed.markServiceStopped(T0 + 20_000)
  crashed.close()
  const stopped = new Store(dir)
  assert.deepEqual(stopped.previousCoverage(), { endWallMs: T0 + 20_000, clean: true })
  stopped.close()
})

test('dangling gaps from a dead service are closed at its last coverage', () => {
  const dir = tmp()
  const s1 = new Store(dir)
  s1.openGap({ reason: 'excluded', scope: 'all', run: 'r1', start: { wall_ms: T0, mono_us: 1, boot: 'b' }, detail: null })
  s1.close()
  const s2 = new Store(dir)
  s2.closeDanglingGaps({ wall_ms: T0 + 9000, mono_us: null, boot: null })
  assert.deepEqual(s2.query('SELECT end_wall_ms FROM capture_gaps'), [{ end_wall_ms: T0 + 9000 }])
  s2.close()
})

test('a locked database delays writes without losing them', () => {
  const dir = tmp()
  const errors: string[] = []
  const store = new Store(dir, { busyTimeoutMs: 10, onError: (c) => errors.push(c) })
  const n = new Normalizer(store)
  const blocker = new Database(path.join(dir, DB_FILE))
  blocker.exec('BEGIN EXCLUSIVE')
  for (let i = 0; i < 20; i++) n.handle(focus(app('com.apple.Terminal', { pid: i }), `t${i}`, T0 + i))
  assert.equal(store.flush(), false)
  assert.ok(store.storeHealth().failingSinceWallMs !== null)
  assert.ok(errors.every((c) => /^SQLITE_[A-Z_]+$/.test(c)), 'errors are reported as codes only')
  blocker.exec('COMMIT')
  blocker.close()
  assert.equal(store.flush(), true)
  assert.equal(store.storeHealth().failingSinceWallMs, null)
  assert.equal(store.query<{ c: number }>('SELECT count(*) AS c FROM observations')[0]!.c, 20)
  assert.equal(store.query<{ c: number }>(`SELECT count(*) AS c FROM capture_gaps WHERE reason = 'storage_failed'`)[0]!.c, 0)
  store.close()
})

test('a long storage outage that overflows the queue is recorded as a gap', () => {
  const dir = tmp()
  let now = T0
  const store = new Store(dir, { busyTimeoutMs: 10, maxPendingOps: 5, now: () => now })
  const n = new Normalizer(store)
  const events: string[] = []
  store.onOverflow = () => {
    events.push('overflow')
    n.interrupt({ wall_ms: now, mono_us: null, boot: null })
  }
  store.onRecovered = () => events.push('recovered')
  const blocker = new Database(path.join(dir, DB_FILE))
  blocker.exec('BEGIN EXCLUSIVE')
  for (let i = 0; i < 12; i++) n.handle(focus(app('com.apple.Terminal', { pid: i }), `t${i}`, T0 + i))
  store.flush()
  now = T0 + 60_000
  blocker.exec('COMMIT')
  blocker.close()
  store.flush()
  const gaps = store.query<{ reason: string; start_wall_ms: number; end_wall_ms: number; detail: string }>('SELECT reason, start_wall_ms, end_wall_ms, detail FROM capture_gaps')
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0]!.reason, 'storage_failed')
  assert.equal(gaps[0]!.end_wall_ms, T0 + 60_000)
  assert.deepEqual(JSON.parse(gaps[0]!.detail), { dropped_ops: 7 })
  assert.deepEqual(events, ['overflow', 'recovered'], 'one overflow episode, one recovery')
  n.handle(focus(app('com.apple.Terminal', { pid: 11 }), 't11', T0 + 70_000, 'reconcile'))
  store.flush()
  assert.equal(store.query<{ c: number }>(`SELECT count(*) AS c FROM observations WHERE title = 't11'`)[0]!.c, 1, 'the open row is re-inserted, not extended into a dropped id')
  store.close()
})

test('one bad statement does not block the rest of the batch', () => {
  const dir = tmp()
  const store = new Store(dir)
  const n = new Normalizer(store)
  n.handle(focus(app('com.apple.Terminal'), 'a', T0))
  store.flush()
  const id = store.insertObservation({
    run: 'r', seq: 0, boot: 'b', platform: 'macos', source: 's', kind: 'focus', event_wall_ms: T0, event_mono_us: 0, tz: 'UTC', tz_offset_min: 0,
    app_id: null, app_name: null, app_path: null, pid: null, window: null, title: null, title_raw: null, title_state: null, state: null, detail: null,
  })
  store.query('INSERT INTO observations (id, run, seq, boot, platform, source, kind, event_wall_ms, event_mono_us, tz, tz_offset_min, recorded_wall_ms, last_seen_wall_ms) VALUES (?, \'x\', 0, \'b\', \'macos\', \'s\', \'focus\', 0, 0, \'UTC\', 0, 0, 0) RETURNING id', id)
  n.handle(focus(app('com.apple.Notes'), 'b', T0 + 1, 'app_changed'))
  assert.equal(store.flush(), true)
  assert.equal(store.query<{ c: number }>(`SELECT count(*) AS c FROM observations WHERE app_id = 'com.apple.Notes'`)[0]!.c, 1)
  store.close()
})

test('a nested V1-looking path below the data dir is refused too', () => {
  const base = tmp()
  const nested = path.join(base, 'Daylens', 'sub')
  mkdirSync(nested, { recursive: true })
  assert.throws(() => new Store(nested), /refusing V1/)
})

test('only one service may write a data folder at a time', () => {
  const dir = tmp()
  const a = new Store(dir)
  assert.throws(() => new Store(dir), /another capture service/)
  a.close()
  const b = new Store(dir)
  b.close()
})

test('a gap closed before it started collapses to empty instead of going negative', () => {
  const dir = tmp()
  const s = new Store(dir)
  const id = s.openGap({ reason: 'excluded', scope: 'all', run: null, start: { wall_ms: T0 + 5000, mono_us: null, boot: null }, detail: null })
  s.closeGap(id, { wall_ms: T0, mono_us: null, boot: null })
  s.flush()
  assert.deepEqual(s.query('SELECT start_wall_ms, end_wall_ms FROM capture_gaps'), [{ start_wall_ms: T0 + 5000, end_wall_ms: T0 + 5000 }])
  s.close()
})
