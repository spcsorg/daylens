import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeletedMaterialError, StaleHourError } from '../../storage/index.ts'
import { app, focus, resetSeq } from '../support/lines.ts'
import { HOUR, MIN, rig, T0 } from './support.ts'

const editor = app('com.example.editor', { name: 'Editor' })

test('thread ids belong to the database and are never handed out again', () => {
  const r = rig()
  const h = r.storage.writeHour({ start_wall_ms: T0, tz: 'Africa/Kigali', status: 'facts' }, r.storage.hourBasis(T0))
  const a = r.storage.createThread('Billing', [h.id])
  const b = r.storage.createThread('Hiring')
  r.storage.deleteThread(b)
  const c = r.storage.createThread('Launch')
  assert.ok(c > b && b > a, `${a} ${b} ${c}`)
  assert.deepEqual(r.storage.threadsForHour(h.id), [{ id: a, title: 'Billing' }])
  r.close()
})

test('an hour keeps one row and counts its versions; facts and written are the only statuses', () => {
  const r = rig()
  const h1 = r.storage.writeHour({ start_wall_ms: T0, tz: 'Africa/Kigali', status: 'facts' }, r.storage.hourBasis(T0))
  const h2 = r.storage.writeHour({ start_wall_ms: T0, tz: 'Africa/Kigali', status: 'written', title: 'Shipped', writer: 'm' }, r.storage.hourBasis(T0))
  assert.equal(h1.id, h2.id)
  assert.deepEqual([h1.version, h2.version, h2.status], [1, 2, 'written'])
  assert.throws(() => r.storage.writeHour({ start_wall_ms: T0 + HOUR, tz: 'x', status: 'draft' as 'facts' }, r.storage.hourBasis(T0 + HOUR)))
  r.close()
})

test('an hour that would draw on deleted material is refused', async () => {
  const r = rig()
  r.clock.t = T0 + 3 * HOUR
  await r.storage.deleteRange(T0, T0 + HOUR).done
  await r.storage.deleteSource('com.example.chat').done
  assert.throws(() => r.storage.writeHour({ start_wall_ms: T0, tz: 'z', status: 'facts' }, r.storage.hourBasis(T0)), DeletedMaterialError)
  assert.throws(() => r.storage.writeHour({ start_wall_ms: T0 + HOUR, tz: 'z', status: 'written', title: 'x', sources: [{ app_id: 'com.example.chat' }] }, r.storage.hourBasis(T0 + HOUR)), DeletedMaterialError)
  assert.ok(r.storage.writeHour({ start_wall_ms: T0 + HOUR, tz: 'z', status: 'written', title: 'x', sources: [{ app_id: 'com.example.editor' }] }, r.storage.hourBasis(T0 + HOUR)))
  r.close()
})

test('settings, AI choice, plan, usage and pause are each written once and announced', () => {
  const r = rig()
  const seen: string[] = []
  r.storage.bus.on((c) => seen.push(c.kind))
  r.storage.setAiChoice({ provider: 'off' })
  r.storage.setRetentionDays(365)
  r.storage.setPlan({ plan: 'pro', status: 'active', confirmed_wall_ms: T0 })
  r.storage.recordUsage({ kind: 'answer', provider: 'anthropic', model: 'm', input_tokens: 10, output_tokens: 5, cost_micro_usd: 120 })
  r.storage.recordUsage({ kind: 'hour', provider: 'anthropic', model: 'm', input_tokens: 10, output_tokens: 5, cost_micro_usd: 80 })
  r.storage.pause(T0 + HOUR)
  r.storage.resume()
  r.storage.addExclusion({ match: 'app_id', value: 'x.y', label: 'X' })
  assert.deepEqual(seen, ['ai_choice', 'retention', 'plan', 'usage', 'usage', 'pause', 'pause', 'exclusion'])
  assert.deepEqual(r.storage.getSetting('ai_choice'), { provider: 'off' })
  assert.equal(r.storage.plan()!.plan, 'pro')
  assert.deepEqual(r.storage.usageTotals(0, T0 + 1), { answers: 1, hours: 1, cost_micro_usd: 200 })
  assert.equal(r.q(`SELECT 1 FROM change_log WHERE payload LIKE '%x.y%'`).length, 0, 'announcements carry no content')
  r.close()
})

test('search matches words and prefixes in titles, file names and hour text, newest material included', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'quarterly-report.docx - Editor', T0))
  r.feed(focus(editor, 'Résumé draft - Editor', T0 + MIN))
  r.store.flush()
  r.storage.writeHour({ start_wall_ms: T0, tz: 'Africa/Kigali', status: 'written', title: 'Reviewed the onboarding funnel' }, r.storage.hourBasis(T0))
  assert.equal(r.storage.search('quarterly').length, 1)
  assert.equal(r.storage.search('quarterly-report.docx').length, 1)
  assert.equal(r.storage.search('resume').length, 1, 'diacritics fold')
  assert.equal(r.storage.search('onboard').length, 1, 'the last word matches as a prefix')
  assert.equal(r.storage.search('funnel onboarding')[0]!.kind, 'hour')
  assert.deepEqual(r.storage.search('"; DROP TABLE x; --'), [], 'query syntax from the user is never passed through')
  r.close()
})

test('retention prunes in short batches and refuses material older than the window', async () => {
  resetSeq()
  const r = rig()
  for (let d = 0; d < 10; d++) {
    for (let i = 0; i < 300; i++) r.feed(focus(editor, `daytag${d} item ${i}.md - Editor`, T0 + d * 24 * HOUR + i * 20_000))
  }
  r.store.flush()
  r.clock.t = T0 + 10 * 24 * HOUR
  r.storage.setRetentionDays(5)
  r.storage.stop()
  let batches = 0
  let worst = 0
  for (;;) {
    const t = performance.now()
    const n = r.storage.pruneBatch(500)
    worst = Math.max(worst, performance.now() - t)
    if (n === 0) break
    batches++
  }
  assert.ok(batches > 2, `pruned in ${batches} batches`)
  assert.ok(worst < 250, `longest batch ${worst.toFixed(1)} ms`)
  const cutoff = r.clock.t - 5 * 24 * HOUR
  assert.deepEqual(r.q(`SELECT 1 FROM observations WHERE event_wall_ms < ? LIMIT 1`, cutoff), [])
  assert.deepEqual(r.q(`SELECT 1 FROM intervals WHERE start_wall_ms < ? LIMIT 1`, cutoff), [])
  assert.deepEqual(r.storage.search('daytag2'), [])
  assert.ok(r.storage.search('daytag7').length > 0)
  r.feed(focus(editor, 'backdated.md - Editor', cutoff - MIN))
  assert.deepEqual(r.q(`SELECT 1 FROM observations WHERE title = 'backdated.md - Editor'`), [])
  r.close()
})

test('pruned material leaves the file too, after the background merge', async () => {
  resetSeq()
  const r = rig()
  const term = 'zqxjoldcanary'
  r.feed(focus(editor, `Notes ${term.toUpperCase()}`, T0))
  let t = T0 + MIN
  for (let i = 0; i < 3000; i++) {
    r.feed(focus(editor, `filler ${i} ${'lorem ipsum dolor '.repeat(3)}`, t + 3 * 24 * HOUR))
    t += 20_000
    if (i % 100 === 0) r.store.flush()
  }
  r.store.flush()
  r.store.database.pragma('wal_checkpoint(TRUNCATE)')
  const { diskContains } = await import('./support.ts')
  assert.deepEqual(diskContains(r.dir, term), ['daylens-v2.sqlite'])
  r.clock.t = T0 + 5 * 24 * HOUR
  r.storage.setRetentionDays(2)
  r.storage.stop()
  await r.storage.prune()
  assert.deepEqual(r.storage.search(term), [])
  assert.deepEqual(diskContains(r.dir, term), [])
  r.close()
})

test('composed and decomposed accents match each other in search, whichever form the title or the query uses', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'Résumé draft - Editor', T0))
  r.feed(focus(editor, 'Café menu - Editor', T0 + MIN))
  r.store.flush()
  for (const q of ['résumé', 'résumé', 'resume']) assert.equal(r.storage.search(q).length, 1, `query ${JSON.stringify(q)} finds the decomposed title`)
  for (const q of ['café', 'café', 'cafe']) assert.equal(r.storage.search(q).length, 1, `query ${JSON.stringify(q)} finds the composed title`)
  r.close()
})

test('an hour computed before a deletion inside it cannot be written back', async () => {
  const r = rig()
  const basis = r.storage.hourBasis(T0)
  const original = { start_wall_ms: T0, tz: 'Africa/Kigali', status: 'written' as const, title: 'Planned the Narwhal canary launch' }
  const h = r.storage.writeHour(original, basis)
  r.clock.t = T0 + 2 * HOUR
  await r.storage.deleteRange(T0 + 10 * MIN, T0 + 20 * MIN).done
  assert.throws(() => r.storage.writeHour(original, basis), StaleHourError)
  assert.deepEqual(r.storage.search('narwhal'), [])
  assert.equal(r.storage.hour(h.id)!.needs_rewrite, true)
  assert.throws(() => r.storage.writeHour(original, { version: 1, deletion: r.storage.hourBasis(T0).deletion }), StaleHourError, 'an old version is refused too')
  const fresh = r.storage.writeHour({ ...original, title: 'Planned the launch' }, r.storage.hourBasis(T0))
  assert.equal(fresh.needs_rewrite, false)
  r.close()
})

test('a retention change is in force by the time it is announced', () => {
  const r = rig()
  r.clock.t = T0 + 30 * 24 * HOUR
  const seen: boolean[] = []
  r.storage.bus.on((c) => c.kind === 'retention' && seen.push(r.storage.accepts(T0, 'com.example.editor', null)))
  r.storage.setRetentionDays(7)
  r.storage.stop()
  assert.deepEqual(seen, [false], 'material older than the new window is already refused')
  r.close()
})
