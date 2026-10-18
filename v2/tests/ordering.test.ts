import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readOrderingPoint } from '../capture/ordering.ts'
import { keptTitleIdentity, Privacy } from '../capture/normalize.ts'
import { app } from './support/lines.ts'

const point = { boot: 'kernel-boot', mono_us: 1, boot_identity: 'kernel' as const }
const read = (source: string, errors: string[]) => readOrderingPoint(process.execPath, ['-e', source, '--'], (code) => errors.push(code))

test('an ordering helper that exceeds the action budget fails closed', () => {
  const errors: string[] = []
  const started = performance.now()
  const result = read(`setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(point))}), 300)`, errors)
  const elapsed = performance.now() - started
  assert.equal(result, null, 'a slow ordering read cannot authorize kept titles')
  assert.deepEqual(errors, ['activation_clock_unavailable'])
  assert.ok(elapsed < 200, `slow helper blocked for ${elapsed.toFixed(1)} ms`)
  const notes = app('com.example.notes', { engine: 'app_runtime', signer: 'TEAMNOTES1' })
  const privacy = new Privacy([], undefined, [{ ...keptTitleIdentity(notes)!, effective_from_wall_ms: 0, activation: { ...point, boot: 'previous-boot' } }], result)
  assert.equal(privacy.classify(notes, point).title, 'unknown')
})

test('a responsive ordering helper still supplies validated monotonic evidence', () => {
  const errors: string[] = []
  assert.deepEqual(read(`process.stdout.write(${JSON.stringify(JSON.stringify(point))})`, errors), point)
  assert.deepEqual(errors, [])
})
