import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readOrderingPoint } from '../capture/ordering.ts'
import { keptTitleIdentity, Privacy } from '../capture/normalize.ts'
import { app } from './support/lines.ts'

const point = { boot: 'kernel-boot', mono_us: 1, boot_identity: 'kernel' as const }
const read = (source: string, errors: string[], timeoutMs?: number) => readOrderingPoint(process.execPath, ['-e', source, '--'], (code) => errors.push(code), timeoutMs)
const answerAfter = (ms: number) => `setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(point))}), ${ms})`

test('a slow first run of the ordering helper still supplies the point, without blocking the event loop', async () => {
  for (const ms of [500, 900]) {
    const errors: string[] = []
    let ticks = 0
    const tick = setInterval(() => ticks++, 10)
    const started = performance.now()
    const result = await read(answerAfter(ms), errors)
    clearInterval(tick)
    assert.deepEqual(result, point, `a ${ms} ms first run`)
    assert.deepEqual(errors, [])
    assert.ok(ticks >= (performance.now() - started) / 40, `the event loop ran ${ticks} times while the helper started`)
  }
})

test('an ordering helper that never answers fails closed at the safety bound', async () => {
  const errors: string[] = []
  const result = await read(answerAfter(60_000), errors, 300)
  assert.equal(result, null, 'no answer cannot authorize kept titles')
  assert.deepEqual(errors, ['activation_clock_unavailable'])
  const notes = app('com.example.notes', { engine: 'app_runtime', signer: 'TEAMNOTES1' })
  const privacy = new Privacy([], undefined, [{ ...keptTitleIdentity(notes)!, effective_from_wall_ms: 0, activation: { ...point, boot: 'previous-boot' } }], result)
  assert.equal(privacy.classify(notes, point).title, 'unknown')
})

test('a responsive ordering helper still supplies validated monotonic evidence', async () => {
  const errors: string[] = []
  assert.deepEqual(await read(`process.stdout.write(${JSON.stringify(JSON.stringify(point))})`, errors), point)
  assert.deepEqual(await read(`process.stdout.write('{"boot":"","mono_us":-1}')`, errors), null)
  assert.deepEqual(errors, ['activation_clock_unavailable'])
})
