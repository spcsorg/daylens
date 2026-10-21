import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { graderMessage, inconsistencies, keySections, parseVerdict, type Verdict } from '../../tools/eval/grade.ts'
import { disagreements, handCheckSample, listPrice, rank, scoreModel, standings, type HourResult } from '../../tools/eval/score.ts'

const verdict = (grade: Verdict['grade'], over: Partial<Verdict> = {}): Verdict => ({
  grade, reason: 'r', must_missed: [], should_missed: [], must_not_said: [], unsupported_claims: [], wrong_attribution: [], only_you_stated: [], ...over,
})

test('a verdict is read only when it is complete, and an only-you hour is graded only-you or wrong', () => {
  assert.equal(parseVerdict(JSON.stringify(verdict('partly')), false).verdict?.grade, 'partly')
  assert.equal(parseVerdict('```json\n' + JSON.stringify(verdict('right')) + '\n```', false).verdict?.grade, 'right')
  assert.match(parseVerdict(JSON.stringify(verdict('partly')), true).error!, /not one of only_you, wrong/)
  assert.match(parseVerdict(JSON.stringify(verdict('only_you')), false).error!, /not one of right, partly, wrong/)
  assert.match(parseVerdict(JSON.stringify({ ...verdict('right'), should_missed: 'x' }), false).error!, /should_missed/)
  assert.match(parseVerdict('Grade: right', false).error!, /not JSON/)
})

test('a verdict that contradicts the rules is flagged for a hand check', () => {
  assert.deepEqual(inconsistencies(verdict('wrong', { must_not_said: ['x'] })), [])
  assert.equal(inconsistencies(verdict('partly', { must_not_said: ['x'] })).length, 1)
  assert.equal(inconsistencies(verdict('right', { wrong_attribution: ['x'], must_missed: ['y'] })).length, 2)
})

test('the grader sees the rules, checklist, key and packet, but not the cited IDs', () => {
  const m = graderMessage({ right: 'r' }, { must: ['m'], should: [], must_not: [], only_you: [] }, '### 8 AM · key', { hour: 'h' } as never, {
    title: 't', summary: 's', apps: [], detail: 'd', outcome: null, sources: ['i1'], suggestion: null,
  })
  const input = JSON.parse(m.slice(m.indexOf('Input:\n') + 7)) as Record<string, Record<string, unknown>>
  assert.deepEqual(Object.keys(input), ['rules', 'checklist', 'key', 'packet', 'written'])
  assert.equal(input.written!.sources, undefined)
})

test('the key is split into its hours, 12 AM as 00 and PM hours on a 24-hour clock', () => {
  const k = keySections('# Day\n## Hours\n### 8 AM · Morning\nA\n### 1 PM · Class\nB\n### 11 PM · Late\nC\n## Earlier\n### 12 AM · Night\nD\n')
  assert.deepEqual(Object.keys(k).sort(), ['00', '08', '13', '23'])
  assert.equal(k['13'], '### 1 PM · Class\nB')
})

const result = (hour: string, grade: Verdict['grade'], over: Partial<HourResult> = {}, v: Partial<Verdict> = {}): HourResult => ({
  hour,
  call: { error: null, quota: false, latency_ms: 1000, usage: { input: 10_000, cached_input: 0, cache_write: 0, output: 1_000, reasoning: null }, reported_cost_usd: 0.05, model: 'm', tool_calls: [] },
  attempts: 1,
  validation: { ok: true, errors: [], warnings: [] },
  verdict: verdict(grade, v),
  hand: null,
  ...over,
})

test('scores count grades, claims and misses per model, price every call at list rates, and take a hand check over the grader', () => {
  assert.equal(listPrice({ input: 1_000_000, cached_input: 500_000, cache_write: 0, output: 100_000, reasoning: null }, { input: 2, output: 10 }), 3)
  const s = scoreModel('m', [
    result('08', 'right'),
    result('09', 'wrong', { hand: { grade: 'partly', note: 'the grader misread the title' } }),
    result('10', 'partly', { validation: { ok: false, errors: [{ code: 'invented_id', detail: 'x9' }], warnings: [] } }, { unsupported_claims: ['a'], only_you_stated: ['b'], should_missed: ['c', 'd'] }),
    result('17', 'only_you', {}, { wrong_attribution: ['e'] }),
  ], { input: 2, output: 10 })
  assert.deepEqual(s.grades, { right: 1, partly: 2, wrong: 0, only_you: 1 })
  assert.equal(s.unsupported_claims, 2)
  assert.equal(s.invented_ids, 1)
  assert.equal(s.wrong_attribution, 1)
  assert.equal(s.should_missed, 2)
  assert.equal(s.rejected, 1)
  assert.equal(s.cost_per_call_usd, 0.03)
  assert.equal(s.reported_cost_usd, 0.2)
  assert.equal(s.latency_mean_ms, 1000)
})

test('ranking is correctness first, then cost, then speed', () => {
  const base = scoreModel('x', [result('08', 'right')], { input: 2, output: 10 })
  const mk = (model: string, over: Partial<typeof base>) => ({ ...base, model, ...over, grades: { ...base.grades, ...(over.grades ?? {}) } })
  const order = rank([
    mk('cheap-but-wrong', { grades: { ...base.grades, wrong: 1 }, cost_per_call_usd: 0.0001 }),
    mk('claims', { unsupported_claims: 2, cost_per_call_usd: 0.001 }),
    mk('pricey', { cost_per_call_usd: 0.1 }),
    mk('slow', { cost_per_call_usd: 0.01, latency_mean_ms: 9000 }),
    mk('fast', { cost_per_call_usd: 0.01, latency_mean_ms: 2000 }),
  ]).map((s) => s.model)
  assert.deepEqual(order, ['fast', 'slow', 'pricey', 'claims', 'cheap-but-wrong'])
})

test('more correct hours and fewer wrong ones outrank fewer claims, and the no-AI baseline is set apart, not ranked', () => {
  const s = (model: string, grades: Partial<Record<Verdict['grade'], number>>, claims: number, cost: number) => ({
    ...scoreModel(model, [], null),
    grades: { right: 0, partly: 0, wrong: 0, only_you: 0, ...grades },
    unsupported_claims: claims,
    cost_per_call_usd: cost,
  })
  const { baseline, ranked } = standings([
    s('no-ai', { right: 5, partly: 8, wrong: 1, only_you: 2 }, 0, 0),
    s('timid', { right: 2, partly: 12, only_you: 2 }, 0, 0.001),
    s('bold', { right: 9, partly: 3, wrong: 3, only_you: 1 }, 6, 0.01),
    s('careful', { right: 9, partly: 5, wrong: 1, only_you: 1 }, 1, 0.03),
  ], 'no-ai')
  assert.equal(baseline?.model, 'no-ai')
  assert.deepEqual(ranked.map((r) => r.model), ['careful', 'bold', 'timid'])
  assert.deepEqual(ranked[0]!.vs_baseline, { correct: 3, wrong: 0 })
})

test('grader disagreements and the hand-check sample: every wrong hour and a quarter of the right ones', () => {
  assert.deepEqual(disagreements({ '08': verdict('right'), '09': verdict('wrong') }, { '08': verdict('right'), '09': verdict('partly') }), [{ hour: '09', a: 'wrong', b: 'partly' }])
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const vs = Object.fromEntries(['00', '08', '09', '10', '11', '12', '13'].map((h, i) => [h, verdict(i === 2 ? 'wrong' : i === 6 ? 'partly' : 'right')]))
  const s = handCheckSample('m', vs, hash)
  assert.ok(s.includes('09'))
  assert.equal(s.length, 1 + 2, 'five right hours, a quarter rounded up is two')
  assert.deepEqual(handCheckSample('m', vs, hash), s, 'the sample is fixed')
})
