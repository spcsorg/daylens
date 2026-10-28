// Collection between slices releases native decode buffers before more history is read.
import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { parentPort, workerData } from 'node:worker_threads'
import { AgentReader } from './reader.ts'
import { AgentStore } from './store.ts'
import { AgentPolicy } from '../../storage/agentPolicy.ts'
import { Rules } from '../../storage/rules.ts'
import { subCounts } from './types.ts'
import type { PlainRoot } from './backfill.ts'
import type { Span } from './withheld.ts'

if (!parentPort) throw new Error('backfill requires a worker message port')
const port = parentPort
const { staging, roots, spans, live: liveFile, platform } = workerData as { staging: string; roots: PlainRoot[]; spans: Span[]; live: string | null; platform: NodeJS.Platform }
setFlagsFromString('--expose-gc')
const collect = runInNewContext('gc') as () => void
setFlagsFromString('--no-expose-gc')
const db = new Database(staging)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = OFF')
db.pragma('cache_size = -256')
const store = Object.assign(new AgentStore(db), { platform })
// The staging copy is storage too: what the live database refuses (deleted, excluded, withheld) is never written to it.
const live = liveFile ? new Database(liveFile, { readonly: true, fileMustExist: true }) : null
const storage = live !== null && ['deletions', 'pauses', 'settings', 'exclusion_periods'].every((t) => live.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t) !== undefined)
const rules = storage ? new Rules(live, Date.now) : null
if (rules) Object.assign(store, new AgentPolicy(live!, rules, Date.now).gatePolicy())
else store.withheld = () => spans ?? []
store.live = live
const reader = new AgentReader(store, roots, { recordHealth: false })

port.on('message', async ({ files, budget, stop }: { files: string[]; budget: number; stop?: boolean }) => {
  if (stop) {
    await reader.stop()
    db.close()
    live?.close()
    port.close()
    return
  }
  // Deletions, pauses and exclusions made while the first read runs apply from its next slice.
  rules?.load()
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
