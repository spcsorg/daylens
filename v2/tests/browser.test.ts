import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BrowserPages } from '../capture/browser.ts'
import { Privacy } from '../capture/normalize.ts'
import { ServiceNormalizer } from '../capture/pipeline.ts'
import type { AppIdentity, LineOf, TabObs } from '../capture/protocol.ts'
import { app, focus, line } from './support/lines.ts'
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
  epochs: (number | null)[] = []
  id: number
  readonly pages: BrowserPages
  readonly browser: AppIdentity
  readonly run = `run-${Math.random().toString(16).slice(2, 10)}`
  constructor(pages: BrowserPages, browser: AppIdentity) {
    this.pages = pages
    this.browser = browser
    this.id = pages.connect({
      send: (m) => {
        this.sent.push(m.op)
        this.epochs.push(m.epoch)
      },
    })
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
      t: { wall_ms: wall, mono_us: wall * 1000, tz: 'Example/Town', tz_offset_min: -300 },
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

function setup(rules = new Privacy([])) {
  const sink = new Sink()
  const pages = new BrowserPages(sink, rules)
  const norm = new ServiceNormalizer(sink, rules, pages)
  const pageRows = () => sink.rows.filter((r) => r.kind === 'page').map((r) => ({ t: r.event_wall_ms, state: r.state, url: r.url ?? null, title: r.title, seen: r.last_seen_wall_ms, detail: r.detail }))
  return { sink, pages, norm, pageRows }
}

test('a page is stored only while that browser is in front and the extension spoke after it came forward', () => {
  const { pages, norm, pageRows } = setup()
  const h = new Host(pages, chrome)
  h.page('https://example.com/early', 'Early', 1000)
  assert.deepEqual(pageRows(), [], 'nothing is in front yet')
  norm.handle(focus(chrome, null, 2000, 'app_changed'))
  assert.deepEqual(pageRows(), [], 'a claim from before the browser came forward is not reused')
  assert.deepEqual(h.sent, ['snapshot'])
  h.page('https://example.com/early', 'Early', 2010)
  h.page('https://example.com/early', 'Early', 2500)
  assert.equal(pageRows().length, 1)
  assert.deepEqual(pageRows()[0]!.state, 'normal')
  assert.equal(pageRows()[0]!.seen, 2500)
})

test('the browser losing focus ends the page with an explicit unknown row', () => {
  const { pages, norm, pageRows } = setup()
  const h = new Host(pages, chrome)
  norm.handle(focus(chrome, null, 1000, 'app_changed'))
  h.page('https://example.com/a', 'A', 1010)
  norm.handle(focus(slack, 'general', 5000, 'app_changed'))
  assert.deepEqual(pageRows().map((r) => [r.t, r.state, r.url]), [
    [1010, 'normal', 'https://example.com/a'],
    [5000, 'unknown', null],
  ])
  assert.match(pageRows()[1]!.detail!, /app_changed/)
  h.page('https://example.com/a', 'A', 5100)
  assert.equal(pageRows().length, 2, 'a page from a browser that is not in front is never stored')
})

test('unknown from the extension (a private or devtools window) is browser time with no page', () => {
  const { sink, pages, norm, pageRows } = setup()
  const h = new Host(pages, chrome)
  norm.handle(focus(chrome, 'Shared page - Google Chrome', 1000, 'app_changed'))
  h.page('https://example.com/shared', 'Shared page', 1010)
  norm.handle(focus(chrome, 'Shared page - Google Chrome', 2000, 'window_changed', 'w2'))
  h.unknown('no_focused_window', 2005)
  assert.deepEqual(pageRows().map((r) => [r.t, r.state]), [[1010, 'normal'], [2000, 'unknown']], 'the window change itself ends the page')
  const focusRows = sink.rows.filter((r) => r.kind === 'focus')
  assert.ok(focusRows.length > 0 && focusRows.every((r) => r.app_id === 'com.google.Chrome' && r.title === null && r.title_state === 'withheld_browser'))
})

test('stale async results cannot outlive a newer unknown, and repeated unknowns add nothing', () => {
  const { pages, norm, pageRows } = setup()
  const h = new Host(pages, chrome)
  norm.handle(focus(chrome, null, 1000, 'app_changed'))
  h.unknown('no_focused_window', 1001)
  h.unknown('not_normal', 1002)
  assert.deepEqual(pageRows(), [])
})

test('two profiles in one browser: the newest claim wins and an unknown withdraws only its own', () => {
  const { pages, norm, pageRows } = setup()
  const a = new Host(pages, chrome)
  const b = new Host(pages, chrome)
  norm.handle(focus(chrome, null, 1000, 'app_changed'))
  a.page('https://a.example.com/', 'Work', 1010)
  b.page('https://b.example.com/', 'Home', 2000)
  a.unknown('no_focused_window', 2001)
  assert.deepEqual(pageRows().map((r) => [r.t, r.state, r.url]), [
    [1010, 'normal', 'https://a.example.com/'],
    [2000, 'normal', 'https://b.example.com/'],
  ])
  b.unknown('no_focused_window', 3000)
  assert.deepEqual(pageRows().at(-1)!.state, 'unknown')
})

test('a different browser in front never takes a page from another browser', () => {
  const { pages, norm, pageRows } = setup()
  const hc = new Host(pages, chrome)
  new Host(pages, dia)
  norm.handle(focus(dia, null, 1000, 'app_changed'))
  hc.page('https://example.com/', 'Chrome page', 1010)
  assert.deepEqual(pageRows(), [])
})

test('the same app id with a different pid is a different browser', () => {
  const { pages, norm, pageRows } = setup()
  const h = new Host(pages, { ...chrome, pid: 501 })
  norm.handle(focus(chrome, null, 1000, 'app_changed'))
  h.page('https://example.com/', 'x', 1010)
  assert.deepEqual(pageRows(), [])
})

test('a host whose browser identity is unknown never stores a page', () => {
  const { pages, norm, pageRows } = setup()
  const h = new Host(pages, { ...chrome, identity_state: 'access_denied', app_id: null })
  norm.handle(focus(chrome, null, 1000, 'app_changed'))
  h.page('https://example.com/', 'x', 1010)
  assert.deepEqual(pageRows(), [])
})

test('a closed connection ends its page at once', () => {
  const { pages, norm, pageRows } = setup()
  const h = new Host(pages, chrome)
  norm.handle(focus(chrome, null, 1000, 'app_changed'))
  h.page('https://example.com/', 'x', 1010)
  pages.disconnect(h.id)
  assert.deepEqual(pageRows().map((r) => r.state), ['normal', 'unknown'])
  assert.match(pageRows()[1]!.detail!, /disconnected/)
})

test('lost host lines withdraw the page and ask for a snapshot', () => {
  const { pages, norm, pageRows } = setup()
  const h = new Host(pages, chrome)
  norm.handle(focus(chrome, null, 1000, 'app_changed'))
  h.page('https://example.com/', 'x', 1010)
  h.seq += 3
  h.page('https://example.com/', 'x', 2000)
  assert.deepEqual(pageRows().map((r) => r.state), ['normal', 'unknown'])
  assert.equal(h.sent.at(-1), 'snapshot')
})

test('a helper interruption forgets the page; the gap covers the time', () => {
  const { pages, norm, pageRows } = setup()
  const h = new Host(pages, chrome)
  norm.handle(focus(chrome, null, 1000, 'app_changed'))
  h.page('https://example.com/', 'x', 1010)
  norm.interrupt({ wall_ms: 2000, mono_us: null, boot: null })
  h.page('https://example.com/', 'x', 2100)
  assert.equal(pageRows().length, 1, 'no page until the helper reports the front app again')
  norm.handle(focus(chrome, null, 2200, 'snapshot'))
  h.page('https://example.com/', 'x', 2210)
  assert.equal(pageRows().length, 2)
})

test('after an unlock the page in front is asked for again and recorded as a new row', () => {
  const { pages, norm, pageRows } = setup()
  const h = new Host(pages, chrome)
  norm.handle(focus(chrome, null, 1000, 'app_changed'))
  h.page('https://example.com/', 'x', 1010)
  norm.handle(line('session', { state: 'locked', snapshot: false }, 2000))
  h.page('https://example.com/', 'x', 2100)
  norm.handle(focus(chrome, null, 2200, 'snapshot'))
  assert.equal(pageRows().length, 1, 'nothing while locked')
  norm.handle(line('session', { state: 'unlocked', snapshot: false }, 9000))
  norm.handle(focus(chrome, null, 9010, 'snapshot'))
  assert.deepEqual(h.sent, ['snapshot', 'snapshot'], 'the fresh read of the browser asks the extension again')
  h.page('https://example.com/', 'x', 9020)
  assert.deepEqual(pageRows().map((r) => [r.t, r.seen]), [
    [1010, 1010],
    [9020, 9020],
  ])
})

test('addresses are cleaned before storage and pages with no address are unknown', () => {
  const { pages, norm, pageRows } = setup()
  const h = new Host(pages, chrome)
  norm.handle(focus(chrome, null, 1000, 'app_changed'))
  h.page('https://u:p@example.com/cb?code=secret&q=1#frag', '(3) Inbox', 1010)
  h.page('chrome://settings/', 'Settings', 2000)
  assert.deepEqual(pageRows().map((r) => [r.state, r.url, r.title]), [
    ['normal', 'https://example.com/cb?q=1', 'Inbox'],
    ['unknown', null, null],
  ])
  assert.match(pageRows()[1]!.detail!, /no_address/)
})

test('an excluded site leaves only an excluded gap; an excluded browser leaves nothing', () => {
  const rules = new Privacy([
    { match: 'site', value: '1password.com', label: '1Password' },
    { match: 'app_id', value: 'company.thebrowser.dia', label: 'Dia' },
  ])
  const { sink, pages, norm, pageRows } = setup(rules)
  const h = new Host(pages, chrome)
  norm.handle(focus(chrome, null, 1000, 'app_changed'))
  h.page('https://example.com/', 'Before', 1010)
  h.page('https://my.1password.com/vaults/all', 'Secret vault item', 2000)
  h.page('https://example.com/', 'After', 3000)
  assert.deepEqual(pageRows().map((r) => [r.t, r.state, r.title]), [
    [1010, 'normal', 'Before'],
    [2000, 'unknown', null],
    [3000, 'normal', 'After'],
  ])
  const g = sink.gaps.find((x) => x.reason === 'excluded')!
  assert.equal(g.start.wall_ms, 2000)
  assert.equal(g.end?.wall_ms, 3000)
  assert.ok(!JSON.stringify(sink.rows).includes('1password') && !JSON.stringify(sink.rows).includes('Secret vault'))

  const hd = new Host(pages, dia)
  norm.handle(focus(dia, null, 4000, 'app_changed'))
  hd.page('https://example.com/dia', 'Dia page', 4010)
  assert.ok(!sink.rows.some((r) => r.url === 'https://example.com/dia'))
})

test('a title change in the same tab starts a new row; the same page repeated extends it', () => {
  const { pages, norm, pageRows } = setup()
  const h = new Host(pages, chrome)
  norm.handle(focus(chrome, null, 1000, 'app_changed'))
  h.page('https://example.com/', 'Loading', 1010)
  h.page('https://example.com/', 'Loaded', 1100)
  h.page('https://example.com/', 'Loaded', 1900)
  assert.deepEqual(pageRows().map((r) => [r.title, r.seen]), [['Loading', 1010], ['Loaded', 1900]])
})

test('a window change inside the same browser ends the page until that window is confirmed', async () => {
  const { pages, norm, pageRows } = setup()
  const h = new Host(pages, chrome)
  norm.handle(focus(chrome, null, 1000, 'app_changed', 'w1'))
  h.page('https://example.com/a', 'A', 1010)
  norm.handle(focus(chrome, null, 2000, 'window_changed', 'w2'))
  assert.deepEqual(pageRows().map((r) => [r.t, r.state]), [[1010, 'normal'], [2000, 'unknown']])
  assert.match(pageRows()[1]!.detail!, /window_changed/)
  assert.equal(h.sent.at(-1), 'snapshot', 'the extension is asked about the new window')
})

test('a claim stamped before the window change is stale even if it arrives after it', async () => {
  const { pages, norm, pageRows } = setup()
  const h = new Host(pages, chrome)
  norm.handle(focus(chrome, null, 1000, 'app_changed', 'w1'))
  norm.handle(focus(chrome, null, 2000, 'window_changed', 'w2'))
  h.page('https://example.com/old', 'Old', 1500)
  assert.deepEqual(pageRows(), [])
  h.page('https://example.com/new', 'New', 2100)
  assert.deepEqual(pageRows().map((r) => r.url), ['https://example.com/new'])
})

test('a snapshot reply counts only for the focus epoch that asked for it', async () => {
  const { pages, norm, pageRows } = setup()
  const h = new Host(pages, chrome)
  norm.handle(focus(chrome, null, 1000, 'app_changed', 'w1'))
  const first = h.epochs.at(-1)
  norm.handle(focus(chrome, null, 2000, 'window_changed', 'w2'))
  const second = h.epochs.at(-1)
  assert.ok(typeof first === 'number' && typeof second === 'number' && second > first)
  if (typeof first !== 'number' || typeof second !== 'number') return
  h.pages.onTab(h.id, h.line({ trigger: 'snapshot', url: 'https://example.com/w1', title: 'W1', epoch: first }, 2050))
  assert.deepEqual(pageRows(), [], 'an answer about the earlier window is dropped although it arrived late')
  h.pages.onTab(h.id, h.line({ trigger: 'snapshot', url: 'https://example.com/w2', title: 'W2', epoch: second }, 2060))
  assert.deepEqual(pageRows().map((r) => r.url), ['https://example.com/w2'])
})


test('when ownership moves to another profile, the earlier profile cannot come back without a fresh claim', async () => {
  for (const ending of ['b-withdraws', 'b-disconnects', 'a-withdraws-first'] as const) {
    const { pages, norm, pageRows } = setup()
    const a = new Host(pages, chrome)
    const b = new Host(pages, chrome)
    norm.handle(focus(chrome, null, 1000, 'app_changed'))
    a.page('https://a.example.com/', 'A', 1010)
    b.page('https://b.example.com/', 'B', 2000)
    if (ending === 'b-withdraws') b.unknown('no_focused_window', 3000)
    if (ending === 'b-disconnects') pages.disconnect(b.id)
    if (ending === 'a-withdraws-first') {
      a.unknown('no_focused_window', 2500)
      assert.deepEqual(pageRows().at(-1)!.url, 'https://b.example.com/', 'a profile that no longer owns the page cannot end it')
      b.unknown('no_focused_window', 3000)
    }
    assert.deepEqual(pageRows().map((r) => r.url ?? r.state), ['https://a.example.com/', 'https://b.example.com/', 'unknown'], ending)
    a.page('https://a.example.com/', 'A', 4000)
    assert.equal(pageRows().at(-1)!.url, 'https://a.example.com/', `${ending}: a fresh claim takes over again`)
  }
})
