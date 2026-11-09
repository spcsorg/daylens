// Proves a release build keeps the test switches out: the Node inspector fuse is off, app.asar holds no tool code (the
// worlds, the seed, the stand-in helper, the demo), and launched on an invented world at a test time it still runs on
// the real time, its own default data folder and its own helper. --test proves a test build the other way round.
// Usage: node app/package/checkRelease.ts [--test] [<Daylens.app>]   (default: what app:package [--test] builds)
import { listPackage } from '@electron/asar'
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses'
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { DB_FILE } from '../../capture/store.ts'
import { makeWorld } from '../tools/world.ts'

const { values, positionals } = parseArgs({ options: { test: { type: 'boolean', default: false } }, allowPositionals: true })
const test = values.test!
const V2 = path.resolve(import.meta.dirname, '..', '..')
const app = positionals[0] ?? path.join(V2, 'build', test ? 'test' : 'release', test ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac') : 'mac-universal', 'Daylens.app')
const binary = path.join(app, 'Contents', 'MacOS', 'Daylens')
if (!existsSync(binary)) throw new Error(`no app at ${app}`)
const problems: string[] = []

// The fuse wire stores each fuse as the character '0' or '1'.
const inspector = (await getCurrentFuseWire(binary))[FuseV1Options.EnableNodeCliInspectArguments] === '1'.charCodeAt(0)
if (inspector !== test) problems.push(`the Node inspector fuse is ${inspector ? 'on' : 'off'}`)

const tools = listPackage(path.join(app, 'Contents', 'Resources', 'app.asar'), { isPack: false }).filter(
  (f) => /[\\/]app[\\/]tools[\\/]/.test(f) || /^(seed|worlds?|demo|demoHelper|demo-helper|bench|cdp)\.(c?js|mjs|ts|sh)$/.test(path.basename(f)),
)
if (tools.length) problems.push(`app.asar holds tool code: ${tools.join(', ')}`)

const TEST_NOW = '2001-01-01T12:00:00Z'
const T = Date.parse(TEST_NOW)
const world = makeWorld({ now: TEST_NOW })
try {
  const started = Date.now()
  const run = await benchRun({ ...world.env, DAYLENS_BENCH: '1' })
  const ended = Date.now()
  const clock = run.now_ms >= T && run.now_ms < T + 10 * 60_000 ? 'the test time' : run.now_ms >= started && run.now_ms <= ended ? 'the real time' : 'neither time'
  if (clock !== (test ? 'the test time' : 'the real time')) problems.push(`main ran on ${clock}: ${new Date(run.now_ms).toISOString()}`)
  // A release build's own folder, under the world's home; a test build keeps the world's.
  const data = test ? world.data : path.join(world.home, 'Library', 'Application Support', 'Daylens V2')
  if (run.data_dir !== data) problems.push(`the data folder was ${run.data_dir}, not ${data}`)
  const db = new Database(path.join(run.data_dir, DB_FILE), { readonly: true, fileMustExist: true })
  const standIn = (db.prepare(`SELECT count(*) AS n FROM capture_runs WHERE helper = 'demo'`).get() as { n: number }).n > 0
  db.close()
  if (standIn !== test) problems.push(`the stand-in helper ${standIn ? 'ran' : 'did not run'}`)
} catch (err) {
  problems.push(`it did not run: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  rmSync(world.root, { recursive: true, force: true })
}

process.stdout.write(problems.length ? `${app} is not a ${test ? 'test' : 'release'} build:\n${problems.map((p) => `  ${p}\n`).join('')}` : `${app}: a ${test ? 'test' : 'release'} build\n`)
process.exit(problems.length ? 1 : 0)

// The bench mode drives the window, reports what it ran on and quits.
function benchRun(env: NodeJS.ProcessEnv): Promise<{ now_ms: number; data_dir: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { env, stdio: ['ignore', 'pipe', 'inherit'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('no bench line within 60 s'))
    }, 60_000)
    let run: { now_ms: number; data_dir: string } | null = null
    createInterface({ input: child.stdout! }).on('line', (line) => {
      if (line.startsWith('DAYLENS_BENCH_RUN ')) run = JSON.parse(line.slice('DAYLENS_BENCH_RUN '.length))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (run) resolve(run)
      else reject(new Error(`Daylens exited with code ${code} before its bench line`))
    })
  })
}
