// Capture write latency while one app is deleted from a database of more than a year of heavy use, and while that
// deletion is purged. Minutes long, so it runs on its own: npm run test:large
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ObservationRow } from '../../capture/normalize.ts'
import { DB_FILE, Store } from '../../capture/store.ts'
import { Storage } from '../../storage/index.ts'
import { diskContains } from '../storage/support.ts'
import { CANARY, CANARY_APP, LARGE_END, LARGE_MIN_MB, largeDatabase } from './generate.ts'

// Capture's flush budget: a write waits at most this long to land.
const FLUSH_BUDGET_MS = 100
const WRITE_EVERY_MS = 20

type Phase = 'pending' | 'done' | 'purged'

interface Run {
  sizeMb: number
  flushes: { phase: Phase; ms: number }[]
  doneMs: number
  purgedMs: number
  observations: number
  canaryLeft: string[]
  state: string
  // The longest the deletion worker went without committing while it had work: what a stall time must stay above.
  workerQuietMs: number
}

async function deleteWhileCapturing(): Promise<Run> {
  const dir = await largeDatabase()
  const sizeMb = statSync(path.join(dir, DB_FILE)).size / 1048576
  const clock = { t: LARGE_END + 3_600_000 }
  const now = () => clock.t
  const store = new Store(dir, { now })
  const storage = new Storage(store, dir, { deletionStallMs: Infinity, now, orderingPoint: () => ({ boot: 'b', mono_us: clock.t * 1000, boot_identity: 'kernel' }) })
  storage.start()
  await storage.derivationSettled()
  let tombstone: number | null = null
  const state = store.database.prepare('SELECT state FROM deletions WHERE id = ?').pluck()
  const flushes: Run['flushes'] = []
  let started: { at: number; phase: Phase } | null = null
  const startWrite = store.onWriteStart
  const endWrite = store.onWriteEnd
  store.onWriteStart = () => {
    startWrite()
    if (started === null && tombstone !== null) started = { at: performance.now(), phase: state.get(tombstone) as Phase }
  }
  store.onWriteEnd = () => {
    endWrite()
    if (store.storeHealth().pendingOps === 0 && started !== null) {
      flushes.push({ phase: started.phase, ms: performance.now() - started.at })
      started = null
    }
  }
  let i = 0
  const write = (): ObservationRow => {
    clock.t += WRITE_EVERY_MS
    return {
      run: 'live', seq: 0, boot: 'b', platform: 'macos', source: 'live', kind: 'focus', event_wall_ms: clock.t, event_mono_us: clock.t * 1000, tz: 'Example/Town',
      tz_offset_min: -300, app_id: 'com.example.editor', app_name: 'Editor', app_path: null, pid: 1, window: 'w', title: `live ${i++}`, title_raw: null, title_state: 'ok', state: 'ok', detail: null,
    }
  }
  // Each write is flushed at once, so every one measures how long a write waits behind the deletion.
  const capture = setInterval(() => {
    store.insertObservation(write())
    store.flush()
  }, WRITE_EVERY_MS)
  try {
    const t0 = performance.now()
    const handle = storage.deleteSource(CANARY_APP)
    tombstone = handle.tombstone
    const result = await handle.done
    const doneMs = performance.now() - t0
    await handle.purged
    const purgedMs = performance.now() - t0
    clearInterval(capture)
    store.flush()
    const workerQuietMs = (storage as unknown as { deletions: { longestQuietMs: number } }).deletions.longestQuietMs
    return { sizeMb, flushes, doneMs, purgedMs, observations: result.observations, canaryLeft: diskContains(dir, CANARY), state: state.get(handle.tombstone) as string, workerQuietMs }
  } finally {
    clearInterval(capture)
    storage.stop()
    store.close()
    // Each run works on a 400 MB clone of the cached database; it is not kept.
    rmSync(dir, { recursive: true, force: true })
  }
}

let run: Promise<Run> | null = null
const once = () => (run ??= deleteWhileCapturing())

function summary(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b)
  const at = (f: number) => Math.round(s[Math.min(s.length - 1, Math.floor(f * s.length))]! * 10) / 10
  return { flushes: s.length, p50_ms: at(0.5), p99_ms: at(0.99), max_ms: Math.round(s.at(-1)! * 10) / 10 }
}

test('capture writes land within the flush budget while a large file is purged, and nothing deleted is left', { timeout: 30 * 60_000 }, async (t) => {
  const r = await once()
  const purge = r.flushes.filter((f) => f.phase === 'done').map((f) => f.ms)
  t.diagnostic(JSON.stringify({ size_mb: Math.round(r.sizeMb), observations_deleted: r.observations, done_s: Math.round(r.doneMs / 100) / 10, purged_s: Math.round(r.purgedMs / 100) / 10, worker_quiet_max_ms: Math.round(r.workerQuietMs), purge: summary(purge) }))
  assert.ok(r.sizeMb >= LARGE_MIN_MB)
  assert.ok(r.observations > 0)
  assert.ok(purge.length > 0, 'capture wrote while the purge ran')
  assert.ok(Math.max(...purge) <= FLUSH_BUDGET_MS, `slowest write during the purge took ${Math.max(...purge).toFixed(1)} ms`)
  assert.equal(r.state, 'purged')
  assert.deepEqual(r.canaryLeft, [])
})

test('capture writes land within the flush budget while a large deletion removes rows', { timeout: 30 * 60_000 }, async (t) => {
  const r = await once()
  const removal = r.flushes.filter((f) => f.phase === 'pending').map((f) => f.ms)
  t.diagnostic(JSON.stringify({ size_mb: Math.round(r.sizeMb), observations_deleted: r.observations, done_s: Math.round(r.doneMs / 100) / 10, removal: summary(removal) }))
  assert.ok(removal.length > 100, 'capture wrote while rows were removed')
  assert.ok(Math.max(...removal) <= FLUSH_BUDGET_MS, `slowest write during the removal took ${Math.max(...removal).toFixed(1)} ms`)
})
