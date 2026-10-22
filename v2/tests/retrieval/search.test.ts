import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { DB_FILE } from '../../capture/store.ts'
import { Reader } from '../../retrieval/reader.ts'
import { search } from '../../retrieval/search.ts'
import { app, focus, line } from '../support/lines.ts'
import { HOUR, MIN, rig, T0 } from '../storage/support.ts'
import { day, page } from './support.ts'

const notes = app('com.example.notes', { name: 'Notes' })
const editor = app('com.example.editor', { name: 'Editor' })
const chrome = app('com.google.Chrome', { name: 'Chrome' })

// The day from support.ts at T0, then two hours later, unlocked, the same page under a new title, the same file, and a note.
function twoHours(r: ReturnType<typeof rig>): void {
  day(r)
  const t = T0 + 2 * HOUR
  r.feed(line('session', { state: 'unlocked', snapshot: false }, t))
  r.feed(focus(editor, 'q4-budget.xlsx - Editor', t))
  r.feed(focus(chrome, null, t + 5 * MIN, 'app_changed'))
  r.store.insertObservation({ ...page(t + 5 * MIN, 'https://docs.example.com/d/budget', 'Q4 costs'), seq: 1 })
  r.feed(focus(notes, 'Budget questions for Keza', t + 10 * MIN, 'app_changed'))
  r.feed(focus(notes, 'Budget questions for Keza', t + 11 * MIN))
  r.store.flush()
  r.storage.writeHour({ start_wall_ms: T0, tz: 'Africa/Kigali', status: 'written', title: 'Budget review with the team', sources: [{ app_id: 'com.example.editor' }] }, r.storage.hourBasis(T0))
}

const open = (r: { dir: string }) => Reader.open(path.join(r.dir, DB_FILE))

test('results come grouped into pages, files, windows and hours, each item once with every hour it was seen in, and say how to open', () => {
  const r = rig()
  twoHours(r)
  const reader = open(r)
  assert.ok(reader.warmSearch() > 0)
  const hourId = r.storage.hourAt(T0)!.id
  const res = search(reader, 'budget', { perGroup: 5 })

  assert.equal(res.pages.length, 1)
  const p = res.pages[0]!
  assert.equal(p.url, 'https://docs.example.com/d/budget')
  assert.equal(p.title, 'Q4 costs', 'the newest title is shown, though only the older one has the word')
  assert.deepEqual(p.seen_in, [{ hour_start_wall_ms: T0 + 2 * HOUR, hour_id: null }, { hour_start_wall_ms: T0, hour_id: hourId }])
  assert.deepEqual(p.open, { kind: 'url', url: 'https://docs.example.com/d/budget' })

  assert.deepEqual(res.files.map((f) => [f.file, f.app_id, f.seen_in.length]), [['q4-budget.xlsx', 'com.example.editor', 2]])
  assert.deepEqual(res.files[0]!.open, { kind: 'app', app_id: 'com.example.editor', app_name: 'Editor' })

  assert.deepEqual(res.windows.map((w) => [w.title, w.seen_in.map((s) => s.hour_start_wall_ms)]), [['Budget questions for Keza', [T0 + 2 * HOUR]]])
  assert.equal(res.windows[0]!.open.kind, 'app')

  assert.deepEqual(res.hours.map((h) => [h.hour_id, h.title]), [[hourId, 'Budget review with the team']])
  assert.deepEqual(res.hours[0]!.open, { kind: 'hour', hour_start_wall_ms: T0, hour_id: hourId })

  assert.deepEqual(search(reader, 'q4 budget xlsx', { perGroup: 5 }).windows, [], 'a window whose file name has the words is listed once, as the file')
  assert.deepEqual(search(reader, 'budget', { perGroup: 5, fromWallMs: T0 + HOUR }).hours, [], 'a date range applies')
  assert.equal(search(reader, 'budget', { perGroup: 5, fromWallMs: T0 + HOUR }).pages[0]!.seen_in.length, 1)
  reader.close()
  r.close()
})

test('each group stops at the number of items asked for, which has no default', () => {
  const r = rig()
  for (let i = 0; i < 6; i++) r.feed(focus(notes, `Budget draft ${i}`, T0 + i * MIN, 'app_changed'))
  r.store.flush()
  const reader = open(r)
  assert.deepEqual([search(reader, 'budget draft', { perGroup: 4 })].map((x) => [x.windows.length, x.more]), [[4, ['windows']]], 'a group says it had more')
  assert.deepEqual([search(reader, 'budget draft', { perGroup: 6 })].map((x) => [x.windows.length, x.more]), [[6, []]])
  assert.throws(() => search(reader, 'budget', { perGroup: 0 }), RangeError)
  assert.throws(() => search(reader, 'budget', {} as { perGroup: number }), RangeError)
  assert.deepEqual(search(reader, '"; DROP TABLE x; --', { perGroup: 4 }), { pages: [], files: [], windows: [], hours: [], more: [], looser: false }, 'query syntax typed by the user is never passed through')
  reader.close()
  r.close()
})

test('nothing a pending deletion covers is found, and an hour is found by the user’s own correction', () => {
  const r = rig(undefined, { holdDeletions: true })
  twoHours(r)
  const hourId = r.storage.hourAt(T0)!.id
  r.storage.correct(hourId, 'title', 'Forecast for the board')
  const reader = open(r)
  assert.deepEqual(search(reader, 'forecast board', { perGroup: 5 }).hours.map((h) => h.title), ['Forecast for the board'])
  r.clock.t = T0 + 3 * HOUR
  r.storage.deleteSource('com.example.editor')
  const res = search(reader, 'budget', { perGroup: 5 })
  assert.deepEqual(res.files, [])
  assert.deepEqual(res.hours, [], 'the hour drew on the deleted app')
  assert.deepEqual([res.pages.length, res.windows.length], [1, 1])
  r.storage.deleteSite('docs.example.com')
  assert.deepEqual(search(reader, 'budget', { perGroup: 5 }).pages, [])
  reader.close()
  r.close()
})

test('a search within dates reads only entries in them, and an item’s sightings read only its own entries', () => {
  const r = rig()
  r.feed(line('session', { state: 'unlocked', snapshot: false }, T0))
  for (let h = 0; h < 20; h++) {
    r.feed(focus(notes, `Budget notes ${h}`, T0 + h * HOUR, 'app_changed'))
    r.feed(focus(notes, 'Budget', T0 + h * HOUR + 10 * MIN, 'app_changed'))
  }
  r.store.flush()
  const reader = open(r)
  const prepare = reader.db.prepare.bind(reader.db)
  let rows = 0
  reader.db.prepare = ((sql: string) => {
    const st = prepare(sql)
    if (!/search MATCH|json_each/.test(sql)) return st
    const all = st.all.bind(st)
    st.all = ((...a: unknown[]) => {
      const out = all(...a) as unknown[]
      rows += out.length
      return out
    }) as typeof st.all
    return st
  }) as typeof reader.db.prepare
  const day = search(reader, 'budget', { perGroup: 5, fromWallMs: T0 + 5 * HOUR, toWallMs: T0 + 6 * HOUR })
  assert.deepEqual(day.windows.map((w) => w.title), ['Budget', 'Budget notes 5'])
  assert.ok(rows <= 6, `${rows} rows read for the two entries in that hour`)
  rows = 0
  const all = search(reader, 'budget', { perGroup: 1 })
  assert.deepEqual(all.windows.map((w) => [w.title, w.seen_in.length]), [['Budget', 20]])
  assert.ok(rows <= 64 + 64 + 20, `${rows} rows read`)
  reader.close()
  r.close()
})

test('when no entry has every word typed, search shows entries with any of them, labelled as looser matches', () => {
  const r = rig()
  twoHours(r)
  const reader = open(r)
  const exact = search(reader, 'budget xlsx', { perGroup: 5 })
  assert.deepEqual([exact.looser, exact.files.map((f) => f.file)], [false, ['q4-budget.xlsx']])
  const loose = search(reader, 'budget zebra', { perGroup: 5 })
  assert.equal(loose.looser, true)
  assert.deepEqual(loose.files.map((f) => f.file), ['q4-budget.xlsx'])
  assert.deepEqual([search(reader, 'zebra', { perGroup: 5 })].map((x) => [x.looser, x.files.length]), [[false, 0]], 'one word has nothing looser to fall back to')
  assert.deepEqual([search(reader, 'zebra okapi', { perGroup: 5 })].map((x) => [x.looser, x.files.length, x.windows.length]), [[false, 0, 0]], 'nothing looser found, nothing labelled')
  assert.equal(search(reader, 'budget zebra', { perGroup: 5, match: 'any' }).looser, false, 'Ask asks for any word itself')
  reader.close()
  r.close()
})
