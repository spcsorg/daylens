import { mock, test } from 'node:test'
import assert from 'node:assert/strict'

// The real background script against a fake browser whose platform lookup fails once, on Windows, with no native host.
type Listener = (...a: unknown[]) => void
const event = () => {
  const ls: Listener[] = []
  return { addListener: (f: Listener) => ls.push(f), fire: (...a: unknown[]) => ls.forEach((f) => f(...a)) }
}
const popup = event()
let platformCalls = 0
const fake = {
  runtime: {
    connectNative: () => {
      throw new Error('Specified native messaging host not found.')
    },
    lastError: undefined as unknown,
    getPlatformInfo: async () => {
      if (++platformCalls === 1) throw new Error('unavailable')
      return { os: 'win' }
    },
    getURL: (p: string) => 'chrome-extension://dgidcofcmgnlicmmepgomalcdcbgjjjg/' + p,
    onMessage: popup,
    onStartup: event(),
    onInstalled: event(),
  },
  alarms: { create: () => {}, clear: async () => true, onAlarm: event() },
  windows: { getAll: async () => [], onFocusChanged: event(), onRemoved: event() },
  tabs: { query: async () => [], create: async () => ({}), remove: async () => {}, onActivated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event() },
}

test('a platform lookup that fails is asked again, so Windows still gets its local connection', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  ;(globalThis as Record<string, unknown>).chrome = fake
  await import('../browser/extension/src/background.ts')
  for (let i = 0; i < 50; i++) await Promise.resolve()
  let reply: { daylens?: string } = {}
  popup.fire({ t: 'status' }, {}, (r: { daylens?: string }) => (reply = r))
  for (let i = 0; i < 50; i++) await Promise.resolve()
  mock.timers.tick(300)
  for (let i = 0; i < 50; i++) await Promise.resolve()
  assert.equal(platformCalls, 2)
  assert.equal(reply.daylens, 'unpaired', 'on Windows, a browser not yet connected over the local connection, not "not installed"')
  mock.timers.reset()
})
