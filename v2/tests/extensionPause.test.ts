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
  windows: { getAll: async () => [], onFocusChanged: event(), onRemoved: event() },
  tabs: { query: async () => [], create: async () => ({}), remove: async () => {}, onActivated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event() },
}

// The extension keeps its pause in IndexedDB; this is the part of it the background script uses.
const kv = new Map<unknown, unknown>()
function request(tx: { oncomplete?: () => void }, run: () => unknown) {
  const r: { result?: unknown } = {}
  queueMicrotask(() => {
    r.result = run()
    tx.oncomplete?.()
  })
  return r
}
const idb = {
  transaction: () => {
    const tx: { oncomplete?: () => void; objectStore?: () => unknown } = {}
    tx.objectStore = () => ({
      get: (k: unknown) => request(tx, () => kv.get(k)),
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
const ask = async (req: Record<string, unknown>) => {
  popup.fire(req, {}, () => {})
  await settle()
}
const lastPause = (i: number) => ports[i]!.posted.filter((m) => m.t === 'pause' || m.t === 'resume').at(-1)
const connected = { t: 'status', daylens: 'connected', capture: 'running', until_wall_ms: null }

test("the popup's pause and resume reach Daylens, and a reconnect tells it the pause in force", async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_792_130_400_000 })
  ;(globalThis as Record<string, unknown>).chrome = fake
  ;(globalThis as Record<string, unknown>).indexedDB = indexedDB
  await import('../browser/extension/src/background.ts')
  await settle()
  assert.equal(ports.length, 1)
  ports[0]!.onMessage.fire(connected)
  await settle()
  assert.deepEqual(lastPause(0), { t: 'resume' }, 'on connecting, Daylens hears that this browser is not paused')
  await ask({ t: 'pause', for: 'hour' })
  assert.deepEqual(lastPause(0), { t: 'pause', until_wall_ms: 1_792_130_400_000 + 3_600_000 })
  await ask({ t: 'resume' })
  assert.deepEqual(lastPause(0), { t: 'resume' })
  await ask({ t: 'pause', for: 'until_resumed' })
  assert.deepEqual(lastPause(0), { t: 'pause', until_wall_ms: null })
  ports[0]!.onDisconnect.fire()
  mock.timers.tick(1000)
  assert.equal(ports.length, 2)
  ports[1]!.onMessage.fire(connected)
  await settle()
  assert.deepEqual(lastPause(1), { t: 'pause', until_wall_ms: null }, 'a reconnect repeats the pause in force')
  mock.timers.reset()
})
