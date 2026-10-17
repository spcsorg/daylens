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
      const p = {
        onMessage: event(),
        onDisconnect: event(),
        postMessage: () => {
          if (ports.length === 1) throw new Error('port closed')
        },
        disconnect: () => {},
      }
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
  windows: { getAll: async () => [], onFocusChanged: event(), onRemoved: event() },
  tabs: { query: async () => [], create: async () => ({}), remove: async () => {}, onActivated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event() },
}

test('a send that fails on a dead port schedules a reconnect like a disconnect does', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  ;(globalThis as Record<string, unknown>).chrome = fake
  await import('../browser/extension/src/background.ts')
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise((r) => setImmediate(r))
  assert.equal(ports.length, 1)
  // The browser loses focus; the extension tries to tell Daylens and the port throws.
  fake.windows.onFocusChanged.fire(-1)
  for (let i = 0; i < 20; i++) await Promise.resolve()
  mock.timers.tick(1000)
  assert.equal(ports.length, 2, 'reconnected after 1 s with no further browser event')
  mock.timers.reset()
})
