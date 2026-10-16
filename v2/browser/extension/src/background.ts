// Background script: listens to the browser and keeps one native port open to Daylens on this computer.
// The open port keeps the background alive, so focus changes are never missed between wake-ups.
// It never logs pages or titles.

import { Tracker, WINDOW_ID_NONE, type Tab, type TabMessage, type Win } from './focus.ts'
import type { PopupRequest, PopupState } from './messages.ts'

interface Port {
  error?: { message?: string }
  postMessage(msg: object): void
  disconnect(): void
  onMessage: { addListener(fn: (msg: Record<string, unknown>) => void): void }
  onDisconnect: { addListener(fn: () => void): void }
}

interface Event<F> {
  addListener(fn: F): void
}

interface Ext {
  runtime: {
    connectNative(name: string): Port
    lastError?: { message?: string }
    onMessage: Event<(msg: PopupRequest, sender: unknown, reply: (r: PopupState) => void) => boolean | void>
    onStartup: Event<() => void>
    onInstalled: Event<() => void>
  }
  windows: {
    getAll(opts?: { windowTypes?: string[] }): Promise<Win[]>
    onFocusChanged: Event<(windowId: number) => void>
    onRemoved: Event<(windowId: number) => void>
  }
  tabs: {
    query(q: { active: boolean; windowId: number }): Promise<Tab[]>
    onActivated: Event<(info: { tabId: number; windowId: number }) => void>
    onUpdated: Event<(tabId: number, change: { url?: string; title?: string }, tab: Tab) => void>
    onRemoved: Event<(tabId: number) => void>
    onReplaced: Event<(added: number, removed: number) => void>
  }
}

const g = globalThis as unknown as { browser?: Ext; chrome?: Ext }
const ext = (g.browser ?? g.chrome)!
const HOST = 'app.daylens.browser'
const ALL_TYPES = ['normal', 'popup', 'panel', 'app', 'devtools']
const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 300_000
const STATUS_WAIT_MS = 300

let port: Port | null = null
let retryMs = RETRY_MIN_MS
let nextAttemptAt = 0
const state: PopupState = { daylens: 'connecting', capture: 'running', until_wall_ms: null }
let openReply: ((ok: boolean) => void) | null = null
let statusWaiters: (() => void)[] = []

function whenStatus(fn: () => void): void {
  if (!port) return fn()
  let done = false
  const once = () => {
    if (done) return
    done = true
    fn()
  }
  statusWaiters.push(once)
  setTimeout(once, STATUS_WAIT_MS)
}

const tracker = new Tracker(
  {
    allWindows: async () => {
      try {
        return await ext.windows.getAll({ windowTypes: ALL_TYPES })
      } catch {
        return await ext.windows.getAll()
      }
    },
    activeTab: async (windowId) => (await ext.tabs.query({ active: true, windowId }))[0],
  },
  (msg: TabMessage) => post(msg),
)

function post(msg: object): void {
  ensurePort()
  try {
    port?.postMessage(msg)
  } catch {
    dropPort()
  }
}

function ensurePort(): void {
  if (port || Date.now() < nextAttemptAt) return
  let p: Port
  try {
    p = ext.runtime.connectNative(HOST)
  } catch {
    state.daylens = 'not_installed'
    backOff()
    return
  }
  port = p
  p.onMessage.addListener(onHostMessage)
  p.onDisconnect.addListener(() => {
    if (port !== p) return
    // Chromium reports why on runtime.lastError, Firefox on the port.
    const why = ext.runtime.lastError?.message ?? p.error?.message ?? ''
    state.daylens = /not found|no such native application/i.test(why) ? 'not_installed' : 'not_running'
    dropPort()
    backOff()
    const waiting = statusWaiters
    statusWaiters = []
    for (const w of waiting) w()
  })
  // Daylens has none of our state yet: the next state goes out even if it matches what we last sent.
  tracker.reset()
}

function dropPort(): void {
  port = null
}

function backOff(): void {
  nextAttemptAt = Date.now() + retryMs
  retryMs = Math.min(retryMs * 2, RETRY_MAX_MS)
}

function onHostMessage(msg: Record<string, unknown>): void {
  if (msg.t === 'status') {
    retryMs = RETRY_MIN_MS
    state.daylens = msg.daylens === 'connected' ? 'connected' : 'not_running'
    state.capture = msg.capture === 'paused' ? 'paused' : 'running'
    state.until_wall_ms = typeof msg.until_wall_ms === 'number' ? msg.until_wall_ms : null
    void tracker.setPaused(state.daylens === 'connected' && state.capture === 'paused')
    const waiting = statusWaiters
    statusWaiters = []
    for (const w of waiting) w()
  } else if (msg.t === 'snapshot') {
    void tracker.snapshot()
  } else if (msg.t === 'opened') {
    openReply?.(msg.ok === true)
    openReply = null
  }
}

ext.windows.onFocusChanged.addListener((id) => void tracker.focusChanged(id ?? WINDOW_ID_NONE))
ext.windows.onRemoved.addListener(() => void tracker.removed())
ext.tabs.onActivated.addListener(() => void tracker.activated())
ext.tabs.onUpdated.addListener((_id, change, tab) => void tracker.updated(tab, change))
ext.tabs.onRemoved.addListener(() => void tracker.removed())
ext.tabs.onReplaced.addListener(() => void tracker.activated())
ext.runtime.onStartup.addListener(() => void tracker.startup())
ext.runtime.onInstalled.addListener(() => void tracker.startup())

ext.runtime.onMessage.addListener((req, _sender, reply) => {
  if (req.t === 'open') {
    openReply = (ok) => reply({ ...state, opened: ok })
    post({ t: 'open' })
    if (!port) {
      openReply = null
      reply({ ...state, opened: false })
    }
    return true
  }
  if (req.t === 'pause') post({ t: 'pause', for: req.for })
  else if (req.t === 'resume') post({ t: 'resume' })
  else {
    nextAttemptAt = 0
    post({ t: 'status' })
  }
  whenStatus(() => reply({ ...state }))
  return true
})

ensurePort()
void tracker.startup()
