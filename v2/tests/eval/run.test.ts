import { test } from 'node:test'
import assert from 'node:assert/strict'
import { factsHour, type CallResult } from '../../engine/backends.ts'
import { buildPacket, type Packet } from '../../engine/packet.ts'
import type { Validation } from '../../engine/validate.ts'
import { gradeIsCurrent, isCurrent, previousHour, shownHour, staleResults, writeId, writerPacket, type RunInfo, type WriteRecord } from '../../tools/eval/run.ts'
import { app, focus, line, resetSeq } from '../support/lines.ts'
import { HOUR, MIN, rig, T0 } from '../storage/support.ts'

const call = (error: string | null = null) => ({ text: error ? null : '{}', error }) as CallResult
const written = (title: string, ok = true): Validation => ({ ok, errors: ok ? [] : [{ code: 'invented_id', detail: 'x9' }], warnings: [], cited: [], hour: { title, summary: `${title} summary`, apps: [], detail: '', outcome: null, sources: [], suggestion: null } })
const rec = (over: Partial<WriteRecord> = {}): WriteRecord => ({ packet_sha256: 'p', prompt_sha256: 'q', previous_hour: null, final: call(), validation: written('Hour'), ...over })

test("each hour gets the candidate's own previous hour, only one that passed validation, and says why when there is none", () => {
  const records: Record<number, WriteRecord> = {
    9: rec({ validation: written('Installed a sketch app') }),
    10: rec({ validation: written('Bad', false) }),
    12: rec({ final: call('timed out'), validation: null }),
  }
  const of = (h: number) => records[h] ?? null
  const hours = [0, 8, 9, 10, 11, 12, 13, 14]
  assert.deepEqual(previousHour(10, hours, of), { previous: { title: 'Installed a sketch app', summary: 'Installed a sketch app summary' }, missing: null })
  assert.deepEqual(previousHour(11, hours, of), { previous: null, missing: 'hour 10 was rejected: invented_id' })
  assert.deepEqual(previousHour(13, hours, of), { previous: null, missing: 'hour 12 failed: timed out' })
  assert.deepEqual(previousHour(8, hours, of), { previous: null, missing: 'no packet for hour 07' })
  assert.deepEqual(previousHour(0, hours, of), { previous: null, missing: 'no packet for hour 23 of the day before' })
  assert.deepEqual(previousHour(14, hours, of), { previous: null, missing: 'hour 13 not written yet' })
})

test('a stored result is kept only when its packet, prompt and previous hour are the ones it would be made from now', () => {
  const want = { packet_sha256: 'p', prompt_sha256: 'q', previous_hour: { title: 'A', summary: 'B' } }
  assert.equal(isCurrent(rec({ previous_hour: { title: 'A', summary: 'B' } }), want), true)
  assert.equal(isCurrent(rec({ previous_hour: { title: 'A', summary: 'B' }, packet_sha256: 'old' }), want), false, 'made on an earlier packet')
  assert.equal(isCurrent(rec({ previous_hour: { title: 'A', summary: 'B' }, prompt_sha256: 'old' }), want), false, 'made with an earlier prompt')
  assert.equal(isCurrent(rec(), want), false, 'made without the previous hour')
  assert.equal(isCurrent(rec({ previous_hour: { title: 'A', summary: 'B' }, final: call('quota') }), want), false, 'the call failed')
  assert.equal(isCurrent(null, want), false)
})

test('a grade is kept only for the write it graded', () => {
  const first = writeId({ started: '2026-10-21T10:00:00Z', final: call() })
  const again = writeId({ started: '2026-10-21T11:00:00Z', final: call() })
  assert.notEqual(first, again)
  const verdict = { grade: 'right' as const, reason: 'ok', must_missed: [], should_missed: [], must_not_said: [], unsupported_claims: [], wrong_attribution: [], only_you_stated: [] }
  assert.equal(gradeIsCurrent({ written: first, verdict }, first), true)
  assert.equal(gradeIsCurrent({ written: first, verdict }, again), false, 'the hour was written again')
  assert.equal(gradeIsCurrent({ verdict }, first), false, 'a grade that does not say which write it graded')
  assert.equal(gradeIsCurrent({ written: first, verdict: null }, first), false)
  assert.equal(gradeIsCurrent(null, first), false)
})

test('the evaluation passes the previous hour exactly as the engine does once that hour is stored', () => {
  resetSeq()
  const r = rig()
  const editor = app('com.example.editor', { name: 'Editor' })
  r.store.startRun(line('hello', { awake_us: 0, helper: 'test', boot_identity: 'kernel', version: '1', pid: 1, os: 'test', permissions: { accessibility: 'granted' }, config: { heartbeat_s: 15, idle_threshold_s: 120, reconcile_s: 60 } }, T0 - HOUR) as never)
  r.feed(focus(editor, 'remove-voiceos.sh', T0 + 5 * MIN, 'app_changed'))
  r.store.recordHeartbeat(line('heartbeat', { awake_us: 0, permissions: { accessibility: 'granted' }, registrations: { focus: true, session: true, power: true }, titles: 'ok', stall_ms: 0, dropped: 0 }, T0 + HOUR) as never)
  r.clock.t = T0 + 2 * HOUR
  const hour = { start_wall_ms: T0, tz: 'Africa/Kigali', tz_offset_min: 120 }
  const opts = { staleTitleMs: HOUR, nearbyHours: 1, openThreadMs: 3 * HOUR }
  const frozen = buildPacket(r.storage, hour, opts).packet
  const previous = { title: 'Installed a sketch app', summary: 'You installed a sketch app and opened its settings.' }
  r.storage.writeHour({ start_wall_ms: T0 - HOUR, tz: 'Africa/Kigali', status: 'written', ...previous }, r.storage.hourBasis(T0 - HOUR))
  const engine = buildPacket(r.storage, hour, opts).packet
  assert.equal(JSON.stringify(writerPacket(frozen, previous)), JSON.stringify(engine))
  assert.equal(writerPacket(frozen, null), frozen)
  assert.throws(() => writerPacket(engine, previous), /already carries context/)
  r.close()
})

test('a rejected hour is graded as the facts-only hour the person would see, and a call with no output as nothing', () => {
  const packet: Packet = { hour: '2030-03-05 10:00-11:00', tz: 'Etc/UTC', away: [], unknown: [], windows: [{ id: 'i1', app: 'Editor', title: 'plan.md', min: 30, from: '10:00', to: '10:30', times: 1 }], pages: [], agents: [], commits: [], scheduled_events: [] }
  assert.deepEqual(shownHour(rec({ validation: written('Planned the week') }), packet), { hour: written('Planned the week').hour, fallback: false })
  assert.deepEqual(shownHour(rec({ validation: written('Shipped the launch', false) }), packet), { hour: factsHour(packet), fallback: true })
  assert.deepEqual(shownHour({ final: { ...call(), text: 'not json' }, validation: { ok: false, errors: [{ code: 'not_json', detail: '' }], warnings: [], hour: null, cited: [] } }, packet), { hour: factsHour(packet), fallback: true })
  assert.equal(shownHour(rec({ final: call('timed out'), validation: null }), packet), null)
})

test('a summary takes only writes made on its run\'s packets, and only grades of those writes', () => {
  const run: RunInfo = { packets_dir: 'packet-v2', packet_version: 2, manifest: { 'packets/hour_09.json': 'p9', 'packets/hour_10.json': 'p10' } }
  const writes = [
    { name: 'm', hour: '09', packet_sha256: 'p9', id: 'w9' },
    { name: 'm', hour: '10', packet_sha256: 'p10', id: 'w10' },
  ]
  const grades = [
    { grader: 'g', name: 'm', hour: '09', written: 'w9' },
    { grader: 'g', name: 'm', hour: '10', written: 'w10' },
  ]
  assert.deepEqual(staleResults(run, writes, grades), [])
  assert.deepEqual(staleResults(run, [writes[0]!, { ...writes[1]!, packet_sha256: 'p10-v3' }], grades), ['writes/m/hour_10: not made on packet version 2'])
  assert.deepEqual(staleResults(run, writes, [grades[0]!, { ...grades[1]!, written: 'older' }]), ['grades/g/m/hour_10: grades another write'])
  assert.deepEqual(staleResults(run, writes.slice(0, 1), grades), ['grades/g/m/hour_10: no write for it'])
})
