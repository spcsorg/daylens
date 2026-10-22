import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { DB_FILE, Store } from '../capture/store.ts'
import { Storage } from '../storage/index.ts'
import { tempDir } from './support/tmp.ts'

const KEY = 'K'.repeat(43)

// The store as the service runs it: storage's deletion worker does the purge a scrub asks for.
function open(dir: string, errors: string[], busyTimeoutMs?: number): { store: Store; close: () => void } {
  const store = new Store(dir, { busyTimeoutMs, onError: (c) => errors.push(c) })
  const storage = new Storage(store, dir, { deletionStallMs: Infinity, onError: (c) => errors.push(c) })
  return { store, close: () => { storage.stop(); store.close() } }
}

function withLegacyKey(): { dir: string; store: Store; errors: string[]; close: () => void } {
  const dir = tempDir('dl-scrub-fail-')
  const errors: string[] = []
  const { store, close } = open(dir, errors, 100)
  store.setMeta('browser_pairings', JSON.stringify([{ id: 'A'.repeat(22), key: KEY, origin: 'chrome-extension://x', paired_wall_ms: 1 }]))
  assert.ok(store.flush())
  // The migration has rewritten the row without the key, as BrowserLocal does before scrubbing.
  store.setMeta('browser_pairings', JSON.stringify([{ id: 'A'.repeat(22), origin: 'chrome-extension://x', paired_wall_ms: 1 }]))
  return { dir, store, errors, close }
}

function keyInFiles(dir: string): boolean {
  return [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`].map((f) => path.join(dir, f)).filter((f) => existsSync(f)).some((f) => readFileSync(f).includes(Buffer.from(KEY)))
}

test('a scrub whose marker cannot be written on a full disk stays pending until it can', async () => {
  const { dir, store, errors, close } = withLegacyKey()
  const page_count = store.query<{ page_count: number }>('PRAGMA page_count')[0]!.page_count
  store.query(`PRAGMA max_page_count = ${page_count}`)
  store.setMeta('filler', 'x'.repeat(20_000))
  assert.equal(await store.scrub([KEY]), false, 'not done while nothing can be written')
  assert.ok(errors.includes('SQLITE_FULL'))
  assert.equal(store.storeHealth().scrubPending, true)
  store.query('PRAGMA max_page_count = 1073741823')
  assert.equal(await store.retryScrub(), true)
  assert.equal(store.storeHealth().scrubPending, false)
  assert.equal(store.meta('scrub_pending'), null)
  assert.equal(keyInFiles(dir), false)
  close()
})

test('a scrub whose marker write is blocked by another writer stays pending until the lock is gone', async () => {
  const { dir, store, errors, close } = withLegacyKey()
  const other = new Database(path.join(dir, DB_FILE))
  other.prepare('BEGIN IMMEDIATE').run()
  assert.equal(await store.scrub([KEY]), false)
  // A busy database is contention for capture, retried rather than reported as an error code.
  assert.ok(errors.includes('scrub_failed'))
  assert.equal(store.storeHealth().scrubPending, true)
  other.prepare('COMMIT').run()
  other.close()
  assert.equal(await store.retryScrub(), true)
  assert.equal(store.storeHealth().scrubPending, false)
  assert.equal(keyInFiles(dir), false)
  close()
})

test('a full queue drops neither the migration write nor the scrub marker, so the key really leaves the files', async () => {
  const dir = tempDir('dl-scrub-overflow-')
  const errors: string[] = []
  const { store, close } = open(dir, errors, 50)
  store.setMeta('browser_pairings', JSON.stringify([{ id: 'A'.repeat(22), key: KEY, origin: 'chrome-extension://x', paired_wall_ms: 1 }]))
  assert.ok(store.flush())
  const other = new Database(path.join(dir, DB_FILE))
  other.prepare('BEGIN IMMEDIATE').run()
  store.setMeta('browser_pairings', JSON.stringify([{ id: 'A'.repeat(22), origin: 'chrome-extension://x', paired_wall_ms: 1 }]), { keep: true })
  assert.equal(await store.scrub([KEY]), false)
  for (let i = 0; i < 50_001; i++) store.touchAlive(1_000 + i)
  assert.ok(store.storeHealth().droppedOps > 0, 'the queue overflowed')
  other.prepare('COMMIT').run()
  other.close()
  assert.equal(await store.retryScrub(), true)
  assert.equal(store.meta('browser_pairings')?.includes(KEY), false)
  assert.equal(keyInFiles(dir), false)
  assert.equal(store.storeHealth().scrubPending, false)
  close()
})

test('a scrub stays pending while a pairing row or any file still holds a key, even with the marker committed', async () => {
  const dir = tempDir('dl-scrub-verify-')
  const { store, close } = open(dir, [])
  store.setMeta('browser_pairings', JSON.stringify([{ id: 'A'.repeat(22), key: KEY, origin: 'chrome-extension://x', paired_wall_ms: 1 }]))
  assert.equal(await store.scrub([KEY]), false, 'the key is still in the row')
  assert.equal(store.storeHealth().scrubPending, true)
  assert.equal(store.meta('scrub_pending'), '1')
  store.setMeta('browser_pairings', JSON.stringify([{ id: 'A'.repeat(22), origin: 'chrome-extension://x', paired_wall_ms: 1 }]))
  assert.equal(await store.retryScrub(), true)
  assert.equal(keyInFiles(dir), false)
  close()
})

function pageTitled(store: Store, title: string): void {
  store.insertObservation({
    run: 'r', seq: 0, boot: 'b', platform: 'macos', source: 's', kind: 'focus', event_wall_ms: 1, event_mono_us: 0, tz: 'UTC', tz_offset_min: 0,
    app_id: 'com.example.browser', app_name: 'Browser', app_path: null, pid: 1, window: 'w', title, title_raw: title, title_state: null, state: null, detail: null,
  })
}

test('a page whose title merely looks like a stored key does not hold the scrub up; the migrated key itself does', async () => {
  const { dir, store, close } = withLegacyKey()
  pageTitled(store, `{"key":"${'Z'.repeat(43)}"}`)
  assert.equal(await store.scrub([KEY]), true)
  assert.equal(store.storeHealth().scrubPending, false)
  assert.equal(keyInFiles(dir), false)
  close()

  const second = withLegacyKey()
  pageTitled(second.store, `copied ${KEY} by hand`)
  assert.equal(await second.store.scrub([KEY]), false, 'the exact key is still in the files')
  assert.equal(second.store.storeHealth().scrubPending, true)
  second.close()
})

test('a scrub never rewrites the file on the capture connection; the deletion worker purges it', async () => {
  const { dir, store, close } = withLegacyKey()
  const exec = store.database.exec.bind(store.database)
  const ran: string[] = []
  store.database.exec = ((sql: string) => {
    ran.push(sql)
    return exec(sql)
  }) as typeof store.database.exec
  assert.equal(await store.scrub([KEY]), true)
  assert.deepEqual(ran.filter((sql) => /vacuum|wal_checkpoint/i.test(sql)), [])
  assert.equal(keyInFiles(dir), false)
  close()
})
