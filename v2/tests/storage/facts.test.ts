import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentStore } from '../../capture/agents/store.ts'
import { PendingDeletionError } from '../../storage/index.ts'
import { app, focus, line, resetSeq } from '../support/lines.ts'
import { HOUR, MIN, rig, T0 } from './support.ts'

const editor = app('com.example.editor', { name: 'Editor' })
const term = app('com.example.term', { name: 'Term' })

test('an hour\'s facts hold its intervals, gaps, lock spans, stale titles and agent turns, and nothing outside it', () => {
  resetSeq()
  const r = rig()
  r.feed(focus(editor, 'notes.md', T0 - 10 * MIN, 'app_changed'))
  r.feed(focus(editor, 'notes.md', T0 + 4 * MIN, 'reconcile'))
  r.feed(focus(term, 'npm test', T0 + 5 * MIN, 'app_changed'))
  r.normalizer.onTitleChannel('stalled', T0 + 6 * MIN)
  r.feed(focus(term, 'npm test', T0 + 7 * MIN, 'reconcile'))
  r.feed(line('session', { state: 'locked', snapshot: false }, T0 + 20 * MIN))
  r.feed(line('session', { state: 'unlocked', snapshot: false }, T0 + 30 * MIN))
  r.feed(focus(editor, 'later.md', T0 + 2 * HOUR, 'app_changed'))
  const gap = r.store.openGap({ reason: 'helper_crashed', scope: 'all', run: 'run-test', start: { wall_ms: T0 + 40 * MIN, mono_us: null, boot: null }, detail: null })
  r.store.closeGap(gap, { wall_ms: T0 + 41 * MIN, mono_us: null, boot: null })
  new AgentStore(r.store.database).apply('codex', [
    { t: 'session', session: 's1', origin: 'interactive', parent: null, client: null, dir: '/code/alpha', branch: null, at: T0 + 10 * MIN },
    { t: 'turn', key: 'k1', session: 's1', dir: '/code/alpha', branch: null, opener: 'user', start: T0 + 10 * MIN, replayed: false },
    { t: 'user', key: 'u1', session: 's1', turn: 'k1', act: 'prompt', basis: 'marked', at: T0 + 10 * MIN },
    { t: 'activity', key: 'k1', session: 's1', at: T0 + 25 * MIN },
  ])
  r.clock.t = T0 + 3 * HOUR

  const f = r.storage.hourFacts(T0, T0 + HOUR)
  assert.deepEqual(
    f.intervals.map((i) => [i.title, i.start_wall_ms]),
    [
      ['notes.md', T0 - 10 * MIN],
      ['npm test', T0 + 5 * MIN],
    ],
  )
  assert.equal(f.intervals[0]!.possibly_stale_since_wall_ms, null)
  assert.equal(f.intervals[1]!.possibly_stale_since_wall_ms, T0 + 6 * MIN)
  assert.equal(f.intervals[1]!.window, 'w1')
  assert.deepEqual(f.presence.locked, [{ start: T0 + 20 * MIN, end: T0 + 30 * MIN }])
  assert.deepEqual(f.gaps.map((g) => [g.reason, g.start_wall_ms, g.end_wall_ms]), [['helper_crashed', T0 + 40 * MIN, T0 + 41 * MIN]])
  assert.deepEqual(f.turns.map((t) => [t.turn_key, t.project_dir]), [['k1', '/code/alpha']])
  assert.deepEqual(f.events.map((e) => [e.kind, e.wall_ms]), [['user', T0 + 10 * MIN]])
  r.close()
})

test('facts are refused while a deletion over the span is still being carried out, and leave out what it removed', async () => {
  resetSeq()
  const r = rig(undefined, { holdDeletions: true })
  r.feed(focus(editor, 'Wombatcanary plan', T0 + 5 * MIN, 'app_changed'))
  r.feed(focus(term, 'make', T0 + 30 * MIN, 'app_changed'))
  r.clock.t = T0 + 2 * HOUR
  r.storage.deleteSource('com.example.editor')
  assert.throws(() => r.storage.hourFacts(T0, T0 + HOUR), PendingDeletionError)
  r.close()

  const again = rig(r.dir)
  again.storage.start()
  await again.storage.deletionsSettled()
  const f = again.storage.hourFacts(T0, T0 + HOUR)
  assert.ok(!JSON.stringify(f).includes('Wombatcanary'))
  assert.deepEqual(f.intervals.map((i) => i.title), ['make'])
  again.close()
})
