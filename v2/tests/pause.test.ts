import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BrowserPages } from '../capture/browser.ts'
import { Privacy } from '../capture/normalize.ts'
import { Pause } from '../capture/pause.ts'
import { ServiceNormalizer } from '../capture/pipeline.ts'
import type { AppIdentity, LineOf, TabObs } from '../capture/protocol.ts'
import { app, focus } from './support/lines.ts'
import { MemorySink } from './support/memorySink.ts'

class Sink extends MemorySink {
  metaValues = new Map<string, string>()
  meta(k: string): string | null {
    return this.metaValues.get(k) ?? null
  }
  setMeta(k: string, v: string | null): void {
    if (v === null) this.metaValues.delete(k)
    else this.metaValues.set(k, v)
  }
}

const chrome = app('com.google.Chrome', { pid: 500, registered_browser: true, name: 'Google Chrome' })
const dia = app('company.thebrowser.dia', { pid: 600, registered_browser: true, name: 'Dia' })
const slack = app('com.tinyspeck.slackmacgap', { pid: 700 })

class Host {
  seq = 0
  sent: string[] = []
  id: number
  readonly pages: BrowserPages
  readonly browser: AppIdentity
  readonly run = `run-${Math.random().toString(16).slice(2, 10)}`
  constructor(pages: BrowserPages, browser: AppIdentity) {
    this.pages = pages
    this.browser = browser
    this.id = pages.connect({ send: (m) => this.sent.push(m.op) })
  }
  line(obs: Partial<TabObs>, wall: number): LineOf<'tab'> {
    const full: TabObs = {
      trigger: 'activated',
      state: 'page',
      reason: null,
      browser: this.browser,
      extension: 'abcdefghijklmnopabcdefghijklmnop',
      window: '1',
      tab: '1',
      url: 'https://example.com/',
      title: 'Example',
      ...obs,
    }
    return {
      v: 1,
      run: this.run,
      seq: this.seq++,
      boot: 'boot-test',
      t: { wall_ms: wall, mono_us: wall * 1000, tz: 'Africa/Kigali', tz_offset_min: 120 },
      platform: 'macos',
      source: 'browser_ext',
      kind: 'tab',
      obs: full,
    }
  }
  page(url: string, title: string, wall: number, window = '1'): void {
    this.pages.onTab(this.id, this.line({ url, title, window }, wall))
  }
  unknown(reason: TabObs['reason'], wall: number): void {
    this.pages.onTab(this.id, this.line({ state: 'unknown', reason, url: null, title: null, window: null, tab: null, trigger: 'focus' }, wall))
  }
}

test('pause is exact: nothing with an event time inside the hour is stored, and capture resumes after', () => {
  const sink = new Sink()
  let now = 10_000
  const rules = new Privacy([])
  const pages = new BrowserPages(sink, rules)
  const changes: boolean[] = []
  let norm: ServiceNormalizer
  const pause = new Pause(sink, {
    now: () => now,
    onChange: (s, at) => {
      changes.push(s.paused)
      norm.interrupt(at)
    },
  })
  norm = new ServiceNormalizer(sink, rules, pause, pages)
  const h = new Host(pages, chrome)
  const T = 10_000
  const H = 3_600_000
  norm.handle(focus(chrome, null, T - 1000, 'app_changed'))
  h.page('https://example.com/before', 'Before', T - 990)
  pause.pause('hour')
  for (const t of [T, T + 1, T + H / 2, T + H - 1]) {
    norm.handle(focus(slack, 'secret paused title', t, 'app_changed'))
    if (!pause.blocks(t)) h.page('https://example.com/paused', 'Paused page', t)
  }
  now = T + H + 5
  norm.handle(focus(slack, 'after', T + H, 'snapshot'))
  const inside = sink.rows.filter((r) => r.event_wall_ms >= T && r.event_wall_ms < T + H)
  assert.deepEqual(inside, [])
  assert.ok(sink.rows.every((r) => r.last_seen_wall_ms < T || r.event_wall_ms >= T + H), 'no row is extended into the pause')
  assert.ok(!JSON.stringify(sink.rows).includes('paused'), 'no paused title or page anywhere')
  const g = sink.gaps.find((x) => x.reason === 'paused')!
  assert.deepEqual([g.start.wall_ms, g.end?.wall_ms], [T, T + H])
  assert.ok(sink.rows.some((r) => r.kind === 'focus' && r.event_wall_ms === T + H && r.title === 'after'), 'capture resumes at the end')
  assert.deepEqual(changes, [true, false])
  assert.equal(JSON.parse(sink.meta('pause') ?? '{}').since_wall_ms ?? null, null, 'no pause is active')
})

test('pause until resumed, resume, and a pause that outlives a restart', () => {
  const sink = new Sink()
  let now = 1000
  const p = new Pause(sink, { now: () => now })
  p.pause('until_resumed')
  assert.deepEqual(p.state(), { paused: true, since_wall_ms: 1000, until_wall_ms: null })
  now = 5000
  const p2 = new Pause(sink, { now: () => now })
  p2.restore()
  assert.ok(p2.blocks(5000) && p2.state().paused)
  p2.resume()
  assert.equal(p2.state().paused, false)
  assert.ok(!p2.blocks(5001))
  const paused = sink.gaps.filter((x) => x.reason === 'paused')
  assert.equal(paused.length, 2)
  assert.equal(paused[1]!.end?.wall_ms, 5000)
  p.stop()
})

test('a pause that expired while the service was down is cleared on restore', () => {
  const sink = new Sink()
  let now = 1000
  const p = new Pause(sink, { now: () => now })
  p.pause('hour')
  p.stop()
  now = 1000 + 3_600_000 + 1
  const p2 = new Pause(sink, { now: () => now })
  p2.restore()
  assert.equal(p2.state().paused, false)
  assert.equal(JSON.parse(sink.meta('pause') ?? '{}').since_wall_ms ?? null, null, 'no pause is active')
})

test('until tomorrow ends at the next local midnight', () => {
  const sink = new Sink()
  const now = new Date(2026, 9, 16, 14, 30).getTime()
  const p = new Pause(sink, { now: () => now })
  assert.equal(p.pause('tomorrow').until_wall_ms, new Date(2026, 9, 17, 0, 0).getTime())
  p.stop()
})

test('an event stamped inside a finished pause is still dropped when it arrives late, across restarts', () => {
  const sink = new Sink()
  let now = 1000
  const p = new Pause(sink, { now: () => now })
  p.pause('until_resumed')
  now = 2000
  p.resume()
  assert.ok(p.blocks(1500), 'manual resume: a late event from inside the pause')
  assert.ok(!p.blocks(2500))
  now = 10_000
  p.pause('hour')
  now = 10_000 + 3_600_000 + 5
  assert.ok(!p.blocks(now), 'the hour is over')
  assert.ok(p.blocks(10_000 + 60_000), 'expired pause: a late event from inside it')
  assert.ok(p.blocks(1999), 'the first pause still counts')
  assert.ok(!p.blocks(5000), 'time between pauses is not paused')
  p.stop()
  const after = new Pause(sink, { now: () => now })
  after.restore()
  assert.equal(after.state().paused, false)
  assert.ok(after.blocks(1500) && after.blocks(10_000 + 60_000), 'finished pauses survive a restart')
  assert.ok(!after.blocks(5000))
})
