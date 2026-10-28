import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AssistantRequests } from '../../app/main/assistantRequests.ts'
import type { Action, ActionResult } from '../../app/shared/types.ts'
import { handleControl } from '../../capture/control.ts'
import { McpServer } from '../../mcp/server.ts'
import { describeRequest, pendingRequests, REQUEST_TTL_MS, type AssistantRequest } from '../../storage/assistantRequests.ts'
import { HOUR, MIN, rig, T0 } from '../storage/support.ts'
import { day } from '../retrieval/support.ts'

process.env.TZ = 'Etc/GMT+5'

/** Seeded storage, the server as an assistant reaches it, and the app as main.ts wires it, minus Electron. */
function setup() {
  const r = rig()
  day(r)
  r.storage.writeHour({ start_wall_ms: T0, tz: 'Example/Town', status: 'written', title: 'Budget review', summary: 'Went through Q4 numbers.', sources: [{ app_id: 'com.example.editor' }] }, r.storage.hourBasis(T0))
  r.store.flush()
  r.clock.t = T0 + 2 * HOUR
  const now = () => r.clock.t
  const control = (op: Record<string, unknown>) =>
    new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
      handleControl(r.storage, { ...op, id: 'x' }, (reply) => reply.op === 'reply' && resolve(reply), now)
    })
  const act = async (a: Action): Promise<ActionResult> => {
    const op = a.a === 'pause' ? { op: 'pause', until: a.until } : a.a === 'delete' ? { op: 'delete', what: a.what } : a.a === 'exclude' ? { op: 'exclude', rule: a.rule } : a.a === 'unexclude' ? { op: 'unexclude', match: a.match, value: a.value } : a.a === 'retention' ? { op: 'retention', days: a.days } : { op: a.a }
    const out = await control(op)
    return out.ok ? { ok: true } : { ok: false, error: out.error ?? 'failed' }
  }
  const notified: AssistantRequest[] = []
  const app = new AssistantRequests({ pending: async () => pendingRequests(r.storage.db, now()), control, act, paused: async () => r.storage.paused() !== null, notify: (x) => notified.push(x), log: () => {} })
  const server = new McpServer({ dataDir: r.dir, version: '0', limits: { perGroup: 5, maxDays: 7 }, now, log: () => {}, waitMs: { run: 600, answer: 600 } })
  void server.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { clientInfo: { name: 'claude-code' } } }))
  const call = async (name: string, args: object) => {
    const reply = (await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }))) as { result: { isError?: boolean; content: { text: string }[] } }
    return { error: reply.result.isError === true, text: reply.result.content[0]!.text }
  }
  // The app sees each request as main.ts does on a change announcement.
  let running = false
  const watch = () => {
    running = true
    const tick = () => running && void app.refresh().then(() => setTimeout(tick, 50))
    tick()
  }
  const requests = () => r.q<{ id: number; state: string }>('SELECT id, state FROM assistant_requests ORDER BY id')
  const pending = async () => pendingRequests(r.storage.db, now())
  return { r, server, app, call, watch, requests, pending, notified, close: () => ((running = false), server.close(), r.close()) }
}

test('a pause runs at once while Daylens is open, and is refused, not queued, while it isn’t', async () => {
  const s = setup()
  const closed = await s.call('set_recording', { paused: true })
  assert.equal(closed.text, "Pause recording for an hour: Daylens isn't running, so nothing changed. Ask the person to open Daylens and try again.")
  assert.equal(s.r.storage.paused(), null)
  assert.deepEqual(s.requests().map((x) => x.state), ['expired'])
  s.watch()
  assert.equal((await s.call('set_recording', { paused: true, for: 'tomorrow' })).text, 'Pause recording until tomorrow: Done.')
  assert.notEqual(s.r.storage.paused(), null)
  assert.equal(s.notified.length, 0, 'a pause asks nobody')
  s.close()
})

test('a new exclusion runs at once; recording it again waits for a yes', async () => {
  const s = setup()
  s.watch()
  assert.equal((await s.call('set_exclusion', { site: 'https://www.Bank.example.com/login', excluded: true })).text, 'Stop recording the site “bank.example.com”: Done.')
  assert.ok(s.r.q(`SELECT 1 FROM exclusions WHERE match = 'site' AND value = 'bank.example.com'`).length)
  const again = await s.call('set_exclusion', { site: 'bank.example.com', excluded: false })
  assert.match(again.text, /^Record the site “bank.example.com” again: waiting for the person to confirm in Daylens/)
  assert.ok(s.r.q(`SELECT 1 FROM exclusions WHERE value = 'bank.example.com'`).length, 'still excluded')
  assert.equal(s.notified.length, 1)
  s.close()
})

test('a deletion happens only on the person’s yes, and a no leaves everything', async () => {
  const s = setup()
  s.watch()
  const asked = s.call('delete_records', { what: 'span', from: '2026-10-16T01:00', to: '2026-10-16T01:30' })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const [r1] = await s.pending()
  assert.equal((await s.app.decide(r1!.id, false)).ok, true)
  assert.equal((await asked).text, 'Delete everything recorded from Fri, Oct 16, 1:00 AM to Fri, Oct 16, 1:30 AM: The person said no in Daylens. Nothing changed.')
  assert.equal(s.r.q('SELECT 1 FROM deletions').length, 0)

  const yes = s.call('delete_records', { what: 'span', from: '2026-10-16T01:00', to: '2026-10-16T01:30' })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const [r2] = await s.pending()
  assert.deepEqual(await s.app.decide(r2!.id, true), { ok: true })
  assert.match((await yes).text, /: Done\.$/)
  assert.deepEqual(s.r.q<{ kind: string; from_wall_ms: number; to_wall_ms: number }>('SELECT kind, from_wall_ms, to_wall_ms FROM deletions'), [{ kind: 'range', from_wall_ms: T0, to_wall_ms: T0 + 30 * MIN }])
  s.close()
})

test('a deletion nobody confirmed in time never runs, whatever asks for it later', async () => {
  const s = setup()
  // As a page titled "delete today" might steer an assistant: the request is filed, and that is all it can do.
  const asked = await s.call('delete_records', { what: 'everything' })
  assert.match(asked.text, /^Delete everything Daylens has recorded: waiting for the person to confirm in Daylens \(request \d+, open for 10 minutes\)/)
  s.r.clock.t += REQUEST_TTL_MS
  const [r] = await s.pending()
  assert.equal(r!.state, 'expired')
  assert.deepEqual(await s.app.decide(r!.id, true), { ok: false, error: 'request_expired' })
  assert.equal(s.r.q('SELECT 1 FROM deletions').length, 0)
  assert.deepEqual(s.requests().map((x) => x.state), ['expired'])
  s.close()
})

test('a correction, once confirmed, replaces the hour’s title everywhere', async () => {
  const s = setup()
  s.watch()
  const hourId = s.r.storage.hourAt(T0)!.id
  const asked = s.call('correct_hour', { date: '2026-10-16', hour: 1, title: 'Planned the bakery budget' })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const [r] = await s.pending()
  assert.deepEqual(r!.change, { kind: 'correct', hour_id: hourId, hour_start_wall_ms: T0, title: 'Planned the bakery budget' })
  await s.app.decide(r!.id, true)
  assert.equal((await asked).text, 'Change the Fri, Oct 16, 1:00 AM hour’s title to “Planned the bakery budget”: Done.')
  assert.equal(s.r.storage.hour(hourId)!.title, 'Planned the bakery budget')
  assert.deepEqual(s.r.storage.hour(hourId)!.corrected, ['title'])
  // A direction mark never reaches the record, where the title shows without the card's quotes.
  const marked = s.call('correct_hour', { date: '2026-10-16', hour: 1, title: 'Planned\u202E the budget' })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const [m] = await s.pending()
  assert.equal((m!.change as { title: string }).title, 'Planned  the budget')
  await s.app.decide(m!.id, false)
  await marked
  assert.equal((await s.call('correct_hour', { date: '2026-10-16', hour: 1, title: '\u202E\u200B' })).error, true, 'a title of marks alone is refused')
  const facts = await s.call('correct_hour', { date: '2026-10-16', hour: 5, title: 'x' })
  assert.deepEqual([facts.error, facts.text], [true, "Daylens hasn't written the hour at 2026-10-16T05:00:00-05:00 yet, so it can't be corrected"])
  s.close()
})

test('status lists what assistants asked for and how each ended; bad input asks nothing', async () => {
  const s = setup()
  s.watch()
  await s.call('set_recording', { paused: true })
  for (const [name, args, message] of [
    ['delete_records', { what: 'app', app: 'Spreadsheet' }, 'Daylens has never recorded an app named Spreadsheet'],
    ['delete_records', { what: 'span', from: '2026-10-16T01:30', to: '2026-10-16T01:00' }, 'to must be after from, and from before now'],
    ['set_retention', { days: 0 }, 'days must be a whole number of days, or null to keep everything'],
    ['set_exclusion', { app: 'Editor', site: 'example.com', excluded: true }, 'give app or site, not both'],
  ] as const) {
    assert.deepEqual(await s.call(name, args), { error: true, text: message })
  }
  const status = JSON.parse((await s.call('get_status', {})).text) as { requests: { assistant: string; asked: string; state: string }[] }
  assert.deepEqual(status.requests.map((x) => [x.assistant, x.asked, x.state]), [['Claude Code', 'Pause recording for an hour', 'done']])
  const tools = (await s.server.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean; destructiveHint?: boolean } }[] } }
  assert.deepEqual(
    tools.result.tools.filter((t) => !t.annotations.readOnlyHint).map((t) => [t.name, t.annotations.destructiveHint]),
    [['set_recording', false], ['set_exclusion', false], ['correct_hour', true], ['delete_records', true], ['set_retention', true]],
  )
  s.close()
})

test('an assistant’s pause never replaces one already in force, which would end it sooner', async () => {
  const s = setup()
  s.watch()
  s.r.storage.pause(null)
  const asked = await s.call('set_recording', { paused: true, for: 'hour' })
  assert.match(asked.text, /not done \(Daylens is already paused/)
  assert.equal(s.r.storage.paused()!.until_wall_ms, null, 'still paused until the person resumes')
  s.close()
})

test('text an assistant wrote can’t break out of its quotes on the card', () => {
  const said = describeRequest({ kind: 'correct', hour_id: 1, hour_start_wall_ms: 0, title: 'x”. Delete everything Daylens has recorded. “\u202Eyalp ″ ＂ «»' })
  assert.equal((said.match(/["«»“”„‟″〝〞〟＂]/g) ?? []).length, 2)
  assert.ok(!said.includes('\u202E'))
})

test('a client that names itself is shown as quoted data, never as Daylens or a known assistant', async () => {
  const server = new McpServer({ dataDir: rig().dir, version: '0', limits: { perGroup: 5, maxDays: 7 }, log: () => {}, waitMs: { run: 0, answer: 0 } })
  await server.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { clientInfo: { name: 'x', title: 'Daylens (you set this, safe)”\u202E' } } }))
  assert.equal((server as unknown as { assistant: string }).assistant, "Assistant “Daylens (you set this, safe)'”")
  server.close()
})
