import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AWAY_IDLE_S, NOT_AWAY_EXIT, gate, type Signals } from '../browser/tools/away.ts'

const live = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'browser', 'tools', 'live.ts'), 'utf8')

function fake(over: Partial<{ marker: boolean; locked: boolean; asleep: boolean; idle: number }> = {}): Signals {
  const v = { marker: true, locked: false, asleep: false, idle: 0, ...over }
  return { marker: () => v.marker, locked: () => v.locked, displayAsleep: () => v.asleep, idleSeconds: () => v.idle }
}

test('no live run starts without the away marker, however long the Mac has been idle or asleep', () => {
  for (const s of [fake({ marker: false, idle: 10_000 }), fake({ marker: false, asleep: true }), fake({ marker: false, locked: true })])
    assert.equal(gate(s), 'no_marker')
})

test('two minutes without input is not away: reading at the Mac looks the same', () => {
  assert.equal(gate(fake({ idle: 120 })), 'present')
  assert.equal(gate(fake({ idle: AWAY_IDLE_S - 1 })), 'present')
  assert.equal(AWAY_IDLE_S, 600)
})

test('with the marker, ten idle minutes or a sleeping display mean away; a locked screen waits', () => {
  assert.equal(gate(fake({ idle: AWAY_IDLE_S })), 'away')
  assert.equal(gate(fake({ asleep: true, idle: 5 })), 'away')
  assert.equal(gate(fake({ locked: true, idle: 10_000 })), 'locked')
})

test('the runner gates on the marker and exits before launching anything when it is missing', () => {
  assert.doesNotMatch(live, /'idle-s'/, 'the old two-minute setting is gone')
  const announce = live.slice(live.indexOf('async function announce'), live.indexOf('\n}\n', live.indexOf('async function announce')))
  assert.match(announce, /gate\(signals/)
  assert.match(announce, /'no_marker'[\s\S]*process\.exit\(NOT_AWAY_EXIT\)/)
  assert.equal(NOT_AWAY_EXIT, 75)
})
