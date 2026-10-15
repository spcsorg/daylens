import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MAX_LINE_BYTES, parseLine, type Kind } from '../capture/protocol.ts'

const fixtures = new URL('../protocol/fixtures/', import.meta.url)
const valid: { name: string; line: unknown }[] = JSON.parse(readFileSync(new URL('valid.json', fixtures), 'utf8'))
const invalid: { name: string; reason: string; raw: string }[] = JSON.parse(readFileSync(new URL('invalid.json', fixtures), 'utf8'))

test('every valid fixture parses and round-trips unchanged', () => {
  for (const { name, line } of valid) {
    const r = parseLine(JSON.stringify(line))
    assert.ok(r.ok, `${name}: ${r.ok ? '' : r.reason + ' ' + r.detail}`)
    assert.deepEqual(r.line, line, name)
  }
})

test('fixtures cover every kind on both stable platforms', () => {
  const kinds = new Set<Kind>(['hello', 'heartbeat', 'focus', 'input', 'session', 'power', 'clock', 'bye'])
  const seen = new Set(valid.map((v) => (v.line as { kind: Kind }).kind))
  assert.deepEqual([...kinds].filter((k) => !seen.has(k)), [])
  const platforms = new Set(valid.map((v) => (v.line as { platform: string }).platform))
  assert.ok(platforms.has('macos') && platforms.has('windows'))
})

test('every invalid fixture is rejected with the expected reason', () => {
  for (const { name, reason, raw } of invalid) {
    const r = parseLine(raw)
    assert.equal(r.ok, false, name)
    if (!r.ok) assert.equal(r.reason, reason, `${name}: ${r.detail}`)
  }
})

test('oversized lines are rejected before parsing', () => {
  const r = parseLine('x'.repeat(MAX_LINE_BYTES + 1))
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.reason, 'too_long')
})

test('rejection detail never echoes a title', () => {
  for (const breakIt of [
    (o: Record<string, unknown>) => { o.app = 'not an object' },
    (o: Record<string, unknown>) => { o.trigger = 'CANARY-SECRET-TITLE' },
    (o: Record<string, unknown>) => { (o.window as Record<string, unknown>).title_state = 'CANARY-SECRET-TITLE' },
  ]) {
    const line = structuredClone(valid.find((v) => v.name === 'mac_focus_title')!.line) as { obs: Record<string, unknown> }
    const win = line.obs.window as Record<string, unknown>
    win.title = 'CANARY-SECRET-TITLE'
    breakIt(line.obs)
    const r = parseLine(JSON.stringify(line))
    assert.equal(r.ok, false)
    if (!r.ok) assert.ok(!r.detail.includes('CANARY'), r.detail)
  }
})

test('unknown extra fields are dropped, not stored', () => {
  const line = structuredClone(valid.find((v) => v.name === 'mac_focus_app')!.line) as { obs: Record<string, unknown> }
  line.obs.keystrokes = 'abc'
  const r = parseLine(JSON.stringify(line))
  assert.ok(r.ok)
  if (r.ok) assert.equal('keystrokes' in r.line.obs, false)
})

test('mono_us stays exact beyond 2^53 nanoseconds of uptime', () => {
  const line = structuredClone(valid[0]!.line) as { t: { mono_us: number } }
  line.t.mono_us = 200 * 86_400 * 1_000_000
  const r = parseLine(JSON.stringify(line))
  assert.ok(r.ok)
  if (r.ok) assert.equal(r.line.t.mono_us, 17_280_000_000_000)
})
