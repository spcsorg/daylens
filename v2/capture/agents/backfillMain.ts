// Child process entry for one slice of a first read. Usage: backfillMain.ts <staging.sqlite>, {roots, files} as JSON on stdin.
import Database from 'better-sqlite3'
import { AgentReader } from './reader.ts'
import { AgentStore } from './store.ts'
import type { PlainRoot } from './backfill.ts'

const staging = process.argv[2]!
let input = ''
for await (const chunk of process.stdin) input += chunk
const { roots, files, budget } = JSON.parse(input) as { roots: PlainRoot[]; files: string[]; budget: number }

let peak = process.memoryUsage().rss
const parts = { heap_total: 0, heap_used: 0, external: 0, array_buffers: 0 }
const sampler = setInterval(() => {
  const m = process.memoryUsage()
  peak = Math.max(peak, m.rss)
  parts.heap_total = Math.max(parts.heap_total, m.heapTotal)
  parts.heap_used = Math.max(parts.heap_used, m.heapUsed)
  parts.external = Math.max(parts.external, m.external)
  parts.array_buffers = Math.max(parts.array_buffers, m.arrayBuffers)
}, 20)
const cpu0 = process.cpuUsage()
const t0 = performance.now()
const db = new Database(staging)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = OFF')
db.pragma('cache_size = -256')
const reader = new AgentReader(new AgentStore(db), roots, { recordHealth: false })
const remaining = await reader.readOnly(files, budget)
db.close()
clearInterval(sampler)
const cpu = process.cpuUsage(cpu0)
peak = Math.max(peak, process.memoryUsage().rss)
process.stdout.write(
  `${JSON.stringify({
    wall_ms: Math.round(performance.now() - t0),
    cpu_ms: Math.round((cpu.user + cpu.system) / 1000),
    peak_rss_mb: Math.round(peak / 1e6),
    peak_mb: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v / 1e6)])),
    files_read: reader.stats.filesRead,
    mb_read: Math.round(reader.stats.bytesRead / 1e6),
    lines: reader.stats.lines,
    records: reader.stats.records,
    roots: reader.rootCounts(),
    remaining,
    progressed: reader.progressed,
    deferred_files: reader.deferredFiles,
  })}\n`,
)
