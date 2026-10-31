// The interface's reader: what a screen shows follows the same privacy rules as the engine's own readers.
process.env.TZ = 'Etc/GMT+5'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import path from 'node:path'
import * as apps from '../../app/reader/apps.ts'
import { Reader } from '../../app/reader/queries.ts'
import * as today from '../../app/reader/today.ts'
import { openReadOnly, Reader as RetrievalReader } from '../../retrieval/reader.ts'
import { search } from '../../retrieval/search.ts'
import { handleControl, type ControlReply } from '../../capture/control.ts'
import { DB_FILE } from '../../capture/store.ts'
import { app, focus, line, resetSeq } from '../support/lines.ts'
import { HOUR, MIN, T0, rig } from '../storage/support.ts'

const notes = app('com.example.notes', { name: 'Notes' })
const sheets = app('com.example.sheets', { name: 'Sheets' })
const DAY = '2026-10-16'

function work(r: ReturnType<typeof rig>, from: number, items: [ReturnType<typeof app>, string, number][]): number {
  let t = from
  for (const [a, title, mins] of items) {
    r.feed(focus(a, title, t))
    r.feed(focus(a, title, t + mins * MIN - 1000, 'reconcile'))
    t += mins * MIN
  }
  return t
}

function readOnly(r: ReturnType<typeof rig>): { reader: Reader; db: Database.Database } {
  r.store.flush()
  const db = new Database(path.join(r.dir, DB_FILE), { readonly: true })
  return { reader: new Reader(db, () => r.clock.t), db }
}

test('a day shows each hour as recorded facts: its apps, longest first, and its window titles', async () => {
  resetSeq()
  const r = rig()
  const end = work(r, T0 + 9 * HOUR, [
    [notes, 'Order list', 40],
    [sheets, 'Flour costs', 20],
    [sheets, 'Flour costs', 30],
  ])
  r.clock.t = end + 5 * MIN
  r.storage.start()
  await r.storage.derivationSettled()
  const { reader, db } = readOnly(r)
  const day = reader.day(DAY)
  assert.deepEqual(
    day.hours.map((h) => h.start_ms),
    [T0 + 9 * HOUR, T0 + 10 * HOUR],
  )
  assert.deepEqual(
    day.hours[0]!.facts.apps.map((a) => a.name),
    ['Notes', 'Sheets'],
  )
  assert.deepEqual(day.hours[0]!.facts.titles, ['Order list', 'Flour costs'])
  assert.equal(day.hours[1]!.current, true)
  db.close()
  r.close()
})

test('an hour with nothing recorded says why: the computer was asleep', async () => {
  resetSeq()
  const r = rig()
  work(r, T0 + 9 * HOUR, [[notes, 'Order list', 50]])
  r.feed(line('power', { state: 'sleep' }, T0 + 10 * HOUR))
  r.feed(line('power', { state: 'resume_user' }, T0 + 11 * HOUR))
  const end = work(r, T0 + 11 * HOUR + MIN, [[notes, 'Order list', 30]])
  r.clock.t = end + 60 * MIN
  r.storage.start()
  await r.storage.derivationSettled()
  const { reader, db } = readOnly(r)
  const gap = reader.day(DAY).hours.find((h) => h.start_ms === T0 + 10 * HOUR)!
  assert.equal(gap.gap, 'asleep')
  assert.equal(gap.facts.apps.length, 0)
  db.close()
  r.close()
})

test('a window that comes to the front while nobody is at the computer adds no time to the day or its apps', async () => {
  resetSeq()
  const r = rig()
  const nine = T0 + 9 * HOUR
  work(r, nine, [[notes, 'Order list', 10]])
  r.feed(line('input', { state: 'idle', last_input_wall_ms: nine + 10 * MIN - 1000, threshold_s: 120, snapshot: false }, nine + 12 * MIN))
  work(r, nine + 20 * MIN, [[sheets, 'Flour costs', 20]])
  r.feed(line('input', { state: 'active', last_input_wall_ms: nine + 45 * MIN, threshold_s: 120, snapshot: false }, nine + 45 * MIN))
  const end = work(r, nine + 45 * MIN, [[notes, 'Order list', 15]])
  r.clock.t = end + 5 * MIN
  r.storage.start()
  await r.storage.derivationSettled()
  const { reader, db } = readOnly(r)
  const day = reader.day(DAY)
  assert.deepEqual(day.hours[0]!.facts.apps.map((a) => a.name), ['Notes'])
  assert.ok(Math.abs(day.total_ms - 25 * MIN) < 5000, `day total ${day.total_ms / MIN} min`)
  assert.deepEqual(reader.appTotals(reader.spans(nine, end)).map((a) => a.name), ['Notes'])
  db.close()
  r.close()
})

test('idle noticed after an hour ends still takes the windows after the last input out of that hour', async () => {
  resetSeq()
  const r = rig()
  const nine = T0 + 9 * HOUR, ten = T0 + 10 * HOUR
  work(r, nine, [[notes, 'Order list', 59]])
  r.feed(focus(sheets, 'Flour costs', ten - 50_000))
  r.feed(focus(app('com.example.mail', { name: 'Mail' }), 'Inbox', ten - 30_000))
  r.feed(line('input', { state: 'idle', last_input_wall_ms: ten - 60_000, threshold_s: 120, snapshot: false }, ten + 60_000))
  r.clock.t = ten + 30 * MIN
  r.storage.start()
  await r.storage.derivationSettled()
  const { reader, db } = readOnly(r)
  assert.deepEqual(reader.appTotals(reader.spans(nine, ten)).map((a) => a.name), ['Notes'])
  assert.deepEqual(reader.day(DAY).hours[0]!.facts.apps.map((a) => a.name), ['Notes'])
  db.close()
  r.close()
})

test('a deletion hides what it covers from every screen while it is still being carried out', async () => {
  resetSeq()
  const r = rig(undefined, { holdDeletions: true })
  const end = work(r, T0 + 9 * HOUR, [
    [notes, 'Order list', 30],
    [sheets, 'Flour costs', 30],
  ])
  r.clock.t = end + 5 * MIN
  r.storage.start()
  await r.storage.derivationSettled()
  const { reader, db } = readOnly(r)
  assert.ok(reader.day(DAY).hours[0]!.facts.titles.includes('Flour costs'))
  // The fence commits; the removal itself is held back, so the rows are still in the database.
  r.storage.deleteSource('com.example.sheets', { from_wall_ms: T0, to_wall_ms: T0 + 23 * HOUR })
  assert.ok((db.prepare(`SELECT count(*) AS n FROM intervals WHERE app_id = 'com.example.sheets'`).get() as { n: number }).n > 0)
  // No change announcement has reached this reader yet: the fence alone hides the material.
  const after = reader.day(DAY)
  assert.deepEqual(
    after.hours[0]!.facts.apps.map((a) => a.id),
    ['com.example.notes'],
  )
  assert.ok(!after.hours[0]!.facts.titles.includes('Flour costs'))
  assert.equal(apps.app(reader, 'com.example.sheets', DAY, 1), null)
  assert.ok(!today.hour(reader, T0 + 9 * HOUR).sources.some((s) => s.title === 'Flour costs'))
  assert.ok(!today.leftOff(reader).some((s) => s.title === 'Flour costs'))
  db.close()
  r.close()
})

test('a range deletion cuts its span out of an interval and leaves the rest', async () => {
  resetSeq()
  const r = rig(undefined, { holdDeletions: true })
  const end = work(r, T0 + 9 * HOUR, [[notes, 'Order list', 60]])
  r.clock.t = end + 5 * MIN
  r.storage.start()
  await r.storage.derivationSettled()
  const { reader, db } = readOnly(r)
  r.storage.deleteRange(T0 + 9 * HOUR + 20 * MIN, T0 + 9 * HOUR + 40 * MIN)
  const ms = reader.day(DAY).hours[0]!.facts.apps[0]!.ms
  assert.ok(ms > 38 * MIN && ms <= 40 * MIN, `kept ${ms / MIN} minutes`)
  db.close()
  r.close()
})

test('nothing older than the retention period is shown, before the purge reaches it', async () => {
  resetSeq()
  const r = rig()
  work(r, T0 + 9 * HOUR, [[notes, 'Order list', 30]])
  r.clock.t = T0 + 5 * 24 * HOUR
  r.storage.start()
  await r.storage.derivationSettled()
  const { reader, db } = readOnly(r)
  assert.equal(reader.firstDay(), DAY)
  handleControl(r.storage, { op: 'retention', id: '1', days: 2 }, () => {})
  reader.invalidate()
  assert.equal(reader.day(DAY).hours.length, 0)
  assert.equal(reader.firstDay(), null)
  db.close()
  r.close()
})

test('as time passes, a day that leaves the retention period disappears without any other change', async () => {
  resetSeq()
  const r = rig()
  work(r, T0 + 9 * HOUR, [[notes, 'Order list', 30]])
  r.clock.t = T0 + 24 * HOUR
  r.storage.start()
  await r.storage.derivationSettled()
  handleControl(r.storage, { op: 'retention', id: '1', days: 2 }, () => {})
  const { reader, db } = readOnly(r)
  assert.equal(reader.firstDay(), DAY)
  r.clock.t = T0 + 4 * 24 * HOUR
  assert.equal(reader.firstDay(), null)
  db.close()
  r.close()
})

test('removing an app from today ends the deletion now, so the rest of the day still records', async () => {
  resetSeq()
  const r = rig()
  const end = work(r, T0 + 9 * HOUR, [[notes, 'Order list', 30]])
  r.clock.t = end + MIN
  r.storage.start()
  await r.storage.derivationSettled()
  handleControl(r.storage, { op: 'delete', id: 'd', what: { kind: 'app', app_id: 'com.example.notes', from_wall_ms: T0, to_wall_ms: T0 + 23 * HOUR } }, () => {}, () => r.clock.t)
  assert.equal(r.storage.accepts(T0 + 9 * HOUR + MIN, 'com.example.notes', null), false)
  assert.equal(r.storage.accepts(r.clock.t + MIN, 'com.example.notes', null), true)
  r.close()
})

test('control ops reply once each, and a bad op is refused with a reason', async () => {
  resetSeq()
  const r = rig()
  r.storage.start()
  const replies: ControlReply[] = []
  const send = (m: ControlReply) => replies.push(m)
  assert.equal(handleControl(r.storage, { op: 'pause', id: 'p', until: 'hour' }, send), true)
  assert.equal(r.storage.paused()?.until_wall_ms, r.clock.t + HOUR)
  handleControl(r.storage, { op: 'resume', id: 'r' }, send)
  assert.equal(r.storage.paused(), null)
  handleControl(r.storage, { op: 'exclude', id: 'e', rule: { match: 'site', value: 'example.org', label: 'example.org' } }, send)
  assert.ok(r.store.exclusions().some((e) => e.value === 'example.org'))
  handleControl(r.storage, { op: 'pause', id: 'bad', until: 'forever' }, send)
  handleControl(r.storage, { op: 'delete', id: 'bad2', what: { kind: 'range', from_wall_ms: 10, to_wall_ms: 5 } }, send)
  handleControl(r.storage, { op: 'setting', id: 'bad3', key: 'retention_days', value: 1 }, send)
  assert.equal(handleControl(r.storage, { op: 'pair', link: 'x' }, send), false)
  assert.deepEqual(
    replies.map((m) => [m.id, m.op === 'reply' && m.ok]),
    [
      ['p', true],
      ['r', true],
      ['e', true],
      ['bad', false],
      ['bad2', false],
      ['bad3', false],
    ],
  )
  r.close()
})

test('a deletion is in force when its reply is sent, and reports done once removed', async () => {
  resetSeq()
  const r = rig()
  const end = work(r, T0 + 9 * HOUR, [[notes, 'Order list', 30]])
  r.clock.t = end + MIN
  r.storage.start()
  await r.storage.derivationSettled()
  const replies: ControlReply[] = []
  const done = new Promise<void>((resolve) =>
    handleControl(r.storage, { op: 'delete', id: 'd', what: { kind: 'app', app_id: 'com.example.notes' } }, (m) => {
      replies.push(m)
      if (m.op === 'deletion' && m.state === 'done') resolve()
    }),
  )
  assert.equal(replies[0]?.op === 'reply' && replies[0].ok, true)
  assert.equal(r.storage.accepts(T0 + 9 * HOUR + MIN, 'com.example.notes', null), false)
  await done
  assert.equal(r.q<{ n: number }>(`SELECT count(*) AS n FROM intervals WHERE app_id = 'com.example.notes'`)[0]!.n, 0)
  r.close()
})

test('search and the day share one connection: what a deletion covers leaves both at once', async () => {
  resetSeq()
  const r = rig(undefined, { holdDeletions: true })
  const end = work(r, T0 + 9 * HOUR, [
    [notes, 'Order list', 30],
    [sheets, 'Flour costs', 30],
  ])
  r.clock.t = end + 5 * MIN
  r.storage.start()
  await r.storage.derivationSettled()
  r.store.flush()
  const db = openReadOnly(path.join(r.dir, DB_FILE))
  const reader = new Reader(db, () => r.clock.t)
  const finder = new RetrievalReader(db)
  const found = () => reader.read(() => search(finder, 'flour', { perGroup: 5 }).windows.map((w) => w.title))
  assert.deepEqual(found(), ['Flour costs'])
  r.storage.deleteSource('com.example.sheets', { from_wall_ms: T0, to_wall_ms: r.clock.t })
  assert.deepEqual(found(), [])
  assert.ok(!reader.read(() => reader.day(DAY)).hours.some((h) => h.facts.titles.includes('Flour costs')))
  db.close()
  r.close()
})

test('search hides what is past the retention period, before pruning reaches it', async () => {
  resetSeq()
  const r = rig()
  work(r, T0 + 9 * HOUR, [[sheets, 'Flour costs', 30]])
  r.clock.t = T0 + 24 * HOUR
  r.storage.start()
  await r.storage.derivationSettled()
  handleControl(r.storage, { op: 'retention', id: '1', days: 2 }, () => {})
  r.store.flush()
  const db = openReadOnly(path.join(r.dir, DB_FILE))
  const reader = new Reader(db, () => r.clock.t)
  const finder = new RetrievalReader(db)
  const found = () => search(finder, 'flour', { perGroup: 5, fromWallMs: reader.cutoff() ?? undefined }).windows.length
  assert.equal(found(), 1)
  r.clock.t = T0 + 4 * 24 * HOUR
  assert.equal(found(), 0)
  db.close()
  r.close()
})

test('a window opens to the newest file it showed under that title, found by app and title', async () => {
  resetSeq()
  const r = rig()
  const withFile = (l: ReturnType<typeof focus>, file: string) => ((l.obs as { window: { document?: string } }).window.document = file, l)
  const t = T0 + 9 * HOUR
  r.feed(withFile(focus(notes, 'Plan.txt', t), '/Users/example/Old/Plan.txt'))
  r.feed(focus(notes, 'Untitled', t + 10 * MIN))
  r.feed(withFile(focus(notes, 'Plan.txt', t + 20 * MIN), '/Users/example/Plan.txt'))
  r.feed(focus(sheets, 'Plan.txt', t + 30 * MIN))
  r.clock.t = t + 40 * MIN
  r.storage.start()
  await r.storage.derivationSettled()
  const { reader, db } = readOnly(r)
  assert.deepEqual(reader.document(notes.app_id!, 'Plan.txt'), { path: '/Users/example/Plan.txt', app_path: notes.path })
  assert.equal(reader.document(notes.app_id!, 'Untitled'), null)
  assert.equal(reader.document(sheets.app_id!, 'Plan.txt'), null, 'another app with the same title has no file')
  db.close()
  r.close()
})

test('a file being deleted is never reopened, and a decomposed file name is found by the title Search shows', async () => {
  resetSeq()
  const r = rig(undefined, { holdDeletions: true })
  const withFile = (l: ReturnType<typeof focus>, file: string) => ((l.obs as { window: { document?: string } }).window.document = file, l)
  const t = T0 + 9 * HOUR
  const decomposed = 'Café menu.txt'
  r.feed(withFile(focus(notes, 'Plan.txt', t), '/Users/example/Old/Plan.txt'))
  r.feed(withFile(focus(notes, decomposed, t + 10 * MIN), '/Users/example/Café menu.txt'))
  r.feed(withFile(focus(notes, decomposed, t + 19 * MIN, 'reconcile'), '/Users/example/Café menu.txt'))
  r.feed(withFile(focus(notes, 'Plan.txt', t + 20 * MIN), '/Users/example/Plan.txt'))
  r.feed(focus(sheets, 'Order list', t + 30 * MIN))
  r.clock.t = t + 40 * MIN
  r.storage.start()
  await r.storage.derivationSettled()
  r.storage.deleteRange(t + 20 * MIN, t + 30 * MIN)
  r.storage.deleteRange(t + 12 * MIN, t + 15 * MIN)
  const { reader, db } = readOnly(r)
  assert.deepEqual(reader.document(notes.app_id!, 'Plan.txt'), { path: '/Users/example/Old/Plan.txt', app_path: notes.path })
  assert.equal(reader.document(notes.app_id!, decomposed.normalize('NFC'))?.path, '/Users/example/Café menu.txt', 'a deletion inside a row leaves the rest of it to open')
  db.close()
  r.close()
})
