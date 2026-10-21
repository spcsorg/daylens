import { mock, test } from 'node:test'
import assert from 'node:assert/strict'

// The real background script against a fake browser: the native port and the popup's requests are observed.
type Listener = (...a: unknown[]) => void
const event = () => {
  const ls: Listener[] = []
  return { addListener: (f: Listener) => ls.push(f), fire: (...a: unknown[]) => ls.forEach((f) => f(...a)) }
}
const ports: { posted: Record<string, unknown>[]; onMessage: ReturnType<typeof event>; onDisconnect: ReturnType<typeof event> }[] = []
const popup = event()
const fake = {
  runtime: {
    connectNative: () => {
      const posted: Record<string, unknown>[] = []
      const p = { posted, onMessage: event(), onDisconnect: event(), postMessage: (m: Record<string, unknown>) => posted.push(m), disconnect: () => {} }
      ports.push(p)
      return p
    },
    lastError: undefined,
    getPlatformInfo: async () => ({ os: 'mac' }),
    getURL: (p: string) => 'chrome-extension://dgidcofcmgnlicmmepgomalcdcbgjjjg/' + p,
    onMessage: popup,
    onStartup: event(),
    onInstalled: event(),
  },
  alarms: { create: () => {}, clear: async () => true, onAlarm: event() },
  windows: { getAll: async () => [{ id: 1, focused: true, incognito: false, type: 'normal' }], onFocusChanged: event(), onRemoved: event() },
  tabs: { query: async () => [{ id: 5, windowId: 1, active: true, incognito: false, url: 'https://example.com/a', title: 'A' }], create: async () => ({}), remove: async () => {}, onActivated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event() },
}

// The extension keeps its pause in IndexedDB; this is the part of it the background script uses, with reads that fail
// while `readable` is false.
const kv = new Map<unknown, unknown>()
let readable = false
function request(tx: { oncomplete?: () => void; onerror?: () => void; error?: unknown }, run: () => unknown, read = false) {
  const r: { result?: unknown } = {}
  queueMicrotask(() => {
    if (read && !readable) {
      tx.error = new Error('read failed')
      return tx.onerror?.()
    }
    r.result = run()
    tx.oncomplete?.()
  })
  return r
}
const idb = {
  transaction: () => {
    const tx: { oncomplete?: () => void; onerror?: () => void; objectStore?: () => unknown } = {}
    tx.objectStore = () => ({
      get: (k: unknown) => request(tx, () => kv.get(k), true),
      put: (v: unknown, k: unknown) => request(tx, () => void kv.set(k, v)),
      delete: (k: unknown) => request(tx, () => void kv.delete(k)),
    })
    return tx
  },
  close: () => {},
}
const indexedDB = {
  open: () => {
    const req: { result?: unknown; onsuccess?: () => void } = {}
    queueMicrotask(() => {
      req.result = idb
      req.onsuccess?.()
    })
    return req
  },
}

const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}
let reply: Record<string, unknown> | null = null
const ask = async (req: Record<string, unknown>) => {
  popup.fire(req, {}, (r: Record<string, unknown>) => (reply = r))
  await settle()
  mock.timers.tick(300)
  await settle()
}
const pauses = (i: number) => ports[i]!.posted.filter((m) => m.t === 'pause' || m.t === 'resume')
const lastPause = (i: number) => ports[i]!.posted.filter((m) => m.t === 'pause' || m.t === 'resume').at(-1)
const connected = { t: 'status', daylens: 'connected', capture: 'running', until_wall_ms: null }

test('a pause that cannot be read keeps the browser paused: Daylens never hears resume, and the popup says why', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_792_130_400_000 })
  ;(globalThis as Record<string, unknown>).chrome = fake
  ;(globalThis as Record<string, unknown>).indexedDB = indexedDB
  await import('../browser/extension/src/background.ts')
  await settle()
  assert.equal(ports.length, 1)
  ports[0]!.onMessage.fire(connected)
  await settle()
  assert.deepEqual(pauses(0), [{ t: 'pause', until_wall_ms: null }], 'on connecting, Daylens hears a pause, not resume')
  fake.windows.onFocusChanged.fire(1)
  await settle()
  assert.ok(ports[0]!.posted.every((m) => m.t !== 'tab' || m.state === 'unknown'), 'no page is sent')
  await ask({ t: 'status' })
  assert.equal(reply?.paused, true)
  assert.equal(reply?.pause_unreadable, true, 'the popup is told the pause could not be read')

  ports[0]!.onDisconnect.fire()
  mock.timers.tick(1000)
  ports[1]!.onMessage.fire(connected)
  await settle()
  assert.deepEqual(pauses(1), [{ t: 'pause', until_wall_ms: null }], 'a reconnect repeats it')

  // Readable again, with no pause saved: the browser resumes, and Daylens hears it.
  readable = true
  await ask({ t: 'status' })
  assert.equal(reply?.pause_unreadable, false)
  assert.equal(reply?.paused, false)
  assert.deepEqual(lastPause(1), { t: 'resume' }, 'once the pause is read and none is saved, Daylens hears resume')
  assert.equal(ports[1]!.posted.filter((m) => m.t === 'tab').at(-1)?.state, 'page', 'and pages are sent again')
  mock.timers.reset()
})

