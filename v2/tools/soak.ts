// Runs the capture service with a real helper, samples every process it owns, and reports CPU, memory,
// wakeups and energy against the background budget (docs/system-design.md#budgets).
// Usage: node tools/soak.ts --helper <path> --minutes 60 --out <dir> [--procstat <path>] [--warmup-s 60]
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const { values } = parseArgs({
  options: {
    helper: { type: 'string' },
    minutes: { type: 'string', default: '60' },
    out: { type: 'string' },
    procstat: { type: 'string' },
    'warmup-s': { type: 'string', default: '60' },
    'interval-s': { type: 'string', default: '10' },
    summarize: { type: 'boolean', default: false },
    'from-ms': { type: 'string' },
    'to-ms': { type: 'string' },
  },
})
const out = values.out!
const procstat = values.procstat ?? path.join(out, 'procstat')
const service = fileURLToPath(new URL('../capture/service.ts', import.meta.url))

interface Sample {
  t_ms: number
  pid: number
  name: string
  cpu_ns: number
  footprint: number
  peak_footprint: number
  rss: number
  idle_wkups: number
  int_wkups: number
  energy_nj: number
  disk_write: number
}

function linearSlope(xs: number[], ys: number[]): number {
  const n = xs.length
  if (n < 2) return 0
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my)
    den += (xs[i]! - mx) ** 2
  }
  return den === 0 ? 0 : num / den
}

export function summarize(dir: string, warmupS: number, window: { from?: number; to?: number } = {}): Record<string, unknown> {
  const samples: Sample[] = readFileSync(path.join(dir, 'samples.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const owned = samples.filter((s) => s.name === 'node' || s.name.startsWith('daylens-capture'))
  const times = [...new Set(owned.map((s) => s.t_ms))].sort((a, b) => a - b)
  const t0 = times[0]!
  const measured = times.filter((t) => t - t0 >= warmupS * 1000 && t >= (window.from ?? 0) && t <= (window.to ?? Infinity))
  const from = measured[0]!
  const to = measured[measured.length - 1]!
  const wallS = (to - from) / 1000
  const perProc: Record<string, unknown>[] = []
  let cpuNs = 0
  let wakeups = 0
  let energyNj = 0
  let diskWrite = 0
  for (const pid of new Set(owned.map((s) => s.pid))) {
    const series = owned.filter((s) => s.pid === pid && s.t_ms >= from && s.t_ms <= to)
    if (series.length < 2) continue
    const a = series[0]!
    const b = series[series.length - 1]!
    const spanS = (b.t_ms - a.t_ms) / 1000
    const dCpu = b.cpu_ns - a.cpu_ns
    cpuNs += dCpu
    wakeups += b.idle_wkups + b.int_wkups - a.idle_wkups - a.int_wkups
    energyNj += b.energy_nj - a.energy_nj
    diskWrite += b.disk_write - a.disk_write
    perProc.push({
      pid,
      name: a.name,
      cpu_pct_of_one_core: +((dCpu / 1e9 / spanS) * 100).toFixed(4),
      footprint_mb_first: +(a.footprint / 2 ** 20).toFixed(1),
      footprint_mb_last: +(b.footprint / 2 ** 20).toFixed(1),
      lifetime_peak_mb: +(Math.max(...series.map((s) => s.peak_footprint)) / 2 ** 20).toFixed(1),
      wakeups_per_s: +((b.idle_wkups + b.int_wkups - a.idle_wkups - a.int_wkups) / spanS).toFixed(3),
    })
  }
  const combined = measured.map((t) => owned.filter((s) => s.t_ms === t).reduce((sum, s) => sum + s.footprint, 0) / 2 ** 20)
  const hours = measured.map((t) => (t - from) / 3_600_000)
  const cores = os.availableParallelism()
  const result: Record<string, unknown> = {
    measured_minutes: +(wallS / 60).toFixed(1),
    warmup_excluded_s: warmupS,
    cpu_pct_of_one_core: +((cpuNs / 1e9 / wallS) * 100).toFixed(4),
    cpu_pct_of_machine: +((cpuNs / 1e9 / wallS / cores) * 100).toFixed(5),
    cores,
    memory_combined_mb: {
      first: +combined[0]!.toFixed(1),
      last: +combined[combined.length - 1]!.toFixed(1),
      max_sampled: +Math.max(...combined).toFixed(1),
      lifetime_peak_sum: +perProc.reduce((s, p) => s + (p.lifetime_peak_mb as number), 0).toFixed(1),
      slope_mb_per_hour: +linearSlope(hours, combined).toFixed(3),
    },
    wakeups_per_s: +(wakeups / wallS).toFixed(3),
    avg_power_mw: +(energyNj / 1e6 / wallS).toFixed(3),
    disk_write_kb_per_hour: +((diskWrite / 1024) / (wallS / 3600)).toFixed(1),
    processes: perProc,
  }
  try {
    const db = new Database(path.join(dir, 'data', 'daylens-v2.sqlite'), { readonly: true })
    result.observations_by_kind = db.prepare('SELECT kind, count(*) AS rows, sum(repeat_count) AS merged FROM observations GROUP BY kind').all()
    result.gaps = db.prepare('SELECT reason, scope, count(*) AS n, sum(coalesce(end_wall_ms, 0) - start_wall_ms) AS total_ms FROM capture_gaps GROUP BY reason, scope').all()
    result.title_states = db.prepare(`SELECT title_state, count(*) AS n FROM observations WHERE kind = 'focus' GROUP BY title_state`).all()
    db.close()
  } catch {
    result.db = 'unreadable'
  }
  const log = readFileSync(path.join(dir, 'service.log'), 'utf8')
  result.service_stats = log.split('\n').find((l) => l.includes('[capture] stats '))?.replace(/^.*stats /, '') ?? null
  return result
}

async function run(): Promise<void> {
  mkdirSync(out, { recursive: true })
  const svc = spawn(process.execPath, [service, '--helper', values.helper!, '--data-dir', path.join(out, 'data')], { stdio: ['ignore', 'ignore', 'pipe'] })
  const log = createWriteStream(path.join(out, 'service.log'))
  svc.stderr!.pipe(log)
  const ps = spawn(procstat, ['--root', String(svc.pid), '--interval-s', values['interval-s']!], { stdio: ['ignore', 'pipe', 'inherit'] })
  ps.stdout!.pipe(createWriteStream(path.join(out, 'samples.jsonl')))
  const stop = () => svc.kill('SIGTERM')
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  const timer = setTimeout(stop, Number(values.minutes) * 60_000)
  await new Promise((r) => svc.once('exit', r))
  clearTimeout(timer)
  await new Promise((r) => setTimeout(r, 500))
  ps.kill()
  log.end()
  await new Promise((r) => setTimeout(r, 200))
  const summary = summarize(out, Number(values['warmup-s']))
  writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary, null, 2))
}

const window = { from: values['from-ms'] ? Number(values['from-ms']) : undefined, to: values['to-ms'] ? Number(values['to-ms']) : undefined }
if (values.summarize) console.log(JSON.stringify(summarize(out, Number(values['warmup-s']), window), null, 2))
else await run()
