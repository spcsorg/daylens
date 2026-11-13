// The test clock: a process handed an offset reads every "now" moved by it, and nothing else about dates changes.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { OFFSET_ENV } from '../../app/shared/clock.ts'

const CHILD_CLOCK = path.join(import.meta.dirname, '..', '..', 'app', 'shared', 'childClock.ts')
const YEAR_MS = 365 * 86_400_000

// Each case runs in its own process, as each app process does: the shift is for the life of the process.
function probe(offset: string | undefined): Record<string, unknown> {
  const script = `
    await import(${JSON.stringify(pathToFileURL(CHILD_CLOCK).href)})
    const real = performance.timeOrigin + performance.now()
    process.stdout.write(JSON.stringify({
      real,
      now: Date.now(),
      date: new Date().getTime(),
      called: Date(),
      epoch: new Date(0).getTime(),
      local: new Date(2020, 0, 2, 3, 4).getTime(),
      localExpected: ${new Date(2020, 0, 2, 3, 4).getTime()},
      utc: Date.UTC(2020, 0, 1),
      parsed: Date.parse('2020-01-01T00:00:00Z'),
      instance: new Date() instanceof Date && new Date(5) instanceof Date,
      tag: Object.prototype.toString.call(new Date()),
      iso: new Date().toISOString(),
    }))`
  const env = { ...process.env }
  delete env[OFFSET_ENV]
  if (offset !== undefined) env[OFFSET_ENV] = offset
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' })) as Record<string, unknown>
}

test('an offset moves Date.now and new Date() by it, and time keeps passing from there', () => {
  const offset = 30 * YEAR_MS
  const r = probe(String(offset))
  const real = r.real as number
  for (const k of ['now', 'date'] as const) {
    const shifted = (r[k] as number) - offset
    assert.ok(shifted >= real - 1000 && shifted <= real + 5000, `${k} is the real time plus the offset`)
  }
  assert.equal(new Date(r.iso as string).getUTCFullYear(), new Date(real + offset).getUTCFullYear())
  assert.match(r.called as string, new RegExp(String(new Date(real + offset).getFullYear())))
})

test('dates built from a time, from parts or from text are not moved', () => {
  const r = probe(String(-20 * YEAR_MS))
  assert.equal(r.epoch, 0)
  assert.equal(r.local, r.localExpected)
  assert.equal(r.utc, 1577836800000)
  assert.equal(r.parsed, 1577836800000)
  assert.equal(r.instance, true)
  assert.equal(r.tag, '[object Date]')
})

test('with no offset, or one that is not a number, the clock is the real one', () => {
  for (const offset of [undefined, '', 'soon']) {
    const r = probe(offset)
    assert.ok(Math.abs((r.now as number) - (r.real as number)) < 5000, `offset ${JSON.stringify(offset)}`)
  }
})
