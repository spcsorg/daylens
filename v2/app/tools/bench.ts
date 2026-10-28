// Measures the interface budgets: launch to Today on screen, Today's first paint from local facts, and how fast each
// action shows its result. Each run starts the app fresh with DAYLENS_BENCH=1, which drives the window and prints marks.
// Usage: node app/tools/bench.ts --data-dir <dir> [--runs 5] [--helper <path>] [--app <Daylens.app>]   (--app: a packaged build)
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, runs: { type: 'string', default: '5' }, helper: { type: 'string' }, app: { type: 'string' } } })
if (!values['data-dir']) {
  process.stderr.write('usage: bench.ts --data-dir <dir> [--runs 5]\n')
  process.exit(64)
}
const v2 = path.resolve(import.meta.dirname, '..', '..')
const electron = path.join(v2, 'node_modules', '.bin', 'electron')
const helper = values.helper ?? path.join(v2, 'app', 'tools', 'demo-helper.sh')

function once(): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const [cmd, args] = values.app ? [path.join(values.app, 'Contents', 'MacOS', 'Daylens'), []] : [electron, [path.join(v2, 'app', 'main', 'main.ts')]]
    const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env
    const child = spawn(cmd, args, {
      env: { ...env, DAYLENS_BENCH: '1', DAYLENS_BENCH_SHOW: '1', DAYLENS_V2_DATA_DIR: values['data-dir'], DAYLENS_HELPER: helper },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('no marks within 30 s'))
    }, 30_000)
    createInterface({ input: child.stdout! }).on('line', (line) => {
      if (!line.startsWith('DAYLENS_BENCH ')) return
      const marks = JSON.parse(line.slice('DAYLENS_BENCH '.length)) as Record<string, number>
      clearTimeout(timer)
      child.once('exit', () => resolve({ launch_to_today_ms: marks.today_painted_epoch_ms! - t0, ...marks }))
    })
    child.stderr!.resume()
  })
}

const uptime = execFileSync('uptime', { encoding: 'utf8' }).trim()
const runs: Record<string, number>[] = []
for (let i = 0; i < Number(values.runs); i++) runs.push(await once())
const keys = Object.keys(runs[0]!).filter((k) => k !== 'today_painted_epoch_ms')
const summary = Object.fromEntries(
  keys.map((k) => {
    const xs = runs.map((r) => r[k]!).sort((a, b) => a - b)
    return [k, { median: Math.round(xs[Math.floor(xs.length / 2)]!), max: Math.round(xs.at(-1)!) }]
  }),
)
process.stdout.write(JSON.stringify({ uptime, runs: runs.length, summary, each: process.env.BENCH_EACH ? runs : undefined }, null, 2) + '\n')
