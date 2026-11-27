// Ask's follow-ups: with an own key and a conversation before it, a question is first rewritten to stand on its own, and
// only then is the record read for it. The conversation is never evidence; the record and its checks still decide.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { bounded, EARLIER_LIMIT, type Earlier } from '../../app/shared/conversation.ts'
import { DB_FILE } from '../../capture/store.ts'
import { AssistantStore } from '../../retrieval/assistantStore.ts'
import { ask, AskError, ModelError, RESOLVE_PROMPT, RESOLVE_SCHEMA, RESOLVED_MAX_CHARS, type AskLog, type AskModel, type AskReply, type AskRequest } from '../../retrieval/ask.ts'
import { anthropicApi } from '../../retrieval/anthropicApi.ts'
import { Reader } from '../../retrieval/reader.ts'
import { fakeAnthropic } from '../support/fakeAnthropic.ts'
import { HOUR, rig, T0 } from '../storage/support.ts'
import { day } from './support.ts'

process.env.TZ = 'Etc/GMT+5'
const LIMITS = { maxHours: 5, maxSources: 10, perGroup: 5 }
// T0 is Friday 16 October, 1 AM; the questions are asked the next day.
const NEXT_DAY = T0 + 24 * HOUR
const BILLED = { model: 'fake-1', input_tokens: 1200, output_tokens: 80, cost_micro_usd: 7 }

type Rec = Record<string, unknown> & { question: string }
const isRewrite = (req: AskRequest) => req.schema === RESOLVE_SCHEMA

/** A model that rewrites with `rewrite` and answers with `answer`, keeping every request it was sent. */
function model(rewrite: (rec: Rec) => unknown, answer: (rec: Rec & { sources: { id: string; title: string; file?: string; address?: string }[] }) => unknown = () => ({ answerable: false, statements: [], missing: 'x' })) {
  const seen: AskRequest[] = []
  const m: AskModel = {
    name: 'Fake',
    provider: 'fake',
    run: async (req): Promise<AskReply> => {
      req.beforeSend?.()
      seen.push(req)
      const rec = JSON.parse(req.prompt)
      return { output: isRewrite(req) ? rewrite(rec) : answer(rec), ...BILLED }
    },
  }
  return { m, seen, rewrites: () => seen.filter(isRewrite).map((r) => JSON.parse(r.prompt) as Rec & { earlier: Record<string, string>[]; now: string }), answers: () => seen.filter((r) => !isRewrite(r)).map((r) => JSON.parse(r.prompt) as Rec & { days_asked: string[]; sources: { title: string; file?: string; address?: string }[] }) }
}

function setup(opts: { holdDeletions?: boolean } = {}) {
  const r = rig(undefined, opts)
  day(r)
  r.storage.writeHour({ start_wall_ms: T0, tz: 'Example/Town', status: 'written', title: 'Budget review', summary: 'Went through Q4 numbers.', sources: [{ app_id: 'com.example.editor' }] }, r.storage.hourBasis(T0))
  const reader = Reader.open(path.join(r.dir, DB_FILE))
  const store = AssistantStore.open(path.join(r.dir, DB_FILE), () => r.clock.t)
  const log: AskLog = { recordRead: (x, mark) => store.recordRead(x, mark), recordUsage: (u) => r.storage.recordUsage(u) }
  const reads = () => r.q<{ id: number; tool: string; query: string }>('SELECT id, tool, query FROM assistant_reads ORDER BY id')
  const usage = () => r.q<{ input_tokens: number; output_tokens: number; cost_micro_usd: number; ref: string }>('SELECT input_tokens, output_tokens, cost_micro_usd, ref FROM usage_ledger')
  // An exchange answered yesterday afternoon, against the record as it is now.
  const said = (question: string, answer: string | null, asked_at = T0 + 14 * HOUR): Earlier => ({ question, answer, asked_at, stamp: reader.stamp() })
  const run = (question: string, m: AskModel | null, earlier: Earlier[]) => ask(question, { reader, model: m, log, now: () => NEXT_DAY }, LIMITS, earlier)
  return { r, reader, log, reads, usage, said, run, close: () => (reader.close(), store.close(), r.close()) }
}

const BUDGET = 'what did I do on the budget yesterday?'
const REVIEWED = 'You reviewed the Q4 budget and the budget review doc.'

test('"What did I just do?" after a thread about yesterday is about today, with no AI and with a rewrite that keeps it', async () => {
  const s = setup()
  const noKey = await s.run('What did I just do?', null, [s.said(BUDGET, null)])
  assert.equal(noKey.kind, 'search_only')
  assert.ok(noKey.kind === 'search_only' && noKey.results.hours.every((h) => h.start_wall_ms >= NEXT_DAY - HOUR), 'no hour of yesterday is shown')
  assert.deepEqual(noKey.kind === 'search_only' && noKey.results.pages, [], 'yesterday’s budget search is not reused')

  const f = model((rec) => ({ question: rec.question }))
  const keyed = await s.run('What did I just do?', f.m, [s.said(BUDGET, REVIEWED)])
  assert.equal(keyed.kind, 'no_answer', 'today has nothing recorded')
  assert.equal(f.answers().length, 0, 'yesterday is not read for it')
  assert.equal(f.rewrites().length, 1)
  assert.equal(s.usage().length, 1, 'the rewrite was billed though nothing was answered')
  s.close()
})

test('with no conversation before it, a question makes one request, as before', async () => {
  const s = setup()
  const f = model(() => assert.fail('nothing to rewrite'))
  await s.run(BUDGET, f.m, [])
  assert.equal(f.seen.length, 1)
  assert.deepEqual(s.reads().map((r) => r.tool), ['ask'])
  s.close()
})

test('common follow-ups are rewritten before evidence is chosen, with the conversation as data, and answered from the record the rewrite selects', async () => {
  const s = setup()
  const cases: { q: string; earlier: Earlier[]; rewritten: string; check: (rec: { days_asked: string[]; sources: { title: string; file?: string; address?: string }[] }) => void }[] = [
    { q: 'When did I start that?', earlier: [s.said(BUDGET, REVIEWED)], rewritten: 'When did I start the q4 budget sheet on 2026-10-16?', check: (rec) => (assert.deepEqual(rec.days_asked, ['2026-10-16']), assert.ok(rec.sources.some((x) => x.file === 'q4-budget.xlsx'))) },
    { q: 'What did I do next?', earlier: [s.said('when did I open the q4 budget sheet?', 'Yesterday at 1 AM.')], rewritten: 'What did I do after the q4 budget sheet on 2026-10-16?', check: (rec) => assert.deepEqual(rec.days_asked, ['2026-10-16']) },
    { q: 'Did I send it?', earlier: [s.said('did I open the budget review doc?', 'Yes, yesterday at 1:20 AM.')], rewritten: 'Did I send the budget review doc?', check: (rec) => (assert.deepEqual(rec.days_asked, []), assert.ok(rec.sources.some((x) => x.address === 'https://docs.example.com/d/budget'))) },
    { q: 'And yesterday?', earlier: [s.said('when did I open the budget review today?', 'You haven’t opened it today.', NEXT_DAY - 30 * 60_000)], rewritten: 'When did I open the budget review yesterday?', check: (rec) => (assert.deepEqual(rec.days_asked, ['2026-10-16']), assert.ok(rec.sources.some((x) => x.address === 'https://docs.example.com/d/budget'))) },
  ]
  for (const c of cases) {
    const f = model(() => ({ question: c.rewritten }))
    await s.run(c.q, f.m, c.earlier)
    const [rewrite] = f.rewrites()
    assert.equal(f.seen[0]!.system, RESOLVE_PROMPT, c.q)
    assert.equal(rewrite!.question, c.q)
    assert.deepEqual(rewrite!.earlier.map((e) => [e.question, e.answer]), c.earlier.map((e) => [e.question, e.answer]))
    const [rec] = f.answers()
    assert.ok(rec, `${c.q}: the record the rewrite selects is read`)
    assert.equal(rec!.question, c.rewritten)
    assert.ok(!('earlier' in rec!), `${c.q}: the conversation never goes with the evidence`)
    c.check(rec!)
  }
  s.close()
})

test('a question that names its own time keeps it: a rewrite that moves the days or the part of the day is not used', async () => {
  const s = setup()
  const asked = async (q: string, rewritten: string) => {
    const f = model(() => ({ question: rewritten }))
    await s.run(q, f.m, [s.said(BUDGET, REVIEWED)])
    // Nothing was recorded on Monday, so nothing is read; the yesterday afternoon question reads what it names.
    return f.answers()[0] ?? null
  }
  assert.equal(await asked('What did I do on Monday?', 'What did I do on Monday?'), null)
  assert.equal(await asked('What did I do on Monday?', 'What did I do on the budget on 2026-10-16?'), null, 'the day the question names wins over the conversation’s')
  const afternoon = await asked('What did I do yesterday afternoon?', 'What did I do on the budget yesterday morning?')
  assert.equal(afternoon?.question ?? 'nothing read', 'nothing read', 'yesterday afternoon has nothing, and the morning is not read for it')
  const kept = await asked('What did I do on the budget yesterday?', 'What did I do on the q4 budget yesterday?')
  assert.equal(kept?.question, 'What did I do on the q4 budget yesterday?', 'a rewrite naming the same day is used')
  const f = model(() => ({ question: 'What did I do yesterday morning?' }))
  await s.run('And in the morning?', f.m, [s.said('What did I do yesterday?', REVIEWED)])
  assert.deepEqual(f.answers()[0]?.days_asked, ['2026-10-16'], 'the day it leaves unsaid comes from the conversation')
  s.close()
})

test('earlier exchanges keep the day they were asked on, so a retry after midnight sends the same', async () => {
  const s = setup()
  const earlier = [s.said('what did I do today?', 'You reviewed the Q4 budget.', T0 + 14 * HOUR)]
  const f = model((rec) => ({ question: rec.question }))
  await s.run('How long did that take?', f.m, earlier)
  await s.run('How long did that take?', f.m, earlier)
  const [first, again] = f.rewrites()
  assert.match(first!.earlier[0]!.asked!, /2026-10-16/)
  assert.match(first!.now, /2026-10-17/)
  assert.deepEqual(again!.earlier, first!.earlier)
  s.close()
})

test('only the latest exchanges are sent, each cut short, and a rewrite that is too long or not text fails as Ask’s error, with its usage kept', async () => {
  const s = setup()
  const many = Array.from({ length: EARLIER_LIMIT.exchanges + 3 }, (_, i) => s.said(`${BUDGET} ${i}`, `${i} `.repeat(5000)))
  assert.equal(bounded(many).length, EARLIER_LIMIT.exchanges)
  const f = model((rec) => ({ question: rec.question }))
  await s.run('How long did that take?', f.m, many)
  const sent = f.rewrites()[0]!.earlier
  assert.deepEqual(sent.map((e) => e.question), many.slice(-EARLIER_LIMIT.exchanges).map((e) => e.question))
  assert.ok(sent.every((e) => e.answer!.length <= EARLIER_LIMIT.chars))
  const before = s.usage().length
  for (const bad of [{ question: 'x'.repeat(RESOLVED_MAX_CHARS + 1) }, { question: 5 }, { question: '  ' }, null]) {
    const g = model(() => bad)
    await assert.rejects(s.run('How long did that take?', g.m, [s.said(BUDGET, REVIEWED)]), (e: unknown) => e instanceof AskError && e.reason === 'invalid_output')
    assert.equal(g.answers().length, 0)
  }
  assert.equal(s.usage().length, before + 4)
  s.close()
})

test('a rewrite that fails says so through Ask’s errors and keeps what it was billed', async () => {
  const s = setup()
  const failing: AskModel = { name: 'Fake', provider: 'fake', run: async () => Promise.reject(new ModelError('overloaded', BILLED)) }
  await assert.rejects(s.run('Did I send it?', failing, [s.said(BUDGET, REVIEWED)]), (e: unknown) => e instanceof AskError && e.reason === 'ai_failed')
  assert.deepEqual(s.usage().map((u) => u.input_tokens), [1200])
  assert.deepEqual(s.reads().map((r) => [r.tool, r.query]), [['ask_followup', 'Did I send it?']], 'what was sent is logged before it is sent')
  s.close()
})

test('a follow-up is one usage entry holding both requests, and the read log names the conversation without keeping answers', async () => {
  const s = setup()
  const f = model(() => ({ question: 'When did I start the q4 budget sheet on 2026-10-16?' }), (rec) => ({ answerable: true, statements: [{ text: 'You opened the Q4 budget sheet first.', sources: [rec.sources.find((x) => x.file === 'q4-budget.xlsx')!.id] }] }))
  const res = await s.run('When did I start that?', f.m, [s.said(BUDGET, REVIEWED)])
  assert.equal(res.kind, 'answer')
  const reads = s.reads()
  assert.deepEqual(reads.map((r) => [r.tool, r.query]), [['ask_followup', 'When did I start that?'], ['ask', 'When did I start that?']])
  assert.deepEqual(s.usage(), [{ input_tokens: 2400, output_tokens: 160, cost_micro_usd: 14, ref: `read:${reads[1]!.id}` }])
  assert.ok(!JSON.stringify(s.r.q('SELECT * FROM assistant_reads')).includes('reviewed'), 'no earlier answer is kept')
  s.close()
})

test('answers made before a correction are not sent, the questions still are; after a deletion, begun or done, nothing of the conversation is', async () => {
  const s = setup({ holdDeletions: true })
  const earlier = [s.said(BUDGET, REVIEWED)]
  s.r.storage.correct(s.r.storage.hourAt(T0)!.id, 'title', 'Planned the bakery deliveries')
  const f = model((rec) => ({ question: rec.question }))
  await s.run('How long did that take?', f.m, earlier)
  assert.deepEqual(f.rewrites()[0]!.earlier.map((e) => [e.question, e.answer]), [[BUDGET, undefined]])
  assert.equal(s.reads()[0]!.tool, 'ask_followup_questions', 'the log says only questions were sent')

  const begun = [s.said(BUDGET, REVIEWED)]
  s.r.storage.deleteRange(T0 + 5 * HOUR, T0 + 6 * HOUR)
  const g = model(() => assert.fail('nothing is left to rewrite with'))
  await s.run('How long did that take?', g.m, begun).catch(() => {})
  assert.equal(g.rewrites().length, 0, 'a deletion still under way')
  s.close()

  const t = setup()
  const done = [t.said(BUDGET, REVIEWED)]
  await t.r.storage.deleteRange(T0 + 5 * HOUR, T0 + 6 * HOUR).done
  const h = model(() => assert.fail('nothing is left to rewrite with'))
  await t.run('How long did that take?', h.m, done)
  assert.equal(h.rewrites().length, 0, 'a deletion that finished')
  const replaced = [{ ...t.said(BUDGET, REVIEWED), stamp: { changes: 10_000, deletions: 0 } }]
  const k = model(() => assert.fail('a record replaced since has none of it'))
  await t.run('How long did that take?', k.m, replaced)
  assert.equal(k.rewrites().length, 0, 'a record replaced since')
  t.close()
})


test('a correction between context validation and the resolver call prevents the network request', async () => {
  const s = setup()
  try {
    const earlier = [s.said(BUDGET, REVIEWED)]
    const f = model(() => assert.fail('outdated context must not leave'))
    const log: AskLog = { ...s.log, recordRead: (r, mark) => {
      const id = s.log.recordRead(r, mark)
      s.r.storage.correct(s.r.storage.hourAt(T0)!.id, 'title', 'Planned bakery deliveries')
      return id
    } }
    await assert.rejects(ask('How long did that take?', { reader: s.reader, model: f.m, log, now: () => NEXT_DAY }, LIMITS, earlier), /record changed/i)
    assert.equal(f.seen.length, 0)
  } finally { s.close() }
})

test('a correction or deletion during resolution prevents a second request with its old subject', async () => {
  for (const kind of ['correction', 'deletion'] as const) {
    const s = setup()
    let deletion: Promise<unknown> | undefined
    try {
      const earlier = [s.said(BUDGET, REVIEWED)]
      const f = model(() => {
        if (kind === 'correction') s.r.storage.correct(s.r.storage.hourAt(T0)!.id, 'title', 'Planned bakery deliveries')
        else deletion = s.r.storage.deleteRange(T0 + 5 * HOUR, T0 + 6 * HOUR).done
        return { question: 'How long did I spend on the budget yesterday?' }
      })
      await assert.rejects(s.run('How long did that take?', f.m, earlier), /record changed|deletion/i)
      assert.equal(f.answers().length, 0)
      assert.equal(s.usage().length, 1, 'the resolver was still billed')
    } finally { await deletion; s.close() }
  }
})

test('a correction or deletion while the provider fails stops its retry: the record is checked before every attempt to send', async () => {
  for (const kind of ['correction', 'deletion'] as const) {
    const s = setup()
    let deletion: Promise<unknown> | undefined
    const api = await fakeAnthropic(() => {
      if (kind === 'correction') s.r.storage.correct(s.r.storage.hourAt(T0)!.id, 'title', 'Planned bakery deliveries')
      else deletion = s.r.storage.deleteRange(T0 + 5 * HOUR, T0 + 6 * HOUR).done
      return { kind: 'error', status: 500, type: 'api_error', message: 'overloaded' }
    })
    try {
      const real = anthropicApi('claude-haiku-5-5', { apiKey: 'sk-test', baseURL: api.url, timeoutMs: 5000 })
      // A follow-up's rewrite, and a question with no conversation that goes straight to its answer.
      const earlier = kind === 'correction' ? [s.said(BUDGET, REVIEWED)] : []
      await assert.rejects(s.run(kind === 'correction' ? 'How long did that take?' : BUDGET, real, earlier), /record changed/i)
      assert.equal(api.seen.length, 1, `${kind}: nothing is sent again`)
    } finally {
      await deletion
      await api.close()
      s.close()
    }
  }
})
test('the evidence read log keeps the actual user question rather than the derived rewrite', async () => {
  const s = setup()
  try {
    const f = model(() => ({ question: 'How long did I spend on the q4 budget sheet yesterday?' }))
    await s.run('How long did that take?', f.m, [s.said(BUDGET, REVIEWED)])
    assert.deepEqual(s.reads().map((r) => r.query), ['How long did that take?', 'How long did that take?'])
  } finally { s.close() }
})


test('a provider failure keeps fresh matching search results with the error', async () => {
  const s = setup()
  try {
    const failing: AskModel = { name: 'Fake', provider: 'fake', run: async () => { throw new Error('credit balance is too low') } }
    await assert.rejects(s.run(BUDGET, failing, []), (e: unknown) => {
      assert.ok(e instanceof AskError)
      assert.match(e.message, /credit balance/)
      assert.ok(e.results?.pages.some((p) => p.url === 'https://docs.example.com/d/budget'))
      return true
    })
    await assert.rejects(s.run('What did I do yesterday?', failing, []), (e: unknown) => {
      assert.ok(e instanceof AskError && e.results && e.results.hours.length > 0, 'a time with nothing to search for keeps its hours')
      return true
    })
  } finally { s.close() }
})

test('Ask says when the record goes to Claude to be read: after a follow-up is rewritten, before the answer is asked for, and never without a key', async () => {
  const s = setup()
  const steps: string[] = []
  const f = model((rec) => (steps.push('rewrite'), { question: rec.question }), () => (steps.push('answer'), { answerable: false, statements: [], missing: 'x' }))
  const onReading = () => void steps.push('reading')
  await ask('And the budget yesterday?', { reader: s.reader, model: f.m, log: s.log, now: () => NEXT_DAY, onReading }, LIMITS, [s.said(BUDGET, REVIEWED)])
  assert.deepEqual(steps, ['rewrite', 'reading', 'answer'])

  steps.length = 0
  await ask(BUDGET, { reader: s.reader, model: null, log: s.log, now: () => NEXT_DAY, onReading }, LIMITS)
  assert.deepEqual(steps, [], 'search alone sends nothing to be read')
  s.close()
})
