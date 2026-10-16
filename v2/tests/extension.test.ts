import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Tracker, WINDOW_ID_NONE, type Tab, type TabMessage, type TabsApi, type Win } from '../browser/extension/src/focus.ts'

// A browser as the extension sees it: incognito windows are invisible unless a test says otherwise.
class FakeBrowser implements TabsApi {
  windows: Win[] = []
  tabs: Tab[] = []
  hold: Promise<void> | null = null
  async allWindows(): Promise<Win[]> {
    if (this.hold) await this.hold
    return this.windows.map((w) => ({ ...w }))
  }
  async activeTab(windowId: number): Promise<Tab | undefined> {
    return this.tabs.find((t) => t.windowId === windowId && t.active)
  }
  focus(id: number | null): void {
    for (const w of this.windows) w.focused = w.id === id
  }
}

function setup() {
  const b = new FakeBrowser()
  const sent: TabMessage[] = []
  const tr = new Tracker(b, (m) => sent.push(m))
  b.windows = [
    { id: 1, focused: true, incognito: false, type: 'normal' },
    { id: 2, focused: false, incognito: false, type: 'normal' },
  ]
  b.tabs = [
    { id: 11, windowId: 1, active: true, incognito: false, url: 'https://example.com/one', title: 'One' },
    { id: 12, windowId: 1, active: false, incognito: false, url: 'https://example.com/bg', title: 'Background tab' },
    { id: 21, windowId: 2, active: true, incognito: false, url: 'https://example.com/two', title: 'Two' },
  ]
  const states = () => sent.map((m) => (m.state === 'page' ? `page:${m.url}` : `unknown:${m.reason}`))
  return { b, sent, tr, states }
}

test('startup reports the focused tab of the focused normal window', async () => {
  const { tr, sent } = setup()
  await tr.startup()
  assert.deepEqual(sent, [{ t: 'tab', state: 'page', trigger: 'startup', window: '1', tab: '11', url: 'https://example.com/one', title: 'One' }])
})

test('focus moving between normal windows follows the focused one', async () => {
  const { b, tr, states } = setup()
  await tr.startup()
  b.focus(2)
  await tr.focusChanged(2)
  b.focus(1)
  await tr.focusChanged(1)
  assert.deepEqual(states(), ['page:https://example.com/one', 'page:https://example.com/two', 'page:https://example.com/one'])
})

test('the browser losing focus sends unknown at once, before any lookup', () => {
  const { b, tr, sent } = setup()
  b.hold = new Promise(() => {})
  void tr.focusChanged(WINDOW_ID_NONE)
  assert.deepEqual(sent, [{ t: 'tab', state: 'unknown', trigger: 'focus', reason: 'no_focused_window' }])
})

test('a private window the extension cannot see is unknown, never the normal window behind it', async () => {
  const { b, tr, states } = setup()
  await tr.startup()
  b.focus(null)
  await tr.focusChanged(WINDOW_ID_NONE)
  await tr.focusChanged(99)
  await tr.snapshot()
  assert.deepEqual(states(), ['page:https://example.com/one', 'unknown:no_focused_window', 'unknown:no_focused_window'])
})

test('a private window that is somehow visible is still never a page', async () => {
  const { b, tr, states } = setup()
  b.windows.push({ id: 3, focused: false, incognito: true, type: 'normal' })
  b.tabs.push({ id: 31, windowId: 3, active: true, incognito: true, url: 'https://canary.example/secret', title: 'Secret' })
  b.focus(3)
  await tr.focusChanged(3)
  b.windows[0]!.focused = true
  b.windows[2]!.focused = false
  b.tabs[0]!.incognito = true
  await tr.focusChanged(1)
  assert.deepEqual(states(), ['unknown:not_normal'])
})

test('devtools, popup and app windows are not normal', async () => {
  for (const type of ['devtools', 'popup', 'app', 'panel']) {
    const { b, tr, states } = setup()
    b.windows.push({ id: 4, focused: false, incognito: false, type })
    b.tabs.push({ id: 41, windowId: 4, active: true, incognito: false, url: 'https://example.com/devtools', title: 'DevTools' })
    b.focus(4)
    await tr.focusChanged(4)
    assert.deepEqual(states(), ['unknown:not_normal'], type)
  }
})

test('several windows: activity in a window that is not focused changes nothing', async () => {
  const { b, tr, sent } = setup()
  await tr.startup()
  b.tabs[2]!.title = 'Two, retitled'
  await tr.updated(b.tabs[2]!, { title: 'Two, retitled' })
  await tr.activated()
  assert.equal(sent.length, 1)
})

test('a background tab changing title is ignored; the active tab changing is sent', async () => {
  const { b, tr, states } = setup()
  await tr.startup()
  await tr.updated(b.tabs[1]!, { title: 'Background (2)' })
  await tr.updated(b.tabs[0]!, { status: 'complete' } as { title?: string })
  b.tabs[0]!.url = 'https://example.com/one?page=2'
  await tr.updated(b.tabs[0]!, { url: b.tabs[0]!.url })
  assert.deepEqual(states(), ['page:https://example.com/one', 'page:https://example.com/one?page=2'])
})

test('switching tabs in the focused window reports the new tab', async () => {
  const { b, tr, states } = setup()
  await tr.startup()
  b.tabs[0]!.active = false
  b.tabs[1]!.active = true
  await tr.activated()
  assert.deepEqual(states(), ['page:https://example.com/one', 'page:https://example.com/bg'])
})

test('a slow lookup that finishes after a newer unknown is thrown away', async () => {
  const { b, tr, states } = setup()
  let release!: () => void
  b.hold = new Promise((r) => (release = r))
  const slow = tr.focusChanged(1)
  b.hold = null
  void tr.focusChanged(WINDOW_ID_NONE)
  release()
  await slow
  assert.deepEqual(states(), ['unknown:no_focused_window'])
})

test('closing the focused window with no other focused window is unknown', async () => {
  const { b, tr, states } = setup()
  await tr.startup()
  b.windows = b.windows.filter((w) => w.id !== 1)
  b.tabs = b.tabs.filter((t) => t.windowId !== 1)
  await tr.removed()
  assert.deepEqual(states(), ['page:https://example.com/one', 'unknown:no_focused_window'])
})

test('identical states are sent once; a snapshot is always answered', async () => {
  const { tr, sent } = setup()
  await tr.startup()
  await tr.activated()
  await tr.focusChanged(1)
  assert.equal(sent.length, 1)
  await tr.snapshot()
  assert.equal(sent.length, 2)
  assert.equal(sent[1]!.trigger, 'snapshot')
})

test('pages without a real address are unknown; addresses are cleaned before they leave the browser', async () => {
  const { b, tr, sent, states } = setup()
  b.tabs[0]!.url = 'chrome://newtab/'
  await tr.startup()
  b.tabs[0]!.url = 'https://me:pw@example.com/cb?code=x&q=y#frag'
  await tr.activated()
  assert.deepEqual(states(), ['unknown:no_address', 'page:https://example.com/cb?q=y'])
  assert.ok(!JSON.stringify(sent).includes('pw') && !JSON.stringify(sent).includes('frag'))
})

test('while paused nothing but paused is sent; resuming answers with the present', async () => {
  const { b, tr, states } = setup()
  await tr.startup()
  await tr.setPaused(true)
  b.focus(2)
  await tr.focusChanged(2)
  await tr.focusChanged(WINDOW_ID_NONE)
  await tr.activated()
  await tr.setPaused(false)
  assert.deepEqual(states(), ['page:https://example.com/one', 'unknown:paused', 'page:https://example.com/two'])
})

test('a failing browser API is unknown, never the last page', async () => {
  const { b, tr, states } = setup()
  await tr.startup()
  b.allWindows = () => Promise.reject(new Error('gone'))
  await tr.focusChanged(2)
  assert.deepEqual(states(), ['page:https://example.com/one', 'unknown:no_focused_window'])
})

test('long titles are cut on a character boundary', async () => {
  const { b, tr, sent } = setup()
  b.tabs[0]!.title = 'a'.repeat(1023) + '🌘🌘'
  await tr.startup()
  const m = sent[0]!
  assert.ok(m.state === 'page' && m.title!.length === 1023)
})

test('a title with an unpaired surrogate is sent well-formed', async () => {
  const { b, tr, sent } = setup()
  b.tabs[0]!.title = 'a\uD800b'
  await tr.startup()
  const m = sent[0]!
  assert.ok(m.state === 'page' && m.title === 'a\uFFFDb')
})
