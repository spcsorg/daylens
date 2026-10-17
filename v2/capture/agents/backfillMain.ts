// Child process entry for the first read of a log history. Usage: backfillMain.ts <staging.sqlite>, roots as JSON on stdin.
import Database from 'better-sqlite3'
import { AgentReader } from './reader.ts'
import { AgentStore } from './store.ts'
import type { PlainRoot } from './backfill.ts'

const staging = process.argv[2]!
let input = ''
for await (const chunk of process.stdin) input += chunk
const roots = JSON.parse(input) as PlainRoot[]

let peak = process.memoryUsage().rss
const sampler = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss)
}, 50)
const cpu0 = process.cpuUsage()
const t0 = performance.now()
const db = new Database(staging)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = OFF')
const reader = new AgentReader(new AgentStore(db), roots, { reconcileMs: 3_600_000 })
await reader.start()
await reader.settle()
await reader.stop()
db.close()
clearInterval(sampler)
const cpu = process.cpuUsage(cpu0)
peak = Math.max(peak, process.memoryUsage().rss)
process.stdout.write(
  `${JSON.stringify({
    wall_ms: Math.round(performance.now() - t0),
    cpu_ms: Math.round((cpu.user + cpu.system) / 1000),
    peak_rss_mb: Math.round(peak / 1e6),
    files_read: reader.stats.filesRead,
    mb_read: Math.round(reader.stats.bytesRead / 1e6),
    lines: reader.stats.lines,
    records: reader.stats.records,
  })}\n`,
)
