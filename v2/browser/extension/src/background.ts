// Background script: listens to the browser and keeps one connection open to Daylens on this computer.
// It tries the native messaging host first. Where the browser cannot find one (Windows, where Daylens is a Store
// package) it uses the local connection instead, once this browser has been connected to Daylens.
// The open connection keeps the background alive, so focus changes are never missed between wake-ups.
// It never logs pages or titles.

import { newPairing, pairLink, type Pairing } from '../../../capture/pairing.ts'
import { LOCAL_EVERYWHERE } from './config.ts'
import { Tracker, WINDOW_ID_NONE, type Tab, type TabMessage, type Win } from './focus.ts'
import * as kv from './kv.ts'
import { connectLocal, type Session, type WsLike } from './local.ts'
import type { PauseFor, PopupRequest, PopupState } from './messages.ts'

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
    getURL(path: string): string
    getPlatformInfo(): Promise<{ os: string }>
    lastError?: { message?: string }
    onMessage: Event<(msg: PopupRequest, sender: unknown, reply: (r: PopupState) => void) => boolean | void>
    onStartup: Event<() => void>
    onInstalled: Event<() => void>
  }
  alarms: {
    create(name: string, info: { when: number }): void
    clear(name: string): Promise<boolean>
    onAlarm: Event<(alarm: { name: string }) => void>
  }
  windows: {
    getAll(opts?: { windowTypes?: string[] }): Promise<Win[]>
    onFocusChanged: Event<(windowId: number) => void>
    onRemoved: Event<(windowId: number) => void>
  }
  tabs: {
    query(q: { active: boolean; windowId: number }): Promise<Tab[]>
    create(props: { url: string; active: boolean }): Promise<{ id?: number }>
    remove(id: number): Promise<void>
    onActivated: Event<(info: { tabId: number; windowId: number }) => void>
    onUpdated: Event<(tabId: number, change: { url?: string; title?: string }, tab: Tab) => void>
    onRemoved: Event<(tabId: number) => void>
    onReplaced: Event<(added: number, removed: number) => void>
  }
}

const g = globalThis as unknown as { browser?: Ext; chrome?: Ext; WebSocket: new (url: string) => WsLike }
const ext = (g.browser ?? g.chrome)!
const HOST = 'app.daylens.browser'
const ALL_TYPES = ['normal', 'popup', 'panel', 'app', 'devtools']
const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 300_000
const STATUS_WAIT_MS = 300
const HOUR_MS = 3_600_000
// setTimeout cannot wait longer than this; a longer wait is re-armed.
const MAX_TIMER_MS = 2 ** 31 - 1

type Link = { kind: 'native'; port: Port } | { kind: 'local'; session: Session }

let ready = false
let link: Link | null = null
let attempting = false
let localAllowed = LOCAL_EVERYWHERE
let pairing: Pairing | null = null
let pairPending = false
let awaitingAllow = false
let pairTab: number | null = null
let pairRetry: ReturnType<typeof setTimeout> | null = null
// Chrome stops an idle service worker after 30 s and its timers with it; a longer wait is an alarm, which wakes it.
const ALARM_AFTER_MS = 25_000
const ALARM_RECONNECT = 'daylens-reconnect'
const ALARM_PAIR = 'daylens-pair'
let browserPause: { until: number | null } | null = null
// Until the saved pause has been read, this browser counts as paused: an unreadable pause never resumes it.
let pauseRead = false
let platformRead = false
let pauseTimer: ReturnType<typeof setTimeout> | null = null
let retryMs = RETRY_MIN_MS
let nextAttemptAt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const state: Pick<PopupState, 'daylens' | 'capture' | 'until_wall_ms'> = { daylens: 'connecting', capture: 'running', until_wall_ms: null }
let openReply: ((ok: boolean) => void) | null = null
let statusWaiters: (() => void)[] = []

function popupState(): PopupState {
  return {
    ...state,
    paused: browserPaused(),
    paused_until_wall_ms: browserPause?.until ?? null,
    pause_unreadable: !pauseRead,
    connecting_pair: pairPending,
    awaiting_allow: awaitingAllow,
  }
}

function wakeWaiters(): void {
  const waiting = statusWaiters
  statusWaiters = []
  for (const w of waiting) w()
}

function whenStatus(fn: () => void): void {
  if (!link && !attempting) return fn()
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
  ensureLink()
  const l = link
  if (!l) return
  try {
    if (l.kind === 'native') l.port.postMessage(msg)
    else l.session.send(msg)
  } catch {
    // A send that fails means the connection is gone; it is retried like any other loss.
    if (link !== l) return
    link = null
    settleControl(true)
    try {
      if (l.kind === 'native') l.port.disconnect()
      else l.session.close()
    } catch {
      // Already closed: the connection is dropped either way.
    }
    state.daylens = 'not_running'
    backOff()
    wakeWaiters()
  }
}

function ensureLink(): void {
  if (!ready || link || attempting || Date.now() < nextAttemptAt) return
  // Native messaging first on every attempt: a host that was missing may have been installed since.
  connectNative()
}

function connectNative(): void {
  let p: Port
  try {
    p = ext.runtime.connectNative(HOST)
  } catch {
    return onNativeMissing()
  }
  link = { kind: 'native', port: p }
  cancelReconnect()
  p.onMessage.addListener(onDaylensMessage)
  p.onDisconnect.addListener(() => {
    if (link?.kind !== 'native' || link.port !== p) return
    link = null
    settleControl(true)
    // Chromium reports why on runtime.lastError, Firefox on the port.
    const why = ext.runtime.lastError?.message ?? p.error?.message ?? ''
    if (/not found|no such native application/i.test(why)) return onNativeMissing()
    state.daylens = 'not_running'
    backOff()
    wakeWaiters()
  })
  // Daylens has none of our state yet: the next state goes out even if it matches what we last sent.
  tracker.reset()
}

function onNativeMissing(): void {
  // Without the platform, the local connection Windows needs would never be tried: it is asked again first.
  if (!localAllowed && !platformRead) {
    attempting = true
    void readPlatform().then(() => {
      attempting = false
      if (localAllowed) return void connectLocalNow()
      notInstalled()
    })
    return
  }
  if (localAllowed) return void connectLocalNow()
  notInstalled()
}

function notInstalled(): void {
  state.daylens = 'not_installed'
  backOff()
  wakeWaiters()
}

async function connectLocalNow(): Promise<void> {
  if (!pairing) {
    state.daylens = 'unpaired'
    return wakeWaiters()
  }
  attempting = true
  const tried = pairing
  let session: Session | null = null
  const r = await connectLocal(
    (url) => new g.WebSocket(url),
    tried,
    onDaylensMessage,
    () => {
      if (link?.kind !== 'local' || link.session !== session) return
      link = null
      settleControl(true)
      state.daylens = 'not_running'
      backOff()
      wakeWaiters()
    },
    {
      onAwaiting: () => {
        awaitingAllow = true
        wakeWaiters()
      },
    },
  )
  attempting = false
  awaitingAllow = false
  if (r.kind === 'denied') {
    // Not allowed in Daylens: this pairing is finished; Connect starts a new one.
    finishPairing()
    pairing = null
    // A pairing left behind is denied again at its next use, and then removed.
    await kv.set('pairing', undefined).catch(() => {})
    state.daylens = 'unpaired'
    return wakeWaiters()
  }
  if (r.kind === 'connected') {
    session = r.session
    if (pairing !== tried) return r.session.close()
    link = { kind: 'local', session }
    cancelReconnect()
    retryMs = RETRY_MIN_MS
    nextAttemptAt = 0
    tracker.reset()
    if (pairPending) finishPairing()
    return
  }
  state.daylens = r.kind === 'unpaired' ? 'unpaired' : 'not_running'
  backOff()
  if (pairPending) schedulePairRetry()
  wakeWaiters()
}

// After a failed connect or a lost connection, try again on a timer: 1 s, doubling to 5 minutes.
function backOff(): void {
  nextAttemptAt = Date.now() + retryMs
  cancelReconnect()
  if (retryMs <= ALARM_AFTER_MS) {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      ensureLink()
    }, retryMs)
  } else ext.alarms.create(ALARM_RECONNECT, { when: nextAttemptAt })
  retryMs = Math.min(retryMs * 2, RETRY_MAX_MS)
}

function cancelReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  // An alarm that fires anyway finds a connection open and does nothing.
  void ext.alarms.clear(ALARM_RECONNECT).catch(() => {})
}

// Daylens records this browser's pause itself, so its pages and window titles both stop; it learns of each pause
// and resume, and of the current one whenever it connects. A pause that could not be read is a pause until resumed.
function tellDaylensPause(req?: string): void {
  const who = { ...(profile === null ? {} : { profile }), ...(req === undefined ? {} : { req }) }
  post(browserPaused() ? { t: 'pause', until_wall_ms: browserPause?.until ?? null, ...who } : { t: 'resume', ...who })
}

// This browser profile's own id, made up once and kept with its pause: Daylens holds each profile's pause apart, so
// one profile resuming, or connecting unpaused, never ends another's.
let profile: string | null = null

async function readProfile(): Promise<void> {
  try {
    profile = (await kv.get<string>('profile')) ?? null
    if (profile === null) {
      const id = crypto.randomUUID()
      await kv.set('profile', id)
      profile = id
    }
  } catch {
    // Without a stored id the pause is sent without one, as one browser-wide pause.
  }
}

function onDaylensMessage(msg: Record<string, unknown>): void {
  if (msg.t === 'status') {
    // Only the reply to the pause or resume waiting says it was recorded; any other status (another browser's change)
    // says nothing about it.
    if (typeof msg.req === 'string') settleControl(true, msg.req)
    // The host says Daylens stopped: the pause is held here and sent when it connects, as when it was not running.
    else if (msg.daylens !== 'connected') settleControl(true)
    retryMs = RETRY_MIN_MS
    const connected = state.daylens !== 'connected' && msg.daylens === 'connected'
    state.daylens = msg.daylens === 'connected' ? 'connected' : 'not_running'
    state.capture = msg.capture === 'paused' ? 'paused' : 'running'
    state.until_wall_ms = typeof msg.until_wall_ms === 'number' ? msg.until_wall_ms : null
    applyPause()
    if (connected) {
      tellDaylensPause()
      void readPause()
    }
    wakeWaiters()
  } else if (msg.t === 'snapshot') {
    void tracker.snapshot(typeof msg.epoch === 'number' && Number.isSafeInteger(msg.epoch) && msg.epoch >= 0 ? msg.epoch : undefined)
  } else if (msg.t === 'opened') {
    openReply?.(msg.ok === true)
    openReply = null
  } else if (msg.t === 'error' && (msg.for === 'pause' || msg.for === 'resume')) {
    settleControl(false, typeof msg.req === 'string' ? msg.req : undefined)
  }
}

// A pause or resume waits for Daylens to record it: the reply carrying its id says it did, or that it could not. With
// no connection the pause holds here, and Daylens hears it when it connects.
let controlWaiter: { req: string; resolve: (ok: boolean) => void } | null = null
let controlSeq = 0

// `req`: settles only the request with that id; without one (the connection went), any.
function settleControl(ok: boolean, req?: string): void {
  const w = controlWaiter
  if (!w || (req !== undefined && req !== w.req)) return
  controlWaiter = null
  w.resolve(ok)
}

function tellDaylensAndWait(): Promise<boolean> {
  settleControl(true)
  const req = String(++controlSeq)
  tellDaylensPause(req)
  if (!link || state.daylens !== 'connected') return Promise.resolve(true)
  return new Promise((resolve) => (controlWaiter = { req, resolve }))
}

// --- connecting this browser over the local connection ----------------------------------------------------------

function ownOrigin(): string {
  return ext.runtime.getURL('').replace(/\/$/, '')
}

// The browser asks once whether to open Daylens; the link carries the new secret to Daylens through the system.
async function startPairing(): Promise<boolean> {
  const p = newPairing(ownOrigin())
  try {
    await kv.set('pairing', p)
  } catch {
    return false
  }
  pairing = p
  pairPending = true
  retryMs = RETRY_MIN_MS
  nextAttemptAt = 0
  if (link?.kind === 'local') link.session.close()
  link = null
  settleControl(true)
  try {
    pairTab = (await ext.tabs.create({ url: pairLink(p), active: true })).id ?? null
  } catch {
    pairPending = false
    return false
  }
  schedulePairRetry()
  return true
}

function schedulePairRetry(): void {
  if (pairRetry) clearTimeout(pairRetry)
  // Gives up once the wait reaches its longest; pressing Connect again starts over.
  if (retryMs >= RETRY_MAX_MS) {
    pairPending = false
    return
  }
  const wait = Math.max(0, nextAttemptAt - Date.now()) || retryMs
  if (wait > ALARM_AFTER_MS) return ext.alarms.create(ALARM_PAIR, { when: Date.now() + wait })
  pairRetry = setTimeout(() => {
    pairRetry = null
    nextAttemptAt = 0
    ensureLink()
  }, wait)
}

function finishPairing(): void {
  pairPending = false
  if (pairRetry) clearTimeout(pairRetry)
  pairRetry = null
  // An alarm that fires anyway finds no pairing pending; the tab may already have been closed by the person.
  void ext.alarms.clear(ALARM_PAIR).catch(() => {})
  if (pairTab !== null) void ext.tabs.remove(pairTab).catch(() => {})
  pairTab = null
}

async function openDaylens(): Promise<boolean> {
  try {
    await ext.tabs.create({ url: 'daylens://open', active: true })
    return true
  } catch {
    return false
  }
}

// --- pausing this browser -----------------------------------------------------------------------------------------

function nextLocalMidnight(nowMs: number): number {
  const d = new Date(nowMs)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

function browserPaused(): boolean {
  if (!pauseRead) return true
  if (browserPause && browserPause.until !== null && Date.now() >= browserPause.until) {
    browserPause = null
    // A saved pause that has ended is read as ended at the next start too.
    void kv.set('pause', undefined).catch(() => {})
  }
  return browserPause !== null
}

// Reads the saved pause; while it cannot be read, the browser stays paused and the read is tried again.
async function readPause(): Promise<void> {
  if (pauseRead) return
  let saved: { until: number | null } | undefined
  try {
    saved = await kv.get<{ until: number | null }>('pause')
  } catch {
    return
  }
  if (pauseRead) return
  pauseRead = true
  browserPause = saved ?? null
  applyPause()
  tellDaylensPause()
  wakeWaiters()
}

async function readPlatform(): Promise<void> {
  try {
    if (!localAllowed) localAllowed = (await ext.runtime.getPlatformInfo()).os === 'win'
    platformRead = true
  } catch {
    // Asked again at the next connection attempt.
  }
}

function applyPause(): void {
  if (pauseTimer) clearTimeout(pauseTimer)
  pauseTimer = null
  const mine = browserPaused()
  if (mine && browserPause && browserPause.until !== null) pauseTimer = setTimeout(applyPause, Math.min(MAX_TIMER_MS, browserPause.until - Date.now()))
  void tracker.setPaused(mine || (state.daylens === 'connected' && state.capture === 'paused'))
}

async function pauseBrowser(f: PauseFor): Promise<boolean> {
  const now = Date.now()
  return setPause({ until: f === 'hour' ? now + HOUR_MS : f === 'tomorrow' ? nextLocalMidnight(now) : null })
}

function resumeBrowser(): Promise<boolean> {
  return setPause(null)
}

// The pause is kept here first, so this browser stops sending pages at once; if Daylens then says it could not record
// it, the earlier one is put back, and the popup says the change did not happen.
async function setPause(next: { until: number | null } | null): Promise<boolean> {
  const prior = browserPause
  try {
    await kv.set('pause', next ?? undefined)
  } catch {
    return false
  }
  browserPause = next
  pauseRead = true
  applyPause()
  if (await tellDaylensAndWait()) return true
  try {
    await kv.set('pause', prior ?? undefined)
  } catch {
    // Kept as asked; Daylens hears it again at the next connection.
    return false
  }
  browserPause = prior
  applyPause()
  tellDaylensPause()
  return false
}

// --- events -------------------------------------------------------------------------------------------------------

ext.windows.onFocusChanged.addListener((id) => void tracker.focusChanged(id ?? WINDOW_ID_NONE))
ext.windows.onRemoved.addListener(() => void tracker.removed())
ext.tabs.onActivated.addListener(() => void tracker.activated())
ext.tabs.onUpdated.addListener((_id, change, tab) => void tracker.updated(tab, change))
ext.tabs.onRemoved.addListener(() => void tracker.removed())
ext.tabs.onReplaced.addListener(() => void tracker.activated())
ext.runtime.onStartup.addListener(() => void tracker.startup())
ext.runtime.onInstalled.addListener(() => void tracker.startup())
// Registered at the top level so a worker woken by the alarm hears it.
ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_RECONNECT && alarm.name !== ALARM_PAIR) return
  nextAttemptAt = 0
  ensureLink()
})

ext.runtime.onMessage.addListener((req, _sender, reply) => {
  const answer = (extra: Partial<PopupState> = {}) => reply({ ...popupState(), ...extra })
  if (req.t === 'open') {
    if (link?.kind === 'native') {
      openReply = (ok) => answer({ opened: ok })
      post({ t: 'open' })
      return true
    }
    void openDaylens().then((ok) => answer({ opened: ok }))
    return true
  }
  if (req.t === 'connect') {
    void startPairing().then((ok) => answer(ok ? {} : { connecting_pair: false }))
    return true
  }
  if (req.t === 'pause' || req.t === 'resume') {
    void (req.t === 'pause' ? pauseBrowser(req.for) : resumeBrowser()).then(() => answer())
    return true
  }
  void readPause().then(() => {
    nextAttemptAt = 0
    post({ t: 'status' })
    whenStatus(() => answer())
  })
  return true
})

async function init(): Promise<void> {
  await readPlatform()
  await readProfile()
  await readPause()
  try {
    pairing = (await kv.get<Pairing>('pairing')) ?? null
  } catch {
    // Without its pairing this browser shows as not connected, and Connect pairs it again.
  }
  ready = true
  applyPause()
  ensureLink()
  void tracker.startup()
}

void init()
