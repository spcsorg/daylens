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

const hello = (wallMs: number) => line('hello', { awake_us: 0, helper: 'fake', boot_identity: 'kernel', version: '0', pid: 1, os: 'test', permissions: { accessibility: 'granted' }, config: { heartbeat_s: 15, idle_threshold_s: 120, reconcile_s: 60 } }, wallMs)

test('a new helper records nothing until it reports the display on, and a display it reports dark keeps recording stopped', () => {
  resetSeq()
  const sink = new MemorySink()
  const n = new Normalizer(sink, new Privacy())
  const rows = () => sink.rows.filter((x) => x.kind === 'focus').map((x) => x.event_wall_ms - T0)
  n.handle(line('power', { state: 'display_off' }, T0))
  n.handle(line('power', { state: 'sleep' }, T0 + 1))
  n.interrupt({ wall_ms: T0 + MIN, mono_us: null, boot: null })
  n.handle(hello(T0 + 2 * MIN))
  n.handle(focus(editor, 'notes.md - Editor', T0 + 2 * MIN + 10, 'snapshot'))
  assert.deepEqual(rows(), [], 'not before the display is known')
  n.handle(line('power', { state: 'display_off', snapshot: true }, T0 + 2 * MIN + 20))
  n.handle(focus(editor, 'notes.md - Editor', T0 + 2 * MIN + 30, 'snapshot'))
  assert.deepEqual(rows(), [], 'a dark wake is not recorded')
  assert.equal(n.handle(line('power', { state: 'display_on' }, T0 + 3 * MIN)), true)
  n.handle(focus(editor, 'notes.md - Editor', T0 + 3 * MIN + 10, 'snapshot'))
  assert.deepEqual(rows(), [3 * MIN + 10])
})

test('a lock state the helper cannot read stops recording until it can', () => {
  resetSeq()
  const sink = new MemorySink()
  const n = new Normalizer(sink, new Privacy())
  const rows = () => sink.rows.filter((x) => x.kind === 'focus').map((x) => x.event_wall_ms - T0)
  n.handle(hello(T0))
  n.handle(line('power', { state: 'display_on', snapshot: true }, T0 + 1))
  n.handle(line('session', { state: 'unknown', snapshot: true }, T0 + 2))
  n.handle(focus(editor, 'notes.md - Editor', T0 + 10, 'snapshot'))
  assert.deepEqual(rows(), [])
  assert.equal(n.handle(line('session', { state: 'unlocked', snapshot: true }, T0 + MIN)), true)
  n.handle(focus(editor, 'notes.md - Editor', T0 + MIN + 10, 'snapshot'))
  assert.deepEqual(rows(), [MIN + 10])
})

// Heartbeats every 15 s in (from, to], as the supervisor passes them on.
function beats(r: ReturnType<typeof rig>, from: number, to: number): void {
  for (let t = from + 15_000; t <= to; t += 15_000) {
    r.clock.t = Math.max(r.clock.t, t)
    r.normalizer.sighted(t)
  }
}

function editorRows(r: ReturnType<typeof rig>): [number, number][] {
  return r
    .q<{ t: number; seen: number }>(`SELECT event_wall_ms - ? AS t, last_seen_wall_ms - ? AS seen FROM observations WHERE kind = 'focus' AND app_id = 'com.example.editor' ORDER BY id`, T0, T0)
    .map((x) => [x.t, x.seen])
}

test('a window kept in front with nothing reported is one interval, heartbeat by heartbeat', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'notes.md - Editor', T0, 'app_changed'))
  beats(r, T0, T0 + 20 * MIN)
  r.feed(focus(chat, null, T0 + 20 * MIN + 1000, 'app_changed'))
  assert.deepEqual(intervals(r).filter(([, , t]) => t !== null), [[0, 20 * MIN + 1000, 'notes.md - Editor']])
  r.close()
})

test('a heartbeat never carries a row through a locked screen, and the row from before the lock is never reopened', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'notes.md - Editor', T0, 'app_changed'))
  beats(r, T0, T0 + 5 * MIN)
  r.feed(line('session', { state: 'locked', snapshot: false }, T0 + 5 * MIN + 1))
  beats(r, T0 + 5 * MIN, T0 + 30 * MIN)
  r.feed(line('session', { state: 'unlocked', snapshot: false }, T0 + 30 * MIN + 1))
  beats(r, T0 + 30 * MIN, T0 + 31 * MIN)
  r.feed(focus(editor, 'notes.md - Editor', T0 + 31 * MIN + 10, 'snapshot'))
  beats(r, T0 + 31 * MIN, T0 + 40 * MIN)
  assert.deepEqual(editorRows(r), [
    [0, 5 * MIN],
    [31 * MIN + 10, 40 * MIN],
  ])
  r.close()
})

test('a heartbeat never carries a row through sleep', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'notes.md - Editor', T0, 'app_changed'))
  beats(r, T0, T0 + 5 * MIN)
  r.feed(line('power', { state: 'sleep' }, T0 + 5 * MIN + 1))
  // A dark wake: the machine is awake for a moment with nobody at it, and the helper heartbeats.
  r.feed(line('power', { state: 'display_off' }, T0 + 20 * MIN))
  r.feed(line('power', { state: 'resume' }, T0 + 20 * MIN + 1))
  r.feed(focus(editor, 'notes.md - Editor', T0 + 20 * MIN + 10, 'snapshot'))
  beats(r, T0 + 20 * MIN, T0 + 21 * MIN)
  r.feed(line('power', { state: 'display_on' }, T0 + 60 * MIN))
  r.feed(focus(editor, 'notes.md - Editor', T0 + 60 * MIN + 10, 'snapshot'))
  beats(r, T0 + 60 * MIN, T0 + 62 * MIN)
  assert.deepEqual(editorRows(r), [
    [0, 5 * MIN],
    [60 * MIN + 10, 62 * MIN],
  ])
  r.close()
})

test('a heartbeat never carries a row into idle time, which counts as away; after it the window is a new row', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'notes.md - Editor', T0, 'app_changed'))
  beats(r, T0, T0 + 3 * MIN)
  r.feed(line('input', { state: 'idle', last_input_wall_ms: T0 + MIN, threshold_s: 120, snapshot: false }, T0 + 3 * MIN + 1))
  beats(r, T0 + 3 * MIN, T0 + 10 * MIN)
  r.feed(line('input', { state: 'active', last_input_wall_ms: T0 + 10 * MIN, threshold_s: 120, snapshot: false }, T0 + 10 * MIN + 1))
  r.feed(focus(editor, 'notes.md - Editor', T0 + 10 * MIN + 10, 'snapshot'))
  beats(r, T0 + 10 * MIN, T0 + 15 * MIN)
  assert.deepEqual(editorRows(r), [
    [0, MIN],
    [10 * MIN + 10, 15 * MIN],
  ])
  r.close()
})

test('a window that comes forward while input is idle is recorded, but no heartbeat extends it until input returns', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(chat, null, T0, 'app_changed'))
  r.feed(line('input', { state: 'idle', last_input_wall_ms: T0 - 2 * MIN, threshold_s: 120, snapshot: false }, T0 + 1))
  r.feed(focus(editor, 'notes.md - Editor', T0 + MIN, 'app_changed'))
  beats(r, T0 + MIN, T0 + 10 * MIN)
  assert.deepEqual(editorRows(r), [[MIN, MIN]])
  r.close()
})

test('a heartbeat never carries a row through a pause, and the row from before it is never reopened', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'notes.md - Editor', T0, 'app_changed'))
  beats(r, T0, T0 + 5 * MIN)
  r.clock.t = T0 + 5 * MIN + 1
  r.storage.pause('until_resumed')
  beats(r, T0 + 5 * MIN, T0 + 30 * MIN)
  r.clock.t = T0 + 30 * MIN + 1
  r.storage.resume()
  beats(r, T0 + 30 * MIN, T0 + 31 * MIN)
  r.feed(focus(editor, 'notes.md - Editor', T0 + 31 * MIN + 10, 'snapshot'))
  beats(r, T0 + 31 * MIN, T0 + 40 * MIN)
  assert.deepEqual(editorRows(r), [
    [0, 5 * MIN],
    [31 * MIN + 10, 40 * MIN],
  ])
  r.close()
})

test('a heartbeat never carries a row through a lock when its focus line was stamped before the lock but arrived after it', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'notes.md - Editor', T0, 'app_changed'))
  beats(r, T0, T0 + 5 * MIN)
  r.feed(line('session', { state: 'locked', snapshot: false }, T0 + 5 * MIN + 100))
  r.feed(focus(editor, 'todo.md - Editor', T0 + 5 * MIN + 50, 'title_changed'))
  beats(r, T0 + 5 * MIN, T0 + 30 * MIN)
  r.feed(line('session', { state: 'unlocked', snapshot: false }, T0 + 30 * MIN + 1))
  assert.deepEqual(editorRows(r), [
    [0, 5 * MIN],
    [5 * MIN + 50, 5 * MIN + 50],
  ])
  r.close()
})

test('a heartbeat that reaches storage after a pause began, before capture was interrupted, is refused', () => {
  resetSeq()
  const r = rig()
  // Not attached to storage, so the pause cannot interrupt it: only the store's own refusal stands.
  const n = new Normalizer(r.store, new Privacy(r.store.exclusions()))
  n.handle(focus(editor, 'notes.md - Editor', T0, 'app_changed'))
  assert.equal(n.sighted(T0 + MIN), false)
  r.clock.t = T0 + 2 * MIN
  r.storage.pause('until_resumed')
  assert.equal(n.sighted(T0 + 3 * MIN), true, 'refused, so the window is read again')
  assert.deepEqual(editorRows(r), [[0, MIN]])
  r.close()
})

test('a heartbeat never carries a row past the moment its app is excluded', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'notes.md - Editor', T0, 'app_changed'))
  beats(r, T0, T0 + 5 * MIN)
  r.clock.t = T0 + 5 * MIN + 1
  r.storage.addExclusion({ match: 'app_id', value: 'com.example.editor', label: 'Editor' })
  beats(r, T0 + 5 * MIN, T0 + 15 * MIN)
  r.feed(focus(editor, 'notes.md - Editor', T0 + 15 * MIN + 10, 'snapshot'))
  beats(r, T0 + 15 * MIN, T0 + 16 * MIN)
  assert.deepEqual(editorRows(r), [[0, 5 * MIN]])
  assert.deepEqual(r.q(`SELECT reason, start_wall_ms - ? AS s FROM capture_gaps WHERE reason = 'excluded'`, T0), [{ reason: 'excluded', s: 15 * MIN + 10 }])
  r.close()
})

test('a heartbeat storage refuses ends the row and asks for a fresh read, once', () => {
  resetSeq()
  class Refusing extends MemorySink {
    extends = 0
    override extendObservation(): boolean {
      this.extends++
      return false
    }
  }
  const sink = new Refusing()
  const n = new Normalizer(sink, new Privacy())
  n.handle(focus(editor, 'notes.md - Editor', T0, 'app_changed'))
  assert.equal(n.sighted(T0 + 15_000), true)
  assert.equal(n.sighted(T0 + 30_000), false)
  assert.equal(sink.extends, 1)
})

test('a heartbeat never carries a row through an excluded app in front', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'notes.md - Editor', T0, 'app_changed'))
  beats(r, T0, T0 + 5 * MIN)
  r.feed(focus(app('com.1password.1password'), null, T0 + 5 * MIN + 1, 'app_changed'))
  beats(r, T0 + 5 * MIN, T0 + 15 * MIN)
  r.feed(focus(editor, 'notes.md - Editor', T0 + 15 * MIN + 1, 'app_changed'))
  beats(r, T0 + 15 * MIN, T0 + 16 * MIN)
  assert.deepEqual(editorRows(r), [
    [0, 5 * MIN],
    [15 * MIN + 1, 16 * MIN],
  ])
  r.close()
})

test('after the helper restarts, a heartbeat never reopens the row that ended before it', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'notes.md - Editor', T0, 'app_changed'))
  beats(r, T0, T0 + 5 * MIN)
  r.normalizer.interrupt({ wall_ms: T0 + 5 * MIN, mono_us: null, boot: null })
  r.feed(hello(T0 + 6 * MIN))
  r.feed(line('power', { state: 'display_on', snapshot: true }, T0 + 6 * MIN + 1))
  beats(r, T0 + 5 * MIN, T0 + 7 * MIN)
  r.feed(focus(editor, 'notes.md - Editor', T0 + 7 * MIN + 10, 'snapshot'))
  beats(r, T0 + 7 * MIN, T0 + 8 * MIN)
  assert.deepEqual(editorRows(r), [
    [0, 5 * MIN],
    [7 * MIN + 10, 8 * MIN],
  ])
  r.close()
})

test('idle counts from the last input: the window in front ends there, not when the idle threshold was noticed', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'notes.md - Editor', T0, 'app_changed'))
  beats(r, T0, T0 + 5 * MIN)
  r.feed(line('input', { state: 'idle', last_input_wall_ms: T0 + 3 * MIN, threshold_s: 120, snapshot: false }, T0 + 5 * MIN))
  beats(r, T0 + 5 * MIN, T0 + 8 * MIN)
  r.feed(line('input', { state: 'active', last_input_wall_ms: T0 + 8 * MIN, threshold_s: 120, snapshot: false }, T0 + 8 * MIN))
  r.feed(focus(editor, 'notes.md - Editor', T0 + 8 * MIN + 10, 'snapshot'))
  assert.deepEqual(editorRows(r), [
    [0, 3 * MIN],
    [8 * MIN + 10, 8 * MIN + 10],
  ])
  assert.deepEqual(intervals(r).filter(([, , t]) => t !== null)[0], [0, 3 * MIN, 'notes.md - Editor'])
  r.close()
})
