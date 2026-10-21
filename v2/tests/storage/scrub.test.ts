import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { ObservationRow } from '../../capture/normalize.ts'
import { Store } from '../../capture/store.ts'
import { Deleter } from '../../storage/deletion.ts'
import { Storage } from '../../storage/index.ts'
import { btreePages, ScrubUnavailableError, scrubAll, unallocated } from '../../storage/scrub.ts'
import { HOUR, rig, T0, tmpDir } from './support.ts'

function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Each page's role as SQLite's own b-tree walk reports it, independent of the scrub's code; a page it does not list
// is a freelist or pointer-map page.
function roles(db: Database.Database): Map<number, string> {
  return new Map((db.prepare('SELECT pageno, pagetype FROM dbstat WHERE aggregate = 0').all() as { pageno: number; pagetype: string }[]).map((r) => [r.pageno, r.pagetype]))
}

function dump(db: Database.Database): string {
  return JSON.stringify([db.prepare('SELECT * FROM t ORDER BY id').all(), db.prepare('SELECT * FROM w ORDER BY k').all()])
}

function pages(db: Database.Database): Map<number, Buffer> {
  const out = new Map<number, Buffer>()
  for (const r of db.prepare('SELECT pgno, data FROM sqlite_dbpage').all() as { pgno: number; data: Buffer }[]) out.set(r.pgno, r.data)
  return out
}

test('a scrub zeroes only cell-free space, keeps every page valid, and leaves no deleted text, over random changes', () => {
  const rand = random(0x5c2b)
  const file = path.join(tmpDir(), 'scrub.sqlite')
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('secure_delete = ON')
  db.exec(`
    CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT NOT NULL, v TEXT NOT NULL);
    CREATE INDEX t_k ON t(k);
    CREATE TABLE w (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
  `)
  const text = (id: number, n: number) => `Scrubcanary${id}x ` + 'abcdefghij klmnopqrst '.repeat(Math.ceil(n / 22)).slice(0, n)
  const live = new Set<number>()
  const deleted = new Set<number>()
  let next = 1
  const insert = db.prepare('INSERT INTO t (id, k, v) VALUES (?, ?, ?)')
  const insertW = db.prepare('INSERT INTO w (k, v) VALUES (?, ?)')
  const update = db.prepare('UPDATE t SET v = ? WHERE id = ?')
  const updateW = db.prepare('UPDATE w SET v = ? WHERE k = ?')
  const remove = db.prepare('DELETE FROM t WHERE id = ?')
  const removeW = db.prepare('DELETE FROM w WHERE k = ?')
  const key = (id: number) => `Scrubcanary${id}k ${Math.floor(rand() * 1e9)}`
  const keys = new Map<number, string>()
  for (let round = 0; round < 10; round++) {
    db.transaction(() => {
      for (let i = 0; i < 1500; i++) {
        const ids = [...live]
        const roll = rand()
        if (roll < 0.5 || ids.length === 0) {
          const id = next++
          const k = key(id)
          keys.set(id, k)
          // Some values span overflow pages, which the scrub must never touch.
          insert.run(id, k, text(id, rand() < 0.05 ? 5000 + Math.floor(rand() * 9000) : Math.floor(rand() * 900)))
          insertW.run(k, text(id, Math.floor(rand() * 300)))
          live.add(id)
        } else {
          const id = ids[Math.floor(rand() * ids.length)]!
          if (roll < 0.75) {
            update.run(text(id, Math.floor(rand() * 900)), id)
            updateW.run(text(id, Math.floor(rand() * 300)), keys.get(id)!)
          } else {
            remove.run(id)
            removeW.run(keys.get(id)!)
            live.delete(id)
            deleted.add(id)
          }
        }
      }
    })()
    const before = pages(db)
    const role = roles(db)
    const rows = dump(db)
    const usable = (db.pragma('page_size', { simple: true }) as number) - before.get(1)![20]!
    scrubAll(db, 20, (fn) => db.transaction(fn).immediate())
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok', `round ${round}`)
    assert.equal(dump(db), rows, `round ${round}: a row changed`)
    const after = pages(db)
    assert.equal(after.size, before.size)
    for (const [pgno, page] of before) {
      const r = role.get(pgno)
      if (r !== 'internal' && r !== 'leaf') {
        assert.ok(after.get(pgno)!.equals(page), `round ${round}: page ${pgno} (${r ?? 'free'}) is not a b-tree page and was written`)
        continue
      }
      const expected = Buffer.from(page)
      for (const [a, b] of unallocated(page, pgno, usable) ?? []) expected.fill(0, a, b)
      assert.ok(after.get(pgno)!.equals(expected), `round ${round}: page ${pgno} changed outside its free space`)
    }
    if (round === 9) assert.ok([...role.values()].includes('overflow'), 'overflow pages were present')
    db.pragma('wal_checkpoint(TRUNCATE)')
    const bytes = Buffer.concat([file, `${file}-wal`].filter((f) => existsSync(f)).map((f) => readFileSync(f))).toString('latin1')
    const found = new Set([...bytes.matchAll(/Scrubcanary(\d+)[xk]/g)].map((m) => Number(m[1])))
    const left = [...deleted].filter((id) => found.has(id))
    assert.deepEqual(left, [], `round ${round}: deleted text left in the file`)
  }
  assert.ok(deleted.size > 1000 && live.size > 1000)
  db.close()
})

test('a pointer-map page that starts with a b-tree type byte is not a b-tree page, and a file with auto_vacuum is never scrubbed', () => {
  const file = path.join(tmpDir(), 'autovacuum.sqlite')
  const db = new Database(file)
  db.pragma('auto_vacuum = INCREMENTAL')
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE a (x TEXT)')
  const ins = db.prepare('INSERT INTO a VALUES (?)')
  for (let i = 0; i < 200; i++) ins.run('Ptrcanary '.repeat(50))
  // With no table left, page 3 is free, and the pointer map on page 2 opens with its type, 2: an index page's byte.
  db.exec('DROP TABLE a')
  const before = pages(db)
  assert.equal(before.get(2)![0], 0x02)
  assert.equal(roles(db).has(2), false, 'SQLite lists page 2 in no b-tree')
  assert.equal(btreePages(db)[2], 0)
  assert.throws(() => scrubAll(db, 20, (fn) => db.transaction(fn).immediate()), (err: Error) => err instanceof ScrubUnavailableError && err.message === 'scrub_auto_vacuum')
  assert.ok(pages(db).get(2)!.equals(before.get(2)!))
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
  db.close()
})

test('a deletion on a file with auto_vacuum is never reported purged, and storage says why', () => {
  const dir = tmpDir()
  const db = new Database(path.join(dir, 'daylens-v2.sqlite'))
  db.pragma('auto_vacuum = FULL')
  db.close()
  const errors: string[] = []
  const r = rig(dir, { holdDeletions: true, onError: (code) => errors.push(code) })
  r.storage.start()
  assert.ok(errors.includes('scrub_auto_vacuum'), errors.join())
  r.store.insertObservation(row(T0, 'Autovacuum canary'))
  r.store.flush()
  r.clock.t = T0 + HOUR
  const { tombstone } = r.storage.deleteSource('com.example.chat')
  const deleter = new Deleter(r.store.database)
  assert.equal(deleter.run(tombstone, r.clock.t).observations, 1)
  assert.throws(() => deleter.purge(tombstone), /scrub_auto_vacuum/)
  assert.deepEqual(r.q('SELECT state FROM deletions'), [{ state: 'done' }])
  r.close()
})

test('a page whose free-space chain is invalid is never written', () => {
  const page = Buffer.alloc(4096)
  page[0] = 0x0d
  page.writeUInt16BE(4000, 1)
  page.writeUInt16BE(0, 3)
  page.writeUInt16BE(3000, 5)
  page.writeUInt16BE(100, 4000)
  page.writeUInt16BE(8, 4002)
  assert.throws(() => unallocated(page, 2, 4096), /invalid freeblock/)
  page.writeUInt16BE(0, 4000)
  assert.deepEqual(unallocated(page, 2, 4096), [[8, 3000], [4004, 4008]])
  page.writeUInt16BE(3000, 3)
  assert.throws(() => unallocated(page, 2, 4096), /invalid header/)
  assert.equal(unallocated(Buffer.alloc(4096), 2, 4096), null)
})

function withoutPages(db: Database.Database): Database.Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (sql.includes('sqlite_dbpage')) throw new Error('no such table: sqlite_dbpage')
          return target.prepare(sql)
        }
      }
      const v = Reflect.get(target, prop) as unknown
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  })
}

const row = (t: number, title: string): ObservationRow => ({
  run: 'seed', seq: 0, boot: 'b', platform: 'macos', source: 'seed', kind: 'focus', event_wall_ms: t, event_mono_us: t * 1000, tz: 'Africa/Kigali',
  tz_offset_min: 120, app_id: 'com.example.chat', app_name: 'Chat', app_path: null, pid: 1, window: 'w', title, title_raw: null, title_state: 'ok', state: 'ok', detail: null,
})

test('without the scrub a removal finishes but is never reported purged', () => {
  const r = rig(tmpDir(), { holdDeletions: true })
  r.store.insertObservation(row(T0, 'Unscrubbed canary'))
  r.store.flush()
  r.clock.t = T0 + HOUR
  const { tombstone } = r.storage.deleteSource('com.example.chat')
  const deleter = new Deleter(withoutPages(r.store.database))
  assert.equal(deleter.run(tombstone, r.clock.t).observations, 1)
  assert.throws(() => deleter.purge(tombstone), ScrubUnavailableError)
  assert.deepEqual(r.q('SELECT state FROM deletions'), [{ state: 'done' }])
  assert.throws(() => deleter.checkpointRetention(), ScrubUnavailableError)
  r.close()
})

test('storage says at start when the scrub is unavailable', () => {
  const dir = tmpDir()
  const errors: string[] = []
  const store = new Store(dir)
  const storage = new Storage(store, dir, { onError: (code) => errors.push(code) })
  storage.start()
  assert.deepEqual(errors, [])
  storage.stop()
  const db = store.database
  Object.defineProperty(store, 'database', { get: () => withoutPages(db) })
  const reported: string[] = []
  const without = new Storage(store, dir, { onError: (code) => reported.push(code) })
  without.start()
  assert.deepEqual(reported, ['scrub_unavailable'])
  without.stop()
  store.close()
})
