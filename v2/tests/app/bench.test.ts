// The bench's report and its refusals, with Node standing in for the app: run through NODE_OPTIONS, the stand-in prints
// the marks a test asks for once DAYLENS_BENCH=1 says it is the app, so the bench itself is untouched.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { MARKS } from '../../app/tools/bench.ts'
import { tempDir } from '../support/tmp.ts'

const BENCH = path.join(import.meta.dirname, '../../app/tools/bench.ts')
const SEED = path.join(import.meta.dirname, '../../app/tools/seed.ts')
const DAY = 86_400_000
// A Thursday, 9 AM in Phoenix and 9:30 PM in India, where both worlds below have recorded time.
const NOW = '2030-03-14T16:00:00Z'

// One day of a world, seeded with this computer in `zone`.
function world(name: string, zone: string): string {
  const dir = path.join(tempDir('daylens-bench-world-'), 'data')
  execFileSync(process.execPath, [SEED, '--data-dir', dir, '--world', name, '--days', '1', '--now', NOW], { env: { ...process.env, TZ: zone }, stdio: 'ignore' })
  return dir
}
const heavy = world('heavy', 'UTC')

// Each run notes what it ran with and leaves a file in its data folder. It prints the line a build with the test clock
// prints, at the time and on the folder it was given, unless `clock` is false; `ran` overrides what that line says.
const STAND_IN = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
if (process.env.DAYLENS_BENCH === '1') {
  const plan = JSON.parse(readFileSync(process.env.STAND_IN_PLAN, 'utf8'))
  const n = readFileSync(process.env.STAND_IN_COUNT, 'utf8').length
  appendFileSync(process.env.STAND_IN_COUNT, '.')
  const run = plan.runs[n] ?? plan.runs.at(-1)
  const data = process.env.DAYLENS_V2_DATA_DIR
  appendFileSync(process.env.STAND_IN_SEEN, JSON.stringify({ home: process.env.HOME, data, now: process.env.DAYLENS_TEST_NOW, offset: new Date().getTimezoneOffset(), stray: existsSync(data + '/stray') }) + '\\n')
  writeFileSync(data + '/stray', '')
  const ran = { now_ms: Date.parse(process.env.DAYLENS_TEST_NOW) + performance.now(), data_dir: data, ...run.ran }
  if (run.clock !== false) process.stdout.write('DAYLENS_BENCH_RUN ' + JSON.stringify(ran) + '\\n')
  if (run.marks) process.stdout.write('DAYLENS_BENCH ' + JSON.stringify({ today_painted_epoch_ms: Date.now(), ...run.marks }) + '\\n')
  process.exit(run.code ?? 0)
}
`

type Run = { marks?: Record<string, unknown>; code?: number; clock?: false; ran?: Record<string, unknown> }
type Seen = { home: string; data: string; now?: string; offset: number; stray: boolean }

function bench(runs: Run[], { data = heavy, now = NOW, count = runs.length }: { data?: string; now?: string; count?: number } = {}) {
  const dir = tempDir('daylens-bench-test-')
  const file = (name: string, text: string) => (writeFileSync(path.join(dir, name), text), path.join(dir, name))
  const env = {
    ...process.env,
    TZ: 'America/Phoenix',
    NODE_OPTIONS: `--import=${pathToFileURL(file('standIn.mjs', STAND_IN)).href}`,
    STAND_IN_PLAN: file('plan.json', JSON.stringify({ runs })),
    STAND_IN_COUNT: file('count', ''),
    STAND_IN_SEEN: file('seen', ''),
  }
  const json = path.join(dir, 'out.json')
  const r = spawnSync(process.execPath, [BENCH, '--data-dir', data, '--now', now, '--app', process.execPath, '--runs', String(count), '--json', json], { env, encoding: 'utf8' })
  const seen = readFileSync(env.STAND_IN_SEEN, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Seen)
  return { ...r, json, seen }
}

const every = (v: number) => Object.fromEntries(MARKS.filter((m) => m !== 'launch_to_today_ms').map((m) => [m, v]))

test('the bench reports p50, p95 and p99 of every mark over its runs, and writes each run to --json', () => {
  const r = bench(Array.from({ length: 20 }, (_, i) => ({ marks: every(20 - i) })))
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(readFileSync(r.json, 'utf8')) as { runs: number; marks: Record<string, { p50: number; p95: number; p99: number }>; each: unknown[] }
  assert.equal(out.runs, 20)
  assert.equal(out.each.length, 20)
  assert.deepEqual(Object.keys(out.marks).sort(), [...MARKS].sort())
  assert.deepEqual(out.marks.week_view_ms, { p50: 10, p95: 19, p99: 20, max: 20 })
  assert.ok(out.marks.launch_to_today_ms!.p50 >= 0)
  assert.deepEqual(JSON.parse(r.stdout).marks, out.marks)
  // The app runs in a throwaway home, never this computer's own, at the world's time.
  assert.notEqual(r.seen[0]!.home, process.env.HOME)
  assert.ok(r.seen.every((s) => s.now === NOW))
})

test('every run starts on an untouched copy of the world, which the bench never writes to', () => {
  const r = bench([{ marks: every(5) }, { marks: every(5) }, { marks: every(5) }])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.seen.length, 3)
  assert.ok(r.seen.every((s) => s.data !== heavy && !s.stray), JSON.stringify(r.seen))
  assert.equal(existsSync(path.join(heavy, 'stray')), false)
})

test('the app runs in the time zone its world was seeded in', () => {
  // Seeded in India, benched from a computer in Phoenix.
  const r = bench([{ marks: every(5) }], { data: world('pricing', 'Asia/Kolkata') })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.seen[0]!.offset, -330)
  assert.equal(bench([{ marks: every(5) }]).seen[0]!.offset, 420, 'the heavy world is in Phoenix')
})

test('the bench refuses a world with nothing recorded on the day the app opens on', () => {
  const r = bench([{ marks: every(5) }], { now: new Date(Date.parse(NOW) + DAY).toISOString() })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /the world has nothing recorded on Fri Mar 15 2030/)
  assert.equal(r.seen.length, 0, 'no run starts')
})

test('the bench fails when the app does not run at --now or on the world', () => {
  const own = bench([{ marks: every(5), clock: false }])
  assert.equal(own.status, 1)
  assert.match(own.stderr, /run 1: the app ran at its own time, not --now/)
  const late = bench([{ marks: every(5), ran: { now_ms: Date.parse(NOW) + DAY } }])
  assert.equal(late.status, 1)
  assert.match(late.stderr, /run 1: the app ran at \d+, not --now/)
  const r = bench([{ marks: every(5), ran: { data_dir: '/elsewhere' } }])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /run 1: the app ran on "\/elsewhere", not the world/)
})

test('the bench fails when a run misses a mark', () => {
  const { open_hour_ms: _, ...missing } = every(5)
  const r = bench([{ marks: every(5) }, { marks: missing }])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /run 2: open_hour_ms is missing/)
})

test('the bench fails on a mark it does not know, so every run reports the same marks', () => {
  const r = bench([{ marks: { ...every(5), scroll_ms: 3 } }, { marks: every(5) }])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /run 1: scroll_ms is not a mark the bench knows/)
})

test('the bench fails when a mark is not a finite, non-negative number', () => {
  for (const bad of [-1, null, 'fast']) {
    const r = bench([{ marks: { ...every(5), switch_day_ms: bad } }])
    assert.equal(r.status, 1, String(bad))
    assert.match(r.stderr, /run 1: switch_day_ms is /)
  }
})

test('the bench fails when the app exits with an error, with or without its marks', () => {
  for (const run of [{ marks: every(5), code: 3 }, { code: 1 }]) {
    const r = bench([run])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /run 1: the app exited with code [31]/)
  }
})
