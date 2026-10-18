import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { ObservationRow } from '../../capture/normalize.ts'
import { DB_FILE, Store } from '../../capture/store.ts'
import { HOUR, rig, T0, tmpDir } from './support.ts'
import Database from 'better-sqlite3'
import { immediate, immediateRetrying, isBusy } from '../../storage/tx.ts'
import { app } from '../support/lines.ts'

function row(t: number, app: string, title: string): ObservationRow {
  return {
    run: 'seed', seq: 0, boot: 'b', platform: 'macos', source: 'seed', kind: 'focus', event_wall_ms: t, event_mono_us: t * 1000, tz: 'Africa/Kigali',
    tz_offset_min: 120, app_id: app, app_name: app, app_path: null, pid: 1, window: 'w', title, title_raw: null, title_state: 'ok', state: 'ok', detail: null,
  }
}

function hammer(dir: string, ms: number): Promise<number> {
  const w = new Worker(new URL('./hammer.ts', import.meta.url), { workerData: { file: path.join(dir, DB_FILE), ms } })
  return new Promise((resolve, reject) => {
    w.on('message', resolve)
    w.on('error', reject)
  })
}

test('a deletion finishes while another connection keeps committing', async () => {
  const r = rig()
  for (let i = 0; i < 9000; i++) r.store.insertObservation(row(T0 + i * 20_000, i % 3 ? 'com.example.editor' : 'com.example.chat', `item ${i} canary${i % 500}`))
  r.store.flush()
  r.clock.t = T0 + 9000 * 20_000 + HOUR
  const writes = hammer(r.dir, 2500)
  await new Promise((res) => setTimeout(res, 100))
  const result = await r.storage.deleteSource('com.example.chat').done
  assert.ok((await writes) > 100)
  assert.equal(result.observations, 3000)
  assert.deepEqual(r.q(`SELECT state FROM deletions`).length, 1)
  assert.notEqual(r.q<{ state: string }>(`SELECT state FROM deletions`)[0]!.state, 'pending')
  assert.deepEqual(r.q(`SELECT 1 FROM search_docs WHERE app_id = 'com.example.chat' LIMIT 1`), [])
  r.close()
})

test('a backfill completes while another connection keeps committing, and reports settled only when it has', async () => {
  const dir = tmpDir()
  const store = new Store(dir, { now: () => T0 })
  for (let i = 0; i < 8000; i++) store.insertObservation(row(T0 + i * 20_000, 'com.example.editor', `history ${i}`))
  store.close()
  const r = rig(dir)
  const writes = hammer(dir, 2500)
  await new Promise((res) => setTimeout(res, 100))
  r.storage.start()
  await r.storage.derivationSettled()
  assert.ok((await writes) > 100)
  assert.equal(r.q<{ n: number }>(`SELECT count(*) AS n FROM intervals`)[0]!.n, 8000)
  r.close()
})

test('a worker transaction retries while another connection holds the lock longer than the busy timeout', async () => {
  const r = rig()
  const db = new Database(path.join(r.dir, DB_FILE))
  db.pragma('busy_timeout = 20')
  const w = new Worker(new URL('./holdLock.ts', import.meta.url), { workerData: { file: path.join(r.dir, DB_FILE), ms: 300 } })
  await new Promise((res) => w.once('message', res))
  assert.throws(() => immediate(db, () => db.prepare(`INSERT INTO meta (key, value) VALUES ('t', '1')`).run()), (e: unknown) => isBusy(e))
  const t0 = Date.now()
  immediateRetrying(db, () => db.prepare(`INSERT INTO meta (key, value) VALUES ('t', '2') ON CONFLICT (key) DO UPDATE SET value = '2'`).run())
  assert.ok(Date.now() - t0 >= 200, 'waited for the other writer')
  assert.deepEqual(db.prepare(`SELECT value FROM meta WHERE key = 't'`).get(), { value: '2' })
  db.close()
  r.close()
})

test('automatic capture flushes land within 100 ms during a long deletion without entering failure', async (test) => {
  const r = rig()
  for (let i = 0; i < 60_000; i++) r.store.insertObservation(row(T0 + i * 20_000, i % 3 ? 'com.example.editor' : 'com.example.chat', `item ${i % 4000} plan canary${i % 500}`))
  r.store.flush()
  r.clock.t = T0 + 60_000 * 20_000 + HOUR
  const readers = [0, 1].map(() => new Worker(new URL('./reader.ts', import.meta.url), { workerData: { file: path.join(r.dir, DB_FILE), ms: 60_000 } }))
  const flushes: number[] = []
  const failures: number[] = []
  const startWrite = r.store.onWriteStart
  const endWrite = r.store.onWriteEnd
  let started: number | null = null
  let capture: ReturnType<typeof setInterval> | undefined
  try {
    const deletion = r.storage.deleteSource('com.example.chat')
    r.store.onWriteStart = () => { startWrite(); started ??= performance.now() }
    r.store.onWriteEnd = () => {
      endWrite()
      if (r.store.storeHealth().failingSinceWallMs !== null) failures.push(performance.now())
      if (r.store.storeHealth().pendingOps === 0 && started !== null) {
        flushes.push(performance.now() - started)
        started = null
      }
    }
    let writes = 0
    capture = setInterval(() => {
      r.clock.t += 1000
      r.store.insertObservation(row(r.clock.t, 'com.example.editor', `automatic live ${++writes}`))
      if (writes === 2) clearInterval(capture)
    }, 1000)
    const result = await deletion.done
    assert.equal(result.observations, 20_000)
    assert.equal(writes, 2, 'capture wrote once per second during the long deletion')
    test.diagnostic(`automatic flush latency: ${flushes.map((f) => f.toFixed(1)).join(', ')} ms`)
    assert.deepEqual(failures, [], 'contention never enters storage failure')
    assert.ok(flushes.length > 0, 'the store timer flushed capture during deletion')
    assert.ok(Math.max(...flushes) < 100, `automatic flush latency: ${flushes.map((f) => f.toFixed(1)).join(', ')} ms`)
    assert.equal(r.store.storeHealth().pendingOps, 0, 'no capture rows remain queued after deletion')
    assert.equal(r.store.query<{ n: number }>(`SELECT count(*) AS n FROM observations WHERE title LIKE 'automatic live %'`)[0]!.n, 2)
    assert.deepEqual(r.store.query(`SELECT value FROM meta WHERE key = 'derive_from'`), [])
  } finally {
    clearInterval(capture)
    for (const w of readers) await w.terminate()
    r.close()
  }
})

test('capture flushes yield a contended writer lock within 100 ms and retry every queued observation', async () => {
  const r = rig()
  const worker = new Worker(new URL('./holdLock.ts', import.meta.url), { workerData: { file: path.join(r.dir, DB_FILE), ms: 300 } })
  const released = new Promise<void>((resolve, reject) => {
    worker.on('message', (m) => { if (m === 'released') resolve() })
    worker.on('error', reject)
  })
  try {
    await new Promise((resolve) => worker.once('message', resolve))
    r.store.insertObservation(row(T0, 'com.example.editor', 'Queued during contention'))
    const start = performance.now()
    const flushed = r.store.flush()
    const elapsed = performance.now() - start
    assert.ok(elapsed < 100, `capture flush blocked for ${elapsed.toFixed(1)} ms`)
    assert.equal(flushed, false, 'contended work remains queued instead of waiting on the event loop')
    await released
    assert.equal(r.store.flush(), true)
    assert.deepEqual(r.q('SELECT title FROM observations'), [{ title: 'Queued during contention' }])
  } finally {
    await released
    await worker.terminate()
    r.close()
  }
})

const notes = app('com.example.notes', { engine: 'app_runtime', signer: 'TEAMNOTES1' })
const exclusion = { match: 'app_id' as const, value: 'com.example.blocked', label: 'Blocked', is_default: false }
const privacyActions = {
  pause: (r: ReturnType<typeof rig>) => r.storage.pause('hour'),
  delete: (r: ReturnType<typeof rig>) => r.storage.deleteLast(HOUR),
  addExclusion: (r: ReturnType<typeof rig>) => r.storage.addExclusion(exclusion),
  removeExclusion: (r: ReturnType<typeof rig>) => r.storage.removeExclusion('app_id', exclusion.value),
  keepTitles: (r: ReturnType<typeof rig>) => r.storage.keepTitles(notes),
  stopKeepingTitles: (r: ReturnType<typeof rig>) => r.storage.stopKeepingTitles(r.storage.keptTitleApps()[0]!.id),
}

for (const [name, action] of Object.entries(privacyActions)) {
  for (const ms of [50, 1300]) test(`user ${name} ${ms === 50 ? 'waits for a contended lock' : 'fails without a privacy change beyond the existing timeout'}`, async () => {
    const r = rig()
    if (name === 'removeExclusion') r.storage.addExclusion(exclusion)
    if (name === 'stopKeepingTitles') await r.storage.keepTitles(notes)
    r.store.insertObservation(row(T0, 'com.example.editor', 'Queued before privacy action'))
    const before = r.store.query(`SELECT * FROM change_log`)
    const worker = new Worker(new URL('./holdLock.ts', import.meta.url), { workerData: { file: path.join(r.dir, DB_FILE), ms } })
    const exited = new Promise<void>((resolve, reject) => { worker.once('exit', () => resolve()); worker.once('error', reject) })
    try {
      await new Promise((resolve) => worker.once('message', resolve))
      const start = performance.now()
      if (ms === 50) {
        const result = await action(r)
        if (name === 'delete') await (result as ReturnType<typeof r.storage.deleteLast>).done
        assert.ok(performance.now() - start >= 30, 'waited for the held lock')
        assert.ok(r.store.query(`SELECT * FROM change_log`).length > before.length)
        if (name === 'pause') assert.ok(r.storage.paused())
        assert.equal(r.store.storeHealth().pendingOps, 0)
      } else {
        await assert.rejects(async () => action(r), /storage is failing; nothing was changed/)
        const elapsed = performance.now() - start
        assert.ok(elapsed >= 900 && elapsed < 1250, `bounded wait took ${elapsed.toFixed(1)} ms`)
        assert.deepEqual(r.store.query(`SELECT * FROM change_log`), before)
        assert.equal(r.storage.paused(), null)
        assert.equal(r.store.storeHealth().pendingOps, 1)
      }
    } finally {
      await exited
      r.close()
    }
  })
}

test('automatic busy retries retain worker priority while the worker has work, and leave storage healthy', async () => {
  const r = rig()
  r.store.writerYields = () => true
  const events: string[] = []
  const begin = r.store.onWriteStart, end = r.store.onWriteEnd
  r.store.onWriteStart = () => { events.push('begin'); begin() }
  r.store.onWriteEnd = () => { events.push('end'); end() }
  const worker = new Worker(new URL('./holdLock.ts', import.meta.url), { workerData: { file: path.join(r.dir, DB_FILE), ms: 1050 } })
  const exited = new Promise<void>((resolve, reject) => { worker.once('exit', () => resolve()); worker.once('error', reject) })
  try {
    await new Promise((resolve) => worker.once('message', resolve))
    r.store.insertObservation(row(T0, 'com.example.editor', 'automatic contention'))
    await new Promise((resolve) => setTimeout(resolve, 1010))
    assert.equal(r.store.storeHealth().failingSinceWallMs, null)
    assert.deepEqual(events, ['begin'], 'worker priority remains held between retries')
    await exited
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(r.store.storeHealth().pendingOps, 0)
    assert.deepEqual(events, ['begin', 'end'])
    assert.equal(r.store.query(`SELECT title FROM observations`).length, 1)
  } finally { await exited; r.close() }
})

test('a contended derivation retries automatically even when all capture rows already committed', async () => {
  const r = rig()
  const derive = r.store.onFlushed
  const locked = new Int32Array(new SharedArrayBuffer(4))
  let worker: Worker | undefined
  let exited: Promise<void> | undefined
  let tries = 0
  r.store.onFlushed = (ids) => {
    if (++tries === 1) {
      worker = new Worker(new URL('./holdLock.ts', import.meta.url), { workerData: { file: path.join(r.dir, DB_FILE), ms: 50, locked } })
      exited = new Promise<void>((resolve, reject) => { worker!.once('exit', () => resolve()); worker!.once('error', reject) })
      Atomics.wait(locked, 0, 0, 5000)
      assert.equal(Atomics.load(locked, 0), 1)
    }
    derive(ids)
  }
  try {
    r.store.insertObservation(row(T0, 'com.example.editor', 'Derived after contention'))
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.ok(tries > 1, 'derivation retried without another capture write')
    assert.equal(r.store.storeHealth().failingSinceWallMs, null)
    assert.deepEqual(r.store.query(`SELECT value FROM meta WHERE key = 'derive_from'`), [])
    assert.equal(r.store.query(`SELECT * FROM intervals`).length, 1)
  } finally { await exited; r.close() }
})

test('every privacy action succeeds while a long deletion commits back to back under readers', async () => {
  const r = rig()
  for (let i = 0; i < 60_000; i++) r.store.insertObservation(row(T0 + i * 20_000, i % 3 ? 'com.example.editor' : 'com.example.chat', `item ${i % 4000} plan canary${i % 500}`))
  r.store.flush()
  r.clock.t = T0 + 60_000 * 20_000 + HOUR
  const readers = [0, 1].map(() => new Worker(new URL('./reader.ts', import.meta.url), { workerData: { file: path.join(r.dir, DB_FILE), ms: 60_000 } }))
  const steps: [string, () => unknown][] = [
    ['pause', () => r.storage.pause('hour')],
    ['resume', () => r.storage.resume()],
    ['addExclusion', () => r.storage.addExclusion(exclusion)],
    ['delete', () => r.storage.deleteRange(T0 - 2 * HOUR, T0 - HOUR)],
    ['removeExclusion', () => r.storage.removeExclusion('app_id', exclusion.value)],
    ['keepTitles', () => r.storage.keepTitles(notes)],
    ['stopKeepingTitles', () => r.storage.stopKeepingTitles(r.storage.keptTitleApps()[0]!.id)],
  ]
  const failures: string[] = []
  const succeeded = new Map<string, number>()
  try {
    const deletion = r.storage.deleteSource('com.example.chat')
    let finished = false
    void deletion.done.finally(() => { finished = true })
    for (let i = 0; !finished; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50 + (i % 6) * 10))
      if (finished) break
      const [name, action] = steps[i % steps.length]!
      r.clock.t += 1000
      try {
        await action()
        succeeded.set(name, (succeeded.get(name) ?? 0) + 1)
      } catch (err) {
        failures.push(`${name}: ${(err as Error).message}`)
      }
    }
    assert.equal((await deletion.done).observations, 20_000)
    await r.storage.deletionsSettled()
    assert.deepEqual(failures, [], 'no privacy action failed during the deletion')
    for (const [name] of steps) assert.ok((succeeded.get(name) ?? 0) > 0, `${name} ran during the deletion`)
  } finally {
    for (const w of readers) await w.terminate()
    r.close()
  }
})

test('a pause that expires while the lock is held stays paused, is retried without throwing, and ends at its end time', async () => {
  const errors: { code: string; paused: boolean }[] = []
  const r: ReturnType<typeof rig> = rig(undefined, { onError: (code) => errors.push({ code, paused: r.storage.paused() !== null }) })
  const until = r.clock.t + 300
  r.storage.pause(until)
  const worker = new Worker(new URL('./holdLock.ts', import.meta.url), { workerData: { file: path.join(r.dir, DB_FILE), ms: 1500 } })
  const exited = new Promise<void>((resolve, reject) => { worker.once('exit', () => resolve()); worker.once('error', reject) })
  try {
    await new Promise((resolve) => worker.once('message', resolve))
    r.clock.t = until + 1
    await exited
    for (let i = 0; i < 100 && r.storage.paused(); i++) await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(errors.length > 0 && errors.every((e) => e.code === 'pause_expiry_SQLITE_BUSY' && e.paused), JSON.stringify(errors))
    assert.equal(r.storage.paused(), null, 'the pause ended once the lock was free')
    assert.deepEqual(r.q('SELECT ended_wall_ms FROM pauses'), [{ ended_wall_ms: until }])
    assert.deepEqual(r.q(`SELECT end_wall_ms FROM capture_gaps WHERE reason = 'paused'`), [{ end_wall_ms: until }])
  } finally {
    await exited
    r.close()
  }
})

function countTransactions(store: Store): { n: number } {
  const db = store.database
  const begin = db.transaction.bind(db)
  const count = { n: 0 }
  db.transaction = ((fn: Parameters<typeof db.transaction>[0]) => (count.n++, begin(fn))) as typeof db.transaction
  return count
}

test('contended flushes back off instead of polling, and release worker priority when the worker has no work', async () => {
  const dir = tmpDir()
  const store = new Store(dir, { now: () => T0 })
  const events: string[] = []
  store.onWriteStart = () => events.push('begin')
  store.onWriteEnd = () => events.push('end')
  const attempts = countTransactions(store)
  const blocker = new Database(path.join(dir, DB_FILE))
  blocker.exec('BEGIN IMMEDIATE')
  try {
    store.insertObservation(row(T0, 'com.example.editor', 'held off'))
    store.flush()
    await new Promise((resolve) => setTimeout(resolve, 3000))
    assert.ok(attempts.n < 40, `${attempts.n} flush attempts in 3 s`)
    assert.equal(events.at(-1), 'end', 'worker priority is not held while nothing yields to capture')
    blocker.exec('COMMIT')
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(store.storeHealth().pendingOps, 0)
    assert.equal(store.query(`SELECT title FROM observations`).length, 1)
  } finally {
    if (blocker.inTransaction) blocker.exec('COMMIT')
    blocker.close()
    store.close()
  }
})

test('contention that outlasts the report threshold shows in health while retries continue', async () => {
  const dir = tmpDir()
  const errors: string[] = []
  const store = new Store(dir, { now: () => T0, contentionReportMs: 300, onError: (c) => errors.push(c) })
  const blocker = new Database(path.join(dir, DB_FILE))
  blocker.exec('BEGIN IMMEDIATE')
  try {
    store.insertObservation(row(T0, 'com.example.editor', 'held off'))
    store.flush()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(!store.storeHealth().contendedSinceWallMs, 'brief contention is not reported')
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(store.storeHealth().contendedSinceWallMs, T0)
    assert.equal(store.storeHealth().failingSinceWallMs, null)
    assert.equal(store.storeHealth().pendingOps, 1)
    blocker.exec('COMMIT')
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(store.storeHealth().contendedSinceWallMs, null)
    assert.equal(store.storeHealth().pendingOps, 0)
    assert.deepEqual(errors, [])
  } finally {
    if (blocker.inTransaction) blocker.exec('COMMIT')
    blocker.close()
    store.close()
  }
})

test('closing while another writer holds the lock reports every unwritten op', () => {
  const dir = tmpDir()
  const errors: string[] = []
  const store = new Store(dir, { now: () => T0, busyTimeoutMs: 50, onError: (c) => errors.push(c) })
  const blocker = new Database(path.join(dir, DB_FILE))
  blocker.exec('BEGIN IMMEDIATE')
  try {
    for (let i = 0; i < 3; i++) store.insertObservation(row(T0 + i, 'com.example.editor', `unwritten ${i}`))
    assert.equal(store.flush(), false)
    const start = performance.now()
    store.close()
    assert.ok(performance.now() - start >= 40, 'close made a final attempt that waited for the lock')
    assert.deepEqual(errors, ['unwritten_at_close_3'])
  } finally {
    blocker.exec('COMMIT')
    blocker.close()
  }
})

test('a same-connection lock error is a failure, not contention: it is reported once and never holds a deletion back', async () => {
  const errors: string[] = []
  const r = rig(undefined, { onError: (c) => errors.push(c) })
  for (let i = 0; i < 50; i++) r.store.insertObservation(row(T0 + i * 20_000, i % 2 ? 'com.example.editor' : 'com.example.chat', `item ${i}`))
  r.store.flush()
  r.clock.t = T0 + HOUR
  const refresh = r.storage.derived.refreshFromMark
  let calls = 0
  r.storage.derived.refreshFromMark = () => {
    calls++
    throw Object.assign(new Error('database table is locked'), { code: 'SQLITE_LOCKED' })
  }
  try {
    r.store.insertObservation(row(T0 + 50 * 20_000, 'com.example.editor', 'derivation fails'))
    r.store.flush()
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(calls, 1, 'not retried as contention')
    assert.deepEqual(errors, ['derive_SQLITE_LOCKED'])
    const deletion = r.storage.deleteSource('com.example.chat')
    const result = await Promise.race([deletion.done, new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))])
    assert.equal(result?.observations, 25, 'the deletion finished')
    assert.equal(isBusy({ code: 'SQLITE_LOCKED' }), false)
  } finally {
    r.storage.derived.refreshFromMark = refresh
    await r.storage.deletionsSettled()
    r.close()
  }
})
