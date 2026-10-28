// Storage-level acceptance tests for the promises in docs/testing.md: deletion reaches everything, a correction
// wins, pause is exact, exclusions apply before storage, and a re-import after deletion brings nothing back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import path from 'node:path'
import { DB_FILE } from '../../capture/store.ts'
import type { ObservationRow } from '../../capture/normalize.ts'
import { ChangeWatcher } from '../../storage/changes.ts'
import { PendingDeletionError, readHour } from '../../storage/index.ts'
import { app, focus, line, resetSeq } from '../support/lines.ts'
import { diskContains, HOUR, MIN, rig, T0, tmpDir } from './support.ts'
import { Deleter, type DeletionStep } from '../../storage/deletion.ts'

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
    ['threads', `SELECT count(*) AS n FROM threads WHERE title LIKE ? OR title LIKE ? OR title LIKE ? OR title LIKE ?`],
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

test('deletion reaches everything: a range is gone from observations, intervals, hours, search, assistant reads and the file on disk', async () => {
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
  const hour = r.storage.writeHour({ start_wall_ms: T0, tz: 'Example/Town', status: 'written', title: 'Planned the Zanzibar canary', sources: [{ app_id: 'com.example.chat' }] }, r.storage.hourBasis(T0))
  r.storage.correct(hour.id, 'summary', 'Zanzibar canary, corrected by me')
  r.storage.recordAssistantRead({ assistant: 'claude', tool: 'getDay', from_wall_ms: inRange.from, to_wall_ms: inRange.to, query: 'what about Zanzibar canary?' })
  assert.ok(containsAnywhere(r, 'Zanzibar').length > 3, 'the canary is present before deletion')

  const res = (await r.storage.deleteRange(inRange.from, inRange.to).done)
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

test('deletion reaches everything: one app, across days, and the hours that drew on it', async () => {
  resetSeq()
  const r = rig()
  day(r, T0, [[chat, 'Quokka canary thread'], [editor, 'notes.md - Editor']])
  day(r, T0 + 24 * HOUR, [[chat, 'Quokka canary again'], [editor, 'todo.md - Editor']])
  r.store.flush()
  const h1 = r.storage.writeHour({ start_wall_ms: T0, tz: 'Example/Town', status: 'written', title: 'Quokka chat', sources: [{ app_id: 'com.example.chat' }, { app_id: 'com.example.editor' }] }, r.storage.hourBasis(T0))
  const h2 = r.storage.writeHour({ start_wall_ms: T0 + 2 * HOUR, tz: 'Example/Town', status: 'written', title: 'Editing only', sources: [{ app_id: 'com.example.editor' }] }, r.storage.hourBasis(T0 + 2 * HOUR))
  r.storage.recordAssistantRead({ assistant: 'claude', tool: 'search', from_wall_ms: T0, to_wall_ms: T0 + 48 * HOUR, query: 'time in Chat this week', sources: [{ app_id: 'com.example.chat' }] })

  await r.storage.deleteSource('com.example.chat').done
  assert.deepEqual(containsAnywhere(r, 'Quokka'), [])
  // The tombstone keeps the app id so a re-import can be refused; nothing else does.
  assert.deepEqual(containsAnywhere(r, 'com.example.chat').filter((w) => !w.startsWith('disk:')), [])
  assert.equal(r.q(`SELECT 1 FROM assistant_reads`).length, 0, 'the read that returned Chat activity is gone')
  assert.equal(r.storage.hour(h1.id)!.needs_rewrite, true)
  assert.deepEqual(r.storage.hour(h1.id)!.sources, [{ app_id: 'com.example.editor' }])
  assert.equal(r.storage.hour(h2.id)!.title, 'Editing only', 'hours that never used the app keep their text')
  assert.equal(r.storage.search('todo').length, 1)
  r.close()
})

test('deletion reaches everything: a site and its subdomains, once page addresses are captured', async () => {
  resetSeq()
  const r = rig()
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

  r2.clock.t = T0 + HOUR
  await r2.storage.deleteSite('secret-bank.example').done
  assert.deepEqual(containsAnywhere(r2, 'Wombat'), [])
  assert.deepEqual(containsAnywhere(r2, 'secret-bank').filter((w) => !w.startsWith('disk:')), [])
  assert.equal(r2.storage.search('public guide').length, 1)
  assert.equal(r2.storage.importObservations(rows).imported, 1, 'a re-import brings back only the other site')
  r2.close()
})

test('a site deletion reaches addresses written with a trailing dot, whichever form the site is named in', async () => {
  for (const named of ['secret-bank.example', 'Secret-Bank.Example.']) {
    resetSeq()
    const r = rig()
    const rows = [
      ['https://secret-bank.example./accounts', 'Wombat canary balance'],
      ['https://login.secret-bank.example./', 'Wombat canary login'],
      ['https://docs.example.org/guide', 'Public guide'],
    ].map(([url, title], i) => obsRow(T0 + i * MIN, 'com.apple.Safari', title!, url!))
    assert.equal(r.storage.importObservations(rows).imported, 3)
    for (const row of rows) r.store.database.prepare('UPDATE observations SET url = ? WHERE title = ?').run(row.url, row.title)
    r.storage.derived.rebuild()
    assert.equal(r.storage.search('wombat').length, 2)
    r.clock.t = T0 + HOUR
    await r.storage.deleteSite(named).done
    assert.deepEqual(containsAnywhere(r, 'Wombat').filter((w) => !w.startsWith('disk:')), [], named)
    assert.equal(r.storage.importObservations(rows).imported, 1, `${named}: a re-import brings back only the other site`)
    r.close()
  }
})

test('delete the last ten minutes is one call; an open row keeps only its part before, and capture continues after', async () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'long-running.md - Editor', T0))
  for (let t = T0 + MIN; t <= T0 + 30 * MIN; t += MIN) r.feed(focus(editor, 'long-running.md - Editor', t, 'reconcile'))
  r.feed(focus(chat, 'Numbat canary', T0 + 25 * MIN))
  r.feed(focus(chat, 'Numbat canary', T0 + 30 * MIN, 'reconcile'))
  r.clock.t = T0 + 30 * MIN
  await r.storage.deleteLast(10 * MIN).done
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

test('a re-import after deletion brings nothing back, and a late capture line inside a deleted range is refused', async () => {
  resetSeq()
  const r = rig()
  day(r, T0, [[editor, 'a.md - Editor'], [chat, 'Bilby canary'], [editor, 'b.md - Editor']])
  const exported = r.q<ObservationRow>(`SELECT * FROM observations`)
  await r.storage.deleteRange(T0 + 5 * MIN, T0 + 10 * MIN).done
  await r.storage.deleteSource('com.example.editor', { from_wall_ms: T0 + 10 * MIN, to_wall_ms: T0 + 15 * MIN }).done
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
  const h = r.storage.writeHour({ start_wall_ms: T0, tz: 'Example/Town', status: 'written', title: 'Wrote the pitch', writer: 'model-a' }, r.storage.hourBasis(T0))
  const reader = new Database(path.join(r.dir, DB_FILE), { readonly: true })
  const seen: string[] = []
  const watcher = new ChangeWatcher(reader, r.dir, (c) => seen.push(c.kind))
  watcher.start()

  const c1 = r.storage.correct(h.id, 'title', 'Fixed the billing bug')
  r.storage.writeHour({ start_wall_ms: T0, tz: 'Example/Town', status: 'written', title: 'Rewritten: wrote the pitch', writer: 'model-b' }, r.storage.hourBasis(T0))
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
    tz: 'Example/Town',
    tz_offset_min: -300,
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

test('deletion leaves nothing on disk even when the search index is large and the deleted entry sits in an old segment', async () => {
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
  await r.storage.deleteRange(T0, T0 + MIN).done
  assert.deepEqual(containsAnywhere(r, term), [])
  assert.deepEqual(diskContains(r.dir, term), [])
  r.close()
})

test('a range deletion reaches a zero-length row that starts exactly at the range start', async () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'before.md - Editor', T0 - 10 * MIN))
  r.feed(focus(chat, 'Okapi canary instant', T0 + 5 * MIN))
  r.store.flush()
  assert.deepEqual(r.q(`SELECT start_wall_ms - end_wall_ms AS d FROM intervals WHERE title LIKE 'Okapi%'`), [{ d: 0 }], 'the canary interval has no length')
  r.clock.t = T0 + 20 * MIN
  await r.storage.deleteRange(T0 + 5 * MIN, T0 + 10 * MIN).done
  assert.deepEqual(containsAnywhere(r, 'Okapi'), [])
  r.close()
})

test('by the time a deletion or pause is announced, capture and import already refuse the material', async () => {
  resetSeq()
  const r = rig()
  day(r, T0, [[chat, 'Tapir canary'], [editor, 'x.md - Editor']])
  const exported = r.q<ObservationRow>(`SELECT * FROM observations`)
  const results: string[] = []
  r.storage.bus.on((c) => {
    if (c.kind === 'deletion' && c.payload.state === 'started') results.push(`import:${JSON.stringify(r.storage.importObservations(exported.filter((o) => o.title === 'Tapir canary')))}`)
    if (c.kind === 'pause' && c.payload.until_wall_ms !== undefined) {
      r.feed(focus(chat, 'Tapir canary during pause', r.clock.t + 1000))
      results.push(`paused-rows:${r.q(`SELECT 1 FROM observations WHERE title LIKE '%during pause%'`).length}`)
    }
  })
  r.clock.t = T0 + 20 * MIN
  await r.storage.deleteSource('com.example.chat').done
  r.storage.pause(T0 + HOUR)
  assert.deepEqual(results, ['import:{"imported":0,"refused":1}', 'paused-rows:0'])
  assert.deepEqual(containsAnywhere(r, 'Tapir'), [])
  r.close()
})

test('a change made by a listener is delivered after the change that caused it, to every listener', () => {
  const r = rig()
  const a: string[] = []
  const b: string[] = []
  r.storage.bus.on((c) => {
    a.push(String(c.payload.key))
    if (c.payload.key === 'first') r.storage.setSetting('second', 1)
  })
  r.storage.bus.on((c) => b.push(String(c.payload.key)))
  r.storage.setSetting('first', 1)
  assert.deepEqual(a, ['first', 'second'])
  assert.deepEqual(b, ['first', 'second'], 'not second before first')
  r.close()
})

test('exclusions apply to imports too: an excluded row leaves only an excluded gap', () => {
  resetSeq()
  const r = rig()
  const vault = { ...obsRow(T0, 'com.1password.1password', 'Gecko canary vault item', 'https://x.example/'), url: undefined } as unknown as ObservationRow
  const byExe = { ...obsRow(T0 + MIN, 'C:\\\\Apps\\\\KeePass\\\\KeePass.exe', 'Gecko canary keepass', 'https://y.example/'), app_path: 'C:\\\\Apps\\\\KeePass\\\\KeePass.exe', url: undefined } as unknown as ObservationRow
  const ok = { ...obsRow(T0 + 2 * MIN, 'com.example.editor', 'fine.md - Editor', 'https://z.example/'), url: undefined } as unknown as ObservationRow
  const res = r.storage.importObservations([vault, byExe, ok])
  assert.deepEqual(res, { imported: 1, refused: 2 })
  assert.deepEqual(containsAnywhere(r, 'Gecko'), [])
  assert.deepEqual(r.q(`SELECT reason, start_wall_ms, end_wall_ms FROM capture_gaps ORDER BY start_wall_ms`), [
    { reason: 'excluded', start_wall_ms: T0, end_wall_ms: T0 },
    { reason: 'excluded', start_wall_ms: T0 + MIN, end_wall_ms: T0 + MIN },
  ])
  r.close()
})

test('a finished pause keeps refusing material stamped inside it: after resume, after expiry, and after a restart', () => {
  resetSeq()
  const r = rig()
  r.clock.t = T0
  r.storage.pause(T0 + HOUR)
  r.clock.t = T0 + 10 * MIN
  r.storage.resume()
  r.feed(focus(chat, 'Ibex canary late after resume', T0 + 5 * MIN))
  r.clock.t = T0 + 2 * HOUR
  r.storage.pause(T0 + 3 * HOUR)
  r.clock.t = T0 + 4 * HOUR
  r.feed(focus(editor, 'after.md - Editor', T0 + 4 * HOUR))
  r.feed(focus(chat, 'Ibex canary late after expiry', T0 + 2 * HOUR + 30 * MIN))
  r.close()
  const r2 = rig(r.dir)
  r2.clock.t = T0 + 5 * HOUR
  r2.storage.start()
  r2.feed(focus(chat, 'Ibex canary late after restart', T0 + 7 * MIN))
  r2.feed(focus(chat, 'Ibex canary late after restart 2', T0 + 2 * HOUR + 40 * MIN))
  r2.feed(focus(editor, 'between.md - Editor', T0 + HOUR))
  assert.deepEqual(containsAnywhere(r2, 'Ibex'), [])
  assert.equal(r2.q(`SELECT 1 FROM observations WHERE title = 'between.md - Editor'`).length, 1, 'time between pauses is still captured')
  r2.close()
})

test('an active pause keeps one open gap through a restart, and resuming early ends it at the moment of resume', () => {
  resetSeq()
  const r = rig()
  r.clock.t = T0
  r.storage.pause('until_resumed')
  r.close()
  const r2 = rig(r.dir)
  r2.clock.t = T0 + 3 * MIN
  // What the supervisor does at startup: gaps left open by the last run end where its coverage ended.
  r2.store.closeDanglingGaps({ wall_ms: T0 + MIN, mono_us: null, boot: null })
  r2.storage.start()
  assert.deepEqual(r2.q(`SELECT start_wall_ms, end_wall_ms FROM capture_gaps WHERE reason = 'paused'`), [{ start_wall_ms: T0, end_wall_ms: null }], 'still open while still paused')
  r2.clock.t = T0 + 5 * MIN
  r2.storage.resume()
  assert.deepEqual(r2.q(`SELECT start_wall_ms, end_wall_ms FROM capture_gaps WHERE reason = 'paused'`), [{ start_wall_ms: T0, end_wall_ms: T0 + 5 * MIN }])
  r2.clock.t = T0 + 10 * MIN
  r2.storage.pause('hour')
  r2.clock.t = T0 + 20 * MIN
  r2.storage.resume()
  assert.deepEqual(r2.q(`SELECT start_wall_ms, end_wall_ms FROM capture_gaps WHERE reason = 'paused' ORDER BY start_wall_ms`)[1], { start_wall_ms: T0 + 10 * MIN, end_wall_ms: T0 + 20 * MIN }, 'early resume ends the gap at resume, not at the planned hour')
  r2.close()
})

test('a pause and its gap are written in one transaction', () => {
  const r = rig()
  const reader = new Database(path.join(r.dir, DB_FILE), { readonly: true })
  // Nothing queued in the capture store is written after the pause commits.
  r.store.flush = () => true
  r.storage.pause('hour')
  const rows = reader.prepare(`SELECT p.gap_id, g.reason FROM pauses p LEFT JOIN capture_gaps g ON g.id = p.gap_id`).all()
  assert.deepEqual(rows, [{ gap_id: rows[0] && (rows[0] as { gap_id: number }).gap_id, reason: 'paused' }])
  reader.close()
})

test('a row cannot be extended across a deleted range or a pause; the next sighting after it starts a fresh row', async () => {
  resetSeq()
  const r = rig()
  const at = (m: number) => T0 + m * MIN
  r.clock.t = at(30)
  await r.storage.deleteRange(at(10), at(20)).done
  r.feed(focus(chat, 'Late chat', at(5)))
  r.feed(focus(chat, 'Late chat', at(15), 'reconcile'))
  r.feed(focus(chat, 'Late chat', at(25), 'reconcile'))
  r.storage.pause(at(50))
  r.clock.t = at(40)
  r.feed(focus(editor, 'pre.md - Editor', at(31)))
  r.storage.resume()
  r.feed(focus(editor, 'pre.md - Editor', at(35), 'reconcile'))
  r.store.flush()
  const rows = r.q<{ title: string; event_wall_ms: number; last_seen_wall_ms: number }>(`SELECT title, event_wall_ms, last_seen_wall_ms FROM observations WHERE kind = 'focus' ORDER BY id`)
  assert.deepEqual(rows.map((o) => [o.title, (o.event_wall_ms - T0) / MIN, (o.last_seen_wall_ms - T0) / MIN]), [
    ['Late chat', 5, 5],
    ['Late chat', 25, 25],
  ], 'nothing covers 10–20 or the pause from 30 to 40')
  assert.deepEqual(r.q(`SELECT 1 FROM intervals WHERE end_wall_ms > ? AND start_wall_ms < ?`, at(10), at(20)), [])
  r.close()
})

test('a bounded app deletion trims and splits rows that cross its edges, and a rebuild does not bring the middle back', async () => {
  resetSeq()
  const r = rig()
  const at = (m: number) => T0 + m * MIN
  r.feed(focus(chat, 'Crossing chat', at(0)))
  for (let m = 1; m <= 20; m++) r.feed(focus(chat, 'Crossing chat', at(m), 'reconcile'))
  r.feed(focus(editor, 'next.md - Editor', at(20) + 1000))
  r.clock.t = at(30)
  await r.storage.deleteSource('com.example.chat', { from_wall_ms: at(10), to_wall_ms: at(15) }).done
  const cover = () =>
    r.q<{ s: number; e: number }>(`SELECT (event_wall_ms - ?) / 60000.0 AS s, (last_seen_wall_ms - ?) / 60000.0 AS e FROM observations WHERE app_id = 'com.example.chat' ORDER BY event_wall_ms`, T0, T0)
  assert.deepEqual(cover(), [{ s: 0, e: 10 }, { s: 15, e: 20 }], 'the row before and after the range survive; the middle is gone')
  const middle = () => r.q(`SELECT 1 FROM intervals WHERE app_id = 'com.example.chat' AND end_wall_ms > ? AND start_wall_ms < ?`, at(10), at(15))
  assert.deepEqual(middle(), [])
  r.storage.derived.rebuild()
  assert.deepEqual(middle(), [], 'still gone after a rebuild')
  assert.equal(r.q(`SELECT 1 FROM intervals WHERE app_id = 'com.example.chat'`).length, 2)
  r.close()
})

test('deletion reaches threads: orphaned threads go, shared ones lose a title that may describe the deleted material', async () => {
  const r = rig()
  const h1 = r.storage.writeHour({ start_wall_ms: T0, tz: 'Example/Town', status: 'facts' }, r.storage.hourBasis(T0))
  const h2 = r.storage.writeHour({ start_wall_ms: T0 + 3 * HOUR, tz: 'Example/Town', status: 'facts' }, r.storage.hourBasis(T0 + 3 * HOUR))
  const only = r.storage.createThread('Kakapo canary only', [h1.id])
  const shared = r.storage.createThread('Kakapo canary shared', [h1.id, h2.id])
  r.clock.t = T0 + 30 * MIN
  r.storage.createThread('Kakapo canary empty')
  r.clock.t = T0 + 2 * HOUR
  await r.storage.deleteRange(T0, T0 + 2 * HOUR).done
  assert.deepEqual(containsAnywhere(r, 'Kakapo'), [])
  assert.deepEqual(r.q(`SELECT id, title, needs_rewrite FROM threads ORDER BY id`), [{ id: shared, title: '', needs_rewrite: 1 }])
  assert.ok(only < shared)
  r.clock.t = T0 + 5 * HOUR
  await r.storage.deleteEverything().done
  assert.deepEqual(r.q(`SELECT id FROM threads`), [])
  r.close()
})

test('deleting an app removes the assistant reads that touched it, by what they read, not by the words of the question', async () => {
  resetSeq()
  const r = rig()
  day(r, T0, [[chat, 'thread'], [editor, 'notes.md - Editor']])
  const h = r.storage.writeHour({ start_wall_ms: T0, tz: 'Example/Town', status: 'written', title: 'Talked', sources: [{ app_id: 'com.example.chat' }] }, r.storage.hourBasis(T0))
  const span = { from_wall_ms: T0, to_wall_ms: T0 + HOUR }
  const direct = r.storage.recordAssistantRead({ assistant: 'claude', tool: 'getAppUsage', ...span, query: 'show my messages', sources: [{ app_id: 'com.example.chat' }] })
  const viaHour = r.storage.recordAssistantRead({ assistant: 'claude', tool: 'getDaySummary', ...span, query: 'summarise', hours: [h.id] })
  const unrelated = r.storage.recordAssistantRead({ assistant: 'claude', tool: 'getAppUsage', ...span, query: 'did I use Chat or the editor more?', sources: [{ app_id: 'com.example.editor' }] })
  r.clock.t = T0 + 2 * HOUR
  await r.storage.deleteSource('com.example.chat').done
  assert.deepEqual(r.q<{ id: number }>(`SELECT id FROM assistant_reads ORDER BY id`).map((x) => x.id), [unrelated])
  assert.ok(direct && viaHour)
  r.close()
})

test('deletion reports purged from disk separately, retrying until a reader holding the old pages lets go', async () => {
  resetSeq()
  const r = rig()
  day(r, T0, [[chat, 'Wallaby canary'], [editor, 'x.md - Editor']])
  r.store.flush()
  const reader = new Database(path.join(r.dir, DB_FILE), { readonly: true })
  reader.prepare('BEGIN').run()
  reader.prepare('SELECT count(*) AS n FROM observations').get()
  r.clock.t = T0 + HOUR
  const seen: string[] = []
  r.storage.bus.on((c) => c.kind === 'deletion' && seen.push(String(c.payload.state)))
  const handle = r.storage.deleteSource('com.example.chat')
  const result = await handle.done
  assert.equal(result.purged, false, 'deleted, but the old pages are still in the log while the reader holds them')
  assert.deepEqual(r.q(`SELECT state FROM deletions`), [{ state: 'done' }])
  assert.ok(diskContains(r.dir, 'Wallaby').length > 0)
  reader.prepare('COMMIT').run()
  await handle.purged
  assert.deepEqual(diskContains(r.dir, 'Wallaby'), [])
  assert.deepEqual(r.q(`SELECT state FROM deletions`), [{ state: 'purged' }])
  assert.deepEqual(seen, ['started', 'done', 'purged'])
  reader.close()
  r.close()
})

test('stopping storage never reports a deletion purged; the purge resumes at the next start', async () => {
  resetSeq()
  const r = rig()
  day(r, T0, [[chat, 'Dingo canary'], [editor, 'x.md - Editor']])
  r.store.flush()
  const reader = new Database(path.join(r.dir, DB_FILE), { readonly: true })
  reader.prepare('BEGIN').run()
  reader.prepare('SELECT count(*) AS n FROM observations').get()
  r.clock.t = T0 + HOUR
  const handle = r.storage.deleteSource('com.example.chat')
  await handle.done
  let purged = false
  void handle.purged.then(() => (purged = true))
  r.close()
  await new Promise((res) => setTimeout(res, 600))
  assert.equal(purged, false, 'not purged: a reader still held the old pages when storage stopped')
  const check = new Database(path.join(r.dir, DB_FILE), { readonly: true })
  assert.deepEqual(check.prepare(`SELECT state FROM deletions`).all(), [{ state: 'done' }])
  check.close()
  reader.prepare('COMMIT').run()
  reader.close()
  const r2 = rig(r.dir)
  r2.storage.start()
  const t0 = Date.now()
  while (r2.q<{ state: string }>(`SELECT state FROM deletions`)[0]!.state !== 'purged' && Date.now() - t0 < 3000) await new Promise((res) => setTimeout(res, 50))
  assert.deepEqual(r2.q(`SELECT state FROM deletions`), [{ state: 'purged' }])
  assert.deepEqual(diskContains(r2.dir, 'Dingo'), [])
  r2.close()
})

test('a row trimmed by a deletion cannot be stretched back over the range from a stale cached sighting', async () => {
  const r = rig()
  const id = r.store.insertObservation(obsRow(T0, 'com.example.chat', 'Long chat', 'https://x.example/') as unknown as ObservationRow)
  assert.equal(r.store.extendObservation(id, T0 + 20 * MIN), true)
  r.store.flush()
  r.clock.t = T0 + 30 * MIN
  await r.storage.deleteRange(T0 + 5 * MIN, T0 + 10 * MIN).done
  r.store.extendObservation(id, T0 + 25 * MIN)
  r.store.flush()
  assert.deepEqual(r.q(`SELECT id FROM observations WHERE event_wall_ms < ? AND last_seen_wall_ms > ?`, T0 + 10 * MIN, T0 + 5 * MIN), [])
  r.close()
})

test('no row spans more than the longest interval the edge scan covers, so a deletion late in a long sighting still trims it', async () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'server-console - Editor', T0))
  for (let h = 1; h <= 8 * 24; h++) r.feed(focus(editor, 'server-console - Editor', T0 + h * HOUR, 'reconcile'))
  r.store.flush()
  const spans = r.q<{ s: number }>(`SELECT last_seen_wall_ms - event_wall_ms AS s FROM observations WHERE kind = 'focus'`)
  assert.ok(spans.length >= 2 && spans.every((x) => x.s <= 7 * 24 * HOUR), JSON.stringify(spans))
  const from = T0 + 7 * 24 * HOUR + 12 * HOUR
  r.clock.t = T0 + 9 * 24 * HOUR
  await r.storage.deleteRange(from, from + HOUR).done
  assert.deepEqual(r.q(`SELECT id FROM observations WHERE event_wall_ms < ? AND last_seen_wall_ms > ?`, from + HOUR, from), [])
  r.close()
})

test('while a deletion is pending, every reader already sees the hours and threads it covers as gone', () => {
  const r = rig()
  const whole = r.storage.writeHour({ start_wall_ms: T0, tz: 'Example/Town', status: 'written', title: 'Emu canary hour' }, r.storage.hourBasis(T0))
  const part = r.storage.writeHour({ start_wall_ms: T0 + HOUR, tz: 'Example/Town', status: 'written', title: 'Emu canary partly' }, r.storage.hourBasis(T0 + HOUR))
  const viaApp = r.storage.writeHour({ start_wall_ms: T0 + 3 * HOUR, tz: 'Example/Town', status: 'written', title: 'Emu canary chat', sources: [{ app_id: 'com.example.chat' }] }, r.storage.hourBasis(T0 + 3 * HOUR))
  const kept = r.storage.writeHour({ start_wall_ms: T0 + 4 * HOUR, tz: 'Example/Town', status: 'written', title: 'Untouched' }, r.storage.hourBasis(T0 + 4 * HOUR))
  const thread = r.storage.createThread('Emu canary thread', [part.id, kept.id])
  // Fenced but not yet removed.
  const pend = r.storage.db.prepare(`INSERT INTO deletions (kind, from_wall_ms, to_wall_ms, app_id, created_wall_ms, state) VALUES (?, ?, ?, ?, ?, 'pending')`)
  pend.run('range', T0, T0 + HOUR + 10 * MIN, null, T0)
  pend.run('source', null, null, 'com.example.chat', T0)
  r.storage.rules.loadTombstones()
  const reader = new Database(path.join(r.dir, DB_FILE), { readonly: true })
  for (const read of [(id: number) => readHour(reader, id), (id: number) => r.storage.hour(id)]) {
    assert.equal(read(whole.id), null)
    assert.equal(read(part.id)!.title, null)
    assert.equal(read(part.id)!.needs_rewrite, true)
    assert.equal(read(viaApp.id)!.title, null)
    assert.equal(read(kept.id)!.title, 'Untouched')
  }
  assert.deepEqual(r.storage.threadsForHour(kept.id), [{ id: thread, title: '' }])
  reader.close()
  r.close()
})

async function crashedDeletion(stopAfter: DeletionStep) {
  resetSeq()
  const r = rig(tmpDir(), { holdDeletions: true })
  day(r, T0, [[editor, 'before.md - Editor'], [chat, 'Quail canary'], [editor, 'after.md - Editor']], 3 * MIN)
  r.store.flush()
  const part = r.storage.writeHour({ start_wall_ms: T0, tz: 'Example/Town', status: 'written', title: 'Quail canary hour' }, r.storage.hourBasis(T0))
  const keep = r.storage.writeHour({ start_wall_ms: T0 + 3 * HOUR, tz: 'Example/Town', status: 'written', title: 'Kept' }, r.storage.hourBasis(T0 + 3 * HOUR))
  const only = r.storage.createThread('Quail canary only', [part.id])
  const shared = r.storage.createThread('Quail canary shared', [part.id, keep.id])
  const read = r.storage.recordAssistantRead({ assistant: 'claude', tool: 'getDay', from_wall_ms: T0 + HOUR, to_wall_ms: T0 + 2 * HOUR, query: 'what happened?', hours: [part.id] })
  r.clock.t = T0 + 5 * HOUR
  const { tombstone } = r.storage.deleteRange(T0 + 3 * MIN, T0 + 6 * MIN)
  const conn = new Database(path.join(r.dir, DB_FILE))
  conn.pragma('foreign_keys = ON')
  conn.pragma('secure_delete = ON')
  assert.throws(() => new Deleter(conn).run(tombstone, r.clock.t, { stopAfter }), /stopped after/)
  conn.close()
  r.close()
  const r2 = rig(r.dir)
  r2.clock.t = T0 + 5 * HOUR
  r2.storage.start()
  await r2.storage.deletionsSettled()
  const t0 = Date.now()
  while (r2.q<{ state: string }>(`SELECT state FROM deletions`)[0]!.state !== 'purged' && Date.now() - t0 < 3000) await new Promise((res) => setTimeout(res, 50))
  assert.deepEqual(r2.q(`SELECT state FROM deletions`), [{ state: 'purged' }])
  assert.deepEqual(containsAnywhere(r2, 'Quail'), [])
  // The hour is only partly inside the range, so it is cleared, not removed: both threads keep their ids, untitled.
  assert.deepEqual(r2.q(`SELECT id, title FROM threads ORDER BY id`), [{ id: only, title: '' }, { id: shared, title: '' }])
  assert.deepEqual(r2.q(`SELECT 1 FROM assistant_reads WHERE id = ?`, read), [])
  r2.close()
}

test('a deletion interrupted after its rows and intervals are gone still finishes the search cleanup at the next start', async () => {
  await crashedDeletion('intervals')
})

test('a deletion interrupted after its hours still reaches their threads and assistant reads at the next start', async () => {
  await crashedDeletion('hours')
})

test('the hour reader takes the hour, its corrections and the pending fence from one snapshot', () => {
  const r = rig()
  const h = r.storage.writeHour({ start_wall_ms: T0, tz: 'Example/Town', status: 'written', title: 'Ocelot canary' }, r.storage.hourBasis(T0))
  r.storage.db.prepare(`INSERT INTO deletions (kind, from_wall_ms, to_wall_ms, created_wall_ms, state) VALUES ('range', ?, ?, ?, 'pending')`).run(T0 + MIN, T0 + 2 * MIN, T0)
  const reader = new Database(path.join(r.dir, DB_FILE), { readonly: true })
  // Right after the reader has the hour row, the deletion completes on another connection: text cleared, marked done.
  const finishDeletion = () => {
    r.storage.db.prepare(`UPDATE hours SET title = NULL, needs_rewrite = 1 WHERE id = ?`).run(h.id)
    r.storage.db.prepare(`UPDATE deletions SET state = 'done'`).run()
  }
  const interleaved = new Proxy(reader, {
    get(target, prop) {
      if (prop !== 'prepare') return Reflect.get(target, prop)
      return (sql: string) => {
        const st = target.prepare(sql)
        if (!sql.startsWith('SELECT * FROM hours')) return st
        return new Proxy(st, {
          get(s, p) {
            if (p !== 'get') return Reflect.get(s, p).bind?.(s) ?? Reflect.get(s, p)
            return (...args: unknown[]) => {
              const row = s.get(...args)
              finishDeletion()
              return row
            }
          },
        })
      }
    },
  }) as Database.Database
  const seen = readHour(interleaved, h.id)
  assert.equal(seen?.title ?? null, null, `read ${JSON.stringify(seen?.title)}`)
  reader.close()
  r.close()
})

test('while a deletion is pending, new threads, links, corrections and assistant reads that reference what it covers are refused', async () => {
  resetSeq()
  const r = rig(tmpDir(), { holdDeletions: true })
  const h = r.storage.writeHour({ start_wall_ms: T0, tz: 'Example/Town', status: 'written', title: 'Marmot hour' }, r.storage.hourBasis(T0))
  const other = r.storage.writeHour({ start_wall_ms: T0 + 5 * HOUR, tz: 'Example/Town', status: 'written', title: 'Other' }, r.storage.hourBasis(T0 + 5 * HOUR))
  const thread = r.storage.createThread('Existing', [other.id])
  r.clock.t = T0 + 6 * HOUR
  r.storage.deleteRange(T0 + MIN, T0 + 2 * MIN)
  r.storage.deleteSource('com.example.chat')
  const span = { assistant: 'claude', tool: 'getDay', from_wall_ms: T0, to_wall_ms: T0 + 6 * HOUR }
  assert.throws(() => r.storage.createThread('Marmot canary thread', [h.id]), PendingDeletionError)
  assert.throws(() => r.storage.linkHour(thread, h.id), PendingDeletionError)
  assert.throws(() => r.storage.correct(h.id, 'title', 'Marmot canary corrected'), PendingDeletionError)
  assert.throws(() => r.storage.recordAssistantRead({ ...span, query: 'Marmot canary read', hours: [h.id] }), PendingDeletionError)
  assert.throws(() => r.storage.recordAssistantRead({ ...span, query: 'Marmot canary chat', sources: [{ app_id: 'com.example.chat' }] }), PendingDeletionError)
  assert.ok(r.storage.recordAssistantRead({ ...span, from_wall_ms: T0 + 5 * HOUR, query: 'fine', hours: [other.id] }), 'a read outside what is being deleted is recorded')
  r.close()
  const r2 = rig(r.dir)
  r2.clock.t = T0 + 6 * HOUR
  r2.storage.start()
  await r2.storage.deletionsSettled()
  assert.deepEqual(containsAnywhere(r2, 'Marmot canary'), [])
  r2.close()
})

test('a restart never reuses a deleted observation id, so no interval can carry the deleted row onto a new one', async () => {
  resetSeq()
  const r = rig(tmpDir(), { holdDeletions: true })
  r.feed(focus(editor, 'early.md - Editor', T0))
  r.feed(focus(chat, 'Lynx canary private', T0 + 10 * MIN))
  r.store.flush()
  const maxBefore = r.q<{ m: number }>(`SELECT max(id) AS m FROM observations`)[0]!.m
  r.clock.t = T0 + HOUR
  const { tombstone } = r.storage.deleteSource('com.example.chat')
  const conn = new Database(path.join(r.dir, DB_FILE))
  conn.pragma('foreign_keys = ON')
  assert.throws(() => new Deleter(conn).run(tombstone, r.clock.t, { stopAfter: 'observations' }), /stopped after/)
  conn.close()
  r.close()
  const r2 = rig(r.dir, { holdDeletions: true })
  r2.clock.t = T0 + 2 * HOUR
  r2.feed(focus(editor, 'later.md - Editor', T0 + 2 * HOUR))
  r2.store.flush()
  assert.ok(r2.q<{ m: number }>(`SELECT max(id) AS m FROM observations`)[0]!.m > maxBefore, 'the new row has a new id')
  r2.close()
  const r3 = rig(r.dir)
  r3.clock.t = T0 + 2 * HOUR
  r3.storage.start()
  await r3.storage.deletionsSettled()
  assert.deepEqual(containsAnywhere(r3, 'Lynx'), [])
  assert.deepEqual(r3.q(`SELECT title FROM intervals ORDER BY start_wall_ms`), [{ title: 'early.md - Editor' }, { title: 'later.md - Editor' }])
  r3.close()
})

test('a site deletion completes on the capture-only schema, which has no page addresses yet', async () => {
  resetSeq()
  const r = rig()
  day(r, T0, [[editor, 'a.md - Editor'], [chat, 'b']])
  r.store.flush()
  r.clock.t = T0 + HOUR
  const result = await r.storage.deleteSite('example.com').done
  assert.equal(result.observations, 0)
  assert.notEqual(r.q<{ state: string }>(`SELECT state FROM deletions`)[0]!.state, 'pending')
  r.close()
})

for (const kind of ['range', 'source', 'site'] as const) {
  for (const stopAfter of ['hours', 'threads'] as const) {
    test(`mid-deletion (${kind}, stopped after ${stopAfter}): the fence still covers cleared hours, their threads and new references`, () => {
      const r = rig(tmpDir(), { holdDeletions: true })
      const sources = kind === 'source' ? [{ app_id: 'com.example.chat' }] : kind === 'site' ? [{ site: 'secret.example' }] : []
      const h = r.storage.writeHour({ start_wall_ms: T0, tz: 'Example/Town', status: 'written', title: 'Civet canary', sources }, r.storage.hourBasis(T0))
      const other = r.storage.writeHour({ start_wall_ms: T0 + 5 * HOUR, tz: 'Example/Town', status: 'written', title: 'Other' }, r.storage.hourBasis(T0 + 5 * HOUR))
      r.storage.createThread('Civet canary shared', [h.id, other.id])
      r.clock.t = T0 + 6 * HOUR
      const { tombstone } =
        kind === 'range' ? r.storage.deleteRange(T0 + MIN, T0 + 2 * MIN) : kind === 'source' ? r.storage.deleteSource('com.example.chat') : r.storage.deleteSite('secret.example')
      const conn = new Database(path.join(r.dir, DB_FILE))
      conn.pragma('foreign_keys = ON')
      assert.throws(() => new Deleter(conn).run(tombstone, r.clock.t, { stopAfter }), /stopped after/)
      conn.close()
      const span = { assistant: 'claude', tool: 'getDay', from_wall_ms: T0 + 5 * HOUR, to_wall_ms: T0 + 6 * HOUR }
      assert.throws(() => r.storage.createThread('Civet canary again', [h.id]), PendingDeletionError)
      assert.throws(() => r.storage.correct(h.id, 'title', 'Civet canary corrected'), PendingDeletionError)
      assert.throws(() => r.storage.recordAssistantRead({ ...span, query: 'Civet canary read', hours: [h.id] }), PendingDeletionError)
      assert.equal(r.storage.hour(h.id)?.title ?? null, null)
      assert.deepEqual(r.storage.threadsForHour(other.id).map((t) => t.title), [''], 'the shared thread shows no title until the deletion is done')
      r.close()
    })
  }
}
