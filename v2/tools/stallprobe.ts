// Times each step of a deletion on the capture thread: node tools/stallprobe.ts <dir>
import { Store } from '../capture/store.ts'
import { Storage } from '../storage/index.ts'
const dir = process.argv[2]!
const t0 = performance.now()
const store = new Store(dir)
let last = (store.database.prepare('SELECT max(last_seen_wall_ms) AS t FROM observations').get() as { t: number }).t
const storage = new Storage(store, dir, { now: () => clock.t + 1000 })
console.log('open ms', (performance.now() - t0).toFixed(1))
let lt = last + 60_000
const clock = { t: lt }
if (process.argv[3] === 'live') {
  // As the benchmark does before deleting: a minute of live capture, one flush a second.
  let id = -1
  for (let i = 0; i < 60; i++) {
    lt += 1000
    clock.t = lt
    const row = { run: 'l', seq: 0, boot: 'b', platform: 'macos', source: 's', kind: 'focus' as const, event_wall_ms: lt, event_mono_us: 0, tz: 'UTC', tz_offset_min: 0, app_id: 'x', app_name: 'x', app_path: null, pid: 1, window: 'w', title: `live ${i % 5}`, title_raw: null, title_state: 'ok' as const, state: 'ok', detail: null }
    if (i % 5 === 0) id = store.insertObservation(row)
    else store.extendObservation(id, lt)
    store.flush()
  }
}
for (let i = 0; i < 3; i++) {
  const lags: { at: number; lag: number }[] = []
  let prev = performance.now()
  const tick = setInterval(() => {
    const now = performance.now()
    lags.push({ at: now, lag: now - prev - 5 })
    prev = now
  }, 5)
  const s = performance.now()
  const h = storage.deleteLast(10 * 60_000)
  const respond = performance.now() - s
  await h.done
  const done = performance.now() - s
  await h.purged
  await new Promise((r) => setTimeout(r, 50))
  clearInterval(tick)
  const worst = lags.reduce((a, b) => (b.lag > a.lag ? b : a), { at: 0, lag: 0 })
  console.log(`run ${i}: respond ${respond.toFixed(1)} done ${done.toFixed(1)} worst stall ${worst.lag.toFixed(1)} at +${(worst.at - s).toFixed(0)} ms`)
}
storage.stop()
store.close()
