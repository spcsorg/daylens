import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentStore } from '../../capture/agents/store.ts'
import type { AgentRecord } from '../../capture/agents/types.ts'
import { buildPacket, type PacketOptions } from '../../engine/packet.ts'
import type { CalendarSource, CommitSource } from '../../engine/sources.ts'
import { app, focus, line, resetSeq } from '../support/lines.ts'
import { HOUR, MIN, rig, T0 } from '../storage/support.ts'

const OPTS: PacketOptions = { staleTitleMs: 2 * HOUR, nearbyHours: 1, openThreadMs: 3 * HOUR }
const HOUR_AT = (start: number) => ({ start_wall_ms: start, tz: 'Africa/Kigali', tz_offset_min: 120 })

const term = app('com.mitchellh.ghostty', { name: 'Ghostty' })
const editor = app('com.example.editor', { name: 'Editor' })
const codexApp = app('com.openai.codex', { name: 'Codex', engine: 'app_runtime' })
const dia = app('company.thebrowser.dia', { name: 'Dia', registered_browser: true, engine: 'browser' })

// A capture run that covers [from, to]: presence is only known while capture was running.
function covered(r: ReturnType<typeof rig>, from: number, to: number): void {
  r.store.startRun(line('hello', { awake_us: 0, helper: 'test', boot_identity: 'kernel', version: '1', pid: 1, os: 'test', permissions: { accessibility: 'granted' }, config: { heartbeat_s: 15, idle_threshold_s: 120, reconcile_s: 60 } }, from) as never)
  r.store.recordHeartbeat(line('heartbeat', { awake_us: 0, permissions: { accessibility: 'granted' }, registrations: { focus: true, session: true, power: true }, titles: 'ok', stall_ms: 0, dropped: 0 }, to) as never)
}

// The helper sights the window in front every minute, as its reconcile timer does.
function hold(r: ReturnType<typeof rig>, a: ReturnType<typeof app>, title: string | null, from: number, to: number): void {
  r.feed(focus(a, title, from, 'app_changed'))
  for (let t = from + MIN; t < to; t += MIN) r.feed(focus(a, title, t, 'reconcile'))
}

function turn(key: string, session: string, start: number, last: number, dir = '/Users/me/Code/alpha'): AgentRecord[] {
  return [
    { t: 'session', session, origin: 'interactive', parent: null, client: null, dir, branch: null, at: start },
    { t: 'turn', key, session, dir, branch: null, opener: 'user', start, replayed: false },
    { t: 'user', key: `${key}-u`, session, turn: key, act: 'prompt', basis: 'marked', at: start },
    { t: 'activity', key, session, at: last },
    { t: 'end', key, state: 'completed', at: last },
  ]
}

test('intervals merge per app, window and page with short IDs that map to their observations', () => {
  resetSeq()
  const r = rig()
  covered(r, T0, T0 + HOUR)
  hold(r, editor, 'plan.md', T0, T0 + 10 * MIN)
  hold(r, term, 'npm test', T0 + 10 * MIN, T0 + 15 * MIN)
  hold(r, editor, 'plan.md', T0 + 15 * MIN, T0 + 25 * MIN)
  hold(r, dia, null, T0 + 25 * MIN, T0 + 30 * MIN)
  hold(r, term, 'make', T0 + 30 * MIN, T0 + 31 * MIN)
  r.clock.t = T0 + 2 * HOUR
  const { packet, refs } = buildPacket(r.storage, HOUR_AT(T0), OPTS)
  assert.deepEqual(
    packet.windows.map((w) => [w.id, w.app, w.title ?? w.title_note, w.min, w.from, w.to, w.times]),
    [
      ['i1', 'Editor', 'plan.md', 20, '08:00', '08:25', 2],
      ['i2', 'Ghostty', 'npm test', 5, '08:10', '08:15', 1],
      ['i3', 'Dia', 'browser window, page not recorded', 5, '08:25', '08:30', 1],
    ],
  )
  const ids = r.q<{ id: number; title: string | null }>(`SELECT id, title FROM observations WHERE kind = 'focus' ORDER BY id`)
  assert.deepEqual(refs.i1, { kind: 'observations', ids: ids.filter((o) => o.title === 'plan.md').map((o) => o.id) })
  assert.ok(!JSON.stringify(packet).includes('com.example.editor'), 'app IDs and observation IDs stay out of the packet')
  r.close()
})

test('pages from the extension take their share of the browser\'s time; the rest is browser time with no page', () => {
  resetSeq()
  const r = rig()
  covered(r, T0, T0 + HOUR)
  hold(r, dia, null, T0, T0 + 30 * MIN)
  const page = (t: number, url: string, title: string) =>
    r.store.insertObservation({
      run: 'ext', seq: 0, boot: 'b', platform: 'macos', source: 'browser_ext', kind: 'page', event_wall_ms: t, event_mono_us: t * 1000, tz: 'Africa/Kigali',
      tz_offset_min: 120, app_id: 'company.thebrowser.dia', app_name: 'Dia', app_path: null, pid: 100, window: 'ext:1', title, title_raw: null, title_state: 'ok', state: 'normal', detail: null, url,
    } as never)
  page(T0 + 5 * MIN, 'https://notes.example.com/projects/1', 'Project list - Example Notes')
  page(T0 + 15 * MIN, 'https://files.example.org/home', 'Home - Example Files')
  hold(r, editor, 'plan.md', T0 + 30 * MIN, T0 + 31 * MIN)
  r.store.flush()
  r.storage.derived.rebuild()
  r.clock.t = T0 + 2 * HOUR
  const { packet, refs } = buildPacket(r.storage, HOUR_AT(T0), OPTS)
  assert.deepEqual(
    packet.pages.map((p) => [p.id, p.app, p.site, p.title, p.min]),
    [
      ['p1', 'Dia', 'notes.example.com', 'Project list - Example Notes', 10],
      ['p2', 'Dia', 'files.example.org', 'Home - Example Files', 15],
    ],
  )
  assert.deepEqual(packet.windows[0]!.title_note, 'browser window, page not recorded')
  assert.equal(packet.windows[0]!.min, 5)
  assert.equal(refs.p1!.kind, 'observations')
  r.close()
})

test('a title that stays unchanged in its window for the stale span, or that could not be read, is flagged', () => {
  resetSeq()
  const r = rig()
  covered(r, T0 - 2 * HOUR, T0 + HOUR)
  hold(r, term, 'λ watch build', T0 - 2 * HOUR, T0 - 2 * HOUR + 5 * MIN)
  hold(r, editor, 'notes.md', T0 - 2 * HOUR + 5 * MIN, T0 + 10 * MIN)
  hold(r, term, 'λ watch build', T0 + 10 * MIN, T0 + 20 * MIN)
  hold(r, term, 'top', T0 + 20 * MIN, T0 + 30 * MIN)
  r.normalizer.onTitleChannel('stalled', T0 + 25 * MIN)
  r.clock.t = T0 + 2 * HOUR
  const { packet } = buildPacket(r.storage, HOUR_AT(T0), OPTS)
  const by = (title: string) => packet.windows.find((w) => w.title === title)!
  assert.equal(by('λ watch build').stale, 'title unchanged since at least 06:00')
  assert.equal(by('notes.md').stale, 'title unchanged since at least 06:05')
  assert.equal(by('top').stale, 'title unreadable since 08:25')

  const fresh = buildPacket(r.storage, HOUR_AT(T0), { ...OPTS, staleTitleMs: 4 * HOUR }).packet
  assert.equal(fresh.windows.find((w) => w.title === 'λ watch build')!.stale, undefined)
  r.close()
})

test('a commit made while the screen was locked is marked as such, with the agent that was working', () => {
  resetSeq()
  const r = rig()
  covered(r, T0, T0 + HOUR)
  hold(r, codexApp, null, T0, T0 + 18 * MIN)
  r.feed(line('session', { state: 'locked', snapshot: false }, T0 + 18 * MIN))
  r.feed(line('session', { state: 'unlocked', snapshot: false }, T0 + 59 * MIN))
  new AgentStore(r.store.database).apply('codex', turn('t1', 's1', T0 + 3 * MIN, T0 + 40 * MIN, '/Users/me/Code/beta'))
  const commits: CommitSource = { commits: () => [{ hash: 'abc123', at_wall_ms: T0 + 23 * MIN, repos: ['beta'], subject: 'Cache the parsed config', stat: null }] }
  r.clock.t = T0 + 2 * HOUR
  const { packet, refs } = buildPacket(r.storage, HOUR_AT(T0), OPTS, { commits })
  assert.deepEqual(packet.away, [{ id: 'w1', from: '08:18', to: '08:59', why: 'locked' }])
  assert.deepEqual(packet.commits, [{ id: 'c1', at: '08:23', repos: ['beta'], subject: 'Cache the parsed config', while_away: 'screen locked', agents_working: ['a1'] }])
  assert.deepEqual(packet.agents, [{ id: 'a1', agent: 'Codex', project: 'beta', with_you_min: 15, while_away_min: 22, messages: ['08:03 prompt'] }])
  assert.deepEqual(refs.a1, { kind: 'agent', agent: 'codex', session: 's1' })
  assert.deepEqual(refs.c1, { kind: 'commit', hash: 'abc123' })
  assert.equal(packet.windows[0]!.title_note, 'title not recorded', 'the agent app shows no title; its session log carries the work')
  r.close()
})

test('commits and calendar events from paused or deleted time are left out; app exclusions do not match them', async () => {
  resetSeq()
  const r = rig()
  covered(r, T0, T0 + HOUR)
  r.clock.t = T0 + 30 * MIN
  r.storage.pause(T0 + 40 * MIN)
  const excluded = r.store.openGap({ reason: 'excluded', scope: 'all', run: 'run-test', start: { wall_ms: T0 + 45 * MIN, mono_us: null, boot: null }, detail: null })
  r.store.closeGap(excluded, { wall_ms: T0 + 50 * MIN, mono_us: null, boot: null })
  r.clock.t = T0 + 2 * HOUR
  await r.storage.deleteRange(T0 + 10 * MIN, T0 + 20 * MIN).done
  const commit = (hash: string, min: number) => ({ hash, at_wall_ms: T0 + min * MIN, repos: ['beta'], subject: `Change ${hash}`, stat: null })
  const commits: CommitSource = { commits: () => [commit('kept', 5), commit('deleted', 15), commit('paused', 35), commit('excluded', 47)] }
  const event = (id: string, from: number, to: number) => ({ id, title: id, start_wall_ms: T0 + from * MIN, end_wall_ms: T0 + to * MIN, attendees: null })
  const calendar: CalendarSource = { events: () => [event('Kept', 21, 29), event('Deleted', 12, 18), event('Paused', 38, 44), event('Excluded', 46, 48)] }
  const { packet } = buildPacket(r.storage, HOUR_AT(T0), OPTS, { commits, calendar })
  assert.deepEqual(packet.commits.map((c) => c.subject), ['Change kept', 'Change excluded'], 'an excluded app in front does not make a commit its own')
  assert.deepEqual(packet.scheduled_events.map((e) => e.title), ['Kept', 'Excluded'])
  r.close()
})

test('the previous hour, open threads and corrections from nearby hours are passed along, corrections as the user wrote them', () => {
  resetSeq()
  const r = rig()
  covered(r, T0 - 4 * HOUR, T0 + 3 * HOUR)
  r.clock.t = T0 + 4 * HOUR
  const w = (start: number, title: string, summary: string) => r.storage.writeHour({ start_wall_ms: start, tz: 'Africa/Kigali', status: 'written', title, summary }, r.storage.hourBasis(start))
  const old = w(T0 - 3 * HOUR, 'Planned the garden', 'You planned.')
  const prev = w(T0 - HOUR, 'Installed a sketch app', 'You installed a sketch app and set it up.')
  const next = w(T0 + HOUR, 'Sorted photos', 'You sorted photos.')
  const far = w(T0 + 2 * HOUR, 'Far away', 'Too far.')
  r.storage.createThread('Garden', [old.id])
  r.storage.createThread('Sketch app trial', [prev.id])
  r.storage.correct(next.id, 'title', 'Sorted the holiday photos')
  r.storage.correct(far.id, 'title', 'Out of range')
  r.storage.correct(prev.id, 'summary', 'You installed a sketch app to try it.')
  const { packet } = buildPacket(r.storage, HOUR_AT(T0), OPTS)
  assert.deepEqual(packet.previous_hour, { title: 'Installed a sketch app', summary: 'You installed a sketch app to try it.' })
  assert.deepEqual(packet.open_threads, ['Garden', 'Sketch app trial'])
  assert.deepEqual(packet.corrections, [
    { hour: '07:00', field: 'summary', text: 'You installed a sketch app to try it.' },
    { hour: '09:00', field: 'title', text: 'Sorted the holiday photos' },
  ])
  assert.equal(buildPacket(r.storage, HOUR_AT(T0), { ...OPTS, openThreadMs: HOUR }).packet.open_threads?.join(), 'Sketch app trial')
  r.close()
})

test('capture gaps, time not recording and idle time are listed with their reasons; calendar events only as scheduled', () => {
  resetSeq()
  const r = rig()
  covered(r, T0, T0 + 50 * MIN)
  hold(r, editor, 'plan.md', T0, T0 + 10 * MIN)
  r.feed(line('input', { state: 'idle', last_input_wall_ms: T0 + 8 * MIN, threshold_s: 120, snapshot: false }, T0 + 10 * MIN))
  r.feed(line('input', { state: 'active', last_input_wall_ms: T0 + 14 * MIN, threshold_s: 120, snapshot: false }, T0 + 14 * MIN))
  const gap = r.store.openGap({ reason: 'helper_crashed', scope: 'all', run: 'run-test', start: { wall_ms: T0 + 20 * MIN, mono_us: null, boot: null }, detail: null })
  r.store.closeGap(gap, { wall_ms: T0 + 22 * MIN, mono_us: null, boot: null })
  const excluded = r.store.openGap({ reason: 'excluded', scope: 'all', run: 'run-test', start: { wall_ms: T0 + 30 * MIN, mono_us: null, boot: null }, detail: null })
  r.store.closeGap(excluded, { wall_ms: T0 + 35 * MIN, mono_us: null, boot: null })
  const calendar: CalendarSource = {
    events: () => [
      { id: 'cal-1', title: 'Pottery class', start_wall_ms: T0 + 30 * MIN, end_wall_ms: T0 + 90 * MIN, attendees: 40 },
      { id: 'cal-2', title: 'Tomorrow', start_wall_ms: T0 + 25 * HOUR, end_wall_ms: T0 + 26 * HOUR, attendees: null },
    ],
  }
  r.clock.t = T0 + 2 * HOUR
  const { packet } = buildPacket(r.storage, HOUR_AT(T0), OPTS, { calendar })
  assert.deepEqual(packet.away, [{ id: 'w1', from: '08:08', to: '08:14', why: 'idle' }], 'away from the last input')
  assert.deepEqual(packet.unknown, [
    { id: 'g1', from: '08:20', to: '08:22', why: 'not recording' },
    { id: 'g2', from: '08:30', to: '08:35', why: 'an excluded app was in front' },
    { id: 'g3', from: '08:50', to: '09:00', why: 'not recording' },
  ])
  assert.deepEqual(packet.scheduled_events, [{ id: 'k1', title: 'Pottery class', from: '08:30', to: '09:30', attendees: 40 }])
  assert.equal(packet.windows[0]!.away_min, undefined, 'idle after the window closed is not counted against it')
  r.close()
})

test('an hour with nothing recorded gives an empty packet, and every option must be set', () => {
  const r = rig()
  r.clock.t = T0 + 2 * HOUR
  const { packet, refs } = buildPacket(r.storage, HOUR_AT(T0), OPTS)
  assert.deepEqual([packet.windows, packet.pages, packet.agents, packet.commits, packet.scheduled_events, packet.away], [[], [], [], [], [], []])
  assert.deepEqual(packet.unknown, [{ id: 'g1', from: '08:00', to: '09:00', why: 'not recording' }])
  assert.deepEqual(Object.keys(refs), ['g1'])
  assert.throws(() => buildPacket(r.storage, HOUR_AT(T0), { ...OPTS, staleTitleMs: undefined as unknown as number }), /staleTitleMs must be set/)
  r.close()
})

test('the same facts give a byte-identical packet', () => {
  resetSeq()
  const r = rig()
  covered(r, T0, T0 + HOUR)
  hold(r, editor, 'plan.md', T0, T0 + 30 * MIN)
  hold(r, term, 'make', T0 + 30 * MIN, T0 + 40 * MIN)
  r.clock.t = T0 + 2 * HOUR
  assert.equal(JSON.stringify(buildPacket(r.storage, HOUR_AT(T0), OPTS).packet), JSON.stringify(buildPacket(r.storage, HOUR_AT(T0), OPTS).packet))
  r.close()
})
