import { mock, test } from 'node:test'
import assert from 'node:assert/strict'

type Listener = (...args: unknown[]) => void
const event = () => {
  const listeners: Listener[] = []
  return { addListener: (f: Listener) => listeners.push(f), fire: (...args: unknown[]) => listeners.forEach(f => f(...args)) }
}
let attempts = 0
const fake = {
  runtime: {
    connectNative: () => { attempts++; throw new Error('host unavailable') },
    getPlatformInfo: async () => ({ os: 'mac' }),
    getURL: (p: string) => `chrome-extension://dgidcofcmgnlicmmepgomalcdcbgjjjg/${p}`,
    onMessage: event(), onStartup: event(), onInstalled: event(),
  },
  alarms: { create() {}, clear: async () => true, onAlarm: event() },
  windows: { getAll: async () => [], onFocusChanged: event(), onRemoved: event() },
  tabs: { query: async () => [], create: async () => ({}), remove: async () => {}, onActivated: event(), onUpdated: event(), onRemoved: event(), onReplaced: event() },
}

test('popup status refreshes leave the background reconnect schedule in charge', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  ;(globalThis as Record<string, unknown>).chrome = fake
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  try {
    await import('../browser/extension/src/background.ts')
    await settle()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(attempts, 1)
    for (let i = 0; i < 3; i++) {
      mock.timers.tick(300)
      fake.runtime.onMessage.fire({ t: 'status' }, {}, () => {})
      await settle()
    }
    assert.equal(attempts, 1, 'status reads cannot force three early connection attempts')
    mock.timers.tick(100)
    await settle()
    assert.equal(attempts, 2, 'the scheduled one-second retry still runs')
  } finally {
    mock.timers.reset()
    delete (globalThis as Record<string, unknown>).chrome
  }
})
