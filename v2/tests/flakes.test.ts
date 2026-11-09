import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { failedTests, fileIssues, report, summary } from '../tools/flakes.ts'
import { tempDir } from './support/tmp.ts'

const FLAKES = fileURLToPath(new URL('../tools/flakes.ts', import.meta.url))

// Invented tests covering every way node:test reports a failure, a skip and a todo.
const SAMPLE: Record<string, string> = {
  'outer.test.ts': `import { test, describe, before } from 'node:test'
describe('outer', () => {
  test('passes', () => {})
  test('fails # here', () => { throw new Error('x') })
  describe('inner', () => { test('deep fail', () => { throw new Error('x') }) })
})
describe('hooked', () => {
  before(() => { throw new Error('hook') })
  test('never runs', () => {})
})
test('slow', { timeout: 50 }, async (t) => {
  await t.test('slow child', () => new Promise((r) => setTimeout(r, 500)))
})
test('skipped', { skip: 'not here [A-1]' }, () => {})
test('todo', { todo: 'later [A-2]' }, () => { throw new Error('t') })
`,
  'nested/broken.test.ts': `throw new Error('import fails')\n`,
  'clean.test.ts': `import { test } from 'node:test'\ntest('fine', () => {})\n`,
}

// Runs node:test over the invented tests and returns the TAP it writes.
function tapOf(files: Record<string, string>): string {
  const root = tempDir('daylens-flakes-tap-')
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(root, 'tests', name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, body)
  }
  const out = path.join(root, 'run.tap')
  // A nested runner that inherits NODE_TEST_CONTEXT reports to this one instead of writing its own TAP.
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '' }
  delete env.NODE_TEST_CONTEXT
  spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', `--test-reporter-destination=${out}`, 'tests/**/*.test.ts'], { cwd: root, env })
  return readFileSync(out, 'utf8')
}

test('names each failing test once, by file and suite, and leaves out suites, cancelled children, skips and todos', () => {
  const r = failedTests(tapOf(SAMPLE))
  assert.equal(r.finished, true)
  assert.deepEqual(r.names.sort(), [
    'tests/nested/broken.test.ts',
    'tests/outer.test.ts > hooked',
    'tests/outer.test.ts > outer > fails # here',
    'tests/outer.test.ts > outer > inner > deep fail',
    'tests/outer.test.ts > slow',
  ])
})

test('a clean run has no failures', () => {
  assert.deepEqual(failedTests(tapOf({ 'clean.test.ts': SAMPLE['clean.test.ts']! })), { names: [], finished: true })
})

test('a run cut off before its final plan did not finish', () => {
  const tap = tapOf({ 'clean.test.ts': SAMPLE['clean.test.ts']! })
  assert.equal(failedTests(tap.slice(0, tap.lastIndexOf('1..'))).finished, false)
})

test('a Windows location gives the same name', () => {
  const tap = `TAP version 13
# Subtest: suite
    # Subtest: case
    not ok 1 - case
      ---
      duration_ms: 1
      type: 'test'
      location: 'D:\\a\\daylens\\daylens\\v2\\tests\\storage\\x.test.ts:4:3'
      failureType: 'testCodeFailure'
      error: |-
        location: 'not/this.ts:1:1'
      ...
    1..1
not ok 1 - suite
  ---
  location: 'D:\\a\\daylens\\daylens\\v2\\tests\\storage\\x.test.ts:2:1'
  failureType: 'subtestsFailed'
  ...
1..1
`
  assert.deepEqual(failedTests(tap), { names: ['tests/storage/x.test.ts > suite > case'], finished: true })
})

test('a failure with no location takes no file from its error text or the next failure', () => {
  const tap = `TAP version 13
# Subtest: lost
not ok 1 - lost
  ---
  failureType: 'testCodeFailure'
  error: |-
    location: '/w/v2/tests/decoy.test.ts:1:1'
  ...
# Subtest: found
not ok 2 - found
  ---
  location: '/w/v2/tests/b.test.ts:1:1'
  failureType: 'testCodeFailure'
  ...
1..2
`
  assert.deepEqual(failedTests(tap), { names: ['lost', 'tests/b.test.ts > found'], finished: true })
})

function results(runs: Record<string, string>): string {
  const dir = tempDir('daylens-flakes-results-')
  for (const [name, tap] of Object.entries(runs)) writeFileSync(path.join(dir, name), tap)
  return dir
}

const failing = (name: string) => `TAP version 13
# Subtest: ${name}
not ok 1 - ${name}
  ---
  location: '/w/v2/tests/a.test.ts:1:1'
  failureType: 'testCodeFailure'
  ...
1..1
`
const passing = 'TAP version 13\n# Subtest: ok\nok 1 - ok\n1..1\n'

test('counts the runs each test failed in, by runner, and the runs that left no result', () => {
  const dir = results({
    'macos-15-1.tap': failing('flaky'),
    'macos-15-2.tap': passing,
    'windows-2025-1.tap': failing('flaky'),
    'windows-2025-2.tap': failing('flaky') + failing('flaky').replaceAll('flaky', 'rare'),
    'ubuntu-24.04-1.tap': 'TAP version 13\n# Subtest: cut\n',
  })
  const r = report(dir, 6)
  assert.deepEqual(r, {
    runs: 6,
    failed: 5,
    tests: [
      { name: 'tests/a.test.ts > flaky', count: 3, runners: { 'macos-15': 1, 'windows-2025': 2 } },
      { name: 'tests/a.test.ts > rare', count: 1, runners: { 'windows-2025': 1 } },
    ],
    unfinished: ['ubuntu-24.04 run 1', '1 run left no results'],
  })
  assert.equal(summary(r), [
    '## Nightly tests',
    '',
    '6 runs, 5 failed.',
    '',
    '| Test | Failed runs | Runners |',
    '| --- | ---: | --- |',
    '| tests/a.test.ts > flaky | 3 | macos-15 (1), windows-2025 (2) |',
    '| tests/a.test.ts > rare | 1 | windows-2025 (1) |',
    '',
    'Did not finish: ubuntu-24.04 run 1, 1 run left no results.',
    '',
  ].join('\n'))
})

test('a run with every test passing gives a one-line summary', () => {
  const r = report(results({ 'macos-15-1.tap': passing, 'macos-15-2.tap': passing }), 2)
  assert.equal(summary(r), '## Nightly tests\n\n2 runs, all passed.\n')
})

test('pipes and tags in a test name cannot break the table', () => {
  const r = report(results({ 'macos-15-1.tap': failing('a | b <i>') }), 1)
  assert.match(summary(r), /\| tests\/a\.test\.ts > a \\\| b &lt;i> \| 1 \|/)
})

test('a missing results folder counts every run as left without results', () => {
  assert.deepEqual(report(path.join(tempDir('daylens-flakes-none-'), 'absent'), 3).unfinished, ['3 runs left no results'])
})

test('the command writes the summary and exits 1 when a run failed, 0 when none did', () => {
  const bad = spawnSync(process.execPath, [FLAKES, results({ 'macos-15-1.tap': failing('flaky'), 'macos-15-2.tap': passing }), '--runs', '2'], { encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /\| tests\/a\.test\.ts > flaky \| 1 \| macos-15 \(1\) \|/)
  const good = spawnSync(process.execPath, [FLAKES, results({ 'macos-15-1.tap': passing }), '--runs', '1'], { encoding: 'utf8' })
  assert.equal(good.status, 0)
  assert.equal(good.stdout, '## Nightly tests\n\n1 run, all passed.\n')
})

test('files one flake issue per failing test, commenting on the open one with the same title', async () => {
  const calls: { method: string; url: string; body?: unknown }[] = []
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (String(url).endsWith('/labels/flake')) return new Response('', { status: 404 })
    if (String(url).includes('/issues?')) {
      const page = new URL(String(url)).searchParams.get('page')
      const fill = Array.from({ length: 100 }, (_, i) => ({ number: 500 + i, title: `other ${i}` }))
      return Response.json(page === '1' ? fill : [{ number: 7, title: 'tests/a.test.ts > flaky' }, { number: 8, title: 'tests/a.test.ts > rare', pull_request: {} }])
    }
    return Response.json({}, { status: 201 })
  }
  const r = report(results({ 'macos-15-1.tap': failing('flaky') + failing('rare'), 'macos-15-2.tap': passing }), 2)
  await fileIssues(r, { repo: 'owner/repo', token: 't', runUrl: 'https://example.test/run/1' }, fake)
  const body = 'Failed in 1 of 2 nightly runs: macos-15 (1). https://example.test/run/1'
  assert.deepEqual(calls.filter((c) => c.method === 'POST'), [
    { method: 'POST', url: 'https://api.github.com/repos/owner/repo/labels', body: { name: 'flake', color: 'd93f0b' } },
    { method: 'POST', url: 'https://api.github.com/repos/owner/repo/issues/7/comments', body: { body } },
    { method: 'POST', url: 'https://api.github.com/repos/owner/repo/issues', body: { title: 'tests/a.test.ts > rare', body, labels: ['flake'] } },
  ])
})

test('a GitHub error stops filing and says which request failed', async () => {
  const fake = async () => new Response('', { status: 403 })
  const r = report(results({ 'macos-15-1.tap': failing('flaky') }), 1)
  await assert.rejects(fileIssues(r, { repo: 'owner/repo', token: 't', runUrl: 'u' }, fake), /GET \/repos\/owner\/repo\/labels\/flake: 403/)
})
