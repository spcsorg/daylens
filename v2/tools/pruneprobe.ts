// Times retention batches on an existing database copy: node tools/pruneprobe.ts <dir> <days-to-keep>
import { Store } from '../capture/store.ts'
import { Storage } from '../storage/index.ts'
const [dir, keep] = process.argv.slice(2) as [string, string]
const store = new Store(dir)
const last = (store.database.prepare('SELECT max(event_wall_ms) AS t FROM observations').get() as { t: number }).t
const storage = new Storage(store, dir, { deletionStallMs: Infinity, now: () => last })
storage.setRetentionDays(Number(keep))
storage.stop()
const times: number[] = []
for (;;) {
  const t = performance.now()
  const n = storage.pruneBatch()
  times.push(performance.now() - t)
  if (n === 0) break
}
times.sort((a, b) => a - b)
console.log(JSON.stringify({ batches: times.length, max_ms: times.at(-1)!.toFixed(1), p95_ms: times[Math.floor(times.length * 0.95)]!.toFixed(1), p50_ms: times[Math.floor(times.length / 2)]!.toFixed(1), total_s: (times.reduce((a, b) => a + b, 0) / 1000).toFixed(1) }))
store.close()
