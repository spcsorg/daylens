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
      // Daylens is not installed yet for the first attempt: the browser reports the host as missing.
      if (ports.length === 1)
        queueMicrotask(() => {
          fake.runtime.lastError = { message: 'Specified native messaging host not found.' } as never
          p.onDisconnect.fire()
          fake.runtime.lastError = undefined
        })
      return p
    },
    lastError: undefined as unknown,
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

test('a native host that was missing is tried again on the backoff, so installing Daylens later just works', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  ;(globalThis as Record<string, unknown>).chrome = fake
  await import('../browser/extension/src/background.ts')
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise((r) => setImmediate(r))
  assert.equal(ports.length, 1, 'the first attempt finds no host')
  mock.timers.tick(1000)
  assert.equal(ports.length, 2, 'tried again after 1 s, without a browser restart')
  mock.timers.tick(600_000)
  assert.equal(ports.length, 2, 'connected now: no more attempts')
  mock.timers.reset()
})
