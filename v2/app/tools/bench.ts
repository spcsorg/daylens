// Measures the interface budgets: launch to Today on screen, Today's first paint from local facts, and how fast each
// action shows its result. Each run starts the app fresh with DAYLENS_BENCH=1, which drives the window and prints marks,
// in a throwaway home and shell folder, so nothing of this computer's own is read. Reports p50, p95 and p99 of every
// mark; fails when a run misses a mark, reports one that isn't a time, or the app exits with an error.
// Usage: node app/tools/bench.ts --data-dir <dir> [--runs 100] [--json <file>] [--helper <path>] [--app <path>]
//   --data-dir: a seeded world, such as seed.ts --world heavy
//   --json: also write the summary and every run's marks to this file
//   --app: a packaged build, its Daylens.app on macOS or its executable elsewhere
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'

/** Every mark a run reports: launch to Today measured here, the rest by the renderer. */
export const MARKS = [
  'launch_to_today_ms',
  'renderer_nav_to_today_ms',
  'switch_day_ms',
  'back_to_today_ms',
  'open_hour_ms',
  'week_view_ms',
  'month_view_ms',
  'apps_view_ms',
  'search_order_ms',
  'search_order_form_ms',
  'search_invoice_october_ms',
]

type Marks = Record<string, number>

// The app's own marks, checked: a missing one or one that isn't a time fails the run rather than skewing the report.
function checked(run: number, t0: number, raw: Record<string, unknown>): Marks {
  const { today_painted_epoch_ms: painted, ...rest } = raw
  const marks: Record<string, unknown> = { launch_to_today_ms: typeof painted === 'number' ? painted - t0 : painted, ...rest }
  for (const name of new Set([...MARKS, ...Object.keys(marks)])) {
    const v = marks[name]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`run ${run}: ${name} is ${v === undefined ? 'missing' : JSON.stringify(v)}`)
  }
  return marks as Marks
}

// Nearest rank: the smallest value at least p% of runs are at or under.
const percentile = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!
const round = (ms: number) => Math.round(ms * 10) / 10

if (import.meta.main) {
  const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, runs: { type: 'string', default: '100' }, json: { type: 'string' }, helper: { type: 'string' }, app: { type: 'string' } } })
  const runs = Number(values.runs)
  if (!values['data-dir'] || !Number.isInteger(runs) || runs < 1) {
    process.stderr.write('usage: bench.ts --data-dir <dir> [--runs 100] [--json <file>] [--app <path>]\n')
    process.exit(64)
  }
  const v2 = path.resolve(import.meta.dirname, '..', '..')
  const [cmd, args] = !values.app
    ? [createRequire(import.meta.url)('electron') as string, [path.join(v2, 'app', 'main', 'main.ts')]]
    : values.app.endsWith('.app')
      ? [path.join(values.app, 'Contents', 'MacOS', 'Daylens'), []]
      : [values.app, []]

  // Every reader of this computer's own files (browser history, agent sessions, assistant configs, the shell's state)
  // is pointed at an empty folder; the stand-in helper reports invented windows.
  const root = mkdtempSync(path.join(os.tmpdir(), 'daylens-bench-'))
  const home = path.join(root, 'home')
  for (const d of [path.join(home, '.claude'), path.join(home, '.codex'), path.join(root, 'shell')]) mkdirSync(d, { recursive: true })
  const { ELECTRON_RUN_AS_NODE: _, ...inherited } = process.env
  const env = {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    DAYLENS_V2_HISTORY_HOME: home,
    DAYLENS_SHELL_DIR: path.join(root, 'shell'),
    DAYLENS_V2_BROWSER_SOCKET: process.platform === 'win32' ? `\\\\.\\pipe\\daylens-bench-${process.pid}` : path.join(root, 'browser.sock'),
    DAYLENS_V2_DATA_DIR: values['data-dir'],
    DAYLENS_HELPER: values.helper ?? path.join(v2, 'app', 'tools', 'demo-helper.sh'),
    // The heavy world is seeded in Phoenix time.
    TZ: 'America/Phoenix',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    DAYLENS_BENCH: '1',
    DAYLENS_BENCH_SHOW: '1',
  }

  function once(run: number): Promise<Marks> {
    return new Promise((resolve, reject) => {
      const t0 = Date.now()
      const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let raw: Record<string, unknown> | null = null
      let stderr = ''
      let late = false
      const timer = setTimeout(() => {
        late = true
        child.kill('SIGKILL')
      }, 60_000)
      createInterface({ input: child.stdout! }).on('line', (line) => {
        if (line.startsWith('DAYLENS_BENCH ')) raw = JSON.parse(line.slice('DAYLENS_BENCH '.length)) as Record<string, unknown>
      })
      child.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)))
      child.on('error', reject)
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        if (late) return reject(new Error(`run ${run}: the app did not finish within 60 s\n${stderr}`))
        if (code !== 0) return reject(new Error(`run ${run}: the app exited with ${code === null ? `signal ${signal}` : `code ${code}`}\n${stderr}`))
        if (!raw) return reject(new Error(`run ${run}: the app exited without marks\n${stderr}`))
        try {
          resolve(checked(run, t0, raw))
        } catch (err) {
          reject(err as Error)
        }
      })
    })
  }

  const loadavg = os.loadavg().map(round)
  const each: Marks[] = []
  let failed: Error | null = null
  try {
    for (let i = 1; i <= runs; i++) each.push(await once(i))
  } catch (err) {
    failed = err as Error
  }
  rmSync(root, { recursive: true, force: true })
  if (failed) {
    process.stderr.write(`${failed.message}\n`)
    process.exit(1)
  }
  const marks = Object.fromEntries(
    Object.keys(each[0]!).map((name) => {
      const xs = each.map((r) => r[name]!).sort((a, b) => a - b)
      return [name, { p50: round(percentile(xs, 50)), p95: round(percentile(xs, 95)), p99: round(percentile(xs, 99)), max: round(xs.at(-1)!) }]
    }),
  )
  const summary = { app: values.app ?? 'source', machine: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, loadavg }, runs, marks }
  if (values.json) writeFileSync(values.json, JSON.stringify({ ...summary, each }, null, 2) + '\n')
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
}
