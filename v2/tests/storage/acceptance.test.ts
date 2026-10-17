// Storage-level acceptance tests for the promises in docs/testing.md: deletion reaches everything, a correction
// wins, pause is exact, exclusions apply before storage, and a re-import after deletion brings nothing back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import path from 'node:path'
import { DB_FILE } from '../../capture/store.ts'
import type { ObservationRow } from '../../capture/normalize.ts'
import { ChangeWatcher } from '../../storage/changes.ts'
import { readHour } from '../../storage/index.ts'
import { app, focus, line, resetSeq } from '../support/lines.ts'
import { diskContains, HOUR, MIN, rig, T0 } from './support.ts'

type R = ReturnType<typeof rig>

const editor = app('com.example.editor', { name: 'Editor' })
const chat = app('com.example.chat', { name: 'Chat' })

function containsAnywhere(r: R, needle: string): string[] {
  const where: string[] = []
  const like = `%${needle}%`
  const checks: [string, string][] = [
    ['observations', `SELECT count(*) AS n FROM observations WHERE title LIKE ? OR title_raw LIKE ? OR app_id LIKE ? OR app_name LIKE ?`],
    ['intervals', `SELECT count(*) AS n FROM intervals WHERE title LIKE ? OR url LIKE ? OR app_id LIKE ? OR app_name LIKE ?`],
    ['search_docs', `SELECT count(*) AS n FROM search_docs WHERE title LIKE ? OR url LIKE ? OR hour_text LIKE ? OR app_name LIKE ?`],
    ['hours', `SELECT count(*) AS n FROM hours WHERE title LIKE ? OR summary LIKE ? OR detail LIKE ? OR sources LIKE ?`],
    ['corrections', `SELECT count(*) AS n FROM corrections WHERE text LIKE ? OR text LIKE ? OR text LIKE ? OR text LIKE ?`],
    ['assistant_reads', `SELECT count(*) AS n FROM assistant_reads WHERE query LIKE ? OR query LIKE ? OR query LIKE ? OR query LIKE ?`],
    ['change_log', `SELECT count(*) AS n FROM change_log WHERE payload LIKE ? OR payload LIKE ? OR payload LIKE ? OR payload LIKE ?`],
  ]
  for (const [table, sql] of checks) if (r.q<{ n: number }>(sql, like, like, like, like)[0]!.n > 0) where.push(table)
  if (r.storage.search(needle).length > 0) where.push('search')
  where.push(...diskContains(r.dir, needle).map((f) => `disk:${f}`))
  return where
}

function day(r: R, startWall: number, items: [ReturnType<typeof app>, string][], stepMs = 5 * MIN): number {
  let t = startWall
  for (const [a, title] of items) {
    r.feed(focus(a, title, t))
    r.feed(focus(a, title, t + stepMs - 1000, 'reconcile'))
    t += stepMs
  }
  return t
}

test('deletion reaches everything: a range is gone from observations, intervals, hours, search, assistant reads and the file on disk', () => {
  resetSeq()
  const r = rig()
  day(r, T0, [
    [editor, 'keep-before.md - Editor'],
    [chat, 'Zanzibar canary plan'],
    [editor, 'Zanzibar canary draft.md - Editor'],
    [editor, 'keep-after.md - Editor'],
  ])
  r.store.flush()
  const inRange = { from: T0 + 5 * MIN, to: T0 + 15 * MIN }
  const hour = r.storage.writeHour({ start_wall_ms: T0, tz: 'Africa/Kigali', status: 'written', title: 'Planned the Zanzibar canary', sources: [{ app_id: 'com.example.chat' }] })
  r.storage.correct(hour.id, 'summary', 'Zanzibar canary, corrected by me')
  r.storage.recordAssistantRead({ assistant: 'claude', tool: 'getDay', from_wall_ms: inRange.from, to_wall_ms: inRange.to, query: 'what about Zanzibar canary?' })
  assert.ok(containsAnywhere(r, 'Zanzibar').length > 3, 'the canary is present before deletion')

  const res = r.storage.deleteRange(inRange.from, inRange.to)
  assert.ok(res.observations >= 2 && res.intervals >= 2 && res.hoursCleared === 1 && res.assistantReads === 1, JSON.stringify(res))
  assert.deepEqual(containsAnywhere(r, 'Zanzibar'), [])
  assert.equal(r.storage.search('keep before').length, 1, 'material outside the range is still searchable')
  assert.equal(r.storage.search('keep after').length, 1)
  const h = r.storage.hour(hour.id)!
  assert.equal(h.needs_rewrite, true)
  assert.equal(h.title, null)
  assert.equal(r.q(`SELECT 1 FROM intervals WHERE end_wall_ms > ? AND start_wall_ms < ?`, inRange.from, inRange.to).length, 0, 'no interval covers the deleted range')
  r.close()
  assert.deepEqual(diskContains(r.dir, 'Zanzibar'), [], 'nothing on disk after close either')
})

test('deletion reaches everything: one app, across days, and the hours that drew on it', () => {
  resetSeq()
  const r = rig()
  day(r, T0, [[chat, 'Quokka canary thread'], [editor, 'notes.md - Editor']])
  day(r, T0 + 24 * HOUR, [[chat, 'Quokka canary again'], [editor, 'todo.md - Editor']])
  r.store.flush()
  const h1 = r.storage.writeHour({ start_wall_ms: T0, tz: 'Africa/Kigali', status: 'written', title: 'Quokka chat', sources: [{ app_id: 'com.example.chat' }, { app_id: 'com.example.editor' }] })
  const h2 = r.storage.writeHour({ start_wall_ms: T0 + 2 * HOUR, tz: 'Africa/Kigali', status: 'written', title: 'Editing only', sources: [{ app_id: 'com.example.editor' }] })
  r.storage.recordAssistantRead({ assistant: 'claude', tool: 'search', from_wall_ms: T0, to_wall_ms: T0 + 48 * HOUR, query: 'time in Chat this week' })

  r.storage.deleteSource('com.example.chat')
  assert.deepEqual(containsAnywhere(r, 'Quokka'), [])
  // The tombstone keeps the app id so a re-import can be refused; nothing else does.
  assert.deepEqual(containsAnywhere(r, 'com.example.chat').filter((w) => !w.startsWith('disk:')), [])
  assert.equal(r.q(`SELECT 1 FROM assistant_reads`).length, 0, 'the read that asked about Chat by name is gone')
  assert.equal(r.storage.hour(h1.id)!.needs_rewrite, true)
  assert.deepEqual(r.storage.hour(h1.id)!.sources, [{ app_id: 'com.example.editor' }])
  assert.equal(r.storage.hour(h2.id)!.title, 'Editing only', 'hours that never used the app keep their text')
  assert.equal(r.storage.search('todo').length, 1)
  r.close()
})

test('deletion reaches everything: a site and its subdomains, once page addresses are captured', () => {
  resetSeq()
  const r = rig()
  // The browser step adds this column; deletion and search already use it when present.
  r.store.database.exec('ALTER TABLE observations ADD COLUMN url TEXT')
  r.close()
  const r2 = rig(r.dir)
  const rows = [
    ['https://www.secret-bank.example/accounts', 'Wombat canary balance'],
    ['https://login.secret-bank.example/', 'Wombat canary login'],
    ['https://docs.example.org/guide', 'Public guide'],
  ].map(([url, title], i) => obsRow(T0 + i * MIN, 'com.apple.Safari', title!, url!))
  assert.equal(r2.storage.importObservations(rows).imported, 3)
  // Capture writes the address on the browser branch; here it is filled in and derived state rebuilt.
  for (const row of rows) r2.store.database.prepare('UPDATE observations SET url = ? WHERE title = ?').run(row.url, row.title)
  r2.storage.derived.rebuild()
  assert.equal(r2.storage.search('wombat').length, 2)
  assert.equal(r2.storage.search('secret bank').length, 2, 'addresses are searchable')

  r2.storage.deleteSite('secret-bank.example')
  assert.deepEqual(containsAnywhere(r2, 'Wombat'), [])
  assert.deepEqual(containsAnywhere(r2, 'secret-bank').filter((w) => !w.startsWith('disk:')), [])
  assert.equal(r2.storage.search('public guide').length, 1)
  assert.equal(r2.storage.importObservations(rows).imported, 1, 'a re-import brings back only the other site')
  r2.close()
})

test('delete the last ten minutes is one call; an open row keeps only its part before, and capture continues after', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'long-running.md - Editor', T0))
  for (let t = T0 + MIN; t <= T0 + 30 * MIN; t += MIN) r.feed(focus(editor, 'long-running.md - Editor', t, 'reconcile'))
  r.feed(focus(chat, 'Numbat canary', T0 + 25 * MIN))
  r.feed(focus(chat, 'Numbat canary', T0 + 30 * MIN, 'reconcile'))
  r.clock.t = T0 + 30 * MIN
  r.storage.deleteLast(10 * MIN)
  assert.deepEqual(containsAnywhere(r, 'Numbat'), [])
  const kept = r.q<{ title: string; last_seen_wall_ms: number }>(`SELECT title, last_seen_wall_ms FROM observations WHERE kind = 'focus'`)
  assert.deepEqual(kept, [{ title: 'long-running.md - Editor', last_seen_wall_ms: T0 + 20 * MIN }])

  // The helper keeps reporting the same window: a fresh row starts after the deletion, the old one is not extended.
  r.feed(focus(editor, 'long-running.md - Editor', T0 + 31 * MIN, 'reconcile'))
  r.store.flush()
  const rows = r.q<{ event_wall_ms: number; last_seen_wall_ms: number }>(`SELECT event_wall_ms, last_seen_wall_ms FROM observations WHERE kind = 'focus' ORDER BY id`)
  assert.deepEqual(rows, [
    { event_wall_ms: T0, last_seen_wall_ms: T0 + 20 * MIN },
    { event_wall_ms: T0 + 31 * MIN, last_seen_wall_ms: T0 + 31 * MIN },
  ])
  assert.equal(r.q(`SELECT 1 FROM intervals WHERE end_wall_ms > ? AND start_wall_ms < ?`, T0 + 20 * MIN, T0 + 30 * MIN).length, 0)
  r.close()
})

test('a re-import after deletion brings nothing back, and a late capture line inside a deleted range is refused', () => {
  resetSeq()
  const r = rig()
  day(r, T0, [[editor, 'a.md - Editor'], [chat, 'Bilby canary'], [editor, 'b.md - Editor']])
  const exported = r.q<ObservationRow>(`SELECT * FROM observations`)
  r.storage.deleteRange(T0 + 5 * MIN, T0 + 10 * MIN)
  r.storage.deleteSource('com.example.editor', { from_wall_ms: T0 + 10 * MIN, to_wall_ms: T0 + 15 * MIN })
  const res = r.storage.importObservations(exported)
  assert.deepEqual(containsAnywhere(r, 'Bilby'), [])
  assert.equal(r.q(`SELECT 1 FROM observations WHERE title = 'b.md - Editor'`).length, 0)
  assert.deepEqual(res, { imported: 1, refused: 2 }, 'only the row outside both deletions comes in')
  r.feed(focus(chat, 'Bilby canary late', T0 + 7 * MIN))
  assert.deepEqual(containsAnywhere(r, 'Bilby'), [])
  r.close()
})

test('a correction wins everywhere, survives a rewrite, and undo restores what was shown before', async () => {
  resetSeq()
  const r = rig()
  const h = r.storage.writeHour({ start_wall_ms: T0, tz: 'Africa/Kigali', status: 'written', title: 'Wrote the pitch', writer: 'model-a' })
  const reader = new Database(path.join(r.dir, DB_FILE), { readonly: true })
  const seen: string[] = []
  const watcher = new ChangeWatcher(reader, r.dir, (c) => seen.push(c.kind))
  watcher.start()

  const c1 = r.storage.correct(h.id, 'title', 'Fixed the billing bug')
  r.storage.writeHour({ start_wall_ms: T0, tz: 'Africa/Kigali', status: 'written', title: 'Rewritten: wrote the pitch', writer: 'model-b' })
  for (const view of [r.storage.hour(h.id)!, readHour(reader, h.id)!]) {
    assert.equal(view.title, 'Fixed the billing bug')
    assert.deepEqual(view.corrected, ['title'])
    assert.equal(view.version, 2)
  }
  assert.equal(r.storage.search('billing').length, 1, 'search shows the corrected text')
  assert.equal(r.storage.search('pitch').length, 0, 'not the text the correction replaced')

  const c2 = r.storage.correct(h.id, 'title', 'Fixed the billing bug and shipped it')
  r.storage.undoCorrection(c2)
  assert.equal(readHour(reader, h.id)!.title, 'Fixed the billing bug', 'undo restores the earlier correction')
  r.storage.undoCorrection(c1)
  assert.equal(readHour(reader, h.id)!.title, 'Rewritten: wrote the pitch', 'then the written text')
  assert.deepEqual(readHour(reader, h.id)!.corrected, [])

  const t0 = Date.now()
  while (seen.filter((k) => k === 'correction').length < 4 && Date.now() - t0 < 2000) await new Promise((res) => setTimeout(res, 20))
  assert.deepEqual(seen, ['correction', 'hour', 'correction', 'correction', 'correction'], 'another process saw every change, in order')
  watcher.stop()
  reader.close()
  r.close()
})

test('pause is exact: nothing with an event time inside the hour is stored, and capture resumes after it', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'before.md - Editor', T0 - 10 * MIN))
  r.feed(focus(editor, 'before.md - Editor', T0 - MIN, 'reconcile'))
  r.clock.t = T0
  r.storage.pause(T0 + HOUR)
  for (let t = T0; t < T0 + HOUR; t += 5 * MIN) {
    r.feed(focus(editor, 'before.md - Editor', t, 'reconcile'))
    r.feed(focus(chat, 'Pangolin canary', t + MIN))
    r.feed(line('input', { state: 'active', last_input_wall_ms: t + MIN, threshold_s: 120, snapshot: false }, t + MIN))
  }
  r.feed(focus(editor, 'after.md - Editor', T0 + HOUR))
  r.feed(focus(editor, 'after.md - Editor', T0 + HOUR + 5 * MIN, 'reconcile'))
  // A line that happened inside the pause but arrives after it ended.
  r.feed(focus(chat, 'Pangolin canary late', T0 + HOUR - 1))

  assert.deepEqual(r.q(`SELECT id FROM observations WHERE event_wall_ms >= ? AND event_wall_ms < ?`, T0, T0 + HOUR), [])
  assert.deepEqual(r.q(`SELECT id FROM observations WHERE last_seen_wall_ms >= ? AND event_wall_ms < ?`, T0, T0), [], 'no row from before runs into the pause')
  assert.deepEqual(containsAnywhere(r, 'Pangolin'), [])
  assert.deepEqual(r.q(`SELECT title, event_wall_ms FROM observations WHERE kind = 'focus' AND event_wall_ms >= ?`, T0 + HOUR), [{ title: 'after.md - Editor', event_wall_ms: T0 + HOUR }])
  assert.deepEqual(r.q(`SELECT reason, start_wall_ms, end_wall_ms FROM capture_gaps WHERE reason = 'paused'`), [{ reason: 'paused', start_wall_ms: T0, end_wall_ms: T0 + HOUR }])
  assert.equal(r.q(`SELECT 1 FROM intervals WHERE end_wall_ms > ? AND start_wall_ms < ?`, T0, T0 + HOUR).length, 0, 'no interval covers the pause')
  r.close()
})

test('pause until resumed stops at the moment of resume, and survives a restart of the service', () => {
  resetSeq()
  const r = rig()
  r.clock.t = T0
  r.storage.pause(null)
  r.feed(focus(chat, 'Quoll canary', T0 + MIN))
  r.close()
  const r2 = rig(r.dir)
  r2.clock.t = T0 + 2 * MIN
  r2.storage.start()
  assert.ok(r2.storage.paused(), 'still paused after restart')
  r2.feed(focus(chat, 'Quoll canary again', T0 + 3 * MIN))
  r2.clock.t = T0 + 4 * MIN
  r2.storage.resume()
  r2.feed(focus(editor, 'back.md - Editor', T0 + 4 * MIN))
  assert.deepEqual(containsAnywhere(r2, 'Quoll'), [])
  assert.deepEqual(r2.q(`SELECT title FROM observations WHERE kind = 'focus'`), [{ title: 'back.md - Editor' }])
  assert.deepEqual(r2.q(`SELECT start_wall_ms, end_wall_ms FROM capture_gaps WHERE reason = 'paused'`), [{ start_wall_ms: T0, end_wall_ms: T0 + 4 * MIN }])
  r2.close()
})

test('exclusions apply before storage: an app excluded while in front leaves only an excluded gap from then on', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(chat, 'ordinary chat', T0))
  r.clock.t = T0 + MIN
  r.storage.addExclusion({ match: 'app_id', value: 'com.example.chat', label: 'Chat' })
  r.feed(focus(chat, 'ordinary chat', T0 + 2 * MIN, 'reconcile'))
  r.feed(focus(chat, 'Echidna canary secret', T0 + 3 * MIN))
  r.feed(focus(app('com.1password.1password', { name: '1Password' }), 'Echidna vault', T0 + 4 * MIN))
  r.feed(focus(editor, 'work.md - Editor', T0 + 5 * MIN))
  assert.deepEqual(containsAnywhere(r, 'Echidna'), [])
  assert.deepEqual(r.q(`SELECT title, last_seen_wall_ms FROM observations WHERE app_id = 'com.example.chat'`), [{ title: 'ordinary chat', last_seen_wall_ms: T0 }], 'the row from before is not extended')
  assert.deepEqual(r.q(`SELECT reason, start_wall_ms, end_wall_ms FROM capture_gaps`), [{ reason: 'excluded', start_wall_ms: T0 + 2 * MIN, end_wall_ms: T0 + 5 * MIN }])
  r.storage.removeExclusion('app_id', 'com.example.chat')
  r.feed(focus(chat, 'allowed again', T0 + 6 * MIN))
  assert.equal(r.q(`SELECT 1 FROM observations WHERE title = 'allowed again'`).length, 1)
  r.close()
})

function obsRow(wall: number, appId: string, title: string, url: string): ObservationRow & { url: string } {
  return {
    run: 'import',
    seq: 0,
    boot: 'b',
    platform: 'macos',
    source: 'import',
    kind: 'focus',
    event_wall_ms: wall,
    event_mono_us: 0,
    tz: 'Africa/Kigali',
    tz_offset_min: 120,
    app_id: appId,
    app_name: 'Safari',
    app_path: null,
    pid: 1,
    window: 'w',
    title,
    title_raw: null,
    title_state: 'ok',
    state: 'ok',
    detail: null,
    url,
  }
}

test('deletion leaves nothing on disk even when the search index is large and the deleted entry sits in an old segment', () => {
  resetSeq()
  const r = rig()
  // The index keeps terms lowercased and prefix-compressed; a term sharing no prefix with its neighbours is stored whole.
  const term = 'zqxjvarkcanary'
  r.feed(focus(chat, `Notes ${term.toUpperCase()}`, T0))
  r.store.flush()
  let t = T0 + MIN
  for (let i = 0; i < 4000; i++) {
    r.feed(focus(i % 2 ? editor : chat, `filler ${i} ${'lorem ipsum dolor '.repeat(3)}`, t))
    t += 20_000
    if (i % 100 === 0) r.store.flush()
  }
  r.store.flush()
  r.store.database.pragma('wal_checkpoint(TRUNCATE)')
  assert.deepEqual(diskContains(r.dir, term), ['daylens-v2.sqlite'], 'the index term is on disk before deletion')
  r.storage.deleteRange(T0, T0 + MIN)
  assert.deepEqual(containsAnywhere(r, term), [])
  assert.deepEqual(diskContains(r.dir, term), [])
  r.close()
})

test('a range deletion reaches a zero-length row that starts exactly at the range start', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'before.md - Editor', T0 - 10 * MIN))
  r.feed(focus(chat, 'Okapi canary instant', T0 + 5 * MIN))
  r.store.flush()
  assert.deepEqual(r.q(`SELECT start_wall_ms - end_wall_ms AS d FROM intervals WHERE title LIKE 'Okapi%'`), [{ d: 0 }], 'the canary interval has no length')
  r.clock.t = T0 + 20 * MIN
  r.storage.deleteRange(T0 + 5 * MIN, T0 + 10 * MIN)
  assert.deepEqual(containsAnywhere(r, 'Okapi'), [])
  r.close()
})
