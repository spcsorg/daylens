import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { Normalizer, Privacy } from '../capture/normalize.ts'
import { assertNotV1, DB_FILE, Store, type StoreHealth } from '../capture/store.ts'
import { wireStorageRecovery } from '../capture/supervisor.ts'
import { app, focus, line } from './support/lines.ts'
import { tempDir } from './support/tmp.ts'

const T0 = 1_792_130_000_000
const CANARY = 'CANARY-5c1d-browser-title'

function tmp(): string {
  return tempDir('daylens-v2-store-')
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

test('previous coverage: the latest checkpoint wins, a clean stop is authoritative, and a crash is unclean', () => {
  const dir = tmp()
  const s1 = new Store(dir)
  s1.markServiceStarted(T0)
  s1.writeCheckpoint({ wall_ms: T0 + 15_000, mono_us: 2_000_000, boot: 'b', boot_identity: 'kernel', clean: false })
  s1.close()
  const crashed = new Store(dir)
  assert.deepEqual(crashed.previousCoverage(), { endWallMs: T0 + 15_000, clean: false, monoUs: 2_000_000, boot: 'b', bootIdentity: 'kernel' })
  crashed.writeCheckpoint({ wall_ms: T0 + 20_000, mono_us: 7_000_000, boot: 'b', boot_identity: 'kernel', clean: true })
  crashed.close()
  const stopped = new Store(dir)
  assert.deepEqual(stopped.previousCoverage(), { endWallMs: T0 + 20_000, clean: true, monoUs: 7_000_000, boot: 'b', bootIdentity: 'kernel' })
  stopped.close()
})

test('a clock rolled back after a later-dated write does not hide behind the largest wall time', () => {
  const dir = tmp()
  const s = new Store(dir)
  s.insertObservation({
    run: 'r', seq: 0, boot: 'b', platform: 'macos', source: 's', kind: 'focus', event_wall_ms: T0 + 3_600_000, event_mono_us: 1, tz: 'UTC', tz_offset_min: 0,
    app_id: null, app_name: null, app_path: null, pid: null, window: null, title: null, title_raw: null, title_state: null, state: null, detail: null,
  })
  s.writeCheckpoint({ wall_ms: T0 + 3_600_000, mono_us: 10_000_000, boot: 'b', clean: false })
  s.writeCheckpoint({ wall_ms: T0 + 60_000, mono_us: 70_000_000, boot: 'b', clean: false })
  s.close()
  const again = new Store(dir)
  assert.equal(again.previousCoverage()!.endWallMs, T0 + 60_000, 'the last checkpoint written, not the largest wall time')
  again.close()
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
  assert.equal(store.storeHealth().failingSinceWallMs, null)
  assert.deepEqual(errors, [], 'contention is not a storage failure')
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

test('a full write queue and writes held off by another writer are reported, and so is their end', () => {
  const dir = tmp()
  let now = T0
  const errors: string[] = []
  const store = new Store(dir, { busyTimeoutMs: 10, maxPendingOps: 5, contentionReportMs: 0, now: () => now, onError: (c) => errors.push(c) })
  const health: StoreHealth[] = []
  store.onHealth = (h) => health.push(h)
  const n = new Normalizer(store)
  const blocker = new Database(path.join(dir, DB_FILE))
  blocker.exec('BEGIN EXCLUSIVE')
  for (let i = 0; i < 12; i++) n.handle(focus(app('com.apple.Terminal', { pid: i }), `t${i}`, T0 + i))
  store.flush()
  assert.deepEqual(errors, ['write_queue_full', 'write_contended'])
  const during = health.at(-1)!
  assert.equal(during.droppedOps, 7)
  assert.equal(during.contendedSinceWallMs, T0)
  now = T0 + 60_000
  blocker.exec('COMMIT')
  blocker.close()
  store.flush()
  const after = health.at(-1)!
  assert.equal(after.contendedSinceWallMs, null, 'the end of the contention is published')
  assert.equal(after.droppedOps, 7, 'what was dropped stays in health')
  assert.deepEqual(errors, ['write_queue_full', 'write_contended'], 'each is reported once per episode')
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

test('a database file linked to another database is refused and the target is untouched', () => {
  const v1 = path.join(tmp(), 'v1-lookalike.sqlite')
  const db = new Database(v1)
  db.exec("CREATE TABLE focus_events (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO focus_events (title) VALUES ('v1 row')")
  db.close()
  const hash = () => createHash('sha256').update(readFileSync(v1)).digest('hex')
  const before = hash()
  for (const suffix of ['', '-wal']) {
    const dir = tmp()
    symlinkSync(suffix ? v1 + '-elsewhere' : v1, path.join(dir, DB_FILE + suffix))
    assert.throws(() => new Store(dir), /linked database file/)
  }
  assert.equal(hash(), before)
})

test('two processes starting at the same instant: exactly one gets the writer lock, every time', async () => {
  const { spawn } = await import('node:child_process')
  const racer = new URL('./support/lockRacer.ts', import.meta.url).pathname
  for (let round = 0; round < 8; round++) {
    const dir = tmp()
    const go = path.join(dir, 'go')
    const release = path.join(dir, 'release')
    const racers = [0, 1, 2].map(() => {
      const p = spawn(process.execPath, [racer, dir, go, release], { stdio: ['ignore', 'pipe', 'inherit'] })
      const lines: string[] = []
      const said = (n: number) => new Promise<void>((resolve) => {
        const check = () => { if (lines.length >= n) resolve() }
        p.stdout!.on('data', check)
        p.on('exit', resolve)
        check()
      })
      p.stdout!.setEncoding('utf8').on('data', (c: string) => lines.push(...c.split('\n').filter(Boolean)))
      return { lines, said, exited: new Promise((resolve) => p.on('exit', resolve)) }
    })
    await Promise.all(racers.map((r) => r.said(1)))
    writeFileSync(go, '')
    await Promise.all(racers.map((r) => r.said(2)))
    writeFileSync(release, '')
    await Promise.all(racers.map((r) => r.exited))
    const results = racers.map((r) => r.lines[1])
    assert.equal(results.filter((x) => x === 'locked').length, 1, `round ${round}: ${results.join(',')}`)
    assert.equal(results.filter((x) => x === 'refused').length, 2, `round ${round}: ${results.join(',')}`)
  }
})

test('a writer that dies without cleaning up does not block the next one', async () => {
  const { spawnSync } = await import('node:child_process')
  const dir = tmp()
  const code = `import { Store } from ${JSON.stringify(new URL('../capture/store.ts', import.meta.url).pathname)}; new Store(${JSON.stringify(dir)}); process.kill(process.pid, 'SIGKILL')`
  spawnSync(process.execPath, ['--input-type=module', '-e', code])
  const s = new Store(dir)
  s.close()
})

test('continued overflow while one title stays unchanged: after recovery that title has a stored row', () => {
  const dir = tmp()
  let now = T0
  const store = new Store(dir, { busyTimeoutMs: 10, maxPendingOps: 4, now: () => now })
  const n = new Normalizer(store)
  const term = app('com.apple.Terminal')
  let snapshots = 0
  wireStorageRecovery(store, n, () => ({ wall_ms: now, mono_us: null, boot: null }), () => {
    snapshots++
    n.handle(focus(term, 'build — zsh', now, 'snapshot'))
  })
  const blocker = new Database(path.join(dir, DB_FILE))
  blocker.exec('BEGIN EXCLUSIVE')
  n.handle(focus(term, 'build — zsh', T0, 'app_changed'))
  // Repeats of the same title keep overflowing the queue, past the first overflow, dropping every insert.
  // Other writes (input changes) keep overflowing the queue past the first overflow, while the same window stays in front.
  for (let i = 1; i <= 40; i++) {
    now = T0 + i * 60_000
    n.handle(line('input', { state: i % 2 ? 'idle' : 'active', last_input_wall_ms: now, threshold_s: 120, snapshot: false }, now))
    n.handle(line('input', { state: i % 2 ? 'active' : 'idle', last_input_wall_ms: now, threshold_s: 120, snapshot: false }, now + 1))
    n.handle(focus(term, 'build — zsh', now + 2, 'reconcile'))
    store.flush()
  }
  blocker.exec('COMMIT')
  blocker.close()
  now = T0 + 41 * 60_000
  assert.equal(store.flush(), true)
  store.flush()
  n.handle(focus(term, 'build — zsh', now + 5000, 'reconcile'))
  store.flush()
  assert.equal(snapshots, 1)
  const rows = store.query<{ title: string; last_seen_wall_ms: number }>(`SELECT title, last_seen_wall_ms FROM observations WHERE title = 'build — zsh'`)
  assert.ok(rows.length >= 1, 'the current window is stored after recovery')
  assert.equal(Math.max(...rows.map((r) => r.last_seen_wall_ms)), now + 5000, 'and keeps being extended')
  store.close()
})
