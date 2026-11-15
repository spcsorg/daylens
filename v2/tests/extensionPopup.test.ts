import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { PopupState } from '../browser/extension/src/messages.ts'

for (const phase of ['starting', 'pairing', 'allowing'] as const) test(`a popup ${phase} refreshes until Connected, then stops polling`, async () => {
  const elements = new Map<string, { textContent: string; hidden: boolean; dataset: object; classList: { toggle(): void }; addEventListener(): void; querySelector(): null }>()
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', hidden: false, dataset: {}, classList: { toggle() {} }, addEventListener() {}, querySelector: () => null })
    return elements.get(id)!
  }
  const state: PopupState = { daylens: phase === 'starting' ? 'connecting' : 'unpaired', capture: 'running', until_wall_ms: null, paused: false, paused_until_wall_ms: null, pause_unreadable: false, connecting_pair: phase === 'pairing', awaiting_allow: phase === 'allowing', front_tab: true }
  let requests = 0
  const globals = globalThis as unknown as { document?: unknown; chrome?: unknown }
  const prior = { document: globals.document, chrome: globals.chrome }
  mock.timers.enable({ apis: ['setTimeout'] })
  globals.document = { getElementById: element, addEventListener() {} }
  globals.chrome = { runtime: { sendMessage: async () => (requests++, { ...state }) } }
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
  try {
    const script = new URL('../browser/extension/src/popup.ts', import.meta.url)
    script.search = phase
    await import(script.href)
    await settle()
    assert.notEqual(element('status').textContent, 'Connected')
    state.daylens = 'connected'
    state.connecting_pair = false
    state.awaiting_allow = false
    mock.timers.tick(1000)
    await settle()
    assert.equal(element('status').textContent, 'Connected')
    const connectedRequests = requests
    mock.timers.tick(60_000)
    await settle()
    assert.equal(requests, connectedRequests, 'a settled popup has no polling timer')
  } finally {
    mock.timers.reset()
    globals.document = prior.document
    globals.chrome = prior.chrome
  }
})

test('in Dia, a connected popup says Dia doesn’t report its front tab yet', async () => {
  const elements = new Map<string, { textContent: string; hidden: boolean; dataset: { tone?: string }; classList: { toggle(): void }; addEventListener(): void; querySelector(): null }>()
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', hidden: false, dataset: {}, classList: { toggle() {} }, addEventListener() {}, querySelector: () => null })
    return elements.get(id)!
  }
  const state: PopupState = { daylens: 'connected', capture: 'running', until_wall_ms: null, paused: false, paused_until_wall_ms: null, pause_unreadable: false, connecting_pair: false, awaiting_allow: false, front_tab: false }
  const globals = globalThis as unknown as { document?: unknown; chrome?: unknown }
  const prior = { document: globals.document, chrome: globals.chrome }
  globals.document = { getElementById: element, addEventListener() {} }
  globals.chrome = { runtime: { sendMessage: async () => ({ ...state }) } }
  try {
    const script = new URL('../browser/extension/src/popup.ts', import.meta.url)
    script.search = 'dia'
    await import(script.href)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    assert.match(element('status').textContent, /Dia doesn’t report its front tab yet/)
    assert.equal(element('status').dataset.tone, 'warn')
  } finally {
    globals.document = prior.document
    globals.chrome = prior.chrome
  }
})
