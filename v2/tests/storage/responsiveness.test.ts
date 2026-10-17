import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ObservationRow } from '../../capture/normalize.ts'
import Database from 'better-sqlite3'
import path from 'node:path'
import { DB_FILE } from '../../capture/store.ts'
import { HOUR, rig, T0 } from './support.ts'

function row(t: number, app: string, title: string): ObservationRow {
  return {
    run: 'seed', seq: 0, boot: 'b', platform: 'macos', source: 'seed', kind: 'focus', event_wall_ms: t, event_mono_us: t * 1000, tz: 'Africa/Kigali',
    tz_offset_min: 120, app_id: app, app_name: app, app_path: null, pid: 1, window: 'w', title, title_raw: null, title_state: 'ok', state: 'ok', detail: null,
  }
}

// A few weeks of heavy use: enough that removing one app synchronously stalled capture for longer than 100 ms.
function seed(r: ReturnType<typeof rig>, rows: number): void {
  for (let i = 0; i < rows; i++) {
    const app = i % 3 === 0 ? 'com.example.chat' : i % 3 === 1 ? 'com.example.editor' : 'com.example.browser'
    r.store.insertObservation(row(T0 + i * 20_000, app, `${app.slice(12)} item ${i % 4000} ${['plan', 'review', 'draft', 'notes'][i % 4]} canary${i % 4000}`))
  }
  r.store.flush()
}

test('a deletion responds at once and never stalls capture, however much it removes', async () => {
  const r = rig()
  seed(r, 60_000)
  r.clock.t = T0 + 60_000 * 20_000 + HOUR
  const lags: number[] = []
  let last = performance.now()
  const tick = setInterval(() => {
    const now = performance.now()
    lags.push(now - last - 5)
    last = now
  }, 5)
  const t0 = performance.now()
  const handle = r.storage.deleteSource('com.example.chat')
  const responded = performance.now() - t0
  assert.deepEqual(r.storage.search('chat'), [], 'hidden from search as soon as the call returns')
  const result = await handle.done
  clearInterval(tick)
  const worstLag = Math.max(...lags)
  assert.ok(responded < 100, `the call returned in ${responded.toFixed(1)} ms`)
  assert.ok(worstLag < 100, `capture's event loop stalled at most ${worstLag.toFixed(1)} ms`)
  assert.equal(result.observations, 20_000)
  assert.deepEqual(r.q(`SELECT 1 FROM observations WHERE app_id = 'com.example.chat' LIMIT 1`), [])
  assert.deepEqual(r.q(`SELECT 1 FROM search_docs WHERE app_id = 'com.example.chat' LIMIT 1`), [])
  r.close()
})

test('a deletion left pending by a crash is still in force, and finishes at the next start', async () => {
  const r = rig()
  seed(r, 6000)
  r.clock.t = T0 + 6000 * 20_000 + HOUR
  const handle = r.storage.deleteSource('com.example.chat')
  await handle.done
  r.close()
  // As a crash part-way through leaves it: still pending, with rows not yet removed.
  const raw = new Database(path.join(r.dir, DB_FILE))
  raw.prepare(`UPDATE deletions SET state = 'pending'`).run()
  raw.prepare(`INSERT INTO observations (run, seq, boot, platform, source, kind, event_wall_ms, event_mono_us, tz, tz_offset_min, recorded_wall_ms, last_seen_wall_ms, app_id, title, title_state)
               VALUES ('x', 0, 'b', 'macos', 'x', 'focus', ?, 0, 'Africa/Kigali', 120, ?, ?, 'com.example.chat', 'chat left behind', 'ok')`).run(T0, T0, T0)
  raw.close()
  const r2 = rig(r.dir)
  r2.clock.t = r.clock.t
  assert.equal(r2.storage.accepts(T0, 'com.example.chat', null), false, 'refused before the work is done')
  r2.storage.start()
  await r2.storage.deletionsSettled()
  assert.deepEqual(r2.q(`SELECT state FROM deletions`), [{ state: 'done' }])
  assert.deepEqual(r2.q(`SELECT 1 FROM observations WHERE app_id = 'com.example.chat' LIMIT 1`), [])
  assert.deepEqual(r2.storage.search('chat'), [])
  r2.close()
})
