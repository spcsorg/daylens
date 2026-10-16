import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Normalizer, Privacy } from '../capture/normalize.ts'
import { Store } from '../capture/store.ts'
import { Supervisor, type SupervisorOptions } from '../capture/supervisor.ts'

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
  const dir = mkdtempSync(path.join(os.tmpdir(), 'daylens-v2-sup-'))
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
  const snapfile = path.join(mkdtempSync(path.join(os.tmpdir(), 'snap-')), 'snaps')
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

test('focus work dropped inside the helper becomes a gap with its time range', async () => {
  const h = harness({ FAKE_MODE: 'loss', FAKE_AFTER_MS: '300' })
  h.sup.start()
  await waitFor(() => h.gaps().some((g) => g.reason === 'events_dropped'))
  const g = h.gaps().find((x) => x.reason === 'events_dropped')!
  assert.equal(g.scope, 'focus')
  assert.equal(g.end_wall_ms! - g.start_wall_ms, 200)
  assert.deepEqual(JSON.parse(g.detail!), { count: 7 })
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
