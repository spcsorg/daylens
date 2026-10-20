// Collection between slices releases native decode buffers before more history is read.
import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { parentPort, workerData } from 'node:worker_threads'
import { AgentReader } from './reader.ts'
import { AgentStore } from './store.ts'
import { subCounts } from './types.ts'
import type { PlainRoot } from './backfill.ts'

if (!parentPort) throw new Error('backfill requires a worker message port')
const port = parentPort
const { staging, roots } = workerData as { staging: string; roots: PlainRoot[] }
setFlagsFromString('--expose-gc')
const collect = runInNewContext('gc') as () => void
setFlagsFromString('--no-expose-gc')
const db = new Database(staging)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = OFF')
db.pragma('cache_size = -256')
const reader = new AgentReader(new AgentStore(db), roots, { recordHealth: false })

port.on('message', async ({ files, budget, stop }: { files: string[]; budget: number; stop?: boolean }) => {
  if (stop) {
    await reader.stop()
    db.close()
    port.close()
    return
  }
  const before = { ...reader.stats }
  const rootBefore = reader.rootCounts()
  const cpu0 = process.cpuUsage()
  const t0 = performance.now()
  let peak = process.memoryUsage().rss
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 20)
  let remaining: boolean
  try {
    remaining = await reader.readOnly(files, budget)
    peak = Math.max(peak, process.memoryUsage().rss)
    collect()
  } finally {
    clearInterval(sampler)
  }
  const cpu = process.cpuUsage(cpu0)
  const memory = process.memoryUsage()
  port.postMessage({
    entrypoint: fileURLToPath(import.meta.url),
    runtime: { electron: process.versions.electron ?? null, node: process.versions.node },
    wall_ms: Math.round(performance.now() - t0),
    cpu_ms: Math.round((cpu.user + cpu.system) / 1000),
    peak_rss_mb: Math.max(peak, memory.rss) / 1e6,
    peak_mb: { heap_total: memory.heapTotal / 1e6, heap_used: memory.heapUsed / 1e6, external: memory.external / 1e6, array_buffers: memory.arrayBuffers / 1e6 },
    files_read: reader.stats.filesRead - before.filesRead,
    mb_read: (reader.stats.bytesRead - before.bytesRead) / 1e6,
    bytes_read: reader.stats.bytesRead - before.bytesRead,
    lines: reader.stats.lines - before.lines,
    records: reader.stats.records - before.records,
    roots: reader.rootCounts().map((root, i) => ({ ...root, counts: subCounts(root.counts, rootBefore[i]!.counts) })),
    remaining,
    progressed: reader.progressed,
    deferred_files: reader.deferredFiles,
  })
})
