import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import Database from 'better-sqlite3'
import { DB_FILE, Store } from '../../capture/store.ts'
import { Reader, UnknownSchemaError } from '../../retrieval/reader.ts'
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
