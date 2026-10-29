import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentStore } from '../../capture/agents/store.ts'
import type { AgentRecord } from '../../capture/agents/types.ts'
import { factsHour, type CallResult, type HourWriter } from '../../engine/backends.ts'
import { dueHours, HourWriting, OPEN_TURN_WAIT_MS, WRITE_DELAY_MS } from '../../engine/hourWriter.ts'
import type { Packet } from '../../engine/packet.ts'
import { app, focus } from '../support/lines.ts'
import { HOUR, MIN, rig, T0 } from '../storage/support.ts'

process.env.TZ = 'Etc/GMT+5'
const editor = app('com.example.editor', { name: 'Editor' })

const call = (over: Partial<CallResult>): CallResult => ({ text: null, error: null, quota: false, latency_ms: 1, first_token_ms: null, usage: { input: 2000, cached_input: 0, cache_write: 0, output: 300, reasoning: null }, model: 'claude-opus-5-5', tool_calls: [], ...over })

// A writer that answers each hour with its facts, citing the first window, as a valid written hour.
function writer(seen: Packet[], reply: (p: Packet) => Partial<CallResult> = (p) => ({ text: JSON.stringify({ ...factsHour(p), title: 'Edited the notes', sources: [p.windows[0]!.id] }) })): HourWriter {
  return { name: 'api:claude-opus-5-5', write: async (p) => (seen.push(p), call(reply(p))) }
}

function setup() {
  const r = rig()
  r.feed(focus(editor, 'notes.md', T0 + 5 * MIN, 'app_changed'))
  for (let t = T0 + 6 * MIN; t < T0 + 50 * MIN; t += MIN) r.feed(focus(editor, 'notes.md', t, 'reconcile'))
  r.store.flush()
  const logs: string[] = []
  const usage = () => r.q<{ kind: string; model: string; input_tokens: number; cost_micro_usd: number; ref: string }>('SELECT kind, model, input_tokens, cost_micro_usd, ref FROM usage_ledger')
  return { r, logs, usage, hours: (now: number) => new HourWriting(r.storage, { log: (l) => logs.push(l), now: () => now, tz: 'Example/Town' }) }
}

test('an hour is due once it has ended and the write delay has passed, and only within the last day', () => {
  assert.deepEqual(dueHours(T0 + HOUR + WRITE_DELAY_MS - 1).at(-1), T0 - HOUR)
  assert.deepEqual(dueHours(T0 + HOUR + WRITE_DELAY_MS).at(-1), T0)
  const all = dueHours(T0 + HOUR + WRITE_DELAY_MS)
  assert.equal(all.length, 23)
  assert.equal(all[0], T0 - 22 * HOUR)
})

test('with a writer, a finished hour is written once, checked, stored with its sources, and what it cost is recorded', async () => {
  const s = setup()
  const seen: Packet[] = []
  const hours = s.hours(T0 + HOUR + WRITE_DELAY_MS)
  hours.setWriter(writer(seen))
  await hours.run()
  const h = s.r.storage.hourAt(T0)!
  assert.equal(h.status, 'written')
  assert.equal(h.title, 'Edited the notes')
  assert.equal(h.writer, 'api:claude-opus-5-5')
  assert.ok(h.observations.length > 0, 'the cited window is the hour’s evidence')
  assert.deepEqual(s.usage(), [{ kind: 'hour', model: 'claude-opus-5-5', input_tokens: 2000, cost_micro_usd: 2000 * 4 + 300 * 20, ref: `hour:${T0}` }])
  assert.equal(seen.length, 1, 'hours with nothing recorded are not sent')
  await hours.run()
  assert.equal(seen.length, 1, 'a written hour is not written again')
})

test('with no writer nothing is sent and the hour stays as facts', async () => {
  const s = setup()
  const hours = s.hours(T0 + HOUR + WRITE_DELAY_MS)
  await hours.run()
  assert.equal(s.r.storage.hourAt(T0), null)
  assert.deepEqual(s.usage(), [])
})

test('an answer that fails the checks is not stored, is still charged, and is tried again later, three times at most', async () => {
  const s = setup()
  const seen: Packet[] = []
  let now = T0 + HOUR + WRITE_DELAY_MS
  const hours = new HourWriting(s.r.storage, { log: (l) => s.logs.push(l), now: () => now, tz: 'Example/Town' })
  hours.setWriter(writer(seen, () => ({ text: JSON.stringify({ title: 'Shipped the release' }) })))
  await hours.run()
  assert.equal(s.r.storage.hourAt(T0), null)
  assert.equal(s.usage().length, 1)
  assert.match(s.logs.join('\n'), /hour write rejected codes=wrong_keys/)
  await hours.run()
  assert.equal(seen.length, 1, 'not again before the retry is due')
  for (const wait of [5 * MIN, 30 * MIN, 60 * MIN]) {
    now += wait
    await hours.run()
  }
  assert.equal(seen.length, 3)
})

test('a spent balance or rate limit stops writing until it can help, and a new key starts again', async () => {
  const s = setup()
  const seen: Packet[] = []
  const hours = s.hours(T0 + 3 * HOUR)
  hours.setWriter(writer(seen, () => ({ text: null, error: 'credit balance is too low', quota: true, usage: null })))
  await hours.run()
  assert.equal(seen.length, 1, 'the next hour is not tried')
  await hours.run()
  assert.equal(seen.length, 1)
  hours.setWriter(writer(seen))
  await hours.run()
  assert.equal(s.r.storage.hourAt(T0)!.status, 'written')
})

test('an hour the person corrected is left as they wrote it', async () => {
  const s = setup()
  const h = s.r.storage.writeHour({ start_wall_ms: T0, tz: 'Example/Town', status: 'facts' }, s.r.storage.hourBasis(T0))
  s.r.storage.correct(h.id, 'title', 'Planning with Sam')
  const seen: Packet[] = []
  const hours = s.hours(T0 + HOUR + WRITE_DELAY_MS)
  hours.setWriter(writer(seen))
  await hours.run()
  assert.equal(seen.length, 0)
  assert.equal(s.r.storage.hourAt(T0)!.title, 'Planning with Sam')
})

test('an hour whose key is removed while it is being written is not stored, though what it cost is recorded', async () => {
  const s = setup()
  const hours = s.hours(T0 + HOUR + WRITE_DELAY_MS)
  const seen: Packet[] = []
  const inner = writer(seen)
  hours.setWriter({ name: inner.name, write: async (p) => {
    const r = await inner.write(p)
    hours.setWriter(null)
    return r
  } })
  await hours.run()
  assert.equal(s.r.storage.hourAt(T0), null)
  assert.equal(s.usage().length, 1)
})

// An agent turn started at 8:56 with one log record, still running when the hour ends.
function openTurn(r: ReturnType<typeof rig>): AgentStore {
  const agents = new AgentStore(r.store.database)
  const start = T0 + 56 * MIN
  const records: AgentRecord[] = [
    { t: 'session', session: 's1', origin: 'interactive', parent: null, client: null, dir: '/Users/me/Code/alpha', branch: null, at: start },
    { t: 'turn', key: 't1', session: 's1', dir: '/Users/me/Code/alpha', branch: null, opener: 'user', start, replayed: false },
    { t: 'user', key: 't1-u', session: 's1', turn: 't1', act: 'prompt', basis: 'marked', at: start },
    { t: 'activity', key: 't1', session: 's1', at: start + 42_000 },
  ]
  agents.apply('claude_code', records)
  return agents
}
const agentMin = (p: Packet) => p.agents.reduce((n, a) => n + a.with_you_min + a.while_away_min + (a.unknown_min ?? 0), 0)

test('an hour that ends while an agent turn is running waits for its next log record, so the turn counts to the hour end', async () => {
  const s = setup()
  const agents = openTurn(s.r)
  const seen: Packet[] = []
  const runAt = async (now: number) => {
    const hours = s.hours(now)
    hours.setWriter(writer(seen))
    await hours.run()
  }
  await runAt(T0 + HOUR + WRITE_DELAY_MS)
  assert.equal(seen.length, 0, 'not written while the turn has nothing on record past the hour')
  agents.apply('claude_code', [{ t: 'activity', key: 't1', session: 's1', at: T0 + HOUR + 3 * MIN }])
  await runAt(T0 + HOUR + 12 * MIN)
  assert.equal(seen.length, 1)
  assert.equal(agentMin(seen[0]!), 4)
  assert.equal(s.r.storage.hourAt(T0)!.status, 'written')
})

test('an hour waits for a running turn only so long, then is written with what the log shows', async () => {
  const s = setup()
  openTurn(s.r)
  const seen: Packet[] = []
  const runAt = async (now: number) => {
    const hours = s.hours(now)
    hours.setWriter(writer(seen))
    await hours.run()
  }
  await runAt(T0 + HOUR + OPEN_TURN_WAIT_MS - 1)
  assert.equal(seen.length, 0)
  await runAt(T0 + HOUR + OPEN_TURN_WAIT_MS)
  assert.equal(seen.length, 1)
  assert.equal(agentMin(seen[0]!), 0.7)
})
