import { mock, test } from 'node:test'
import assert from 'node:assert/strict'

// The real background script against a fake browser: only the native port is observed; no tab or window events fire.
type Listener = (...a: unknown[]) => void
const event = () => {
  const ls: Listener[] = []
  return { addListener: (f: Listener) => ls.push(f), fire: (...a: unknown[]) => ls.forEach((f) => f(...a)) }
}
const ports: { disconnect: () => void; onMessage: ReturnType<typeof event>; onDisconnect: ReturnType<typeof event> }[] = []
const fake = {
  runtime: {
    connectNative: () => {
      const p = { onMessage: event(), onDisconnect: event(), postMessage: () => {}, disconnect: () => {} }
      ports.push(p as never)
      return p
    },
    lastError: undefined,
    getPlatformInfo: async () => ({ os: 'mac' }),
    getURL: (p: string) => 'chrome-extension://dgidcofcmgnlicmmepgomalcdcbgjjjg/' + p,
    onMessage: event(),
    onStartup: event(),
    onInstalled: event(),
  },
  alarms: { create: () => {}, clear: async () => true, onAlarm: event() },
  windows: { getAll: async () => [], onFocusChanged: event(), onRemoved: event() },
  tabs: { query: async () => [], create: async () => ({}), remove: async () => {}, onActivated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event() },
}

test('a lost connection to Daylens comes back on its own, with backoff, and stops retrying once connected', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  ;(globalThis as Record<string, unknown>).chrome = fake
  await import('../browser/extension/src/background.ts')
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise((r) => setImmediate(r))
  assert.equal(ports.length, 1, 'connected at start')
  ports[0]!.onDisconnect.fire()
  mock.timers.tick(999)
  assert.equal(ports.length, 1)
  mock.timers.tick(1)
  assert.equal(ports.length, 2, 'reconnected after 1 s with no browser event')
  ports[1]!.onDisconnect.fire()
  mock.timers.tick(1999)
  assert.equal(ports.length, 2)
  mock.timers.tick(1)
  assert.equal(ports.length, 3, 'then after 2 s')
  ports[2]!.onMessage.fire({ t: 'status', daylens: 'connected', capture: 'running', until_wall_ms: null })
  mock.timers.tick(600_000)
  assert.equal(ports.length, 3, 'no retries while connected')
  mock.timers.reset()
})
