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
  alarms: {
    created: [] as { name: string; when: number }[],
    create(name: string, info: { when: number }) {
      this.created.push({ name, when: info.when })
    },
    clear: async () => true,
    onAlarm: event(),
  },
  windows: { getAll: async () => [], onFocusChanged: event(), onRemoved: event() },
  tabs: { query: async () => [], create: async () => ({}), remove: async () => {}, onActivated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event() },
}

test('waits longer than a stopped service worker would survive use an alarm, and the alarm reconnects', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  ;(globalThis as Record<string, unknown>).chrome = fake
  await import('../browser/extension/src/background.ts')
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise((r) => setImmediate(r))
  // 1, 2, 4, 8, 16 s on timers.
  for (const wait of [1000, 2000, 4000, 8000, 16000]) {
    ports.at(-1)!.onDisconnect.fire()
    mock.timers.tick(wait)
  }
  assert.equal(ports.length, 6)
  assert.equal(fake.alarms.created.length, 0, 'short waits need no alarm')
  ports.at(-1)!.onDisconnect.fire()
  const alarm = fake.alarms.created.at(-1)
  assert.ok(alarm, 'a 32 s wait is an alarm')
  assert.equal(alarm.when - Date.now(), 32_000)
  // The worker was stopped meanwhile: no timer fires; the alarm wakes it.
  mock.timers.tick(32_000)
  fake.alarms.onAlarm.fire({ name: alarm.name })
  assert.equal(ports.length, 7, 'the alarm reconnected')
  mock.timers.reset()
})
