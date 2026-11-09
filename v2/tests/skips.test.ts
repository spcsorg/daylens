import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSkips, linked } from '../tools/skips.ts'
import { tempDir } from './support/tmp.ts'

const SCRIPT = fileURLToPath(new URL('../tools/skips.ts', import.meta.url))

// Runs a test file under node's TAP reporter, outside this run's own test context, and returns the report.
function tapOf(source: string): string {
  const dir = tempDir('daylens-v2-skips-')
  writeFileSync(path.join(dir, 'a.test.ts'), source)
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'a.test.ts'], { cwd: dir, env, encoding: 'utf8' })
  return r.stdout
}

function check(tap: string): { status: number | null; out: string } {
  const file = path.join(tempDir('daylens-v2-skips-'), 'tests.tap')
  writeFileSync(file, tap)
  const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' })
  return { status: r.status, out: r.stdout + r.stderr }
}

const MIXED = `import { test, describe } from 'node:test'
test('a boolean # skip', { skip: true }, () => {})
test('a linked skip', { skip: 'no SIGSTOP on Windows [A-19]' }, () => {})
test('not skipped', { skip: false }, () => {})
test('a runtime skip', (t) => { t.skip('the screen # was locked [A-19]') })
test('a todo', { todo: 'later' }, () => {})
describe('a suite', () => { test('a nested skip', { skip: 'needs a named pipe [S-G7]' }, () => {}) })
test('a parent', async (t) => { await t.test('a child skip', { skip: 'no lsof' }, () => {}) })
`

test('every skip and todo in a run is listed with its reason, wherever it sits', () => {
  const { tests, skips } = readSkips(tapOf(MIXED))
  assert.ok(tests >= 7)
  assert.deepEqual(skips, [
    { name: 'a boolean # skip', directive: 'SKIP', reason: '' },
    { name: 'a linked skip', directive: 'SKIP', reason: 'no SIGSTOP on Windows [A-19]' },
    { name: 'a runtime skip', directive: 'SKIP', reason: 'the screen # was locked [A-19]' },
    { name: 'a todo', directive: 'TODO', reason: 'later' },
    { name: 'a nested skip', directive: 'SKIP', reason: 'needs a named pipe [S-G7]' },
    { name: 'a child skip', directive: 'SKIP', reason: 'no lsof' },
  ])
})

test('a report with Windows line endings reads the same', () => {
  const tap = tapOf(MIXED)
  assert.deepEqual(readSkips(tap.replaceAll('\n', '\r\n')), readSkips(tap))
})

test('a reason is linked only by a SHIP ID in brackets', () => {
  for (const r of ['no SIGSTOP on Windows [A-19]', '[E-2] needs a named pipe', 'billing [S-G7]', 'two [A-1] and [A-2]']) assert.ok(linked(r), r)
  for (const r of ['', 'no lsof', 'see A-13', '(A-13)', '[a-13]', '[A13]', '[A-]', '[AB-1]']) assert.ok(!linked(r), r)
})

test('the script fails on a run with an unlinked skip and names it', () => {
  const r = check(tapOf(`import { test } from 'node:test'\ntest('fine', { skip: 'linked [O-5]' }, () => {})\ntest('stray', { skip: 'no reason given' }, () => {})\n`))
  assert.equal(r.status, 1)
  assert.match(r.out, /stray/)
  assert.match(r.out, /no reason given/)
})

test('the script fails on a boolean skip, which has no reason', () => {
  const r = check(tapOf(`import { test } from 'node:test'\ntest('bare', { skip: true }, () => {})\n`))
  assert.equal(r.status, 1)
  assert.match(r.out, /bare/)
})

test('the script passes a run whose every skip is linked, and lists them', () => {
  const r = check(tapOf(`import { test } from 'node:test'\ntest('ran', () => {})\ntest('linked', { skip: 'no SIGSTOP on Windows [A-19]' }, () => {})\n`))
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /linked.*\[A-19\]/)
})

test('the script fails on a report with no tests in it, so a broken reporter is not a pass', () => {
  assert.equal(check('TAP version 13\n1..0\n').status, 1)
  assert.notEqual(spawnSync(process.execPath, [SCRIPT, path.join(tempDir('daylens-v2-skips-'), 'missing.tap')]).status, 0)
})
