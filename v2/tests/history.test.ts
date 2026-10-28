// Browser history readers: which visits are read, and that every one passes the same gate as capture.
process.env.TZ = 'Etc/GMT+5'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { DB_FILE } from '../capture/store.ts'
import { FROM_KEY, HistoryReader, historyCopyDir, historyProfiles, readVisits, snapshot, STATUS_KEY } from '../capture/history.ts'
import { Reader } from '../app/reader/queries.ts'
import * as today from '../app/reader/today.ts'
import { Reader as SearchReader } from '../retrieval/reader.ts'
import { search } from '../retrieval/search.ts'
import { HOUR, MIN, T0, rig, tmpDir } from './storage/support.ts'

// T0 is 01:00 in Example/Town.
const NOON = T0 + 11 * HOUR

const CHROMIUM_EPOCH_US = 11_644_473_600_000_000n
const LINK = 0x30000000 // a link, chain start and end
const chromeTime = (ms: number) => BigInt(ms) * 1000n + CHROMIUM_EPOCH_US

function chromiumHistory(file: string): Database.Database {
  mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.exec(`
    CREATE TABLE urls (id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR, hidden INTEGER DEFAULT 0 NOT NULL);
    CREATE TABLE visits (id INTEGER PRIMARY KEY AUTOINCREMENT, url INTEGER NOT NULL, visit_time INTEGER NOT NULL, transition INTEGER DEFAULT 0 NOT NULL,
      originator_cache_guid TEXT DEFAULT '');
    CREATE TABLE visit_source (id INTEGER PRIMARY KEY, source INTEGER NOT NULL);
  `)
  return db
}

function chromiumVisit(db: Database.Database, v: { url: string; title: string | null; at: number; transition?: number; hidden?: number; origin?: string; source?: number }): number {
  const u = db.prepare('INSERT INTO urls (url, title, hidden) VALUES (?, ?, ?)').run(v.url, v.title, v.hidden ?? 0).lastInsertRowid
  const id = Number(db.prepare('INSERT INTO visits (url, visit_time, transition, originator_cache_guid) VALUES (?, ?, ?, ?)').run(u, chromeTime(v.at), v.transition ?? LINK, v.origin ?? '').lastInsertRowid)
  if (v.source !== undefined) db.prepare('INSERT INTO visit_source (id, source) VALUES (?, ?)').run(id, v.source)
  return id
}

function chromeHome(home: string, profiles: string[]): void {
  const root = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome')
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { info_cache: Object.fromEntries(profiles.map((p) => [p, { name: 'Invented' }])) } }))
}

const chromeFile = (home: string, profile = 'Default') => path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', profile, 'History')

test('a Chromium history yields only pages opened on this computer: no redirects, subframes, synced, extension or hidden visits', () => {
  const dir = tmpDir()
  const db = chromiumHistory(path.join(dir, 'History'))
  const at = T0 + 9 * HOUR
  const kept = chromiumVisit(db, { url: 'https://garden.example/plan', title: 'Garden plan', at })
  chromiumVisit(db, { url: 'https://short.example/r', title: 'Redirect', at: at + 1000, transition: 0x10000000 })
  const end = chromiumVisit(db, { url: 'https://garden.example/beds', title: 'Garden beds', at: at + 1000, transition: Number(BigInt.asIntN(32, 0xa0000006n)) })
  chromiumVisit(db, { url: 'https://ads.example/frame', title: 'Frame', at: at + 2000, transition: LINK | 3 })
  chromiumVisit(db, { url: 'https://phone.example/', title: 'From the phone', at: at + 3000, origin: 'another-device' })
  chromiumVisit(db, { url: 'https://ext.example/', title: 'Added by an extension', at: at + 4000, source: 2 })
  chromiumVisit(db, { url: 'https://hidden.example/', title: 'Hidden', at: at + 5000, hidden: 1 })
  chromiumVisit(db, { url: 'https://early.example/', title: 'Before the start', at: at - 2 * HOUR })
  const r = readVisits(db, 'chromium', 0, at - HOUR)
  assert.deepEqual(
    r.visits.map((v) => [v.id, v.url, v.wall_ms]),
    [
      [kept, 'https://garden.example/plan', at],
      [end, 'https://garden.example/beds', at + 1000],
    ],
  )
  assert.equal(r.lastId, 7)
  assert.equal(readVisits(db, 'chromium', r.lastId, at - HOUR).visits.length, 0)
  db.close()
})

test('a Firefox history skips embeds, downloads, framed links, synced and hidden visits', () => {
  const dir = tmpDir()
  const db = new Database(path.join(dir, 'places.sqlite'))
  db.exec(`
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, hidden INTEGER DEFAULT 0 NOT NULL);
    CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, from_visit INTEGER, place_id INTEGER, visit_date INTEGER, visit_type INTEGER, source INTEGER DEFAULT 0 NOT NULL);
  `)
  const at = T0 + 9 * HOUR
  const add = (url: string, type: number, opts: { source?: number; hidden?: number } = {}) => {
    const p = db.prepare('INSERT INTO moz_places (url, title, hidden) VALUES (?, ?, ?)').run(url, url, opts.hidden ?? 0).lastInsertRowid
    db.prepare('INSERT INTO moz_historyvisits (place_id, visit_date, visit_type, source) VALUES (?, ?, ?, ?)').run(p, at * 1000, type, opts.source ?? 0)
  }
  add('https://a.example/', 1)
  add('https://b.example/', 2)
  add('https://embed.example/', 4)
  add('https://file.example/x.zip', 7)
  add('https://frame.example/', 8)
  add('https://synced.example/', 1, { source: 4 })
  add('https://hidden.example/', 1, { hidden: 1 })
  add('https://c.example/', 6)
  assert.deepEqual(
    readVisits(db, 'firefox', 0, at).visits.map((v) => [v.url, v.wall_ms]),
    [
      ['https://a.example/', at],
      ['https://b.example/', at],
      ['https://c.example/', at],
    ],
  )
  db.close()
})

test('a Firefox redirect chain counts only its destination, even when the pages it passed through are not hidden', () => {
  const dir = tmpDir()
  const db = new Database(path.join(dir, 'places.sqlite'))
  db.exec(`
    CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, hidden INTEGER DEFAULT 0 NOT NULL);
    CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, from_visit INTEGER, place_id INTEGER, visit_date INTEGER, visit_type INTEGER, source INTEGER DEFAULT 0 NOT NULL);
  `)
  const at = T0 + 9 * HOUR
  const add = (url: string, type: number, from: number | null) => {
    const p = db.prepare('INSERT INTO moz_places (url, title) VALUES (?, ?)').run(url, url).lastInsertRowid
    return Number(db.prepare('INSERT INTO moz_historyvisits (from_visit, place_id, visit_date, visit_type) VALUES (?, ?, ?, ?)').run(from, p, at * 1000, type).lastInsertRowid)
  }
  const link = add('https://short.example/go', 1, null)
  const hop = add('https://login.example/check', 5, link)
  add('https://garden.example/plan', 6, hop)
  add('https://garden.example/beds', 1, add('https://garden.example/', 2, null))
  assert.deepEqual(
    readVisits(db, 'firefox', 0, at).visits.map((v) => v.url),
    ['https://garden.example/plan', 'https://garden.example/', 'https://garden.example/beds'],
  )
  db.close()
})

test('only the profiles a browser lists are read: a Guest profile or a stray folder is not', () => {
  const home = tmpDir()
  chromeHome(home, ['Default', 'Profile 1'])
  for (const p of ['Default', 'Profile 1', 'Guest Profile', 'Profile 9']) chromiumHistory(chromeFile(home, p)).close()
  const ff = path.join(home, 'Library', 'Application Support', 'Firefox')
  mkdirSync(path.join(ff, 'Profiles', 'abc.default-release'), { recursive: true })
  writeFileSync(path.join(ff, 'Profiles', 'abc.default-release', 'places.sqlite'), '')
  writeFileSync(path.join(ff, 'profiles.ini'), '[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\n')
  assert.deepEqual(
    historyProfiles(home).map((p) => [p.browser.name, p.profile]),
    [
      ['Google Chrome', 'Default'],
      ['Google Chrome', 'Profile 1'],
      ['Firefox', 'Profiles/abc.default-release'],
    ],
  )
})

test('a snapshot copies the history file with its log, readable while the original stays open for writing', async () => {
  const dir = tmpDir()
  const file = path.join(dir, 'src', 'History')
  const db = chromiumHistory(file)
  db.pragma('journal_mode = WAL')
  chromiumVisit(db, { url: 'https://garden.example/', title: 'Garden', at: T0 })
  const copy = await snapshot(file, path.join(dir, 'copy'))
  const c = new Database(copy)
  assert.equal(readVisits(c, 'chromium', 0, 0).visits.length, 1)
  c.close()
  db.close()
})

test('the copy of a history file is kept in a private temporary folder, outside the data folder and backups', async () => {
  const dir = tmpDir()
  const copyDir = historyCopyDir(path.join(dir, 'data'))
  assert.equal(path.dirname(copyDir), os.tmpdir())
  assert.notEqual(copyDir, historyCopyDir(path.join(dir, 'other-data')), 'each data folder has its own')
  mkdirSync(copyDir, { recursive: true, mode: 0o755 })
  const db = chromiumHistory(path.join(dir, 'src', 'History'))
  await snapshot(path.join(dir, 'src', 'History'), copyDir)
  assert.equal(statSync(copyDir).mode & 0o777, 0o700)
  db.close()
  rmSync(copyDir, { recursive: true, force: true })
})

function setup() {
  const r = rig()
  const home = tmpDir()
  chromeHome(home, ['Default'])
  const hist = chromiumHistory(chromeFile(home))
  const reader = () => new HistoryReader(r.store, { home, copyDir: path.join(r.dir, 'history-copy'), intervalMs: 60_000, now: () => r.clock.t })
  const visits = () => r.q<{ url: string; title: string | null; event_wall_ms: number; app_id: string }>(`SELECT url, title, event_wall_ms, app_id FROM observations WHERE kind = 'visit' ORDER BY event_wall_ms`)
  return { r, home, hist, reader, visits }
}

test('the first read starts at the beginning of that day, later reads take only new visits, and visits get no time', async () => {
  const { r, hist, reader, visits } = setup()
  const dayStart = NOON - 12 * HOUR
  chromiumVisit(hist, { url: 'https://yesterday.example/', title: 'Yesterday', at: dayStart - MIN })
  chromiumVisit(hist, { url: 'https://garden.example/plan', title: 'Garden plan', at: dayStart + 2 * HOUR })
  r.clock.t = NOON + 30 * MIN
  r.storage.start()
  const h = reader()
  await h.readAll()
  assert.equal(r.q<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, FROM_KEY)[0]!.value, String(dayStart))
  assert.deepEqual(visits().map((v) => [v.url, v.app_id]), [['https://garden.example/plan', 'com.google.Chrome']])
  chromiumVisit(hist, { url: 'https://garden.example/beds', title: 'Garden beds', at: NOON + 31 * MIN })
  await h.readAll()
  await h.readAll()
  assert.deepEqual(visits().map((v) => v.url), ['https://garden.example/plan', 'https://garden.example/beds'])
  assert.equal(r.q<{ n: number }>('SELECT count(*) AS n FROM intervals')[0]!.n, 0)
  assert.deepEqual(JSON.parse(r.q<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, STATUS_KEY)[0]!.value), [{ name: 'Google Chrome', app_id: 'com.google.Chrome', state: 'ok' }])
  hist.close()
  r.close()
})

test('pause, excluded sites and apps, and deletions keep visits out, and a deleted range does not come back when history is read again', async () => {
  const { r, hist, reader, visits } = setup()
  const at = NOON - 3 * HOUR
  r.clock.t = NOON
  r.storage.start()
  r.storage.addExclusion({ match: 'site', value: 'bank.example', label: 'Bank' })
  // Paused now, so the visit made during the pause is read after it ended.
  const pause = r.storage.pause(NOON + 10 * MIN)
  assert.ok(pause)
  chromiumVisit(hist, { url: 'https://garden.example/plan', title: 'Garden plan', at })
  chromiumVisit(hist, { url: 'https://online.bank.example/login', title: 'Bank login', at: at + MIN })
  chromiumVisit(hist, { url: 'https://recipes.example/soup', title: 'Soup', at: at + 2 * MIN })
  chromiumVisit(hist, { url: 'https://during-pause.example/', title: 'During the pause', at: NOON + 5 * MIN })
  r.clock.t = NOON + 20 * MIN
  await reader().readAll()
  assert.deepEqual(visits().map((v) => v.url), ['https://garden.example/plan', 'https://recipes.example/soup'])
  assert.equal(r.q<{ n: number }>(`SELECT count(*) AS n FROM capture_gaps WHERE reason = 'excluded'`)[0]!.n, 0)

  await r.storage.deleteRange(at + MIN, at + 3 * MIN).done
  assert.deepEqual(visits().map((v) => v.url), ['https://garden.example/plan'])

  // Every cursor lost: the whole day is read again, and only what may be stored comes back.
  r.store.flush()
  r.store.database.prepare(`DELETE FROM meta WHERE key LIKE 'history_cursor:%'`).run()
  r.store.database.prepare(`DELETE FROM observations WHERE kind = 'visit'`).run()
  await reader().readAll()
  assert.deepEqual(visits().map((v) => v.url), ['https://garden.example/plan'])

  r.storage.addExclusion({ match: 'app_id', value: 'com.google.Chrome', label: 'Chrome' })
  chromiumVisit(hist, { url: 'https://later.example/', title: 'Later', at: NOON + 21 * MIN })
  r.clock.t = NOON + 22 * MIN
  await reader().readAll()
  assert.deepEqual(visits().map((v) => v.url), ['https://garden.example/plan'])
  hist.close()
  r.close()
})

test('a profile read empty on its first day still reads what was visited before a restart the next day', async () => {
  const { r, home, hist } = setup()
  r.clock.t = NOON
  r.storage.start()
  const copyDir = path.join(r.dir, 'history-copy')
  await new HistoryReader(r.store, { home, copyDir, intervalMs: 60_000, now: () => r.clock.t }).readAll()
  r.close()
  chromiumVisit(hist, { url: 'https://evening.example/', title: 'Evening', at: NOON + 8 * HOUR })
  const r2 = rig(r.dir)
  r2.clock.t = NOON + 24 * HOUR
  r2.storage.start()
  await new HistoryReader(r2.store, { home, copyDir, intervalMs: 60_000, now: () => r2.clock.t }).readAll()
  assert.deepEqual(r2.q<{ url: string }>(`SELECT url FROM observations WHERE kind = 'visit'`).map((v) => v.url), ['https://evening.example/'])
  hist.close()
  r2.close()
})

test('a page title written after a visit, during a pause, is not stored with that visit', async () => {
  const { r, hist, reader, visits } = setup()
  r.clock.t = NOON - HOUR
  r.storage.start()
  chromiumVisit(hist, { url: 'https://mail.example/inbox', title: 'Inbox', at: NOON - 2 * HOUR })
  r.storage.pause(NOON - HOUR + 10 * MIN)
  // The same address visited again while paused: the browser keeps one title per address and rewrites it.
  const u = hist.prepare('SELECT url FROM visits ORDER BY id DESC LIMIT 1').get() as { url: number }
  hist.prepare('INSERT INTO visits (url, visit_time, transition) VALUES (?, ?, ?)').run(u.url, chromeTime(NOON - HOUR + 5 * MIN), LINK)
  hist.prepare('UPDATE urls SET title = ? WHERE id = ?').run('Inbox: a message read while paused', u.url)
  chromiumVisit(hist, { url: 'https://garden.example/plan', title: 'Garden plan', at: NOON - 30 * MIN })
  r.clock.t = NOON
  await reader().readAll()
  assert.deepEqual(
    visits().map((v) => [v.url, v.title]),
    [
      ['https://mail.example/inbox', null],
      ['https://garden.example/plan', 'Garden plan'],
    ],
  )
  hist.close()
  r.close()
})

test('a page title written while its site was excluded is not stored with an earlier visit read after the exclusion ends', async () => {
  const { r, hist, reader, visits } = setup()
  r.clock.t = NOON - HOUR
  r.storage.start()
  chromiumVisit(hist, { url: 'https://mail.example/inbox', title: 'Inbox', at: NOON - 2 * HOUR })
  r.storage.addExclusion({ match: 'site', value: 'mail.example', label: 'Mail' })
  const u = hist.prepare('SELECT url FROM visits ORDER BY id DESC LIMIT 1').get() as { url: number }
  hist.prepare('INSERT INTO visits (url, visit_time, transition) VALUES (?, ?, ?)').run(u.url, chromeTime(NOON - HOUR + 5 * MIN), LINK)
  hist.prepare('UPDATE urls SET title = ? WHERE id = ?').run('Inbox: a message read while excluded', u.url)
  r.clock.t = NOON - HOUR + 10 * MIN
  r.storage.removeExclusion('site', 'mail.example')
  r.clock.t = NOON
  await reader().readAll()
  assert.deepEqual(visits().map((v) => [v.url, v.event_wall_ms, v.title]), [['https://mail.example/inbox', NOON - 2 * HOUR, null]])
  hist.close()
  r.close()
})

test('after a restart, deleted and excluded visits stay out and new ones are read', async () => {
  const { r, home, hist, visits } = setup()
  const at = NOON - 3 * HOUR
  r.clock.t = NOON
  r.storage.start()
  chromiumVisit(hist, { url: 'https://garden.example/plan', title: 'Garden plan', at })
  chromiumVisit(hist, { url: 'https://recipes.example/soup', title: 'Soup', at: at + MIN })
  const copyDir = path.join(r.dir, 'history-copy')
  await new HistoryReader(r.store, { home, copyDir, intervalMs: 60_000, now: () => r.clock.t }).readAll()
  await r.storage.deleteSite('recipes.example').done
  r.storage.addExclusion({ match: 'site', value: 'garden.example', label: 'Garden' })
  await r.storage.deleteEverything().done
  assert.deepEqual(visits(), [])
  r.close()

  const r2 = rig(r.dir)
  r2.clock.t = NOON + HOUR
  r2.storage.start()
  r2.store.database.prepare(`DELETE FROM meta WHERE key LIKE 'history_cursor:%'`).run()
  chromiumVisit(hist, { url: 'https://garden.example/beds', title: 'Garden beds', at: NOON + HOUR - MIN })
  chromiumVisit(hist, { url: 'https://new.example/', title: 'New', at: NOON + HOUR - MIN })
  await new HistoryReader(r2.store, { home, copyDir, intervalMs: 60_000, now: () => r2.clock.t }).readAll()
  assert.deepEqual(
    r2.q<{ url: string }>(`SELECT url FROM observations WHERE kind = 'visit'`).map((v) => v.url),
    ['https://new.example/'],
  )
  hist.close()
  r2.close()
})

test('Today shows an hour known only from history as pages opened, marked, with no time, and its visits as sources', async () => {
  const { r, hist, reader } = setup()
  r.clock.t = NOON + 30 * MIN
  r.storage.start()
  chromiumVisit(hist, { url: 'https://garden.example/plan', title: 'Garden plan', at: NOON - 2 * HOUR + 5 * MIN })
  chromiumVisit(hist, { url: 'https://garden.example/plan', title: 'Garden plan', at: NOON - 2 * HOUR + 9 * MIN })
  chromiumVisit(hist, { url: 'https://recipes.example/soup', title: 'Soup', at: NOON - 2 * HOUR + 7 * MIN })
  await reader().readAll()
  r.store.flush()
  await r.storage.derivationSettled()
  const db = new Database(path.join(r.dir, DB_FILE), { readonly: true })
  const view = new Reader(db, () => r.clock.t)
  const day = view.day('2026-10-16')
  const hour = day.hours.find((h) => h.start_ms === NOON - 2 * HOUR)!
  assert.equal(hour.from_history, true)
  assert.equal(hour.gap, null)
  assert.deepEqual(hour.facts.apps, [{ id: 'com.google.Chrome', name: 'Google Chrome', ms: 0 }])
  assert.deepEqual(hour.facts.titles, ['Garden plan', 'Soup'])
  assert.equal(day.total_ms, 0)
  const sources = today.hour(view, NOON - 2 * HOUR).sources
  assert.deepEqual(
    sources.map((s) => [s.kind, s.title, s.first_ms, s.last_ms, s.ms]),
    [
      ['visit', 'Garden plan', NOON - 2 * HOUR + 5 * MIN, NOON - 2 * HOUR + 9 * MIN, 0],
      ['visit', 'Soup', NOON - 2 * HOUR + 7 * MIN, NOON - 2 * HOUR + 7 * MIN, 0],
    ],
  )
  assert.deepEqual(view.recording().browsers, [{ name: 'Google Chrome', app_id: 'com.google.Chrome', state: 'ok' }])
  db.close()
  hist.close()
  r.close()
})

test('pages known only from history can be searched, as moments with no time, through rebuilds and deletions', async () => {
  const { r, hist, reader } = setup()
  r.clock.t = NOON
  r.storage.start()
  chromiumVisit(hist, { url: 'https://garden.example/plan', title: 'Garden plan', at: NOON - 2 * HOUR + 5 * MIN })
  chromiumVisit(hist, { url: 'https://garden.example/soil', title: 'Garden soil', at: NOON - 2 * HOUR + 40 * MIN })
  await reader().readAll()
  r.store.flush()
  await r.storage.derivationSettled()
  const found = () => {
    const s = SearchReader.open(path.join(r.dir, DB_FILE))
    const res = search(s, 'garden', { perGroup: 5 })
    s.close()
    return res.pages.map((p) => [p.url, p.sightings.map((x) => [x.from_wall_ms, x.to_wall_ms])])
  }
  const plan = ['https://garden.example/plan', [[NOON - 2 * HOUR + 5 * MIN, NOON - 2 * HOUR + 5 * MIN]]]
  const soil = ['https://garden.example/soil', [[NOON - 2 * HOUR + 40 * MIN, NOON - 2 * HOUR + 40 * MIN]]]
  assert.deepEqual(found().sort(), [plan, soil])
  r.storage.derived.rebuild()
  assert.deepEqual(found().sort(), [plan, soil])
  await r.storage.deleteRange(NOON - 2 * HOUR + 30 * MIN, NOON - HOUR + 30 * MIN).done
  assert.deepEqual(found(), [plan])
  hist.close()
  r.close()
})

test('a day known only from history is marked in the calendar, shows in the week and month, and counts as the first day', async () => {
  const { r, hist, reader } = setup()
  r.clock.t = NOON
  r.storage.start()
  await reader().readAll()
  r.store.flush()
  chromiumVisit(hist, { url: 'https://evening.example/', title: 'Evening', at: NOON + 8 * HOUR })
  r.clock.t = NOON + 24 * HOUR
  await reader().readAll()
  r.store.flush()
  const db = new Database(path.join(r.dir, DB_FILE), { readonly: true })
  const view = new Reader(db, () => r.clock.t)
  assert.deepEqual(view.recordedDays('2026-10'), ['2026-10-16'])
  assert.equal(view.firstDay(), '2026-10-16')
  const week = today.week(view, '2026-10-12').days.find((d) => d.date === '2026-10-16')!
  assert.deepEqual(week, { date: '2026-10-16', total_ms: 0, blocks: [{ start_ms: NOON + 8 * HOUR, title: 'Google Chrome', written: false }] })
  const month = today.month(view, '2026-10')
  assert.deepEqual(month.days.find((d) => d.date === '2026-10-16'), { date: '2026-10-16', total_ms: 0, apps: [{ id: 'com.google.Chrome', name: 'Google Chrome', ms: 0 }] })
  assert.equal(month.total_ms, 0)
  db.close()
  hist.close()
  r.close()
})
