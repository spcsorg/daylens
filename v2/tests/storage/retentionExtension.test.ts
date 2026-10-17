import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import Database from 'better-sqlite3'
import { DB_FILE } from '../../capture/store.ts'
import { pruneStep } from '../../storage/deletion.ts'
import { DAY_MS } from '../../storage/rules.ts'
import { app, focus, resetSeq } from '../support/lines.ts'
import { MIN, rig, T0 } from './support.ts'

const editor = app('com.example.editor')
const sighting = T0 + 6 * DAY_MS

for (const pruner of ['capture connection', 'worker connection'] as const) {
  test(`a queued extension survives retention on the ${pruner}, covering only the new sighting`, () => {
    resetSeq()
    const r = rig()
    const conn = new Database(path.join(r.dir, DB_FILE))
    try {
      r.storage.setRetentionDays(7)
      r.feed(focus(editor, 'Retained sighting', T0))
      r.store.flush()
      const oldId = r.store.query<{ id: number }>('SELECT id FROM observations')[0]!.id
      r.feed(focus(editor, 'Retained sighting', sighting, 'reconcile'))
      assert.equal(r.store.query<{ last_seen_wall_ms: number }>('SELECT last_seen_wall_ms FROM observations')[0]!.last_seen_wall_ms, T0, 'extension is queued')
      r.clock.t = T0 + 7 * DAY_MS + MIN
      if (pruner === 'capture connection') r.storage.pruneBatch()
      else pruneStep(conn, T0 + MIN, 0)
      assert.deepEqual(r.store.query('SELECT id FROM observations'), [], 'prune removed the original before flush')
      assert.equal(r.store.flush(), true)
      const rows = r.store.query<{ id: number; event_wall_ms: number; last_seen_wall_ms: number }>('SELECT id, event_wall_ms, last_seen_wall_ms FROM observations')
      assert.equal(rows.length, 1)
      assert.ok(rows[0]!.id > oldId, 'the replacement has a new id')
      assert.equal(rows[0]!.event_wall_ms, sighting)
      assert.equal(rows[0]!.last_seen_wall_ms, sighting)
      assert.equal(r.store.query<{ event_mono_us: number }>('SELECT event_mono_us FROM observations')[0]!.event_mono_us, sighting * 1000)
      assert.equal(r.store.query<{ n: number }>('SELECT count(*) AS n FROM intervals WHERE obs_id = ?', rows[0]!.id)[0]!.n, 1)
      r.feed(focus(editor, 'Retained sighting', r.clock.t + MIN, 'reconcile'))
      r.store.flush()
      assert.equal(r.store.query<{ n: number }>('SELECT count(*) AS n FROM observations')[0]!.n, 2, 'the pruned id is no longer open')
    } finally {
      conn.close()
      r.close()
    }
  })
}

for (const blocker of ['retention', 'pause', 'range deletion', 'source deletion'] as const) {
  test(`a replacement sighting is refused by ${blocker} rules in force at flush`, () => {
    resetSeq()
    const r = rig()
    try {
      r.storage.setRetentionDays(7)
      r.feed(focus(editor, 'Refused replacement canary', T0))
      r.store.flush()
      r.feed(focus(editor, 'Refused replacement canary', sighting, 'reconcile'))
      r.clock.t = T0 + 7 * DAY_MS + MIN
      r.storage.pruneBatch()
      if (blocker === 'retention') r.clock.t = sighting + 7 * DAY_MS + MIN
      else if (blocker === 'pause') {
        r.storage.db.prepare('INSERT INTO pauses (since_wall_ms, until_wall_ms) VALUES (?, ?)').run(sighting, sighting + MIN)
        r.storage.rules.loadPauses()
      } else {
        r.storage.db.prepare("INSERT INTO deletions (kind, app_id, from_wall_ms, to_wall_ms, created_wall_ms, state) VALUES (?, ?, ?, ?, ?, 'pending')")
          .run(blocker === 'range deletion' ? 'range' : 'source', editor.app_id, sighting, sighting + MIN, r.clock.t)
        r.storage.rules.loadTombstones()
      }
      assert.equal(r.store.flush(), true)
      assert.deepEqual(r.store.query('SELECT id FROM observations'), [])
      assert.deepEqual(r.storage.search('canary'), [])
    } finally {
      r.close()
    }
  })
}

test('a replacement rolls back and retries atomically, and its id is never reused after restart', () => {
  resetSeq()
  const r = rig()
  let replacementId: number
  try {
    r.storage.setRetentionDays(7)
    r.feed(focus(editor, 'Retry replacement', T0))
    r.store.flush()
    r.feed(focus(editor, 'Retry replacement', sighting, 'reconcile'))
    r.clock.t = T0 + 7 * DAY_MS + MIN
    r.storage.pruneBatch()
    let fail = true
    r.storage.db.function('fail_id_mark_once', () => {
      if (fail) {
        fail = false
        throw Object.assign(new Error('injected id mark failure'), { code: 'SQLITE_BUSY' })
      }
      return 1
    })
    r.storage.db.exec("CREATE TEMP TRIGGER fail_id_mark BEFORE INSERT ON meta WHEN NEW.key = 'next_observation_id' BEGIN SELECT fail_id_mark_once(); END")
    assert.equal(r.store.flush(), false)
    assert.deepEqual(r.store.query('SELECT id FROM observations'), [], 'the replacement rolled back with the id mark')
    assert.equal(r.store.flush(), true)
    const rows = r.store.query<{ id: number }>('SELECT id FROM observations')
    assert.equal(rows.length, 1, 'retry writes the sighting once')
    replacementId = rows[0]!.id
    assert.ok(Number(r.store.query<{ value: string }>("SELECT value FROM meta WHERE key = 'next_observation_id'")[0]!.value) > replacementId)
    r.storage.db.prepare('DELETE FROM observations').run()
  } finally {
    r.close()
  }
  const again = rig(r.dir)
  try {
    again.feed(focus(editor, 'After restart', sighting + MIN))
    again.store.flush()
    assert.ok(again.store.query<{ id: number }>('SELECT id FROM observations')[0]!.id > replacementId)
  } finally {
    again.close()
  }
})


for (const retry of [false, true]) {
  test(`one pruned source gets one replacement for all queued extensions, including equal timestamps${retry ? ' after rollback' : ''}`, () => {
    resetSeq()
    const r = rig()
    const conn = new Database(path.join(r.dir, DB_FILE))
    try {
      r.storage.setRetentionDays(7)
      r.feed(focus(editor, 'Merged replacement', T0))
      r.store.flush()
      r.feed(focus(editor, 'Merged replacement', sighting, 'reconcile'))
      r.feed(focus(editor, 'Merged replacement', sighting + MIN, 'reconcile'))
      r.feed(focus(editor, 'Merged replacement', sighting + MIN, 'reconcile'))
      r.clock.t = T0 + 7 * DAY_MS + MIN
      pruneStep(conn, T0 + MIN, 0)
      assert.deepEqual(r.store.query('SELECT id FROM observations'), [])
      if (retry) {
        let fail = true
        r.storage.db.function('fail_merged_id_mark_once', () => {
          if (fail) {
            fail = false
            throw Object.assign(new Error('injected id mark failure'), { code: 'SQLITE_BUSY' })
          }
          return 1
        })
        r.storage.db.exec("CREATE TEMP TRIGGER fail_merged_id_mark BEFORE INSERT ON meta WHEN NEW.key = 'next_observation_id' BEGIN SELECT fail_merged_id_mark_once(); END")
        assert.equal(r.store.flush(), false)
        assert.deepEqual(r.store.query('SELECT id FROM observations'), [])
      }
      assert.equal(r.store.flush(), true)
      assert.deepEqual(r.store.query('SELECT event_wall_ms, last_seen_wall_ms, repeat_count FROM observations'), [
        { event_wall_ms: sighting, last_seen_wall_ms: sighting + MIN, repeat_count: 2 },
      ])
      assert.equal(r.store.query<{ n: number }>('SELECT count(*) AS n FROM intervals')[0]!.n, 1)
    } finally {
      conn.close()
      r.close()
    }
  })
}


for (const order of ['extension then flag', 'flag then extension', 'extension then flag with rollback'] as const) {
  test(`a pruned replacement keeps its queued stale-title marker: ${order}`, () => {
    resetSeq()
    const r = rig()
    const conn = new Database(path.join(r.dir, DB_FILE))
    try {
      r.storage.setRetentionDays(7)
      r.feed(focus(editor, 'Stalled replacement', T0))
      r.store.flush()
      const staleSince = sighting + MIN
      if (order === 'flag then extension') r.normalizer.onTitleChannel('stalled', staleSince)
      r.feed(focus(editor, 'Stalled replacement', sighting, 'reconcile'))
      if (order !== 'flag then extension') r.normalizer.onTitleChannel('stalled', staleSince)
      r.clock.t = T0 + 7 * DAY_MS + MIN
      pruneStep(conn, T0 + MIN, 0)
      assert.deepEqual(r.store.query('SELECT id FROM observations'), [])
      if (order.endsWith('rollback')) {
        let fail = true
        r.storage.db.function('fail_stale_id_mark_once', () => {
          if (fail) {
            fail = false
            throw Object.assign(new Error('injected id mark failure'), { code: 'SQLITE_BUSY' })
          }
          return 1
        })
        r.storage.db.exec("CREATE TEMP TRIGGER fail_stale_id_mark BEFORE INSERT ON meta WHEN NEW.key = 'next_observation_id' BEGIN SELECT fail_stale_id_mark_once(); END")
        assert.equal(r.store.flush(), false)
        assert.deepEqual(r.store.query('SELECT id FROM observations'), [])
      }
      assert.equal(r.store.flush(), true)
      assert.deepEqual(r.store.query('SELECT title, event_wall_ms, possibly_stale_since_wall_ms FROM observations'), [
        { title: 'Stalled replacement', event_wall_ms: sighting, possibly_stale_since_wall_ms: staleSince },
      ])
    } finally {
      conn.close()
      r.close()
    }
  })
}
