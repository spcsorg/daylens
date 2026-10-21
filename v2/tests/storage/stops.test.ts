import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Normalizer, Privacy } from '../../capture/normalize.ts'
import { app, focus, line, resetSeq } from '../support/lines.ts'
import { MemorySink } from '../support/memorySink.ts'
import { CONTINUITY_MS } from '../../storage/derive.ts'
import { MIN, rig, T0 } from './support.ts'

const editor = app('com.example.editor', { name: 'Editor' })
const chat = app('com.example.chat', { name: 'Chat' })

type Span = [start: number, end: number, title: string | null]
function intervals(r: ReturnType<typeof rig>): Span[] {
  return r.q<{ s: number; e: number; title: string | null }>(`SELECT start_wall_ms AS s, end_wall_ms AS e, title FROM intervals ORDER BY start_wall_ms`).map((i) => [i.s - T0, i.e - T0, i.title])
}

test('after an unlock, time in the same window is its own interval', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'notes.md - Editor', T0, 'app_changed'))
  r.feed(focus(editor, 'notes.md - Editor', T0 + 5 * MIN, 'snapshot'))
  r.feed(line('session', { state: 'locked', snapshot: false }, T0 + 10 * MIN))
  r.feed(line('session', { state: 'unlocked', snapshot: false }, T0 + 30 * MIN))
  r.feed(focus(editor, 'notes.md - Editor', T0 + 30 * MIN + 10, 'snapshot'))
  r.feed(focus(editor, 'notes.md - Editor', T0 + 50 * MIN, 'snapshot'))
  r.feed(focus(chat, null, T0 + 50 * MIN + 1000, 'app_changed'))
  const got = intervals(r).filter(([, , t]) => t === 'notes.md - Editor')
  assert.deepEqual(got, [
    [0, 5 * MIN + CONTINUITY_MS, 'notes.md - Editor'],
    [30 * MIN + 10, 50 * MIN + 1000, 'notes.md - Editor'],
  ])
  r.close()
})

test('after a wake, time in the same window is its own interval', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'notes.md - Editor', T0, 'app_changed'))
  r.feed(line('power', { state: 'sleep' }, T0 + 10 * MIN))
  r.feed(line('power', { state: 'resume' }, T0 + 60 * MIN))
  r.feed(focus(editor, 'notes.md - Editor', T0 + 60 * MIN + 10, 'snapshot'))
  r.feed(focus(editor, 'notes.md - Editor', T0 + 80 * MIN, 'snapshot'))
  r.feed(focus(chat, null, T0 + 80 * MIN + 1000, 'app_changed'))
  assert.deepEqual(intervals(r).filter(([, , t]) => t !== null), [
    [0, CONTINUITY_MS, 'notes.md - Editor'],
    [60 * MIN + 10, 80 * MIN + 1000, 'notes.md - Editor'],
  ])
  r.close()
})

test('the snapshot at a wake while the screen is still locked is not a row; the window is recorded from the unlock', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'notes.md - Editor', T0, 'app_changed'))
  r.feed(line('session', { state: 'locked', snapshot: false }, T0 + 10 * MIN))
  r.feed(line('power', { state: 'sleep' }, T0 + 11 * MIN))
  r.feed(line('power', { state: 'resume' }, T0 + 60 * MIN))
  r.feed(focus(editor, 'notes.md - Editor', T0 + 60 * MIN + 10, 'snapshot'))
  r.feed(line('session', { state: 'locked', snapshot: true }, T0 + 60 * MIN + 20))
  r.feed(line('session', { state: 'unlocked', snapshot: false }, T0 + 62 * MIN))
  r.feed(focus(editor, 'notes.md - Editor', T0 + 62 * MIN + 10, 'snapshot'))
  r.feed(focus(chat, null, T0 + 70 * MIN, 'app_changed'))
  const locked = r.q(`SELECT id FROM observations WHERE kind = 'focus' AND event_wall_ms > ? AND event_wall_ms < ?`, T0 + 10 * MIN, T0 + 62 * MIN)
  assert.deepEqual(locked, [], 'no focus row while locked or asleep')
  assert.deepEqual(intervals(r).filter(([, , t]) => t !== null), [
    [0, CONTINUITY_MS, 'notes.md - Editor'],
    [62 * MIN + 10, 62 * MIN + 10 + CONTINUITY_MS, 'notes.md - Editor'],
  ])
  r.close()
})

test('a focus line stamped just before the lock that arrives after it is kept, but never held open across the lock', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'notes.md - Editor', T0, 'app_changed'))
  r.feed(line('session', { state: 'locked', snapshot: false }, T0 + 10 * MIN))
  r.feed(focus(chat, null, T0 + 10 * MIN - 200, 'app_changed'))
  r.feed(line('session', { state: 'unlocked', snapshot: false }, T0 + 30 * MIN))
  r.feed(focus(chat, null, T0 + 30 * MIN + 10, 'snapshot'))
  r.feed(focus(editor, 'notes.md - Editor', T0 + 40 * MIN, 'app_changed'))
  const rows = r.q<{ t: number; seen: number }>(`SELECT event_wall_ms - ? AS t, last_seen_wall_ms - ? AS seen FROM observations WHERE kind = 'focus' AND app_id = 'com.example.chat' ORDER BY id`, T0, T0)
  assert.deepEqual(rows, [
    { t: 10 * MIN - 200, seen: 10 * MIN - 200 },
    { t: 30 * MIN + 10, seen: 30 * MIN + 10 },
  ])
  r.close()
})

test('a stop that ends asks for one fresh read, only once nothing else stops', () => {
  resetSeq()
  const n = new Normalizer(new MemorySink(), new Privacy())
  const h = (l: ReturnType<typeof line>) => n.handle(l)
  assert.equal(h(line('session', { state: 'locked', snapshot: false }, T0)), false)
  assert.equal(h(line('power', { state: 'display_off' }, T0 + 1)), false)
  assert.equal(h(line('power', { state: 'sleep' }, T0 + 2)), false)
  assert.equal(h(line('power', { state: 'resume' }, T0 + MIN)), false, 'still locked, display still off')
  assert.equal(h(line('power', { state: 'display_on' }, T0 + MIN + 1)), false, 'still locked')
  assert.equal(h(line('session', { state: 'unlocked', snapshot: false }, T0 + 2 * MIN)), true)
  assert.equal(h(line('session', { state: 'unlocked', snapshot: true }, T0 + 2 * MIN + 1)), false, 'a repeat is not a return')
  assert.equal(h(line('power', { state: 'display_off' }, T0 + 3 * MIN)), false)
  assert.equal(h(line('power', { state: 'display_on' }, T0 + 4 * MIN)), true)
  // An unlock the helper missed is learned from its next snapshot, which then needs a fresh read of its own.
  h(line('session', { state: 'locked', snapshot: false }, T0 + 5 * MIN))
  assert.equal(h(line('session', { state: 'unlocked', snapshot: true }, T0 + 6 * MIN)), true)
})

test('with the display off, the window is not a row; after it comes back on, the next read is a new row', () => {
  resetSeq()
  const sink = new MemorySink()
  const n = new Normalizer(sink, new Privacy())
  n.handle(focus(editor, 'notes.md - Editor', T0, 'app_changed'))
  n.handle(line('power', { state: 'display_off' }, T0 + MIN))
  n.handle(focus(editor, 'notes.md - Editor', T0 + 2 * MIN, 'snapshot'))
  n.handle(line('power', { state: 'display_on' }, T0 + 3 * MIN))
  n.handle(focus(editor, 'notes.md - Editor', T0 + 3 * MIN + 10, 'snapshot'))
  const rows = sink.rows.filter((x) => x.kind === 'focus').map((x) => [x.event_wall_ms - T0, x.last_seen_wall_ms - T0])
  assert.deepEqual(rows, [
    [0, 0],
    [3 * MIN + 10, 3 * MIN + 10],
  ])
})

test('a new helper runs on an awake machine: a sleep or a dark display it never reported back does not stop recording', () => {
  resetSeq()
  const sink = new MemorySink()
  const n = new Normalizer(sink, new Privacy())
  n.handle(line('power', { state: 'display_off' }, T0))
  n.handle(line('power', { state: 'sleep' }, T0 + 1))
  n.interrupt({ wall_ms: T0 + MIN, mono_us: null, boot: null })
  n.handle(line('hello', { helper: 'fake', boot_identity: 'kernel', version: '0', pid: 1, os: 'test', permissions: { accessibility: 'granted' }, config: { heartbeat_s: 15, idle_threshold_s: 120, reconcile_s: 60 } }, T0 + 2 * MIN))
  n.handle(focus(editor, 'notes.md - Editor', T0 + 2 * MIN + 10, 'snapshot'))
  assert.equal(sink.rows.filter((x) => x.kind === 'focus').length, 1)
})
