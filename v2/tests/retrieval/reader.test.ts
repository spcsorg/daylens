import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { GapReason } from '../../capture/normalize.ts'
import { DB_FILE, Store } from '../../capture/store.ts'
import { Reader, UnknownSchemaError } from '../../retrieval/reader.ts'
import { search } from '../../retrieval/search.ts'
import { app, focus, line } from '../support/lines.ts'
import { HOUR, MIN, rig, T0, tmpDir } from '../storage/support.ts'
import { day } from './support.ts'

const file = (r: { dir: string }) => path.join(r.dir, DB_FILE)

test('the reader refuses a database storage has not set up, or a schema it does not know, and changes neither', () => {
  const dir = tmpDir()
  new Store(dir).close()
  assert.throws(() => Reader.open(path.join(dir, DB_FILE)), UnknownSchemaError)
  const raw = new Database(path.join(dir, DB_FILE), { readonly: true })
  assert.equal((raw.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name IN ('migrations', 'intervals')`).get() as { n: number }).n, 0, 'nothing was migrated')
  raw.close()

  const r = rig()
  r.store.database.prepare(`UPDATE meta SET value = '99' WHERE key = 'schema_version'`).run()
  assert.throws(() => Reader.open(file(r)), /unsupported schema version 99/)
  r.store.database.prepare(`UPDATE meta SET value = '4' WHERE key = 'schema_version'`).run()
  const reader = Reader.open(file(r))
  assert.equal(reader.db.readonly, true)
  assert.throws(() => reader.db.exec('CREATE TABLE x (y)'), /readonly/)
  reader.close()
  r.close()
  const closed = Reader.open(file(r))
  assert.equal(closed.hours(T0, T0 + HOUR).length, 0, 'opens once capture has closed the database and removed its log files')
  closed.close()
})

test('an hour is its recorded facts, plus the written hour through readHour with the user’s corrections', () => {
  const r = rig()
  day(r)
  r.storage.writeHour({ start_wall_ms: T0, tz: 'Africa/Kigali', status: 'written', title: 'Budget review', summary: 'Went through Q4 numbers.', sources: [{ app_id: 'com.example.editor' }] }, r.storage.hourBasis(T0))
  r.storage.correct(r.storage.hourAt(T0)!.id, 'summary', 'Cut the travel line.')
  const reader = Reader.open(file(r))
  const [h, ...rest] = reader.hours(T0, T0 + HOUR)
  assert.equal(rest.length, 0)
  assert.equal(h!.start_wall_ms, T0)
  assert.equal(h!.tz_offset_min, 120)
  assert.deepEqual(h!.apps.map((a) => [a.app_id, a.ms]), [['com.example.editor', 20 * MIN], ['com.google.Chrome', 10 * MIN], ['com.example.notes', MIN]])
  assert.equal(h!.recorded_ms, 31 * MIN)
  assert.deepEqual(
    h!.sources.map((s) => [s.kind, s.file ?? s.url ?? s.title, s.ms]),
    [['file', 'q4-budget.xlsx', 10 * MIN], ['window', 'Scratch - Editor', 10 * MIN], ['page', 'https://docs.example.com/d/budget', 10 * MIN], ['window', 'Groceries', MIN]],
  )
  assert.equal(h!.sources.find((s) => s.kind === 'page')!.title, 'Budget review', 'a browser window title is never kept; the page title comes from the page')
  assert.deepEqual([h!.hour?.title, h!.hour?.summary, h!.hour?.corrected], ['Budget review', 'Cut the travel line.', ['summary']])
  assert.deepEqual(h!.gaps, [{ reason: 'locked', ms: 29 * MIN }])
  assert.equal(reader.hourAt(T0 + HOUR), null)
  reader.close()
  r.close()
})

test('a day of hours reads presence and capture gaps once, not once per hour, and each hour gets its own part', () => {
  const r = rig()
  const notes = app('com.example.notes', { name: 'Notes' })
  // Four hours each active for 30 minutes, then locked: a lock spans every hour boundary.
  for (let h = 0; h < 4; h++) {
    const t = T0 + h * HOUR
    r.feed(line('session', { state: 'unlocked', snapshot: false }, t))
    for (let m = 0; m < 30; m++) r.feed(focus(notes, `Draft ${h}`, t + m * MIN, m === 0 ? 'app_changed' : undefined))
    r.feed(line('session', { state: 'locked', snapshot: false }, t + 30 * MIN))
  }
  r.store.flush()
  const reader = Reader.open(file(r))
  const prepare = reader.db.prepare.bind(reader.db)
  let presenceReads = 0
  reader.db.prepare = ((sql: string) => {
    if (/FROM observations/.test(sql)) presenceReads++
    return prepare(sql)
  }) as typeof reader.db.prepare
  const hours = reader.hours(T0, T0 + 4 * HOUR)
  assert.deepEqual(hours.map((h) => [(h.start_wall_ms - T0) / HOUR, h.recorded_ms / MIN, h.gaps]), [0, 1, 2, 3].map((h) => [h, 30, [{ reason: 'locked', ms: 30 * MIN }]]))
  assert.equal(presenceReads, 1)
  reader.close()
  r.close()
})

test('an app deleted across all time is gone up to the deletion and found again after it, pending or done', async () => {
  const editor = app('com.example.editor', { name: 'Editor' })
  for (const hold of [true, false]) {
    const r = rig(undefined, { holdDeletions: hold })
    day(r)
    r.clock.t = T0 + 2 * HOUR
    const handle = r.storage.deleteSource('com.example.editor')
    if (!hold) await handle.done
    const t = T0 + 3 * HOUR
    r.feed(line('session', { state: 'unlocked', snapshot: false }, t))
    for (let m = 0; m < 10; m++) {
      r.clock.t = t + m * MIN
      r.feed(focus(editor, 'q4-budget-final.xlsx - Editor', t + m * MIN, m === 0 ? 'app_changed' : undefined))
    }
    r.clock.t = T0 + 4 * HOUR
    r.store.flush()
    const reader = Reader.open(file(r))
    assert.ok(!reader.hourAt(T0)!.apps.some((a) => a.app_id === 'com.example.editor'), `hold=${hold}: before the deletion, hidden`)
    const after = reader.hourAt(t)
    assert.deepEqual(after?.apps.map((a) => a.app_id), ['com.example.editor'], `hold=${hold}: after the deletion, recorded again`)
    assert.deepEqual(after!.sources.map((s) => s.file), ['q4-budget-final.xlsx'])
    const res = search(reader, 'budget xlsx', { perGroup: 5 })
    assert.deepEqual(res.files.map((f) => [f.file, f.seen_in.map((s) => s.hour_start_wall_ms)]), [['q4-budget-final.xlsx', [t]]], `hold=${hold}: search finds only what came after`)
    reader.close()
    r.close()
  }
})

test('what a pending deletion covers is already gone from what the reader returns', () => {
  const r = rig(undefined, { holdDeletions: true })
  day(r)
  r.storage.writeHour({ start_wall_ms: T0, tz: 'Africa/Kigali', status: 'written', title: 'Budget review', sources: [{ app_id: 'com.example.editor' }] }, r.storage.hourBasis(T0))
  r.clock.t = T0 + 2 * HOUR
  r.storage.deleteSource('com.example.editor')
  const reader = Reader.open(file(r))
  const h = reader.hourAt(T0)!
  assert.deepEqual(h.apps.map((a) => a.app_id), ['com.google.Chrome', 'com.example.notes'])
  assert.ok(!h.sources.some((s) => s.app_id === 'com.example.editor'))
  assert.equal(h.hour?.title ?? null, null, 'the hour drew on the deleted app, so its text is withheld')

  r.storage.deleteRange(T0 + 25 * MIN, T0 + 35 * MIN)
  const after = reader.hourAt(T0)!
  assert.deepEqual(after.apps.map((a) => [a.app_id, a.ms]), [['com.google.Chrome', 5 * MIN]])
  reader.close()
  r.close()

  const whole = rig(undefined, { holdDeletions: true })
  day(whole)
  whole.storage.writeHour({ start_wall_ms: T0, tz: 'Africa/Kigali', status: 'written', title: 'Budget review' }, whole.storage.hourBasis(T0))
  whole.clock.t = T0 + 2 * HOUR
  whole.storage.deleteRange(T0, T0 + HOUR)
  const wholeReader = Reader.open(file(whole))
  assert.deepEqual(wholeReader.hours(T0 - HOUR, T0 + 2 * HOUR), [])
  wholeReader.close()
  whole.close()
})

test('a pending range deletion already takes its part out of an hour’s gaps and its lock, sleep and idle, as the deletion leaves them', async () => {
  for (const hold of [true, false]) {
    const r = rig(undefined, { holdDeletions: hold })
    day(r)
    const at = (m: number) => ({ wall_ms: T0 + m * MIN, mono_us: (T0 + m * MIN) * 1000, boot: 'boot-test' })
    const gap = (reason: GapReason, from: number, to: number) => r.store.writeGapNow({ reason, scope: 'all', run: 'run-test', start: at(from), detail: null }, at(to))
    gap('helper_crashed', 22, 28)
    gap('helper_crashed', 40, 45)
    gap('paused', 46, 48)
    gap('helper_hung', 49, 53)
    r.clock.t = T0 + 2 * HOUR
    const handle = r.storage.deleteRange(T0 + 25 * MIN, T0 + 50 * MIN)
    if (!hold) await handle.done
    const reader = Reader.open(file(r))
    // The lock at 31 minutes is inside the range; a gap crossing its start ends there, one crossing its end starts
    // there, and those inside it go, the pause too.
    assert.deepEqual(reader.hourAt(T0)!.gaps, [{ reason: 'helper_crashed', ms: 3 * MIN }, { reason: 'helper_hung', ms: 3 * MIN }], `hold=${hold}`)
    reader.close()
    r.close()
  }
})

test('an hour’s lock, sleep and idle are what attribution reads: away from the last input, a wake alone is not a return, and a lock whose end was deleted ends where the range begins', () => {
  const r = rig(undefined, { holdDeletions: true })
  const notes = app('com.example.notes', { name: 'Notes' })
  for (let m = 0; m < 5; m++) r.feed(focus(notes, 'Draft', T0 + m * MIN, m === 0 ? 'app_changed' : undefined))
  r.feed(line('input', { state: 'idle', last_input_wall_ms: T0 + 5 * MIN, threshold_s: 120, snapshot: false }, T0 + 7 * MIN))
  r.feed(line('input', { state: 'active', last_input_wall_ms: T0 + 12 * MIN, threshold_s: 120, snapshot: false }, T0 + 12 * MIN))
  r.feed(line('power', { state: 'sleep' }, T0 + 20 * MIN))
  r.feed(line('power', { state: 'resume' }, T0 + 30 * MIN))
  r.feed(line('session', { state: 'locked', snapshot: false }, T0 + 35 * MIN))
  r.feed(line('session', { state: 'unlocked', snapshot: false }, T0 + 45 * MIN))
  r.store.flush()
  r.clock.t = T0 + 2 * HOUR
  r.storage.deleteRange(T0 + 40 * MIN, T0 + 50 * MIN)
  const reader = Reader.open(file(r))
  const gaps = Object.fromEntries(reader.hourAt(T0)!.gaps.map((g) => [g.reason, g.ms / MIN]))
  // Idle from the last input at 5 to 12; asleep 20 to 30; away from the wake at 30, with no input after it; the lock
  // from 35 and that away both end at 40, where the deleted range begins.
  assert.deepEqual(gaps, { idle: 7 + 10, asleep: 10, locked: 5 })
  reader.close()
  r.close()
})
