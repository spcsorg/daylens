import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { DB_FILE, Store } from '../capture/store.ts'

const KEY = 'K'.repeat(43)

function withLegacyKey(): { dir: string; store: Store; errors: string[] } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dl-scrub-fail-'))
  const errors: string[] = []
  const store = new Store(dir, { busyTimeoutMs: 100, onError: (c) => errors.push(c) })
  store.setMeta('browser_pairings', JSON.stringify([{ id: 'A'.repeat(22), key: KEY, origin: 'chrome-extension://x', paired_wall_ms: 1 }]))
  assert.ok(store.flush())
  // The migration has rewritten the row without the key, as BrowserLocal does before scrubbing.
  store.setMeta('browser_pairings', JSON.stringify([{ id: 'A'.repeat(22), origin: 'chrome-extension://x', paired_wall_ms: 1 }]))
  return { dir, store, errors }
}

function keyInFiles(dir: string): boolean {
  return [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`].map((f) => path.join(dir, f)).filter((f) => existsSync(f)).some((f) => readFileSync(f).includes(Buffer.from(KEY)))
}

test('a scrub whose marker cannot be written on a full disk stays pending until it can', () => {
  const { dir, store, errors } = withLegacyKey()
  const page_count = store.query<{ page_count: number }>('PRAGMA page_count')[0]!.page_count
  store.query(`PRAGMA max_page_count = ${page_count}`)
  store.setMeta('filler', 'x'.repeat(20_000))
  assert.equal(store.scrub(), false, 'not done while nothing can be written')
  assert.ok(errors.includes('SQLITE_FULL'))
  assert.equal(store.storeHealth().scrubPending, true)
  store.query('PRAGMA max_page_count = 1073741823')
  assert.equal(store.retryScrub(), true)
  assert.equal(store.storeHealth().scrubPending, false)
  assert.equal(store.meta('scrub_pending'), null)
  assert.equal(keyInFiles(dir), false)
  store.close()
})

test('a scrub whose marker write is blocked by another writer stays pending until the lock is gone', () => {
  const { dir, store, errors } = withLegacyKey()
  const other = new Database(path.join(dir, DB_FILE))
  other.prepare('BEGIN IMMEDIATE').run()
  assert.equal(store.scrub(), false)
  assert.ok(errors.some((e) => e.startsWith('SQLITE_BUSY')))
  assert.equal(store.storeHealth().scrubPending, true)
  other.prepare('COMMIT').run()
  other.close()
  assert.equal(store.retryScrub(), true)
  assert.equal(store.storeHealth().scrubPending, false)
  assert.equal(keyInFiles(dir), false)
  store.close()
})
