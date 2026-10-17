import { test } from 'node:test'
import assert from 'node:assert/strict'
import { measureDowntime } from '../capture/supervisor.ts'

const H = 3_600_000
const T = 1_792_130_000_000
const span = (d: { startWallMs: number }, helloWall: number) => helloWall - d.startWallMs

test('same OS-named boot: the downtime is measured exactly by monotonic time', () => {
  const d = measureDowntime({ endWallMs: T, clean: false, monoUs: 1 * H * 1000, boot: 'b', bootIdentity: 'kernel' }, { wallMs: T - H, monoUs: 1 * H * 1000 + 2_000_000, boot: 'b', bootIdentity: 'kernel' })
  assert.equal(span(d, T - H), 2000)
  assert.equal(d.detail.measured, 'monotonic')
})

test('clock-derived boot: a larger uptime does not prove the boot continued', () => {
  // Old uptime 1 h, new 2 h, an hour of wall time between: an hour at least, but whether it was a reboot is unknown.
  const d = measureDowntime({ endWallMs: T, clean: false, monoUs: 1 * H * 1000, boot: 'bootclock-1', bootIdentity: 'clock' }, { wallMs: T + H, monoUs: 2 * H * 1000, boot: 'bootclock-2', bootIdentity: 'clock' })
  assert.equal(span(d, T + H), H)
  assert.equal(d.detail.uncertain, true)
  assert.equal(d.detail.measured, 'uncertain_boot')
})

test('clock-derived boot: equal readings are never recorded as zero', () => {
  const d = measureDowntime({ endWallMs: T, clean: false, monoUs: 5_000_000, boot: 'bootclock-1', bootIdentity: 'clock' }, { wallMs: T, monoUs: 5_000_000, boot: 'bootclock-9', bootIdentity: 'clock' })
  assert.ok(span(d, T) >= 1)
  assert.equal(d.detail.uncertain, true)
})

test('clock-derived boot: when uptime fell, the new boot uptime is a provable bound even if the wall clock went back', () => {
  const d = measureDowntime({ endWallMs: T, clean: false, monoUs: 10 * H * 1000, boot: 'bootclock-1', bootIdentity: 'clock' }, { wallMs: T - H, monoUs: 90_000_000, boot: 'bootclock-2', bootIdentity: 'clock' })
  assert.equal(span(d, T - H), 90_000)
  assert.equal(d.detail.uncertain, true)
})

test('OS-named new boot with the clock set back: at least the new boot uptime', () => {
  const d = measureDowntime({ endWallMs: T, clean: false, monoUs: 10 * H * 1000, boot: 'boot-812', bootIdentity: 'kernel' }, { wallMs: T - H, monoUs: 90_000_000, boot: 'boot-813', bootIdentity: 'kernel' })
  assert.equal(span(d, T - H), 90_000)
  assert.equal(d.detail.measured, 'lower_bound_new_boot')
})

test('OS-named new boot after a long off period: the wall interval stands', () => {
  const d = measureDowntime({ endWallMs: T, clean: false, monoUs: 10 * H * 1000, boot: 'boot-812', bootIdentity: 'kernel' }, { wallMs: T + 8 * H, monoUs: 60_000_000, boot: 'boot-813', bootIdentity: 'kernel' })
  assert.equal(d.startWallMs, T)
  assert.equal(d.detail.measured, 'wall')
})

test('a service that died before its first helper reading: the restart interval, not an invented reboot', () => {
  // Restarted 5 s later on a machine that has been up for 30 days.
  const d = measureDowntime({ endWallMs: T, clean: false, monoUs: null, boot: null, bootIdentity: null }, { wallMs: T + 5000, monoUs: 30 * 24 * H * 1000, boot: 'boot-812', bootIdentity: 'kernel' })
  assert.equal(span(d, T + 5000), 5000)
  assert.equal(d.detail.measured, 'wall_restart_interval')
  assert.equal(d.detail.uncertain, true)
})

test('no helper reading and the clock set back: still never zero', () => {
  const d = measureDowntime({ endWallMs: T, clean: false, monoUs: null, boot: null, bootIdentity: null }, { wallMs: T - H, monoUs: 30 * 24 * H * 1000, boot: 'boot-812', bootIdentity: 'kernel' })
  assert.ok(span(d, T - H) >= 1)
  assert.equal(d.detail.uncertain, true)
})

test('matching clock-derived names across a reboot (1 h -> 2 h uptime) stay uncertain, not an exact hour', () => {
  // Wall T with 1 h uptime, then wall T + 1 h with 2 h uptime: wall minus uptime rounds to the same name.
  const d = measureDowntime({ endWallMs: T, clean: false, monoUs: 1 * H * 1000, boot: 'bootclock-29868833', bootIdentity: 'clock' }, { wallMs: T + H, monoUs: 2 * H * 1000, boot: 'bootclock-29868833', bootIdentity: 'clock' })
  assert.equal(d.detail.uncertain, true)
  assert.equal(d.detail.measured, 'uncertain_boot')
  assert.equal(span(d, T + H), H)
})

test('matching clock-derived names with equal readings are never zero', () => {
  const d = measureDowntime({ endWallMs: T, clean: false, monoUs: 7_000_000, boot: 'bootclock-1', bootIdentity: 'clock' }, { wallMs: T, monoUs: 7_000_000, boot: 'bootclock-1', bootIdentity: 'clock' })
  assert.ok(span(d, T) >= 1)
  assert.equal(d.detail.uncertain, true)
})

test('a matching kernel name on only one side is not enough for an exact measure', () => {
  const d = measureDowntime({ endWallMs: T, clean: false, monoUs: 7_000_000, boot: 'boot-1', bootIdentity: null }, { wallMs: T + 1000, monoUs: 8_000_000, boot: 'boot-1', bootIdentity: 'kernel' })
  assert.equal(d.detail.uncertain, true)
})
