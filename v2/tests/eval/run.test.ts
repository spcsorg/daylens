import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claudeCli, factsHour, type CallResult } from '../../engine/backends.ts'
import { buildPacket, type Packet, type Ref } from '../../engine/packet.ts'
import type { Validation } from '../../engine/validate.ts'
import { checkPackets, gradeIsCurrent, handGradeFor, isCurrent, previousHour, shownHour, staleResults, withAttempts, WRITER_TRIES, writeId, writerPacket, type GradeBasis, type HandCheck, type RunInfo, type WriteRecord } from '../../tools/eval/run.ts'
import { app, focus, line, resetSeq } from '../support/lines.ts'
import { HOUR, MIN, rig, T0 } from '../storage/support.ts'
import { tempDir } from '../support/tmp.ts'

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

test('a grade is reused only for the same write, packet, shown hour, grader prompt, checklist, answer key, grader model, effort and CLI', () => {
  const first = writeId({ started: '2030-03-05T10:00:00Z', final: call() })
  const again = writeId({ started: '2030-03-05T11:00:00Z', final: call() })
  assert.notEqual(first, again)
  const verdict = { grade: 'right' as const, reason: 'ok', must_missed: [], should_missed: [], must_not_said: [], unsupported_claims: [], wrong_attribution: [], only_you_stated: [] }
  const basis: GradeBasis = { written: first, packet_sha256: 'p', shown_sha256: 's', grader_prompt_sha256: 'gp', checklists_sha256: 'cl', key_sha256: 'k', model: 'claude-opus-5-5', effort: null, cli: '2.1.306 (Claude Code)' }
  assert.equal(gradeIsCurrent({ ...basis, verdict }, basis), true)
  assert.equal(gradeIsCurrent({ ...basis, verdict }, { ...basis, written: again }), false, 'the hour was written again')
  for (const [k, v] of [['packet_sha256', 'p2'], ['shown_sha256', 's2'], ['grader_prompt_sha256', 'gp2'], ['checklists_sha256', 'cl2'], ['key_sha256', 'k2'], ['model', 'claude-sonnet-5-5'], ['effort', 'low'], ['cli', '2.1.308 (Claude Code)']] as const) {
    assert.equal(gradeIsCurrent({ ...basis, verdict }, { ...basis, [k]: v }), false, k)
  }
  assert.equal(gradeIsCurrent({ written: first, verdict }, basis), false, 'a grade that does not say what it was made with')
  assert.equal(gradeIsCurrent({ ...basis, verdict: null }, basis), false)
  assert.equal(gradeIsCurrent({ ...basis, verdict: { ...verdict, grade: 'wrong' }, automatic: true }, basis), false, 'a failed call graded wrong without a grader')
  assert.equal(gradeIsCurrent(null, basis), false)
})

test('a hand check applies only to the write and the shown hour it was made on', () => {
  const hand: HandCheck[] = [{ grader: 'g', candidate: 'm', hour: '09', written: 'w1', shown_sha256: 's1', grader_grade: 'right', my_grade: 'partly', note: '' }]
  assert.deepEqual(handGradeFor(hand, 'g', 'm', '09', 'w1', 's1'), { grade: 'partly', note: '' })
  assert.equal(handGradeFor(hand, 'g', 'm', '09', 'w2', 's1'), null, 'the hour was written again')
  assert.equal(handGradeFor(hand, 'g', 'm', '09', 'w1', 'facts'), null, "today's validator shows the facts-only hour for the same write")
  const agreed: HandCheck[] = [{ ...hand[0]!, my_grade: 'right' }]
  assert.deepEqual(handGradeFor(agreed, 'g', 'm', '09', 'w1', 's1'), { grade: 'right', note: '' }, 'a check that agreed still decides the grade if the hour is graded again')
})

test('the evaluation passes the previous hour exactly as the engine does once that hour is stored', () => {
  resetSeq()
  const r = rig()
  const editor = app('com.example.editor', { name: 'Editor' })
  r.store.startRun(line('hello', { awake_us: 0, helper: 'test', boot_identity: 'kernel', version: '1', pid: 1, os: 'test', permissions: { accessibility: 'granted' }, config: { heartbeat_s: 15, idle_threshold_s: 120, reconcile_s: 60 } }, T0 - HOUR) as never)
  r.feed(focus(editor, 'remove-sketch-app.sh', T0 + 5 * MIN, 'app_changed'))
  r.store.recordHeartbeat(line('heartbeat', { awake_us: 0, permissions: { accessibility: 'granted' }, registrations: { focus: true, session: true, power: true }, titles: 'ok', stall_ms: 0, dropped: 0 }, T0 + HOUR) as never)
  r.clock.t = T0 + 2 * HOUR
  const hour = { start_wall_ms: T0, tz: 'Africa/Johannesburg', tz_offset_min: 120 }
  const opts = { staleTitleMs: HOUR, nearbyHours: 1, openThreadMs: 3 * HOUR }
  const frozen = buildPacket(r.storage, hour, opts).packet
  const previous = { title: 'Installed a sketch app', summary: 'You installed a sketch app and opened its settings.' }
  r.storage.writeHour({ start_wall_ms: T0 - HOUR, tz: 'Africa/Johannesburg', status: 'written', ...previous }, r.storage.hourBasis(T0 - HOUR))
  const engine = buildPacket(r.storage, hour, opts).packet
  assert.equal(JSON.stringify(writerPacket(frozen, previous)), JSON.stringify(engine))
  assert.equal(writerPacket(frozen, null), frozen)
  assert.throws(() => writerPacket(engine, previous), /already carries context/)
  r.close()
})

test("an hour is graded as what the person would see with today's validator: a rejected hour and a failed call as the facts-only hour", () => {
  const packet: Packet = { hour: '2030-03-05 10:00-11:00', tz: 'Etc/UTC', away: [], unknown: [], windows: [{ id: 'i1', app: 'Editor', title: 'plan.md', min: 30, from: '10:00', to: '10:30', times: 1 }], pages: [], agents: [], commits: [], scheduled_events: [] }
  const refs: Record<string, Ref> = { i1: { kind: 'observations', ids: [1] } }
  const hour = { title: 'Planned the week', summary: 'You planned the week in the editor.', apps: ['Editor'], detail: 'You had “plan.md” open until 10:30.', outcome: null, sources: ['i1'], suggestion: null }
  const text = (h: object) => ({ final: { ...call(), text: JSON.stringify(h) } })
  const facts = { hour: factsHour(packet), fallback: true }
  const shown = (r: { final: CallResult }) => {
    const { validation: _v, ...rest } = shownHour(r, packet, refs)
    return rest
  }
  assert.deepEqual(shown(text(hour)), { hour, fallback: false })
  assert.deepEqual(shown(text({ ...hour, sources: ['x9'] })), facts, 'rejected')
  assert.deepEqual(shown({ ...text({ ...hour, summary: 'You shipped the plan.' }), validation: written('Stored as valid') } as never), facts, 'a stored validation from an older validator is not trusted')
  assert.deepEqual(shown({ final: { ...call(), text: 'not json' } }), facts)
  assert.deepEqual(shown({ final: call('timed out') }), facts, 'the call failed')
})

test("a summary takes only writes made on its run's packets, and a current grade of each of them for every hour", () => {
  const run: RunInfo = { packets_dir: 'packet-v2', packet_version: 2, manifest: { 'packets/hour_09.json': 'p9', 'packets/hour_10.json': 'p10' } }
  const writes: Parameters<typeof staleResults>[1] = [
    { name: 'm', hour: '09', packet_sha256: 'p9', id: 'w9', prompt_sha256: 'q', previous_hour: null },
    { name: 'm', hour: '10', packet_sha256: 'p10', id: 'w10', prompt_sha256: 'q', previous_hour: { title: 'A', summary: 'B' } },
  ]
  const made = (hour: string) => ({ packet_sha256: `p${Number(hour)}`, shown_sha256: `s${hour}`, grader_prompt_sha256: 'gp', checklists_sha256: 'cl', key_sha256: 'k', model: 'claude-opus-5-5', effort: null })
  const verdict = { grade: 'right' as const, reason: 'ok', must_missed: [], should_missed: [], must_not_said: [], unsupported_claims: [], wrong_attribution: [], only_you_stated: [] }
  const grades: Parameters<typeof staleResults>[2] = [
    { grader: 'g', name: 'm', hour: '09', written: 'w9', ...made('09'), cli: '1', verdict },
    { grader: 'g', name: 'm', hour: '10', written: 'w10', ...made('10'), cli: '1', verdict },
  ]
  const want = {
    write: (_name: string, hour: string) => ({ prompt_sha256: 'q', previous_hour: hour === '10' ? { title: 'A', summary: 'B' } : null }),
    grade: (grader: string, _name: string, hour: string) => (grader === 'g' ? made(hour) : null),
  }
  const stale = (w = writes, g = grades, h: HandCheck[] = []) => staleResults(run, w, g, h, ['09', '10'], want)
  assert.deepEqual(stale(), [])
  assert.deepEqual(stale(writes, [grades[0]!, { ...grades[1]!, cli: '2' }]), [], 'an older grader CLI')
  assert.deepEqual(stale([writes[0]!, { ...writes[1]!, packet_sha256: 'p10-v3' }]), ['writes/m/hour_10: not made on packet version 2'])
  assert.deepEqual(stale([writes[0]!, { ...writes[1]!, prompt_sha256: 'q-old' }]), ['writes/m/hour_10: written with another writer prompt'])
  assert.deepEqual(stale([writes[0]!, { ...writes[1]!, previous_hour: null }]), ["writes/m/hour_10: given another previous hour than its candidate's hour before it gives today"])
  assert.deepEqual(stale(writes, [grades[0]!, { ...grades[1]!, written: 'older' }]), ['grades/g/m/hour_10: grades another write'])
  assert.deepEqual(stale(writes.slice(0, 1)), ['grades/g/m/hour_10: no write for it'])
  assert.deepEqual(stale(writes, [grades[0]!, { ...grades[1]!, automatic: true }]), ['grades/g/m/hour_10: grades a failed call wrong instead of as its facts'])
  assert.deepEqual(stale(writes, [grades[0]!, { ...grades[1]!, packet_sha256: 'other' }]), ['grades/g/m/hour_10: not made with the current packet_sha256'], 'the grader was given other packets')
  assert.deepEqual(stale(writes, [grades[0]!, { ...grades[1]!, shown_sha256: 'old' }]), ['grades/g/m/hour_10: not made with the current shown_sha256'], 'today the person would see another hour')
  assert.deepEqual(stale(writes, [grades[0]!, { ...grades[1]!, key_sha256: 'k-old', checklists_sha256: 'cl-old' }]), ['grades/g/m/hour_10: not made with the current checklists_sha256, key_sha256'])
  assert.deepEqual(stale(writes, [grades[0]!, { ...grades[1]!, key_sha256: undefined }]), ['grades/g/m/hour_10: not made with the current key_sha256'], 'a grade that does not record its answer key')
  assert.deepEqual(stale(writes, [grades[0]!, { ...grades[1]!, verdict: null }]), ['grades/g/m/hour_10: the grader gave no verdict'])
  assert.deepEqual(stale(writes, [grades[0]!]), ['grades/g/m/hour_10: not graded'])
  const check = (over: Partial<HandCheck>): HandCheck => ({ grader: 'g', candidate: 'm', hour: '10', written: 'w10', shown_sha256: 's10', grader_grade: 'right', my_grade: 'wrong', note: '', ...over })
  assert.deepEqual(stale(writes, grades, [check({}), check({ written: 'older', shown_sha256: 'old' })]), [], 'a hand check of an older write is history')
  assert.deepEqual(stale(writes, grades, [check({ shown_sha256: 'old' })]), ['hand-checks/g/m/hour_10: judged another hour than the person would see today'])
  const contradicts = [grades[0]!, { ...grades[1]!, verdict: { ...verdict, grade: 'partly' as const, wrong_attribution: ['agent work while locked'] } }]
  assert.deepEqual(stale(writes, contradicts), ['grades/g/m/hour_10: the verdict contradicts its own findings and has no hand check'])
  assert.deepEqual(stale(writes, contradicts, [check({})]), [], 'checked by hand')
  assert.deepEqual(stale(writes, contradicts, [check({ shown_sha256: 'old' })]), [
    'grades/g/m/hour_10: the verdict contradicts its own findings and has no hand check',
    'hand-checks/g/m/hour_10: judged another hour than the person would see today',
  ])
  assert.deepEqual(stale(writes, [grades[0]!, { ...grades[1]!, grader: 'x' }]), ['grades/x/m/hour_10: x is not a grader', 'grades/g/m/hour_10: not graded', 'grades/x/m/hour_09: not graded'])
})

test('nothing runs on packets other than the ones a results folder was made on', () => {
  const run: RunInfo = { packets_dir: '.', packet_version: 3, manifest: { 'packets/hour_09.json': 'p9', 'refs/hour_09.json': 'r9' } }
  assert.doesNotThrow(() => checkPackets(run, { 'refs/hour_09.json': 'r9', 'packets/hour_09.json': 'p9' }))
  assert.throws(() => checkPackets(run, { 'packets/hour_09.json': 'p9-new', 'refs/hour_09.json': 'r9' }), /not the ones results\/ was made on/)
})

test('a writer that cannot be started is a failed call: retried once, then the hour stays as its facts', async () => {
  const missing = claudeCli('m', { cwd: tempDir('daylens-no-cli-'), env: { PATH: '/nonexistent' } })
  const { final, attempts } = await withAttempts(WRITER_TRIES, () => missing.call('hour'), () => null, async () => {})
  assert.equal(attempts.length, 2)
  assert.equal(final.text, null)
  assert.match(final.error ?? '', /ENOENT/)
})

test('a failed writer call is retried once, a minute later, and then the hour stays as its facts', async () => {
  const waits: number[] = []
  let calls = 0
  const failing = async () => (calls++, call('timed out'))
  const { final, attempts } = await withAttempts(WRITER_TRIES, failing, () => null, async (ms) => void waits.push(ms))
  assert.equal(calls, 2)
  assert.deepEqual(waits, [60_000])
  assert.equal(attempts.length, 2)
  assert.equal(final.error, 'timed out')
  calls = 0
  await withAttempts(WRITER_TRIES, async () => (calls++, call()), () => null, async (ms) => void waits.push(ms))
  assert.equal(calls, 1, 'a call that worked is not repeated')
})
