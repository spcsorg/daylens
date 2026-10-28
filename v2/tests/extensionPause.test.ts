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
const lastSent = (i: number) => ports[i]!.posted.filter((m) => m.t === 'pause' || m.t === 'resume').at(-1)
// Without the request id a popup's pause or resume carries.
const lastPause = (i: number) => {
  const m = lastSent(i)
  if (!m) return m
  const { req: _req, ...rest } = m
  return rest
}
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
  const profile = lastPause(0)?.profile
  assert.ok(typeof profile === 'string' && profile.length > 0, 'the extension names the profile it pauses for')
  assert.deepEqual(lastPause(0), { t: 'resume', profile }, 'on connecting, Daylens hears that this browser is not paused')
  await ask({ t: 'pause', for: 'hour' })
  assert.deepEqual(lastPause(0), { t: 'pause', until_wall_ms: 1_792_130_400_000 + 3_600_000, profile })
  await ask({ t: 'resume' })
  assert.deepEqual(lastPause(0), { t: 'resume', profile })
  await ask({ t: 'pause', for: 'until_resumed' })
  assert.deepEqual(lastPause(0), { t: 'pause', until_wall_ms: null, profile })
  ports[0]!.onDisconnect.fire()
  mock.timers.tick(1000)
  assert.equal(ports.length, 2)
  ports[1]!.onMessage.fire(connected)
  await settle()
  assert.deepEqual(lastPause(1), { t: 'pause', until_wall_ms: null, profile }, 'a reconnect repeats the pause in force, for the same profile')
  mock.timers.reset()
})

test('a pause Daylens could not record is taken back, and the popup hears this browser did not pause', async () => {
  const port = ports.at(-1)!
  const i = ports.length - 1
  const profile = lastPause(i)?.profile
  let reply: Record<string, unknown> | undefined
  const send = async (req: Record<string, unknown>) => {
    reply = undefined
    popup.fire(req, {}, (r: Record<string, unknown>) => (reply = r))
    await settle()
  }
  const replied = () => reply
  await send({ t: 'resume' })
  assert.equal(replied(), undefined, 'the popup waits for Daylens to record it')
  port.onMessage.fire({ ...connected, req: lastSent(i)?.req })
  await settle()
  assert.equal(replied()?.paused, false)
  await send({ t: 'pause', for: 'hour' })
  port.onMessage.fire({ t: 'error', for: 'pause' })
  await settle()
  assert.equal(replied()?.paused, false, 'this browser did not pause, and the popup says so')
  assert.deepEqual(lastPause(i), { t: 'resume', profile }, 'Daylens hears the pause taken back')
})

test("a status another browser's change sent is not the reply to this browser's pause", async () => {
  const port = ports.at(-1)!
  const i = ports.length - 1
  let reply: Record<string, unknown> | undefined
  popup.fire({ t: 'pause', for: 'hour' }, {}, (r: Record<string, unknown>) => (reply = r))
  await settle()
  const req = lastSent(i)?.req
  assert.ok(typeof req === 'string', 'the pause carries an id')
  port.onMessage.fire({ ...connected, capture: 'paused' })
  await settle()
  assert.equal(reply, undefined, 'a status without the id does not settle the pause')
  port.onMessage.fire({ t: 'error', for: 'pause', req })
  await settle()
  assert.equal((reply as Record<string, unknown> | undefined)?.paused, false, 'the error that is its reply does')
})

test('a pause waiting when the host says Daylens stopped is held here, and the popup hears it', async () => {
  // The reconnect this status schedules stays on the mocked clock.
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const port = ports.at(-1)!
  let reply: Record<string, unknown> | undefined
  popup.fire({ t: 'pause', for: 'hour' }, {}, (r: Record<string, unknown>) => (reply = r))
  await settle()
  assert.equal(reply, undefined)
  port.onMessage.fire({ t: 'status', daylens: 'not_running', capture: 'running', until_wall_ms: null })
  await settle()
  assert.equal((reply as Record<string, unknown> | undefined)?.paused, true)
  mock.timers.reset()
})
