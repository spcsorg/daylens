// What Ask's thread sends with a question: at most the latest few exchanges before it that the person saw succeed, each
// with when it was asked and the record it was answered from, and after a correction none of their answers.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { askedAs } from '../../app/reader/ask.ts'
import { corrected, earlierOf, questionOf, type Turn } from '../../app/renderer/src/screens/ask/thread.ts'
import { askFailure, type AskResult } from '../../app/shared/ai.ts'
import { EARLIER_LIMIT } from '../../app/shared/conversation.ts'

const none = { pages: [], files: [], windows: [], hours: [], more: [], looser: false }
const stamp = { changes: 7, deletions: 2 }
const answer = (text: string): AskResult => ({ kind: 'answer', statements: [{ text, cites: [] }], visual: null, dropped: 0, withdrawn: 0, results: none, stamp })
const turn = (id: number, question: string, over: Partial<Turn> = {}): Turn => ({ id, question, asked_at: 1000 * id, earlier: [], streamed: [], result: null, error: null, stale: false, outdated: null, ...over })

test('a question carries the answered and searched exchanges before it, never a pending, failed, unanswered or outdated one', () => {
  const thread = [
    turn(1, 'what did I do on the pricing memo?', { result: answer('You drafted the pricing memo.') }),
    turn(2, 'and the invoices?', { error: 'Claude couldn’t answer that. Try again.' }),
    turn(3, 'anything on the bakery site?', { result: { kind: 'no_answer', missing: null, results: none, stamp } }),
    turn(4, 'invoice 1042', { result: { kind: 'search_only', results: none, stamp } }),
    turn(5, 'what about Kestrel?', { stale: true }),
    turn(6, 'still going'),
  ]
  assert.deepEqual(earlierOf(thread), [
    { question: 'what did I do on the pricing memo?', answer: 'You drafted the pricing memo.', asked_at: 1000, stamp },
    { question: 'invoice 1042', answer: null, asked_at: 4000, stamp },
  ])
})

test('each turn keeps at most the latest exchanges, each cut short, however long the thread', () => {
  const thread = Array.from({ length: 40 }, (_, i) => turn(i + 1, `question ${i}`, { result: answer('word '.repeat(1000)) }))
  const kept = earlierOf(thread)
  assert.equal(kept.length, EARLIER_LIMIT.exchanges)
  assert.deepEqual(kept.map((e) => e.question), ['question 37', 'question 38', 'question 39'])
  assert.ok(kept.every((e) => e.answer!.length <= EARLIER_LIMIT.chars))
})

test('a correction drops every answer, shown or carried, and keeps the questions for a retry and for the next question', () => {
  const carried = { question: 'what did I do on the pricing memo?', answer: 'You drafted the pricing memo.', asked_at: 1000, stamp }
  const thread = [turn(1, carried.question, { result: answer(carried.answer) }), turn(2, 'How long did that take?', { earlier: [carried], result: answer('About an hour.') })]
  const after = corrected(thread)
  assert.ok(after.every((t) => t.stale && t.result === null))
  assert.deepEqual(after[1]!.earlier, [{ ...carried, answer: null }])
  assert.deepEqual(earlierOf(after), [{ ...carried, answer: null }, { question: 'How long did that take?', answer: null, asked_at: 2000, stamp }], 'a new question still knows what was asked, and when')
  assert.deepEqual(earlierOf(corrected(after)), earlierOf(after), 'a second correction keeps them too')
})

test('the reader answers again when the conversation before a question differs, and not when only what is never sent does', () => {
  const now = new Date(2030, 2, 4, 15).getTime()
  const memo = [{ question: 'what did I do on the pricing memo?', answer: 'You drafted it.', asked_at: now - 60_000, stamp }]
  const invoice = [{ question: 'what did I do on invoice 1042?', answer: 'You sent it.', asked_at: now - 60_000, stamp }]
  const q = 'How long did that take?'
  assert.notEqual(askedAs(q, memo, now), askedAs(q, invoice, now))
  assert.notEqual(askedAs(q, memo, now), askedAs(q, [], now))
  assert.notEqual(askedAs(q, [{ ...memo[0]!, answer: null }], now), askedAs(q, memo, now))
  assert.notEqual(askedAs(q, [{ ...memo[0]!, stamp: { changes: 8, deletions: 2 } }], now), askedAs(q, memo, now), 'answered from another record')
  assert.notEqual(askedAs(q, [{ ...memo[0]!, asked_at: now - 86_400_000 }], now), askedAs(q, memo, now), 'asked on another day')
  assert.equal(askedAs(`${q} `, memo, now), askedAs(q.toLowerCase(), memo, now))
  assert.notEqual(askedAs(q, memo, now), askedAs(q, memo, now + 24 * 3_600_000), 'today is another day after midnight')
  const older = Array.from({ length: 10 }, (_, i) => ({ question: `question ${i}`, answer: null, asked_at: now - 3_600_000, stamp }))
  assert.equal(askedAs(q, [...older, ...memo], now), askedAs(q, [...older.slice(5), ...memo], now), 'exchanges too old to be sent change nothing')
})


test('context only reads the latest successful exchanges and bounds answers before joining', () => {
  const old = turn(1, 'old', { result: answer('old') })
  Object.defineProperty(old, 'result', { get: () => assert.fail('old history must not be copied') })
  const latest = [2, 3, 4].map((id) => turn(id, `question ${id}`, { result: answer('x'.repeat(EARLIER_LIMIT.chars)) }))
  const r = latest[2]!.result!
  if (r.kind === 'answer') r.statements.push({ get text() { return assert.fail('text beyond the bound must not be read') }, cites: [] })
  assert.equal(earlierOf([old, ...latest]).length, 3)
})

test('a retry keeps its original timestamp and bounded conversation', () => {
  const t = turn(4, 'And yesterday?', { earlier: [{ question: 'What did I do today?', answer: 'x'.repeat(5000), asked_at: 1000, stamp }] })
  assert.deepEqual(questionOf(t), { question: t.question, asked_at: 4000, earlier: [{ ...t.earlier[0]!, answer: 'x'.repeat(EARLIER_LIMIT.chars) }] })
})


test('provider and record-change failures give a stable action the person can take', () => {
  assert.match(askFailure('Claude did not answer: credit balance is too low'), /out of credit/)
  assert.match(askFailure('Claude did not answer: the API key was refused'), /Check it in Settings/)
  assert.match(askFailure('Your record changed. Ask again.'), /record changed/)
})
