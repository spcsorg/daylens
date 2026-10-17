import { test } from 'node:test'
import assert from 'node:assert/strict'
import { measureDowntime } from '../capture/supervisor.ts'

const H = 3_600_000
const T = 1_792_130_000_000
const span = (d: { startWallMs: number }, helloWall: number) => helloWall - d.startWallMs

test('same OS-named boot: the downtime is measured exactly by monotonic time', () => {
  const d = measureDowntime({ endWallMs: T, clean: false, monoUs: 1 * H * 1000, boot: 'b' }, { wallMs: T - H, monoUs: 1 * H * 1000 + 2_000_000, boot: 'b', bootIdentity: 'kernel' })
  assert.equal(span(d, T - H), 2000)
  assert.equal(d.detail.measured, 'monotonic')
})

test('clock-derived boot: a larger uptime does not prove the boot continued', () => {
  // Old uptime 1 h, new 2 h, an hour of wall time between: an hour at least, but whether it was a reboot is unknown.
  const d = measureDowntime({ endWallMs: T, clean: false, monoUs: 1 * H * 1000, boot: 'bootclock-1' }, { wallMs: T + H, monoUs: 2 * H * 1000, boot: 'bootclock-2', bootIdentity: 'clock' })
  assert.equal(span(d, T + H), H)
  assert.equal(d.detail.uncertain, true)
  assert.equal(d.detail.measured, 'uncertain_boot')
})

test('clock-derived boot: equal readings are never recorded as zero', () => {
  const d = measureDowntime({ endWallMs: T, clean: false, monoUs: 5_000_000, boot: 'bootclock-1' }, { wallMs: T, monoUs: 5_000_000, boot: 'bootclock-9', bootIdentity: 'clock' })
  assert.ok(span(d, T) >= 1)
  assert.equal(d.detail.uncertain, true)
})

test('clock-derived boot: when uptime fell, the new boot uptime is a provable bound even if the wall clock went back', () => {
  const d = measureDowntime({ endWallMs: T, clean: false, monoUs: 10 * H * 1000, boot: 'bootclock-1' }, { wallMs: T - H, monoUs: 90_000_000, boot: 'bootclock-2', bootIdentity: 'clock' })
  assert.equal(span(d, T - H), 90_000)
  assert.equal(d.detail.uncertain, true)
})

test('OS-named new boot with the clock set back: at least the new boot uptime', () => {
  const d = measureDowntime({ endWallMs: T, clean: false, monoUs: 10 * H * 1000, boot: 'boot-812' }, { wallMs: T - H, monoUs: 90_000_000, boot: 'boot-813', bootIdentity: 'kernel' })
  assert.equal(span(d, T - H), 90_000)
  assert.equal(d.detail.measured, 'lower_bound_new_boot')
})

test('OS-named new boot after a long off period: the wall interval stands', () => {
  const d = measureDowntime({ endWallMs: T, clean: false, monoUs: 10 * H * 1000, boot: 'boot-812' }, { wallMs: T + 8 * H, monoUs: 60_000_000, boot: 'boot-813', bootIdentity: 'kernel' })
  assert.equal(d.startWallMs, T)
  assert.equal(d.detail.measured, 'wall')
})
