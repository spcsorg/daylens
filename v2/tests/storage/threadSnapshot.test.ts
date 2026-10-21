import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import Database from 'better-sqlite3'
import { DB_FILE } from '../../capture/store.ts'
import { Deleter, planDeletion } from '../../storage/deletion.ts'
import { HOUR, rig, T0 } from './support.ts'

function sharedThread(r: ReturnType<typeof rig>) {
  const affected = r.storage.writeHour({
    start_wall_ms: T0, tz: 'Africa/Kigali', status: 'written', title: 'Deleted hour', sources: [{ app_id: 'com.example.chat' }],
  }, r.storage.hourBasis(T0))
  const kept = r.storage.writeHour({
    start_wall_ms: T0 + HOUR, tz: 'Africa/Kigali', status: 'written', title: 'Kept hour',
  }, r.storage.hourBasis(T0 + HOUR))
  const thread = r.storage.createThread('ThreadSecretCanary', [affected.id, kept.id])
  return { affected, kept, thread }
}

test('thread title and deletion fences share a snapshot when another connection finishes deletion between reads', (t) => {
  const r = rig(undefined, { holdDeletions: true })
  const conn = new Database(path.join(r.dir, DB_FILE))
  conn.pragma('foreign_keys = ON')
  try {
    const { affected, kept, thread } = sharedThread(r)
    // Deleting an app across all time reaches what was recorded before the deletion.
    r.clock.t = T0 + 2 * HOUR
    const { tombstone } = r.storage.deleteSource('com.example.chat')
    const prepare = r.storage.db.prepare.bind(r.storage.db)
    let completed = false
    t.mock.method(r.storage.db, 'prepare', (sql: string) => {
      const statement = prepare(sql)
      if (sql.startsWith('SELECT t.id, t.title FROM threads')) {
        const all = statement.all.bind(statement)
        t.mock.method(statement, 'all', (...args: unknown[]) => {
          const titles = all(...args)
          assert.equal((titles[0] as { title: string }).title, 'ThreadSecretCanary')
          new Deleter(conn).run(tombstone, T0 + 2 * HOUR)
          assert.deepEqual(conn.prepare('SELECT title FROM threads WHERE id = ?').get(thread), { title: '' })
          assert.deepEqual(conn.prepare('SELECT sources FROM hours WHERE id = ?').get(affected.id), { sources: '[]' })
          assert.deepEqual(conn.prepare('SELECT state FROM deletions WHERE id = ?').get(tombstone), { state: 'done' })
          assert.deepEqual(conn.prepare('SELECT 1 FROM deletion_fence WHERE tombstone_id = ?').all(tombstone), [])
          completed = true
          return titles
        })
      }
      return statement
    })
    const result = r.storage.threadsForHour(kept.id)
    assert.equal(completed, true, 'the second connection completed deletion after the title read')
    assert.deepEqual(result, [{ id: thread, title: '' }])
  } finally {
    t.mock.restoreAll()
    conn.close()
    r.close()
  }
})

test('thread reads load pending deletions from the database even when the in-memory list is stale', () => {
  const r = rig()
  const conn = new Database(path.join(r.dir, DB_FILE))
  try {
    const { kept, thread } = sharedThread(r)
    conn.transaction(() => {
      const spec = { kind: 'source' as const, app_id: 'com.example.chat', site: null, from_wall_ms: null, to_wall_ms: null }
      const id = Number(conn.prepare("INSERT INTO deletions (kind, app_id, created_wall_ms, state) VALUES ('source', ?, ?, 'pending')").run(spec.app_id, T0).lastInsertRowid)
      planDeletion(conn, id, spec)
    }).immediate()
    assert.deepEqual(r.storage.rules.tombstones, [], 'capture has not reloaded its in-memory rules')
    assert.deepEqual(r.storage.threadsForHour(kept.id), [{ id: thread, title: '' }])
  } finally {
    conn.close()
    r.close()
  }
})
