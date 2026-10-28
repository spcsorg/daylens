import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { ObservationRow } from '../../capture/normalize.ts'
import { DB_FILE, Store, WAL_AUTOCHECKPOINT } from '../../capture/store.ts'
import { diskContains, HOUR, rig, T0, tmpDir } from './support.ts'
import Database from 'better-sqlite3'
import { immediate, immediateRetrying, isBusy } from '../../storage/tx.ts'
import { Deleter, DeletionWorker, FTS_MERGE_PENDING } from '../../storage/deletion.ts'
import { readStructure } from '../../storage/ftsStructure.ts'
import { app } from '../support/lines.ts'

async function eventually(done: () => boolean, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; !done() && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 20))
}

function row(t: number, app: string, title: string): ObservationRow {
  return {
    run: 'seed', seq: 0, boot: 'b', platform: 'macos', source: 'seed', kind: 'focus', event_wall_ms: t, event_mono_us: t * 1000, tz: 'Example/Town',
    tz_offset_min: -300, app_id: app, app_name: app, app_path: null, pid: 1, window: 'w', title, title_raw: null, title_state: 'ok', state: 'ok', detail: null,
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
  assert.ok((await writes) > 0, 'the other connection committed while the deletion ran')
  assert.equal(result.observations, 3000)
  assert.deepEqual(r.q(`SELECT state FROM deletions`).length, 1)
  assert.notEqual(r.q<{ state: string }>(`SELECT state FROM deletions`)[0]!.state, 'pending')
  assert.deepEqual(r.q(`SELECT 1 FROM search_docs WHERE app_id = 'com.example.chat' LIMIT 1`), [])
  r.close()
})

// Search documents for two apps, written in shuffled order with window-title-length text. Splitting pages for writes
// in the middle of an index leaves copies of moved rows in the pages' free space, which secure_delete never clears.
function seedShuffledSearchDocs(dir: string, n: number): void {
  const db = new Database(path.join(dir, DB_FILE))
  const ins = db.prepare(`INSERT INTO search_docs (kind, hour_start_wall_ms, app_id, app_name, title, url, first_wall_ms, last_wall_ms) VALUES ('activity', ?, ?, ?, ?, '', ?, ?)`)
  const order = [...Array(n).keys()]
  for (let i = n - 1, x = 1; i > 0; i--) {
    x = (x * 48271) % 2147483647
    const j = x % (i + 1)
    ;[order[i], order[j]] = [order[j]!, order[i]!]
  }
  for (let b = 0; b < n; b += 100) {
    db.transaction(() => {
      for (const i of order.slice(b, b + 100)) {
        const chat = i % 3 === 0
        const hour = T0 + Math.floor(i / 600) * HOUR
        const title = chat ? `Quokkacanary ${i} private title, a long window title the way browsers and editors write them` : `editor item ${i} with a similarly long window title so pages fill the same way`
        ins.run(hour, chat ? 'com.example.chat' : 'com.example.editor', 'app', title, hour, hour + 1000)
      }
    })()
  }
  db.close()
}

test('purged means no deleted title is left in the files, including free space inside indexes', async () => {
  const r = rig()
  r.storage.start()
  await r.storage.derivationSettled()
  seedShuffledSearchDocs(r.dir, 6000)
  r.clock.t = T0 + 12 * HOUR
  const handle = r.storage.deleteSource('com.example.chat')
  assert.equal((await handle.done).searchDocs, 2000)
  await handle.purged
  assert.deepEqual(r.q(`SELECT state FROM deletions`), [{ state: 'purged' }])
  assert.deepEqual(diskContains(r.dir, 'Quokkacanary'), [])
  r.close()
})

test('removing search entries rewrites no index page in place; they stop matching at once, and the purge merges their terms away', async () => {
  const r = rig(tmpDir(), { holdDeletions: true })
  seedShuffledSearchDocs(r.dir, 3000)
  const db = r.store.database
  // One segment to start from, and the index's own merging, which follows any write, off: what the removal itself
  // writes is then all that changes.
  db.exec(`INSERT INTO search (search) VALUES ('optimize'); INSERT INTO search (search, rank) VALUES ('automerge', 0)`)
  const blocks = () => new Map((db.prepare('SELECT id, block FROM search_data WHERE id >= ?').all(2 ** 37) as { id: number; block: Buffer }[]).map((x) => [x.id, x.block]))
  const before = blocks()
  r.clock.t = T0 + 12 * HOUR
  const { tombstone } = r.storage.deleteSource('com.example.chat')
  const deleter = new Deleter(db)
  assert.equal(deleter.run(tombstone, r.clock.t).searchDocs, 1000)
  const after = blocks()
  const rewritten = [...before].filter(([id, b]) => after.has(id) && !after.get(id)!.equals(b)).length
  assert.equal(rewritten, 0, 'a removal only adds delete markers to the index; it rewrites none of its pages while holding the lock')
  assert.deepEqual(r.q(`SELECT rowid FROM search WHERE search MATCH 'Quokkacanary'`), [], 'removed entries stop matching at once')
  assert.deepEqual(r.q(`SELECT key FROM meta WHERE key = 'fts_merge_pending'`), [{ key: 'fts_merge_pending' }])
  assert.equal(deleter.purge(tombstone), true)
  assert.deepEqual(r.q(`SELECT key FROM meta WHERE key = 'fts_merge_pending'`), [])
  assert.deepEqual(r.q(`SELECT state FROM deletions`), [{ state: 'purged' }])
  assert.deepEqual(diskContains(r.dir, 'Quokkacanary'), [])
  assert.equal(r.q<{ n: number }>(`SELECT count(*) AS n FROM search WHERE search MATCH 'editor'`)[0]!.n, 2000, 'what was kept still matches')
  r.close()
})

// The tables that hold the search index's terms: its segments' pages and their page index.
function indexHolds(db: Database.Database, term: string): string[] {
  const needle = Buffer.from(term)
  const tables: string[] = []
  if ((db.prepare('SELECT block FROM search_data').pluck().all() as Buffer[]).some((b) => b.includes(needle))) tables.push('search_data')
  if ((db.prepare('SELECT term FROM search_idx').pluck().all() as Buffer[]).some((b) => Buffer.from(b).includes(needle))) tables.push('search_idx')
  return tables
}

// A purge that is still merging after this many steps is not going to finish; the tests fail instead of hanging.
const MERGE_STEP_CAP = 500

function cappedSteps(each: (step: number) => void = () => {}): () => void {
  let steps = 0
  return () => {
    if (++steps > MERGE_STEP_CAP) throw new Error(`the index merge was still running after ${MERGE_STEP_CAP} steps`)
    each(steps)
  }
}

test('the purge merge finishes while search entries are added between its steps, and leaves none of the removed terms', () => {
  const r = rig(tmpDir(), { holdDeletions: true })
  seedShuffledSearchDocs(r.dir, 3000)
  const db = r.store.database
  r.clock.t = T0 + 12 * HOUR
  const { tombstone } = r.storage.deleteSource('com.example.chat')
  const deleter = new Deleter(db)
  assert.equal(deleter.run(tombstone, r.clock.t).searchDocs, 1000)
  assert.ok(indexHolds(db, 'quokkacanary').includes('search_data'))
  // Capture's entries go in between steps, one transaction each: each a new segment, which FTS5 numbers with the
  // lowest id not in use, so they take the ids of segments the merge has removed.
  const add = db.prepare(`INSERT INTO search_docs (kind, hour_start_wall_ms, app_id, app_name, title, url, first_wall_ms, last_wall_ms) VALUES ('activity', ?, 'com.example.editor', 'Editor', ?, '', ?, ?)`)
  let added = 0
  deleter.mergeSearchIfPending(
    cappedSteps((n) => {
      const h = T0 + 24 * HOUR + n
      add.run(h, `live entry ${n}`, h, h)
      added = n
    }),
  )
  assert.deepEqual(r.q(`SELECT key FROM meta WHERE key = 'fts_merge_pending'`), [])
  assert.deepEqual(indexHolds(db, 'quokkacanary'), [], 'no removed term is left in the index')
  assert.deepEqual(r.q(`SELECT rowid FROM search WHERE search MATCH 'Quokkacanary'`), [])
  assert.equal(r.q<{ n: number }>(`SELECT count(*) AS n FROM search WHERE search MATCH 'live'`)[0]!.n, added)
  assert.equal(r.q<{ n: number }>(`SELECT count(*) AS n FROM search WHERE search MATCH 'editor'`)[0]!.n, 2000)
  r.close()
})

// Writes and merges replayed in order, to bring the index's segments into a given shape: 'kept n' and 'canary n'
// add entries in one transaction, 'del' removes every canary entry, '-N' merges all segments and '+n' merges n pages.
function replayIndex(db: Database.Database, ops: readonly string[]): void {
  const ins = db.prepare(`INSERT INTO search_docs (kind, hour_start_wall_ms, app_id, app_name, title, url, first_wall_ms, last_wall_ms) VALUES ('activity', ?, ?, 'x', ?, '', ?, ?)`)
  let c = 0
  for (const op of ops) {
    const [kind, arg] = op.startsWith('+') || op.startsWith('-') ? ['merge', op] : op.split(' ')
    const n = Number(arg)
    const add = (app: string, title: (c: number) => string) =>
      db.transaction(() => {
        for (let i = 0; i < n; i++, c++) ins.run(T0 + (c % 50) * HOUR, app, title(c + 1), T0, T0)
      })()
    if (kind === 'kept') add('com.example.editor', (c) => `kept ${c} a${c} b${c}`)
    else if (kind === 'canary') add('com.example.chat', (c) => `zebracanary ${c} q${c}`)
    else if (kind === 'del') db.exec(`DELETE FROM search_docs WHERE app_id = 'com.example.chat'`)
    else db.exec(`INSERT INTO search (search, rank) VALUES ('merge', ${op === '-N' ? -100000 : n})`)
  }
}

function structureShape(db: Database.Database) {
  const s = readStructure(db)!
  const used = s.levels.flatMap((l, i) => (l.segments.length > 0 ? [{ level: i, segments: l.segments.length, merging: l.nMerge > 0 }] : []))
  return { levels: s.levels.length, used }
}

function mergeOnly(db: Database.Database): void {
  db.prepare(FTS_MERGE_PENDING).run()
  new Deleter(db).mergeSearchIfPending(cappedSteps())
  assert.deepEqual(db.prepare(`SELECT key FROM meta WHERE key = 'fts_merge_pending'`).all(), [])
  db.exec(`INSERT INTO search (search) VALUES ('integrity-check')`)
}

test('the purge keeps merging when a merge of every segment would keep the delete markers, which carry the removed terms', () => {
  const r = rig(tmpDir(), { holdDeletions: true })
  const db = r.store.database
  replayIndex(db, ['kept 137', '+4', '-N', 'del', 'kept 37', 'kept 190', '-N', 'canary 132', 'canary 148', 'kept 3', '+25', '-N', 'canary 82', 'kept 45', 'kept 139', 'canary 173', 'kept 71', 'canary 64', 'canary 24', 'kept 64', 'del'])
  // Every segment on level 1 above empty levels: merging them writes level 2, which is not the last, so FTS5 keeps
  // the delete markers.
  const shape = structureShape(db)
  assert.equal(shape.used.length, 1)
  assert.equal(shape.used[0]!.level, 1)
  assert.ok(shape.levels > 3 && shape.used[0]!.segments >= 2 && !shape.used[0]!.merging)
  assert.deepEqual(r.q(`SELECT rowid FROM search WHERE search MATCH 'zebracanary'`), [])
  assert.ok(indexHolds(db, 'zebracanary').includes('search_data'))
  const kept = r.q<{ n: number }>(`SELECT count(*) AS n FROM search_docs`)[0]!.n
  mergeOnly(db)
  assert.deepEqual(indexHolds(db, 'zebracanary'), [])
  assert.equal(r.q<{ n: number }>(`SELECT count(*) AS n FROM search WHERE search MATCH 'kept'`)[0]!.n, kept)
  r.close()
})

test('the purge leaves no removed term when every segment is on level 0 above empty levels', () => {
  const r = rig(tmpDir(), { holdDeletions: true })
  const db = r.store.database
  replayIndex(db, ['kept 86', 'kept 92', '+29', 'del', '+10', '-N', 'canary 161', '+2', '+17', 'canary 196', 'del'])
  const shape = structureShape(db)
  assert.equal(shape.used.length, 1)
  assert.equal(shape.used[0]!.level, 0)
  assert.ok(shape.levels > 2 && shape.used[0]!.segments >= 2)
  assert.ok(indexHolds(db, 'zebracanary').includes('search_data'))
  const kept = r.q<{ n: number }>(`SELECT count(*) AS n FROM search_docs`)[0]!.n
  mergeOnly(db)
  assert.deepEqual(indexHolds(db, 'zebracanary'), [])
  assert.equal(r.q<{ n: number }>(`SELECT count(*) AS n FROM search WHERE search MATCH 'kept'`)[0]!.n, kept)
  r.close()
})

test('the purge rebuilds an index no bigger than one merge step when every segment is on level 0 above empty levels', () => {
  const r = rig(tmpDir(), { holdDeletions: true })
  const db = r.store.database
  replayIndex(db, ['kept 12', 'kept 9', '-N', '+19', '-N', 'kept 5', '-N', 'del', 'canary 1', '+15', '+24', 'del', 'del', 'canary 18', '-N', 'canary 18', 'canary 19', 'kept 2', 'canary 7', 'canary 20', 'del', 'del', 'kept 19', '+27', '+18', 'kept 4', 'canary 14', 'canary 1', 'kept 8', '-N', 'del'])
  // A new segment of one page moves any segment of one page to level 0, so no merge can leave this shape.
  const shape = structureShape(db)
  assert.equal(shape.used.length, 1)
  assert.equal(shape.used[0]!.level, 0)
  assert.ok(shape.levels > 2)
  assert.ok(indexHolds(db, 'zebracanary').includes('search_data'))
  const kept = r.q<{ n: number }>(`SELECT count(*) AS n FROM search_docs`)[0]!.n
  mergeOnly(db)
  assert.deepEqual(indexHolds(db, 'zebracanary'), [])
  assert.equal(r.q<{ n: number }>(`SELECT count(*) AS n FROM search WHERE search MATCH 'kept'`)[0]!.n, kept)
  assert.equal(structureShape(db).levels <= 2, true, 'the rebuild starts the index over')
  r.close()
})

test('a purge cut short by a restart still leaves no deleted title in the files', async () => {
  const r = rig()
  r.storage.start()
  await r.storage.derivationSettled()
  seedShuffledSearchDocs(r.dir, 6000)
  const reader = new Database(path.join(r.dir, DB_FILE), { readonly: true })
  reader.prepare('BEGIN').run()
  reader.prepare('SELECT count(*) AS n FROM search_docs').get()
  r.clock.t = T0 + 12 * HOUR
  assert.equal((await r.storage.deleteSource('com.example.chat').done).purged, false)
  r.close()
  reader.prepare('COMMIT').run()
  reader.close()
  const r2 = rig(r.dir)
  r2.storage.start()
  const t0 = Date.now()
  while (r2.q<{ state: string }>(`SELECT state FROM deletions`)[0]!.state !== 'purged' && Date.now() - t0 < 10_000) await new Promise((res) => setTimeout(res, 50))
  assert.deepEqual(r2.q(`SELECT state FROM deletions`), [{ state: 'purged' }])
  assert.deepEqual(diskContains(r2.dir, 'Quokkacanary'), [])
  r2.close()
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
  assert.ok((await writes) > 0, 'the other connection committed while the backfill ran')
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
    // The second write can land after the removal ends; the store's timer flushes it within a second.
    for (const until = performance.now() + 3000; (writes < 2 || r.store.storeHealth().pendingOps > 0) && performance.now() < until; ) await new Promise((res) => setTimeout(res, 50))
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
    const release = new Int32Array(new SharedArrayBuffer(4))
    const worker = new Worker(new URL('./holdLock.ts', import.meta.url), { workerData: { file: path.join(r.dir, DB_FILE), ms: ms === 50 ? 50 : 0, release } })
    const exited = new Promise<void>((resolve, reject) => { worker.once('exit', () => resolve()); worker.once('error', reject) })
    const letGo = () => { Atomics.store(release, 0, 1); Atomics.notify(release, 0) }
    try {
      await new Promise((resolve) => worker.once('message', resolve))
      const start = performance.now()
      if (ms === 50) letGo()
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
        letGo()
        assert.ok(elapsed >= 900 && elapsed < 5000, `bounded wait took ${elapsed.toFixed(1)} ms`)
        assert.deepEqual(r.store.query(`SELECT * FROM change_log`), before)
        assert.equal(r.storage.paused(), null)
        assert.equal(r.store.storeHealth().pendingOps, 1)
      }
    } finally {
      letGo()
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
    await eventually(() => tries > 1 && r.store.query(`SELECT value FROM meta WHERE key = 'derive_from'`).length === 0)
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
  const release = new Int32Array(new SharedArrayBuffer(4))
  const worker = new Worker(new URL('./holdLock.ts', import.meta.url), { workerData: { file: path.join(r.dir, DB_FILE), ms: 0, release } })
  const exited = new Promise<void>((resolve, reject) => { worker.once('exit', () => resolve()); worker.once('error', reject) })
  const letGo = () => { Atomics.store(release, 0, 1); Atomics.notify(release, 0) }
  try {
    await new Promise((resolve) => worker.once('message', resolve))
    r.clock.t = until + 1
    await eventually(() => errors.length > 0)
    letGo()
    await exited
    await eventually(() => r.storage.paused() === null)
    assert.ok(errors.length > 0 && errors.every((e) => e.code === 'pause_expiry_SQLITE_BUSY' && e.paused), JSON.stringify(errors))
    assert.equal(r.storage.paused(), null, 'the pause ended once the lock was free')
    assert.deepEqual(r.q('SELECT ended_wall_ms FROM pauses'), [{ ended_wall_ms: until }])
    assert.deepEqual(r.q(`SELECT end_wall_ms FROM capture_gaps WHERE reason = 'paused'`), [{ end_wall_ms: until }])
  } finally {
    letGo()
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
    await eventually(() => errors.length > 0)
    assert.equal(store.storeHealth().contendedSinceWallMs, T0)
    assert.equal(store.storeHealth().failingSinceWallMs, null)
    assert.equal(store.storeHealth().pendingOps, 1)
    blocker.exec('COMMIT')
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(store.storeHealth().contendedSinceWallMs, null)
    assert.equal(store.storeHealth().pendingOps, 0)
    assert.deepEqual(errors, ['write_contended'], 'reported once, when it passed the threshold')
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

test('a deletion whose announcements meet a lock held past the busy timeout finishes without throwing or blocking capture', async () => {
  const errors: string[] = []
  const r = rig(undefined, { onError: (code) => errors.push(code) })
  r.store.insertObservation(row(T0, 'com.example.chat', 'announce canary'))
  r.store.flush()
  r.clock.t = T0 + HOUR
  const deletions = (r.storage as unknown as { deletions: { run: (t: number, now: number) => Promise<unknown> } }).deletions
  const run = deletions.run.bind(deletions)
  let lockedAt = 0
  let exited: Promise<void> = Promise.resolve()
  deletions.run = async (t, now) => {
    const result = await run(t, now)
    const worker = new Worker(new URL('./holdLock.ts', import.meta.url), { workerData: { file: path.join(r.dir, DB_FILE), ms: 1500 } })
    exited = new Promise<void>((resolve, reject) => { worker.once('exit', () => resolve()); worker.once('error', reject) })
    await new Promise((resolve) => worker.once('message', resolve))
    lockedAt = performance.now()
    return result
  }
  try {
    const handle = r.storage.deleteSource('com.example.chat')
    assert.equal((await handle.done).observations, 1)
    // Measured from when the other connection holds the lock: starting its thread is not the deletion's wait.
    assert.ok(performance.now() - lockedAt < 500, 'the deletion finished without waiting out the busy timeout')
    await handle.purged
    // The other connection holds the lock for 1500 ms after it reports holding it.
    assert.ok(performance.now() - lockedAt >= 1400, 'purged is announced only once the lock is free')
    const states = r.q<{ payload: string }>(`SELECT payload FROM change_log WHERE kind = 'deletion'`).map((c) => JSON.parse(c.payload).state)
    assert.ok(states.includes('done') && states.includes('purged'), JSON.stringify(states))
    assert.ok(errors.length > 0 && errors.every((e) => e === 'deletion_announce_SQLITE_BUSY'), JSON.stringify(errors))
  } finally {
    await exited
    r.close()
  }
})

test('a deletion is announced purged only after it is announced done, however long the done announcement waits', async () => {
  const errors: string[] = []
  const r = rig(undefined, { onError: (code) => errors.push(code) })
  r.store.insertObservation(row(T0, 'com.example.chat', 'order canary'))
  r.store.flush()
  r.clock.t = T0 + HOUR
  type Commit = (kind: string, payload: Record<string, unknown>, ...rest: unknown[]) => unknown
  const bus = (r.storage as unknown as { bus: { commit: Commit } }).bus
  const commit = bus.commit.bind(bus)
  // The done announcement meets a busy lock three times; nothing else does.
  let refused = 0
  bus.commit = (kind, payload, ...rest) => {
    if (kind === 'deletion' && payload.state === 'done' && refused < 3) {
      refused++
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
    }
    return commit(kind, payload, ...rest)
  }
  try {
    const handle = r.storage.deleteSource('com.example.chat')
    await handle.done
    await handle.purged
    const states = r.q<{ payload: string }>(`SELECT payload FROM change_log WHERE kind = 'deletion' ORDER BY seq`).map((c) => JSON.parse(c.payload).state)
    assert.deepEqual(states, ['started', 'done', 'purged'])
    assert.deepEqual(errors, ['deletion_announce_SQLITE_BUSY', 'deletion_announce_SQLITE_BUSY', 'deletion_announce_SQLITE_BUSY'])
  } finally {
    await r.storage.deletionsSettled()
    r.close()
  }
})

test('a flush contended by a writer that yields to capture lands as soon as that writer lets go', async (t) => {
  const dir = tmpDir()
  const store = new Store(dir, { now: () => T0 })
  store.writerYields = () => true
  const attempts = countTransactions(store)
  const release = new Int32Array(new SharedArrayBuffer(4))
  const worker = new Worker(new URL('./holdLock.ts', import.meta.url), { workerData: { file: path.join(dir, DB_FILE), ms: 0, release } })
  const exited = new Promise<void>((resolve, reject) => { worker.once('exit', () => resolve()); worker.once('error', reject) })
  const letGo = () => { Atomics.store(release, 0, 1); Atomics.notify(release, 0) }
  try {
    await new Promise((resolve) => worker.once('message', resolve))
    // The store's clock stays inside its flush budget however slow the runner is.
    const frozen = performance.now()
    t.mock.method(performance, 'now', () => frozen)
    store.insertObservation(row(T0, 'com.example.editor', 'behind a yielding writer'))
    store.flush()
    await eventually(() => attempts.n >= 5)
    assert.equal((store as unknown as { contention: { waitMs: number } }).contention.waitMs, 10, 'retries keep the shortest interval')
    letGo()
    await eventually(() => store.storeHealth().pendingOps === 0)
    assert.equal(store.storeHealth().pendingOps, 0)
  } finally {
    letGo()
    await exited
    store.close()
  }
})

test('while the deletion worker has work, capture leaves checkpointing to it, and takes it back when the worker is idle', async () => {
  const r = rig()
  for (let i = 0; i < 200; i++) r.store.insertObservation(row(T0 + i * 1000, 'com.example.chat', `checkpoint canary ${i}`))
  r.store.flush()
  r.clock.t = T0 + HOUR
  const setting = () => Number(r.store.database.pragma('wal_autocheckpoint', { simple: true }))
  assert.equal(setting(), 1000)
  const handle = r.storage.deleteSource('com.example.chat')
  assert.equal(setting(), 0, 'a capture commit never copies the worker\'s log back while the worker writes')
  await handle.done
  await handle.purged
  await r.storage.deletionsSettled()
  assert.equal(setting(), 1000)
  r.close()
})

for (const crashedAfter of ['done', 'purged'] as const) {
  test(`a deletion the worker finished as ${crashedAfter} just before a crash is announced done and purged, in order, after the restart`, async () => {
    const dir = tmpDir()
    const r = rig(dir, { holdDeletions: true })
    r.store.insertObservation(row(T0, 'com.example.chat', 'crash canary'))
    r.store.flush()
    r.clock.t = T0 + HOUR
    const { tombstone } = r.storage.deleteSource('com.example.chat')
    r.close()
    // The worker's own commits, then the process ends before the capture thread announces them.
    const db = new Database(path.join(dir, DB_FILE))
    db.pragma('secure_delete = ON')
    const deleter = new Deleter(db)
    deleter.run(tombstone, T0 + HOUR)
    if (crashedAfter === 'purged') assert.equal(deleter.purge(tombstone), true)
    db.close()

    const again = rig(dir)
    const states = () => again.q<{ payload: string }>(`SELECT payload FROM change_log WHERE kind = 'deletion' ORDER BY seq`).map((c) => JSON.parse(c.payload).state as string)
    try {
      again.storage.start()
      await again.storage.deletionsSettled()
      for (const start = Date.now(); !states().includes('purged') && Date.now() - start < 5000; ) await new Promise((res) => setTimeout(res, 20))
      assert.deepEqual(states(), ['started', 'done', 'purged'])
    } finally {
      again.close()
    }
    const third = rig(dir)
    try {
      third.storage.start()
      await new Promise((res) => setTimeout(res, 200))
      assert.deepEqual(third.q<{ n: number }>(`SELECT count(*) AS n FROM change_log WHERE kind = 'deletion'`)[0]!.n, 3, 'a later start announces nothing again')
    } finally {
      third.close()
    }
  })
}

test('a deletion worker that has work but commits nothing for the stall time gives checkpointing back to capture, and says so', async () => {
  const errors: string[] = []
  const r = rig(tmpDir(), { deletionStallMs: 300, onError: (code) => errors.push(code) })
  r.store.insertObservation(row(T0, 'com.example.chat', 'stall canary'))
  r.store.flush()
  r.clock.t = T0 + HOUR
  const deletions = (r.storage as unknown as { deletions: { captureWriting(on: boolean): void } }).deletions
  const autocheckpoint = () => r.store.database.pragma('wal_autocheckpoint', { simple: true })
  // The worker waits before its first write for as long as capture says it is writing: alive, and stuck.
  deletions.captureWriting(true)
  const handle = r.storage.deleteSource('com.example.chat')
  try {
    await new Promise((res) => setTimeout(res, 100))
    assert.equal(autocheckpoint(), 0, 'the worker checkpoints while it has work')
    await new Promise((res) => setTimeout(res, 400))
    assert.equal(autocheckpoint(), WAL_AUTOCHECKPOINT, 'capture checkpoints again once the worker has committed nothing for the stall time')
    assert.deepEqual(errors, ['deletion_worker_stalled'])
  } finally {
    deletions.captureWriting(false)
    await handle.done
    await r.storage.deletionsSettled()
    r.close()
  }
})

test('a stall beginning keeps one progress check running, not two', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  try {
    const worker = new DeletionWorker(path.join(tmpDir(), DB_FILE), 300)
    const w = worker as unknown as { pending: Map<number, unknown>; progress: Float64Array; watchProgress(): void; notifyBusy(): void }
    w.pending.set(1, {})
    w.progress[0] = Date.now() - 1000
    let checks = 0
    const check = w.watchProgress.bind(worker)
    w.watchProgress = () => {
      checks++
      check()
    }
    w.notifyBusy()
    checks = 0
    mock.timers.tick(300)
    assert.equal(checks, 1)
  } finally {
    mock.timers.reset()
  }
})
