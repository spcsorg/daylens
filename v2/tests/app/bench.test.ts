// The bench's report and its refusals, with Node standing in for the app: run through NODE_OPTIONS, the stand-in prints
// the marks a test asks for once DAYLENS_BENCH=1 says it is the app, so the bench itself is untouched.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { MARKS } from '../../app/tools/bench.ts'
import { tempDir } from '../support/tmp.ts'

const BENCH = path.join(import.meta.dirname, '../../app/tools/bench.ts')

const STAND_IN = `
import { appendFileSync, readFileSync } from 'node:fs'
if (process.env.DAYLENS_BENCH === '1') {
  const plan = JSON.parse(readFileSync(process.env.STAND_IN_PLAN, 'utf8'))
  const n = readFileSync(process.env.STAND_IN_COUNT, 'utf8').length
  appendFileSync(process.env.STAND_IN_COUNT, '.')
  const run = plan.runs[n] ?? plan.runs.at(-1)
  if (run.home) appendFileSync(process.env.STAND_IN_HOMES, process.env.HOME + '\\n')
  if (run.marks) process.stdout.write('DAYLENS_BENCH ' + JSON.stringify({ today_painted_epoch_ms: Date.now(), ...run.marks }) + '\\n')
  process.exit(run.code ?? 0)
}
`

type Run = { marks?: Record<string, unknown>; code?: number; home?: boolean }

function bench(runs: Run[], count = runs.length) {
  const dir = tempDir('daylens-bench-test-')
  const file = (name: string, text: string) => (writeFileSync(path.join(dir, name), text), path.join(dir, name))
  const env = {
    ...process.env,
    NODE_OPTIONS: `--import=${pathToFileURL(file('standIn.mjs', STAND_IN)).href}`,
    STAND_IN_PLAN: file('plan.json', JSON.stringify({ runs })),
    STAND_IN_COUNT: file('count', ''),
    STAND_IN_HOMES: file('homes', ''),
  }
  const json = path.join(dir, 'out.json')
  const r = spawnSync(process.execPath, [BENCH, '--data-dir', path.join(dir, 'data'), '--app', process.execPath, '--runs', String(count), '--json', json], { env, encoding: 'utf8' })
  return { ...r, json, homes: readFileSync(env.STAND_IN_HOMES, 'utf8').split('\n').filter(Boolean) }
}

const every = (v: number) => Object.fromEntries(MARKS.filter((m) => m !== 'launch_to_today_ms').map((m) => [m, v]))

test('the bench reports p50, p95 and p99 of every mark over its runs, and writes each run to --json', () => {
  const r = bench(Array.from({ length: 20 }, (_, i) => ({ marks: every(20 - i), home: i === 0 })))
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(readFileSync(r.json, 'utf8')) as { runs: number; marks: Record<string, { p50: number; p95: number; p99: number }>; each: unknown[] }
  assert.equal(out.runs, 20)
  assert.equal(out.each.length, 20)
  assert.deepEqual(Object.keys(out.marks).sort(), [...MARKS].sort())
  assert.deepEqual(out.marks.week_view_ms, { p50: 10, p95: 19, p99: 20, max: 20 })
  assert.ok(out.marks.launch_to_today_ms!.p50 >= 0)
  assert.deepEqual(JSON.parse(r.stdout).marks, out.marks)
  // The app runs in a throwaway home, never this computer's own.
  assert.equal(r.homes.length, 1)
  assert.notEqual(r.homes[0], process.env.HOME)
})

test('the bench fails when a run misses a mark', () => {
  const { open_hour_ms: _, ...missing } = every(5)
  const r = bench([{ marks: every(5) }, { marks: missing }])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /run 2: open_hour_ms is missing/)
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
