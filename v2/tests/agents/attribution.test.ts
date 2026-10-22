import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentSegments, presenceFromCapture, presenceTimeline, summarize, unionMs, type PresenceInputs } from '../../capture/agents/attribution.ts'
import type { EventRow, TurnRow } from '../../capture/agents/store.ts'
import { Normalizer } from '../../capture/normalize.ts'
import { Store } from '../../capture/store.ts'
import { line } from '../support/lines.ts'
import { sec, tmp } from './fixtures.ts'
import { rig, T0 } from '../storage/support.ts'

const MIN = 60_000

function turn(key: string, start: number, last: number, end: number | null = null, extra: Partial<TurnRow> = {}): TurnRow {
  return {
    agent: 'codex',
    turn_key: key,
    session_id: `s-${key}`,
    project_dir: '/home/me/code/project-beta',
    branch: null,
    opened_by: 'user',
    replayed: 0,
    start_wall_ms: start,
    last_activity_wall_ms: last,
    end_wall_ms: end,
    end_state: end === null ? null : 'completed',
    origin: 'interactive',
    ...extra,
  }
}

const covered = (from: number, to: number): PresenceInputs => ({ covered: [{ start: from, end: to }], locked: [], asleep: [], idle: [], unknown: [] })

test('agent work while the screen was locked is the agent alone, never the person', () => {
  const day = covered(sec(0), sec(7200))
  day.locked.push({ start: sec(1800), end: sec(4200) })
  const presence = presenceTimeline(sec(0), sec(7200), day)
  const segs = agentSegments([turn('t', sec(600), sec(3600))], [], presence)
  const s = summarize(segs, [], sec(0), sec(7200))
  assert.equal(s.working.present, 20 * MIN)
  assert.equal(s.working.away, 30 * MIN)
  assert.equal(segs.find((x) => x.presence === 'away')!.why, 'locked')
})

test('asleep, idle, capture gaps and time capture was not running are each told apart', () => {
  const inputs = covered(sec(0), sec(3000))
  inputs.asleep.push({ start: sec(100), end: sec(200) })
  inputs.locked.push({ start: sec(150), end: sec(300) })
  inputs.idle.push({ start: sec(400), end: sec(500) })
  inputs.unknown.push({ start: sec(600), end: sec(700) })
  const p = presenceTimeline(sec(0), sec(4000), inputs)
  const at = (s: number) => p.find((x) => x.start <= sec(s) && sec(s) < x.end)!
  assert.equal(at(50).state, 'present')
  assert.equal(at(160).state, 'asleep', 'asleep wins over locked')
  assert.deepEqual([at(250).state, at(250).why], ['away', 'locked'])
  assert.deepEqual([at(450).state, at(450).why], ['away', 'idle'])
  assert.equal(at(650).state, 'unknown')
  assert.equal(at(3500).state, 'unknown', 'outside capture coverage nothing is claimed')
})

test('the agent works from the turn start to its last activity; a later end is waiting, never work', () => {
  const p = presenceTimeline(sec(0), sec(7200), covered(sec(0), sec(7200)))
  const t = turn('t', sec(0), sec(600), sec(2400), { end_state: 'failed' })
  const s = summarize(agentSegments([t], [], p), [], sec(0), sec(7200))
  assert.equal(s.working.present, 10 * MIN)
  assert.equal(s.waiting, 30 * MIN)
})

test('waits inside a turn are cut out of working time', () => {
  const p = presenceTimeline(sec(0), sec(7200), covered(sec(0), sec(7200)))
  const wait: EventRow = { agent: 'codex', event_key: 'w', session_id: 's-t', turn_key: 't', kind: 'wait', detail: 'usage_limit', basis: null, wall_ms: sec(600), end_wall_ms: sec(4200) }
  const s = summarize(agentSegments([turn('t', sec(0), sec(4800))], [wait], p), [wait], sec(0), sec(7200))
  assert.equal(s.working.present, 20 * MIN)
  assert.equal(s.waiting, 60 * MIN)
})

test('sessions running at the same time are counted once in total, and each in its own row', () => {
  const p = presenceTimeline(sec(0), sec(3600), covered(sec(0), sec(3600)))
  const segs = agentSegments([turn('a', sec(0), sec(1200)), turn('b', sec(600), sec(1800)), turn('c', sec(600), sec(900), null, { session_id: 's-a' })], [], p)
  const s = summarize(segs, [], sec(0), sec(3600))
  assert.equal(s.working.present, 30 * MIN)
  assert.deepEqual(s.sessions.map((x) => [x.session, x.working_ms]).sort(), [
    ['s-a', 20 * MIN],
    ['s-b', 20 * MIN],
  ])
  assert.equal(unionMs([{ start: 0, end: 10 }, { start: 5, end: 15 }, { start: 20, end: 25 }]), 20)
})

test('presence comes from the capture tables: locks, sleep, idle, helper runs and gaps', () => {
  const dir = tmp()
  const store = new Store(dir)
  const n = new Normalizer(store)
  store.startRun(line('hello', { awake_us: 0, helper: 'test', boot_identity: 'kernel', version: '1', pid: 1, os: 'test', permissions: { accessibility: 'granted' }, config: { heartbeat_s: 15, idle_threshold_s: 120, reconcile_s: 60 } }, sec(0)) as never)
  store.endRun('run-test', sec(7200), 'test')
  n.handle(line('session', { state: 'unlocked', snapshot: true }, sec(0)))
  n.handle(line('session', { state: 'locked', snapshot: false }, sec(1000)))
  n.handle(line('session', { state: 'unlocked', snapshot: false }, sec(2000)))
  n.handle(line('power', { state: 'sleep' }, sec(3000)))
  n.handle(line('power', { state: 'resume' }, sec(4000)))
  n.handle(line('input', { state: 'idle', last_input_wall_ms: sec(4880), threshold_s: 120, snapshot: false }, sec(5000)))
  n.handle(line('input', { state: 'active', last_input_wall_ms: sec(5500), threshold_s: 120, snapshot: false }, sec(5500)))
  const gap = store.openGap({ reason: 'helper_crashed', scope: 'all', run: 'run-test', start: { wall_ms: sec(6000), mono_us: null, boot: null }, detail: null })
  store.closeGap(gap, { wall_ms: sec(6100), mono_us: null, boot: null })
  store.flush()
  const inputs = presenceFromCapture(store.database, sec(0), sec(7200))
  assert.deepEqual(inputs.locked, [{ start: sec(1000), end: sec(2000) }])
  assert.deepEqual(inputs.asleep, [{ start: sec(3000), end: sec(4000) }])
  assert.deepEqual(inputs.idle, [
    { start: sec(4000), end: sec(5500) },
    { start: sec(4880), end: sec(5500) },
  ], 'away from the wake until the first input, and from the last input, not from when idle was noticed')
  assert.deepEqual(inputs.unknown, [{ start: sec(6000), end: sec(6100) }])
  assert.deepEqual(inputs.covered, [{ start: sec(0), end: sec(7200) }])
  // A window that starts while the screen is already locked still knows it is locked.
  assert.deepEqual(presenceFromCapture(store.database, sec(1500), sec(1800)).locked, [{ start: sec(1000), end: sec(1800) }])
  store.close()
})

test('an imported or copied turn adds neither working nor waiting time', () => {
  const p = presenceTimeline(sec(0), sec(7200), covered(sec(0), sec(7200)))
  const t = turn('imp', sec(0), sec(0), sec(1800), { replayed: 1 })
  const s = summarize(agentSegments([t], [], p), [], sec(0), sec(7200))
  assert.equal(s.working.present, 0)
  assert.equal(s.waiting, 0)
})

test('a machine that wakes by itself is not the person coming back: presence starts at the first input', () => {
  const dir = tmp()
  const store = new Store(dir)
  const n = new Normalizer(store)
  store.startRun(line('hello', { awake_us: 0, helper: 'test', boot_identity: 'kernel', version: '1', pid: 1, os: 'test', permissions: { accessibility: 'granted' }, config: { heartbeat_s: 15, idle_threshold_s: 120, reconcile_s: 60 } }, sec(0)) as never)
  store.endRun('run-test', sec(7200), 'test')
  n.handle(line('session', { state: 'unlocked', snapshot: true }, sec(0)))
  n.handle(line('power', { state: 'sleep' }, sec(1000)))
  n.handle(line('power', { state: 'resume' }, sec(2000)))
  n.handle(line('input', { state: 'active', last_input_wall_ms: sec(2600), threshold_s: 120, snapshot: false }, sec(2600)))
  n.handle(line('power', { state: 'sleep' }, sec(3000)))
  n.handle(line('power', { state: 'resume_user' }, sec(4000)))
  store.flush()
  const inputs = presenceFromCapture(store.database, sec(0), sec(7200))
  assert.deepEqual(inputs.asleep, [{ start: sec(1000), end: sec(2000) }, { start: sec(3000), end: sec(4000) }])
  assert.deepEqual(inputs.idle, [{ start: sec(2000), end: sec(2600) }], 'away from the wake to the first input; a wake the person caused is presence at once')
  assert.deepEqual(presenceFromCapture(store.database, sec(2200), sec(2400)).idle, [{ start: sec(2000), end: sec(2400) }], 'a window that starts after the wake still knows nobody is back')
  store.close()
})

test('presence reads use the index of presence rows, so a read does not scan the whole history', () => {
  const r = rig()
  const db = r.store.database
  const seen: string[] = []
  const prepare = db.prepare.bind(db)
  const spy = Object.create(db, { prepare: { value: (sql: string) => (seen.push(sql), prepare(sql)) } }) as typeof db
  presenceFromCapture(spy, T0, T0 + 3_600_000)
  const reads = seen.filter((sql) => sql.includes('FROM observations'))
  assert.equal(reads.length, 1)
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${reads[0]}`).all({ from: T0, to: T0 + 3_600_000 }) as { detail: string }[]).map((p) => p.detail)
  const scans = plan.filter((d) => /\bobservations\b/.test(d))
  assert.equal(scans.length, 5, plan.join('\n'))
  assert.ok(scans.every((d) => d.includes('USING INDEX observations_presence')), plan.join('\n'))
  r.close()
})

test('presence shows nothing from a range a deletion is still removing', () => {
  const r = rig(undefined, { holdDeletions: true })
  const H = 3_600_000
  r.feed(line('session', { state: 'unlocked', snapshot: true }, T0))
  r.feed(line('session', { state: 'locked', snapshot: false }, T0 + H + 600_000))
  r.feed(line('session', { state: 'unlocked', snapshot: false }, T0 + H + 1_200_000))
  r.feed(line('input', { state: 'idle', last_input_wall_ms: T0 + H + 1_300_000, threshold_s: 120, snapshot: false }, T0 + H + 1_420_000))
  r.feed(line('input', { state: 'active', last_input_wall_ms: T0 + H + 1_500_000, threshold_s: 120, snapshot: false }, T0 + H + 1_500_000))
  r.store.flush()
  r.clock.t = T0 + 3 * H
  r.storage.deleteRange(T0 + H, T0 + 2 * H)
  const inputs = presenceFromCapture(r.store.database, T0, T0 + 3 * H)
  assert.deepEqual([inputs.locked, inputs.idle], [[], []])
  r.close()
})
