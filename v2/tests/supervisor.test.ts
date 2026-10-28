import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Normalizer, Privacy } from '../capture/normalize.ts'
import { Store } from '../capture/store.ts'
import { Supervisor, type SupervisorOptions } from '../capture/supervisor.ts'
import { tempDir } from './support/tmp.ts'

const FAKE = fileURLToPath(new URL('./support/fakeHelper.ts', import.meta.url))
const CANARY = 'CANARY-91be-private-page'

interface Gap {
  reason: string
  scope: string
  start_wall_ms: number
  end_wall_ms: number | null
  detail: string | null
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 20))
  }
}

function harness(env: Record<string, string>, opts: Partial<SupervisorOptions> = {}) {
  const dir = tempDir('daylens-v2-sup-')
  const logs: string[] = []
  const store = new Store(dir, { onError: (c) => logs.push(`storage ${c}`) })
  const normalizer = new Normalizer(store, new Privacy(store.exclusions()))
  const sup = new Supervisor(store, normalizer, {
    helperPath: process.execPath,
    helperArgs: [FAKE],
    env: { ...process.env, FAKE_CANARY: CANARY, FAKE_HB_MS: '100', ...env },
    heartbeatMs: 100,
    hangAfterMs: 1200,
    tickMs: 50,
    backoffInitialMs: 50,
    backoffMaxMs: 200,
    stableMs: 3000,
    crashLoopCount: 3,
    unavailableRetryMs: 60_000,
    log: (m) => logs.push(m),
    ...opts,
  })
  const gaps = () => {
    store.flush()
    return store.query<Gap>('SELECT reason, scope, start_wall_ms, end_wall_ms, detail FROM capture_gaps ORDER BY id')
  }
  let finished = false
  const finish = async () => {
    finished = true
    await sup.stop()
    store.close()
    for (const f of readdirSync(dir)) assert.ok(!readFileSync(path.join(dir, f)).includes(CANARY), `${f} holds the canary`)
    assert.ok(!logs.join('\n').includes(CANARY), 'logs hold the canary')
  }
  after(async () => {
    if (!finished) {
      await sup.stop()
      store.close()
    }
  })
  return { dir, store, sup, logs, gaps, finish }
}

test('a healthy helper: startup gap closes at hello, focus is stored, browser titles are not', async () => {
  const h = harness({})
  h.sup.start()
  await waitFor(() => h.sup.stats.lines > 20)
  const gaps = h.gaps()
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0]!.reason, 'service_starting')
  assert.ok(gaps[0]!.end_wall_ms !== null)
  h.store.flush()
  const rows = h.store.query<{ app_id: string; title: string | null; title_state: string }>(`SELECT app_id, title, title_state FROM observations WHERE kind = 'focus'`)
  assert.ok(rows.some((r) => r.app_id === 'com.apple.Terminal' && r.title?.startsWith('zsh')))
  assert.ok(rows.filter((r) => r.app_id === 'com.google.Chrome').every((r) => r.title === null && r.title_state === 'withheld_browser'))
  assert.equal(h.sup.stats.hangs + h.sup.stats.crashes, 0)
  await h.finish()
})

test('a window kept in front with no change reported is still in front at each heartbeat', async () => {
  const h = harness({ FAKE_FOCUS_MS: '3600000' })
  h.sup.start()
  await waitFor(() => h.sup.stats.heartbeats >= 8)
  h.store.flush()
  const rows = h.store.query<{ event_wall_ms: number; last_seen_wall_ms: number }>(`SELECT event_wall_ms, last_seen_wall_ms FROM observations WHERE kind = 'focus'`)
  assert.equal(rows.length, 1, 'one focus line, from the start-up snapshot')
  assert.ok(rows[0]!.last_seen_wall_ms - rows[0]!.event_wall_ms >= 500, `the row reaches the latest heartbeat (${rows[0]!.last_seen_wall_ms - rows[0]!.event_wall_ms} ms)`)
  await h.finish()
})

test('idle input ends the row in front, and when input returns the helper is asked for a fresh read', async () => {
  const snapfile = path.join(tempDir('daylens-v2-snap-'), 'snaps')
  const h = harness({ FAKE_MODE: 'idle_cycle', FAKE_AFTER_MS: '300', FAKE_FOCUS_MS: '3600000', FAKE_SNAPFILE: snapfile })
  h.sup.start()
  await waitFor(() => existsSync(snapfile) && readFileSync(snapfile, 'utf8').trim().split('\n').length >= 2)
  await waitFor(() => h.sup.stats.heartbeats >= 12)
  h.store.flush()
  const input = h.store.query<{ state: string; event_wall_ms: number }>(`SELECT state, event_wall_ms FROM observations WHERE kind = 'input' AND state = 'idle'`)
  const rows = h.store.query<{ event_wall_ms: number; last_seen_wall_ms: number }>(`SELECT event_wall_ms, last_seen_wall_ms FROM observations WHERE kind = 'focus' ORDER BY id`)
  assert.equal(input.length, 1)
  assert.equal(rows.length, 2, 'the row before idle, and the fresh read after it')
  assert.ok(rows[0]!.last_seen_wall_ms <= input[0]!.event_wall_ms, 'no heartbeat carried the first row into idle time')
  assert.ok(rows[1]!.last_seen_wall_ms > rows[1]!.event_wall_ms, 'heartbeats carry the new row')
  await h.finish()
})

test('a heartbeat that ends a stall gap does not carry the row across it; the window is read again', async () => {
  const h = harness({ FAKE_MODE: 'heartbeat_gap', FAKE_AFTER_MS: '400', FAKE_FOCUS_MS: '3600000' })
  h.sup.start()
  await waitFor(() => h.gaps().some((g) => g.reason === 'helper_stalled'))
  await waitFor(() => h.sup.stats.heartbeats >= 12)
  const stall = h.gaps().find((g) => g.reason === 'helper_stalled')!
  const rows = h.store.query<{ event_wall_ms: number; last_seen_wall_ms: number }>(`SELECT event_wall_ms, last_seen_wall_ms FROM observations WHERE kind = 'focus' ORDER BY id`)
  assert.equal(rows.length, 2)
  assert.ok(rows[0]!.last_seen_wall_ms <= stall.start_wall_ms, 'the row before the stall ends at its start')
  assert.ok(rows[1]!.event_wall_ms >= stall.end_wall_ms!, 'a fresh row after it')
  await h.finish()
})

test('after a helper crash, the new helper\'s snapshot and heartbeats never reopen the row from before it', async () => {
  const h = harness({ FAKE_MODE: 'crash', FAKE_AFTER_MS: '500', FAKE_FOCUS_MS: '3600000' }, { stableMs: 100 })
  h.sup.start()
  await waitFor(() => h.sup.stats.restarts >= 1 && h.gaps().some((g) => g.reason === 'helper_crashed' && g.end_wall_ms !== null))
  const restarts = h.sup.stats.restarts
  const beats = h.sup.stats.heartbeats
  await waitFor(() => h.sup.stats.heartbeats >= beats + 3 && h.sup.stats.restarts === restarts)
  const crash = h.gaps().find((g) => g.reason === 'helper_crashed')!
  const rows = h.store.query<{ event_wall_ms: number; last_seen_wall_ms: number }>(`SELECT event_wall_ms, last_seen_wall_ms FROM observations WHERE kind = 'focus' ORDER BY id`)
  assert.ok(rows.length >= 2, `a row before the crash and one from the new helper's snapshot (${rows.length} rows)`)
  assert.ok(rows[0]!.last_seen_wall_ms <= crash.start_wall_ms, 'the row before the crash ends at it')
  assert.ok(rows[1]!.event_wall_ms >= crash.end_wall_ms!, 'the new helper\'s window is a new row')
  assert.ok(rows[1]!.last_seen_wall_ms > rows[1]!.event_wall_ms, 'heartbeats carry the new row')
  await h.finish()
})

test('when the display comes back on, the helper is asked for a fresh read of the window in front', async () => {
  const snapfile = path.join(tempDir('daylens-v2-snap-'), 'snaps')
  const h = harness({ FAKE_MODE: 'display_cycle', FAKE_AFTER_MS: '200', FAKE_FOCUS_MS: '3600000', FAKE_SNAPFILE: snapfile })
  h.sup.start()
  // The display the new helper reports clears the last stop, which asks for a snapshot of its own before the cycle.
  await waitFor(() => existsSync(snapfile) && readFileSync(snapfile, 'utf8').trim().split('\n').length >= 3)
  h.store.flush()
  const rows = h.store.query<{ kind: string; state: string | null }>(`SELECT kind, state FROM observations WHERE kind IN ('focus', 'power') ORDER BY event_wall_ms, id`)
  assert.deepEqual(rows.map((r) => (r.kind === 'focus' ? 'focus' : r.state)), ['display_on', 'focus', 'display_off', 'display_on', 'focus'])
  await h.finish()
})

test('a crashed helper is restarted and the gap is explained', async () => {
  const h = harness({ FAKE_MODE: 'crash', FAKE_AFTER_MS: '300' }, { stableMs: 100 })
  h.sup.start()
  await waitFor(() => h.sup.stats.restarts >= 1 && h.sup.stats.lines > 30)
  const crash = h.gaps().find((g) => g.reason === 'helper_crashed')!
  assert.ok(crash, 'crash gap recorded')
  assert.ok(crash.end_wall_ms !== null && crash.end_wall_ms >= crash.start_wall_ms, 'closed when the new helper said hello')
  assert.deepEqual(JSON.parse(crash.detail!), { exit_code: 3, signal: null })
  await h.finish()
})

test('a helper whose event loop stops heartbeating is killed even while other threads still emit', async () => {
  const h = harness({ FAKE_MODE: 'main_stuck', FAKE_AFTER_MS: '300' })
  h.sup.start()
  await waitFor(() => h.sup.stats.hangs >= 1 && h.sup.stats.restarts >= 1)
  const hung = h.gaps().find((g) => g.reason === 'helper_hung')!
  assert.ok(hung)
  await waitFor(() => h.gaps().find((g) => g.reason === 'helper_hung')!.end_wall_ms !== null)
  await h.finish()
})

test('a frozen helper (SIGSTOP) is detected, killed and replaced', async () => {
  const h = harness({})
  h.sup.start()
  await waitFor(() => h.sup.stats.lines > 10)
  const pid = h.sup.helperPid()!
  process.kill(pid, 'SIGSTOP')
  await waitFor(() => h.sup.stats.hangs === 1 && h.sup.helperPid() !== null && h.sup.helperPid() !== pid)
  await waitFor(() => h.gaps().some((g) => g.reason === 'helper_hung' && g.end_wall_ms !== null))
  const hung = h.gaps().find((g) => g.reason === 'helper_hung')!
  assert.ok(hung.end_wall_ms! - hung.start_wall_ms >= 1200, 'gap spans the silence')
  await h.finish()
})

test('sleep followed by a hang still recovers', async () => {
  const h = harness({ FAKE_MODE: 'sleep_then_hang', FAKE_AFTER_MS: '300' })
  h.sup.start()
  await waitFor(() => h.sup.stats.hangs >= 1, 5000)
  await h.finish()
})

test('a crash loop is reported as helper_unavailable and retried slowly', async () => {
  const h = harness({ FAKE_MODE: 'crash_always' })
  h.sup.start()
  await waitFor(() => h.sup.stats.crashes >= 3)
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(h.sup.stats.crashes, 3, 'no fast retries after the loop is detected')
  const gaps = h.gaps().filter((g) => g.reason !== 'service_starting')
  assert.equal(gaps.length, 1, 'one gap for the whole outage')
  assert.equal(gaps[0]!.reason, 'helper_unavailable')
  assert.equal(gaps[0]!.end_wall_ms, null)
  await h.sup.stop()
  assert.ok(h.gaps().every((g) => g.end_wall_ms !== null), 'stop closes open gaps')
  await h.finish()
})

test('a missing helper binary is helper_unavailable, not a crash loop', async () => {
  const h = harness({}, { helperPath: '/nonexistent/daylens-helper', helperArgs: [] })
  h.sup.start()
  await waitFor(() => h.gaps().some((g) => g.reason === 'helper_unavailable' || g.detail?.includes('ENOENT') === true))
  assert.ok(h.logs.some((l) => l.includes('code=ENOENT')))
  await h.finish()
})

test('lost lines are recorded and a fresh snapshot is requested', async () => {
  const snapfile = path.join(tempDir('snap-'), 'snaps')
  const h = harness({ FAKE_MODE: 'skip_seq', FAKE_SNAPFILE: snapfile })
  h.sup.start()
  await waitFor(() => h.sup.stats.linesLost > 0)
  await waitFor(() => readFileSync(snapfile, 'utf8').split('\n').filter(Boolean).length >= 2)
  const lost = h.gaps().find((g) => g.reason === 'lines_lost')!
  assert.deepEqual(JSON.parse(lost.detail!), { missing: 3 })
  await h.finish()
})

test('garbage, oversized lines and unsafe stderr are rejected without leaking content', async () => {
  const h = harness({ FAKE_MODE: 'garbage', FAKE_AFTER_MS: '200' })
  h.sup.start()
  await waitFor(() => h.sup.stats.rejected.not_json >= 1 && h.sup.stats.rejected.too_long >= 1 && h.sup.stats.rejected.malformed >= 1)
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(h.logs.includes('helper stderr line redacted'))
  assert.ok(h.logs.includes('helper code=ax_error state=-25204'))
  const rejected = h.gaps().filter((g) => g.reason === 'protocol_rejected')
  assert.equal(rejected.length, 1, 'rejections in one minute share one gap row')
  assert.equal(JSON.parse(rejected[0]!.detail!).count, 3)
  await h.finish()
})

test('a title channel that stalls opens a titles-only gap', async () => {
  const h = harness({ FAKE_MODE: 'titles_stalled' })
  h.sup.start()
  await waitFor(() => h.gaps().some((g) => g.reason === 'titles_unavailable'))
  const g = h.gaps().find((x) => x.reason === 'titles_unavailable')!
  assert.equal(g.scope, 'titles')
  await h.finish()
})

test('dropped focus work keeps focus uncertain from the first drop until the next focus line', async () => {
  const h = harness({ FAKE_MODE: 'loss', FAKE_AFTER_MS: '300' })
  h.sup.start()
  await waitFor(() => h.gaps().some((g) => g.reason === 'events_dropped' && g.end_wall_ms !== null))
  const g = h.gaps().find((x) => x.reason === 'events_dropped')!
  assert.equal(g.scope, 'focus')
  assert.deepEqual(JSON.parse(g.detail!), { count: 1 })
  h.store.flush()
  const at = h.store.query<{ n: number }>(`SELECT count(*) AS n FROM observations WHERE kind = 'focus' AND event_wall_ms = ?`, g.end_wall_ms)[0]!
  assert.equal(at.n, 1, 'the gap ends exactly at a recorded focus line')
  assert.ok(g.end_wall_ms! - g.start_wall_ms >= 8000, `the 8 s after the dropped switch are uncertain, not credited to the previous app (${g.end_wall_ms! - g.start_wall_ms} ms)`)
  await h.finish()
})

test('an event source the helper could not subscribe to is a gap until it is in place', async () => {
  const h = harness({ FAKE_MODE: 'session_unregistered', FAKE_AFTER_MS: '500' })
  h.sup.start()
  await waitFor(() => h.gaps().some((g) => g.reason === 'events_unavailable' && g.end_wall_ms !== null))
  const g = h.gaps().find((x) => x.reason === 'events_unavailable')!
  assert.equal(g.scope, 'session')
  await new Promise((r) => setTimeout(r, 300))
  h.store.flush()
  const sessions = h.store.query<{ state: string }>(
    `SELECT state FROM observations WHERE kind = 'session' AND event_wall_ms >= ? ORDER BY id`,
    g.end_wall_ms! - 150,
  )
  assert.deepEqual(sessions.map((s) => s.state), ['locked', 'unlocked'], 'lock and unlock after the retry are captured')
  await h.finish()
})

test('a stuck title worker restarts the helper even while heartbeats continue, and the titles gap is bounded', async () => {
  const h = harness({ FAKE_MODE: 'titles_stuck' })
  h.sup.start()
  await waitFor(() => h.sup.stats.hangs >= 1 && h.sup.stats.restarts >= 1)
  await waitFor(() => h.gaps().some((g) => g.reason === 'titles_unavailable' && g.end_wall_ms !== null))
  const titles = h.gaps().find((g) => g.reason === 'titles_unavailable')!
  const hung = h.gaps().find((g) => g.reason === 'helper_hung')!
  assert.equal(JSON.parse(hung.detail!).channel, 'titles')
  assert.ok(titles.end_wall_ms! >= hung.start_wall_ms, 'the titles gap lasts until the new helper is up')
  assert.ok(titles.end_wall_ms! - titles.start_wall_ms < 5000)
  await h.finish()
})

test('when the title channel recovers, a forced snapshot replaces the possibly stale title', async () => {
  const h = harness({ FAKE_MODE: 'titles_recover', FAKE_AFTER_MS: '600', FAKE_FOCUS_MS: '100000' })
  h.sup.start()
  await waitFor(() => h.gaps().some((g) => g.reason === 'titles_unavailable' && g.end_wall_ms !== null))
  // A slow runner can take more than one snapshot while titles are still stalled; the one after recovery comes last.
  const focusRows = () => {
    h.store.flush()
    return h.store.query<{ title: string; possibly_stale_since_wall_ms: number | null }>(`SELECT title, possibly_stale_since_wall_ms FROM observations WHERE kind = 'focus' ORDER BY id`)
  }
  await waitFor(() => focusRows().length > 1 && focusRows().at(-1)!.possibly_stale_since_wall_ms === null)
  const rows = focusRows()
  assert.ok(rows[0]!.possibly_stale_since_wall_ms !== null, 'the title read before the stall was flagged')
  assert.equal(rows.at(-1)!.possibly_stale_since_wall_ms, null, 'the re-read after recovery is a fresh row')
  assert.equal(rows.at(-1)!.title, rows[0]!.title, 'even though the title is the same')
  await h.finish()
})

// A supervisor fed protocol lines directly, with no helper process.
function fed() {
  const dir = tempDir('daylens-v2-sup-fed-')
  const store = new Store(dir)
  const normalizer = new Normalizer(store, new Privacy(store.exclusions()))
  const sup = new Supervisor(store, normalizer, {
    helperPath: process.execPath, helperArgs: [], env: process.env, heartbeatMs: 15_000, hangAfterMs: 45_000, tickMs: 5000,
    backoffInitialMs: 50, backoffMaxMs: 200, stableMs: 3000, crashLoopCount: 3, unavailableRetryMs: 60_000, log: () => {},
  })
  const T = 1_792_130_400_000
  const sent: string[] = []
  const send = (sup as unknown as { send(m: { op: string }): void }).send.bind(sup)
  ;(sup as unknown as { send(m: { op: string }): void }).send = (m) => {
    sent.push(m.op)
    send(m)
  }
  let seq = 0
  const feed = (kind: string, obs: unknown, atMs: number, mono = atMs, awake = atMs) =>
    (sup as unknown as { onRawLine(raw: string): void }).onRawLine(JSON.stringify({ v: 1, run: 'r', seq: seq++, boot: 'b', t: { wall_ms: T + atMs, mono_us: mono * 1000, tz: 'UTC', tz_offset_min: 0 }, platform: 'macos', source: 't', kind, obs }))
  const heartbeat = (atMs: number, mono: number, awake: number, session = true) =>
    feed('heartbeat', { awake_us: awake * 1000, permissions: { accessibility: 'granted' }, registrations: { focus: true, session, power: true }, titles: 'ok', stall_ms: 0, dropped: 0 }, atMs, mono)
  const editor = { app_id: 'com.example.editor', name: 'Editor', path: null, pid: 7, registered_browser: false, engine: 'none', signer: null, version_info: null, identity_state: 'ok', store: null }
  const open = () => {
    feed('hello', { awake_us: 0, helper: 'fake', boot_identity: 'kernel', version: '0', pid: 1, os: 'test', permissions: { accessibility: 'granted' }, config: { heartbeat_s: 15, idle_threshold_s: 120, reconcile_s: 60 } }, 0)
    feed('power', { state: 'display_on', snapshot: true }, 1)
    feed('session', { state: 'unlocked', snapshot: true }, 2)
    feed('focus', { trigger: 'snapshot', app: editor, window: { window: 'w', title: 'notes.md', title_state: 'ok' } }, 3)
  }
  const seen = () => {
    store.flush()
    return store.query<{ seen: number }>(`SELECT last_seen_wall_ms - ? AS seen FROM observations WHERE kind = 'focus'`, T).map((x) => x.seen)
  }
  const gaps = () => {
    store.flush()
    return store.query<{ reason: string; scope: string; s: number; e: number | null; detail: string | null }>('SELECT reason, scope, start_wall_ms - ? AS s, end_wall_ms - ? AS e, detail FROM capture_gaps ORDER BY id', T, T)
  }
  return { open, heartbeat, seen, feed, gaps, editor, sent, close: () => store.close() }
}

test('a heartbeat after a sleep the helper never reported does not carry the row through it', () => {
  const s = fed()
  s.open()
  s.heartbeat(15_000, 15_000, 15_000)
  assert.deepEqual(s.seen(), [15_000])
  // An hour asleep: monotonic time ran on, awake time did not, and no sleep notice arrived.
  s.heartbeat(3_630_000, 3_630_000, 30_000)
  assert.deepEqual(s.seen(), [15_000])
  s.close()
})

test('after a sleep the helper never reported, nothing is recorded until the person is back', () => {
  const s = fed()
  const T = 1_792_130_400_000
  s.open()
  s.heartbeat(15_000, 15_000, 15_000)
  s.heartbeat(3_630_000, 3_630_000, 30_000)
  s.feed('power', { state: 'display_on', snapshot: true }, 3_630_001)
  s.feed('session', { state: 'unlocked', snapshot: true }, 3_630_002)
  s.feed('focus', { trigger: 'snapshot', app: s.editor, window: { window: 'w', title: 'notes.md', title_state: 'ok' } }, 3_630_003)
  assert.deepEqual(s.seen(), [15_000], 'the snapshot taken after the wake records no window')
  s.feed('input', { state: 'active', last_input_wall_ms: T + 3_640_000, threshold_s: 120, snapshot: false }, 3_640_000)
  s.feed('focus', { trigger: 'snapshot', app: s.editor, window: { window: 'w', title: 'notes.md', title_state: 'ok' } }, 3_640_001)
  assert.deepEqual(s.seen(), [15_000, 3_640_001], 'the first input after it is')
  s.close()
})

test('a sleep the helper never reported waits for the person, also when the helper stalled around it', () => {
  const s = fed()
  s.open()
  s.heartbeat(15_000, 15_000, 15_000)
  // 40 seconds awake (a stall) and 30 asleep between two heartbeats.
  s.heartbeat(85_000, 85_000, 55_000)
  s.feed('power', { state: 'display_on', snapshot: true }, 85_001)
  s.feed('session', { state: 'unlocked', snapshot: true }, 85_002)
  s.feed('focus', { trigger: 'snapshot', app: s.editor, window: { window: 'w', title: 'notes.md', title_state: 'ok' } }, 85_003)
  assert.deepEqual(s.seen(), [15_000], 'the snapshot taken after the wake records no window')
  s.close()
})

test('a sleep the helper did report is not taken again from the next heartbeat after the person is back', () => {
  const s = fed()
  const T = 1_792_130_400_000
  s.open()
  s.heartbeat(15_000, 15_000, 15_000)
  s.feed('power', { state: 'sleep' }, 20_000)
  s.feed('power', { state: 'resume' }, 50_000)
  s.feed('input', { state: 'active', last_input_wall_ms: T + 51_000, threshold_s: 120, snapshot: false }, 51_000)
  s.feed('focus', { trigger: 'snapshot', app: s.editor, window: { window: 'w', title: 'notes.md', title_state: 'ok' } }, 52_000)
  s.heartbeat(60_000, 60_000, 30_000)
  s.feed('focus', { trigger: 'snapshot', app: s.editor, window: { window: 'w', title: 'other.md', title_state: 'ok' } }, 61_000)
  assert.deepEqual(s.seen(), [15_000, 60_000, 61_000], 'capture goes on after the input that showed the person back: the heartbeat carries its row, and the next window is a row')
  s.close()
})

test('input from before a wake is not taken for the person back after the clock is moved forward', () => {
  const s = fed()
  const T = 1_792_130_400_000
  s.open()
  s.feed('power', { state: 'sleep' }, 20_000)
  s.feed('power', { state: 'resume' }, 100_000)
  // The clock moves 60 s forward: input 12 s before this line (at 90 s, before the wake) reads as 150 s.
  s.feed('input', { state: 'active', last_input_wall_ms: T + 150_000, threshold_s: 120, snapshot: true }, 162_000, 102_000)
  s.feed('power', { state: 'display_on', snapshot: true }, 163_000, 103_000)
  s.feed('session', { state: 'unlocked', snapshot: true }, 163_001, 103_001)
  s.feed('focus', { trigger: 'snapshot', app: s.editor, window: { window: 'w', title: 'notes.md', title_state: 'ok' } }, 163_002, 103_002)
  assert.deepEqual(s.seen(), [3], 'no window is recorded after the wake')
  s.close()
})

test('while the helper cannot receive lock events, a heartbeat does not extend the row', () => {
  const s = fed()
  s.open()
  s.heartbeat(15_000, 15_000, 15_000)
  s.heartbeat(30_000, 30_000, 30_000, false)
  s.heartbeat(45_000, 45_000, 45_000, false)
  assert.deepEqual(s.seen(), [15_000])
  s.close()
})

test('a display state the helper cannot read for longer than its reconcile interval is a gap until it can', () => {
  const s = fed()
  s.feed('hello', { awake_us: 0, helper: 'fake', boot_identity: 'kernel', version: '0', pid: 1, os: 'test', permissions: { accessibility: 'granted' }, config: { heartbeat_s: 15, idle_threshold_s: 120, reconcile_s: 60 } }, 0)
  s.feed('session', { state: 'unlocked', snapshot: true }, 2)
  s.feed('focus', { trigger: 'snapshot', app: s.editor, window: { window: 'w', title: 'notes.md', title_state: 'ok' } }, 3)
  for (let t = 15_000; t <= 60_000; t += 15_000) s.heartbeat(t, t, t)
  assert.deepEqual(s.gaps(), [], 'not before one reconcile interval has passed')
  s.heartbeat(75_000, 75_000, 75_000)
  assert.deepEqual(s.gaps(), [{ reason: 'events_unavailable', scope: 'power', s: 0, e: null, detail: '{"state":"unknown"}' }])
  assert.deepEqual(s.seen(), [], 'and nothing is recorded meanwhile')
  s.feed('power', { state: 'display_on', snapshot: true }, 80_000)
  assert.deepEqual(s.gaps().map((g) => g.e), [80_000])
  s.close()
})

test('a display the helper can no longer read stops recording, and is a gap once it has lasted a reconcile interval', () => {
  const s = fed()
  s.open()
  s.heartbeat(15_000, 15_000, 15_000)
  s.feed('power', { state: 'display_unknown', snapshot: true }, 20_000)
  for (let t = 30_000; t <= 90_000; t += 15_000) s.heartbeat(t, t, t)
  assert.deepEqual(s.seen(), [15_000], 'the row is not carried on while the display is not known')
  assert.deepEqual(s.gaps(), [{ reason: 'events_unavailable', scope: 'power', s: 20_000, e: null, detail: '{"state":"unknown"}' }])
  s.close()
})

test('a display not known for a reconcile interval is a gap, though the wall clock was set back meanwhile', () => {
  const s = fed()
  s.open()
  s.heartbeat(15_000, 15_000, 15_000)
  s.feed('power', { state: 'display_unknown', snapshot: true }, 20_000)
  for (let m = 30_000; m <= 90_000; m += 15_000) s.heartbeat(m - 60_000, m, m)
  assert.deepEqual(s.gaps().map((g) => [g.reason, g.scope, g.s]), [['events_unavailable', 'power', 20_000]])
  s.close()
})

test('a sleep the helper reported does not hide a later one it did not, between the same two heartbeats', () => {
  const s = fed()
  const T = 1_792_130_400_000
  s.open()
  s.heartbeat(15_000, 15_000, 15_000)
  s.feed('power', { state: 'sleep' }, 16_000)
  s.feed('power', { state: 'resume' }, 18_000)
  s.feed('input', { state: 'active', last_input_wall_ms: T + 19_000, threshold_s: 120, snapshot: false }, 19_000)
  // Asleep again from 20 s to 50 s, with no notice either way.
  s.heartbeat(50_000, 50_000, 18_000)
  s.feed('power', { state: 'display_on', snapshot: true }, 50_001)
  s.feed('session', { state: 'unlocked', snapshot: true }, 50_002)
  s.feed('focus', { trigger: 'snapshot', app: s.editor, window: { window: 'w', title: 'notes.md', title_state: 'ok' } }, 50_003)
  assert.deepEqual(s.seen(), [15_000], 'no window is recorded after the second wake until the person is back')
  s.close()
})

test('a sleep the helper reported without its wake is over at the next heartbeat, and capture waits only for the person', () => {
  const s = fed()
  const T = 1_792_130_400_000
  s.open()
  s.heartbeat(15_000, 15_000, 15_000)
  s.feed('power', { state: 'sleep' }, 20_000)
  s.heartbeat(60_000, 60_000, 30_000)
  s.feed('focus', { trigger: 'snapshot', app: s.editor, window: { window: 'w', title: 'notes.md', title_state: 'ok' } }, 60_001)
  assert.deepEqual(s.seen(), [15_000], 'not before the person is back')
  s.feed('input', { state: 'active', last_input_wall_ms: T + 61_000, threshold_s: 120, snapshot: false }, 61_000)
  s.feed('focus', { trigger: 'snapshot', app: s.editor, window: { window: 'w', title: 'notes.md', title_state: 'ok' } }, 61_001)
  assert.deepEqual(s.seen(), [15_000, 61_001])
  s.close()
})

test('while a wake waits for the person, each heartbeat asks for a snapshot, whose input shows them back', () => {
  const s = fed()
  const T = 1_792_130_400_000
  s.open()
  s.heartbeat(15_000, 15_000, 15_000)
  // Asleep 20 s, below the idle threshold, with no notice either way: the helper's own return check is never armed.
  s.heartbeat(50_000, 50_000, 30_000)
  s.feed('input', { state: 'active', last_input_wall_ms: T + 10_000, threshold_s: 120, snapshot: true }, 50_001)
  s.sent.length = 0
  s.heartbeat(65_000, 65_000, 45_000)
  assert.deepEqual(s.sent, ['snapshot'], 'the next heartbeat asks again')
  // The person is back, and active since: no input transition comes, only the snapshot's input line.
  s.feed('input', { state: 'active', last_input_wall_ms: T + 60_000, threshold_s: 120, snapshot: true }, 65_001)
  s.feed('focus', { trigger: 'snapshot', app: s.editor, window: { window: 'w', title: 'notes.md', title_state: 'ok' } }, 65_002)
  assert.deepEqual(s.seen(), [15_000, 65_002])
  s.sent.length = 0
  s.heartbeat(80_000, 80_000, 60_000)
  assert.deepEqual(s.sent, [], 'and stops asking once they are')
  s.close()
})
