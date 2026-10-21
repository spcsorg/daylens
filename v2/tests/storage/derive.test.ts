import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONTINUITY_MS, filesOf, hourStart, IntervalBuilder, siteOf, type IntervalRow } from '../../storage/derive.ts'
import { app, focus, line, resetSeq } from '../support/lines.ts'
import { HOUR, MIN, rig, T0, tmpDir } from './support.ts'
import { Store } from '../../capture/store.ts'
import { Normalizer, Privacy } from '../../capture/normalize.ts'

const editor = app('com.example.editor', { name: 'Editor' })
const chat = app('com.example.chat', { name: 'Chat' })

test('local hours follow the offset of the moment, file names and sites come from titles and addresses', () => {
  assert.equal(hourStart(T0 + 59 * MIN, 120), T0)
  assert.equal(hourStart(T0 + 90 * MIN, 120), T0 + HOUR)
  assert.equal(hourStart(T0 + 30 * MIN, 330) % HOUR, 30 * MIN, 'a half-hour zone has hours on the half hour (UTC)')
  assert.equal(filesOf('store.ts — daylens — Cursor'), 'store.ts')
  assert.equal(filesOf('Q3 plan.docx and notes.md'), 'plan.docx notes.md')
  assert.equal(filesOf('Inbox (3) - Mail'), '')
  assert.equal(siteOf('https://www.Example.com/a'), 'example.com')
  assert.equal(siteOf('not a url'), null)
})

test('an interval runs to the next one, but never more than the continuity window past its last sighting, and stops at a lock', () => {
  const out: IntervalRow[] = []
  const b = new IntervalBuilder((i) => out.push(i))
  const row = (id: number, kind: string, t: number, last = t, state: string | null = null) =>
    ({ id, kind, state, event_wall_ms: t, last_seen_wall_ms: last, tz_offset_min: 120, app_id: 'a', app_name: 'A', title: `t${id}`, title_state: 'ok', url: null })
  b.push(row(1, 'focus', T0, T0 + MIN))
  b.push(row(2, 'focus', T0 + 2 * MIN, T0 + 3 * MIN))
  b.push(row(3, 'focus', T0 + 30 * MIN, T0 + 31 * MIN))
  b.push(row(4, 'session', T0 + 32 * MIN, T0 + 32 * MIN, 'locked'))
  b.push(row(5, 'focus', T0 + 40 * MIN))
  b.finish()
  assert.deepEqual(
    out.map((i) => [i.obs_id, i.start_wall_ms - T0, i.end_wall_ms - T0]),
    [
      [1, 0, 2 * MIN],
      [2, 2 * MIN, 3 * MIN + CONTINUITY_MS],
      [3, 30 * MIN, 31 * MIN + MIN],
      [5, 40 * MIN, 40 * MIN],
    ],
  )
})

test('intervals and search documents built as capture flushes equal a rebuild from observations', () => {
  resetSeq()
  const r = rig()
  let t = T0
  for (let i = 0; i < 300; i++) {
    const a = i % 3 === 0 ? chat : editor
    r.feed(focus(a, `item ${i % 17}.md - ${a.name}`, t))
    if (i % 5 === 0) r.feed(focus(a, `item ${i % 17}.md - ${a.name}`, t + 30_000, 'reconcile'))
    if (i % 50 === 49) r.feed(line('session', { state: 'locked', snapshot: false }, t + 40_000))
    t += 50_000 + (i % 7) * 10_000
    if (i % 20 === 0) r.store.flush()
  }
  r.store.flush()
  const snap = () => ({
    intervals: r.q(`SELECT obs_id, start_wall_ms, end_wall_ms, app_id, title, files FROM intervals ORDER BY obs_id`),
    docs: r.q(`SELECT hour_start_wall_ms, app_id, title, files, first_wall_ms, last_wall_ms FROM search_docs ORDER BY hour_start_wall_ms, app_id, title`),
  })
  const incremental = snap()
  assert.ok(incremental.intervals.length > 250 && incremental.docs.length > 20)
  r.storage.derived.rebuild()
  assert.deepEqual(snap(), incremental)
  r.close()
})

test('an interval stops where a capture gap starts', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'a.md - Editor', T0))
  r.feed(focus(editor, 'a.md - Editor', T0 + MIN, 'reconcile'))
  r.store.openGap({ reason: 'helper_crashed', scope: 'all', run: null, start: { wall_ms: T0 + MIN + 10_000, mono_us: null, boot: null }, detail: null })
  r.feed(focus(editor, 'b.md - Editor', T0 + MIN + 30_000))
  r.store.flush()
  assert.deepEqual(r.q(`SELECT end_wall_ms FROM intervals WHERE title = 'a.md - Editor'`), [{ end_wall_ms: T0 + MIN + 10_000 }])
  r.close()
})

test('a long-running activity is searchable in every hour it covers, not only the hour it began', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'marathon-session.md - Editor', T0 + 30 * MIN))
  for (let t = T0 + 31 * MIN; t <= T0 + 2 * HOUR + 10 * MIN; t += MIN) r.feed(focus(editor, 'marathon-session.md - Editor', t, 'reconcile'))
  r.store.flush()
  const hours = r.q<{ h: number }>(`SELECT hour_start_wall_ms AS h FROM search_docs WHERE title LIKE 'marathon%' ORDER BY h`).map((x) => x.h - T0)
  assert.deepEqual(hours, [0, HOUR, 2 * HOUR])
  assert.equal(r.storage.search('marathon', { fromWallMs: T0 + HOUR, toWallMs: T0 + 2 * HOUR }).length, 1, 'found when searching only the second hour')
  r.storage.derived.rebuild()
  assert.deepEqual(r.q<{ h: number }>(`SELECT hour_start_wall_ms AS h FROM search_docs WHERE title LIKE 'marathon%' ORDER BY h`).map((x) => x.h - T0), hours, 'a rebuild gives the same')
  r.close()
})

test('existing capture history is backfilled into intervals and search when storage first opens it', async () => {
  resetSeq()
  const dir = tmpDir()
  const store = new Store(dir, { now: () => T0 })
  const n = new Normalizer(store, new Privacy(store.exclusions()))
  for (let i = 0; i < 120; i++) n.handle(focus(i % 2 ? editor : chat, `history ${i}.md - x`, T0 + i * 30_000))
  store.close()
  const r = rig(dir)
  r.storage.start()
  await r.storage.derivationSettled()
  const got = r.q(`SELECT obs_id, start_wall_ms, end_wall_ms FROM intervals ORDER BY obs_id`)
  assert.equal(got.length, 120)
  assert.equal(r.storage.search('history').length, 50)
  r.storage.derived.rebuild()
  assert.deepEqual(r.q(`SELECT obs_id, start_wall_ms, end_wall_ms FROM intervals ORDER BY obs_id`), got)
  r.close()
})

test('rows committed by capture but not yet derived when the service died are derived at the next start', async () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'derived.md - Editor', T0))
  r.store.flush()
  // The service dies after capture commits and before derivation runs.
  r.store.onFlushed = () => {}
  r.feed(focus(chat, 'Crashed before derive', T0 + MIN))
  r.feed(focus(editor, 'derived.md - Editor', T0 + 2 * MIN))
  r.store.flush()
  r.close()
  const r2 = rig(r.dir)
  r2.storage.start()
  await r2.storage.derivationSettled()
  assert.equal(r2.storage.search('crashed').length, 1)
  const got = r2.q(`SELECT obs_id, start_wall_ms, end_wall_ms FROM intervals ORDER BY obs_id`)
  r2.storage.derived.rebuild()
  assert.deepEqual(r2.q(`SELECT obs_id, start_wall_ms, end_wall_ms FROM intervals ORDER BY obs_id`), got)
  r2.close()
})

test('derivation reads observations through the time index, not by scanning the table', () => {
  const r = rig()
  const plan = (r.store.database.prepare(`EXPLAIN QUERY PLAN ${r.storage.derived.pageSql()}`).all(0, 0, 0) as { detail: string }[]).map((p) => p.detail)
  assert.ok(plan.some((d) => d.startsWith('SEARCH observations USING INDEX observations_event_wall')), plan.join('; '))
  assert.ok(!plan.some((d) => d.startsWith('SCAN observations')), plan.join('; '))
  r.close()
})

test('re-deriving a row rewrites every field of its interval, not just its times', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(chat, 'old private title', T0))
  r.store.flush()
  const id = r.q<{ id: number }>(`SELECT id FROM observations WHERE kind = 'focus'`)[0]!.id
  r.store.database.prepare(`UPDATE observations SET app_id = 'com.example.editor', app_name = 'Editor', title = 'new.md - Editor' WHERE id = ?`).run(id)
  r.store.database.prepare(`INSERT INTO meta (key, value) VALUES ('derive_from', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(String(T0))
  r.storage.derived.refreshFromMark()
  assert.deepEqual(r.q(`SELECT app_id, app_name, title, files FROM intervals WHERE obs_id = ?`, id), [{ app_id: 'com.example.editor', app_name: 'Editor', title: 'new.md - Editor', files: 'new.md' }])
  r.close()
})

test('browser pages from the extension divide the browser time into intervals per page, searchable by title and address', () => {
  const out: IntervalRow[] = []
  const b = new IntervalBuilder((i) => out.push(i))
  const row = (id: number, kind: string, t: number, last: number, o: Partial<{ app_id: string; state: string; title: string; url: string }> = {}) =>
    ({ id, kind, state: o.state ?? null, event_wall_ms: t, last_seen_wall_ms: last, tz_offset_min: 120, app_id: o.app_id ?? 'com.google.chrome', app_name: 'Browser', title: o.title ?? null, title_state: o.title ? 'ok' : null, url: o.url ?? null })
  b.push(row(1, 'focus', T0, T0 + 9 * MIN))
  b.push(row(2, 'page', T0 + MIN, T0 + MIN, { state: 'normal', title: 'Budget sheet', url: 'https://docs.example.com/d/1' }))
  b.push(row(3, 'page', T0 + 3 * MIN, T0 + 3 * MIN, { state: 'normal', title: 'Flights', url: 'https://travel.example.org/q' }))
  b.push(row(4, 'page', T0 + 4 * MIN, T0 + 4 * MIN, { state: 'normal', app_id: 'com.other.browser', title: 'Not in front', url: 'https://x.example/' }))
  b.push(row(5, 'page', T0 + 5 * MIN, T0 + 5 * MIN, { state: 'unknown' }))
  b.push(row(6, 'focus', T0 + 8 * MIN, T0 + 9 * MIN, { app_id: 'com.apple.notes', title: 'Groceries' }))
  b.push(row(7, 'page', T0 + 8 * MIN + 1000, T0 + 8 * MIN + 1000, { state: 'normal', title: 'Behind notes', url: 'https://y.example/' }))
  b.finish()
  assert.deepEqual(
    out.map((i) => [i.obs_id, (i.start_wall_ms - T0) / MIN, (i.end_wall_ms - T0) / MIN, i.app_id, i.title, i.url]),
    [
      [1, 0, 1, 'com.google.chrome', null, null],
      [2, 1, 3, 'com.google.chrome', 'Budget sheet', 'https://docs.example.com/d/1'],
      [3, 3, 5, 'com.google.chrome', 'Flights', 'https://travel.example.org/q'],
      [5, 5, 8, 'com.google.chrome', null, null],
      [6, 8, 9, 'com.apple.notes', 'Groceries', null],
    ],
  )
  assert.equal(out[1]!.site, 'docs.example.com')
})

test('pages captured by the extension reach intervals and search through storage', () => {
  const r = rig()
  const page = (t: number, title: string | null, url: string | null, state = 'normal') =>
    ({ run: 'ext', seq: 0, boot: 'b', platform: 'macos' as const, source: 'browser_ext', kind: 'page' as const, event_wall_ms: t, event_mono_us: t * 1000, tz: 'Africa/Kigali',
      tz_offset_min: 120, app_id: 'com.google.Chrome', app_name: 'Google Chrome', app_path: null, pid: 500, window: 'ext:1', title, title_raw: null, title_state: title ? ('ok' as const) : null, state, detail: null, url })
  const chrome = app('com.google.Chrome', { pid: 500, registered_browser: true, engine: 'browser', name: 'Google Chrome' })
  r.feed(focus(chrome, null, T0, 'app_changed'))
  r.store.insertObservation(page(T0 + MIN, 'Quarterly budget review', 'https://docs.example.com/d/1'))
  // The helper's reconciliation sights the browser in front every minute.
  r.feed(focus(chrome, null, T0 + 2 * MIN, 'reconcile'))
  r.store.insertObservation(page(T0 + 3 * MIN, null, null, 'unknown'))
  r.feed(focus(chrome, null, T0 + 3 * MIN + 30_000, 'reconcile'))
  r.feed(focus(editor, 'notes.md', T0 + 4 * MIN, 'app_changed'))
  r.store.flush()
  const iv = r.q<{ title: string | null; url: string | null; start_wall_ms: number; end_wall_ms: number }>(`SELECT title, url, start_wall_ms, end_wall_ms FROM intervals WHERE app_id = 'com.google.Chrome' ORDER BY start_wall_ms`)
  assert.deepEqual(iv.map((i) => [i.title, i.url, (i.start_wall_ms - T0) / MIN, (i.end_wall_ms - T0) / MIN]), [
    [null, null, 0, 1],
    ['Quarterly budget review', 'https://docs.example.com/d/1', 1, 3],
    [null, null, 3, 4],
  ])
  assert.deepEqual(r.storage.search('budget review').map((h) => h.url), ['https://docs.example.com/d/1'])
  r.close()
})
