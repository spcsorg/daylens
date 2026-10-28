// The first full scrub of the large test database (more than a year of heavy use), as the deletion worker runs it:
// pages zeroed and the time it takes, how long each transaction holds the write lock, the write-ahead log's peak size,
// the checkpoint that truncates the log after it, and whether a second scrub of the clean file takes the lock at all.
// Each run scrubs a fresh copy. Timings depend on load, so the load averages are printed with them.
// Usage: node tools/scrubbench.ts [--runs 8] [--step-ms 20]
import Database from 'better-sqlite3'
import { rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { DB_FILE } from '../capture/store.ts'
import { scrubAll, scrubBlocked } from '../storage/scrub.ts'
import { immediateRetrying } from '../storage/tx.ts'
import { largeDatabase } from '../tests/large/generate.ts'

const { values } = parseArgs({ options: { runs: { type: 'string', default: '8' }, 'step-ms': { type: 'string', default: '20' } } })
const RUNS = Number(values.runs)
// The deletion worker's step (FTS_STEP_MS in storage/deletion.ts).
const STEP_MS = Number(values['step-ms'])

const load = () => os.loadavg().map((l) => l.toFixed(2)).join(' ')
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.floor(q * s.length))]!
}
const round = (n: number, d = 1) => Number(n.toFixed(d))

interface Run {
  size_mb: number
  pages: number
  transactions: number
  total_s: number
  hold_p50_ms: number
  hold_max_ms: number
  wal_peak_mb: number
  final_checkpoint_ms: number
  second_scrub_transactions: number
}

async function run(): Promise<{ run: Run; holds: number[] }> {
  const dir = await largeDatabase()
  const file = path.join(dir, DB_FILE)
  const db = new Database(file)
  try {
    const blocked = scrubBlocked(db)
    if (blocked !== null) throw new Error(`the scrub cannot run here: ${blocked} (npm run build:sqlite)`)
    const walSize = () => {
      try {
        return statSync(`${file}-wal`).size
      } catch {
        return 0
      }
    }
    const holds: number[] = []
    let pages = 0
    let walPeak = walSize()
    const t0 = performance.now()
    scrubAll(db, STEP_MS, (fn) => immediateRetrying(db, fn), (ms, n) => {
      holds.push(ms)
      pages += n
      walPeak = Math.max(walPeak, walSize())
    })
    const totalMs = performance.now() - t0
    const c0 = performance.now()
    db.pragma('wal_checkpoint(TRUNCATE)')
    const checkpointMs = performance.now() - c0
    let second = 0
    scrubAll(db, STEP_MS, (fn) => immediateRetrying(db, fn), () => second++)
    return {
      holds,
      run: {
        size_mb: round(statSync(file).size / 1048576),
        pages,
        transactions: holds.length,
        total_s: round(totalMs / 1000, 2),
        hold_p50_ms: round(quantile(holds, 0.5)),
        hold_max_ms: round(Math.max(0, ...holds)),
        wal_peak_mb: round(walPeak / 1048576),
        final_checkpoint_ms: round(checkpointMs, 2),
        second_scrub_transactions: second,
      },
    }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(JSON.stringify({ load_before: load(), runs: RUNS, step_ms: STEP_MS }))
const all: number[] = []
const runs: Run[] = []
for (let i = 0; i < RUNS; i++) {
  const r = await run()
  all.push(...r.holds)
  runs.push(r.run)
  console.log(JSON.stringify({ run: i + 1, ...r.run, load: load() }))
}
console.log(JSON.stringify({
  pages: [...new Set(runs.map((r) => r.pages))],
  total_s: [Math.min(...runs.map((r) => r.total_s)), Math.max(...runs.map((r) => r.total_s))],
  hold_median_ms: round(quantile(all, 0.5)),
  hold_worst_ms: Math.max(...runs.map((r) => r.hold_max_ms)),
  wal_peak_mb: Math.max(...runs.map((r) => r.wal_peak_mb)),
  final_checkpoint_ms: [Math.min(...runs.map((r) => r.final_checkpoint_ms)), Math.max(...runs.map((r) => r.final_checkpoint_ms))],
  second_scrub_transactions: Math.max(...runs.map((r) => r.second_scrub_transactions)),
  load_after: load(),
}))
