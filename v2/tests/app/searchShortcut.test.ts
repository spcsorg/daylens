// Search opens with Cmd+K on macOS and Ctrl+K on Windows and Linux; Ctrl+K on a Mac stays the text field's.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { opensSearch } from '../../app/renderer/src/screens/search/shortcut.ts'

const key = (k: Partial<KeyboardEvent>) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: 'k', ...k })

test('macOS opens Search with Cmd+K and leaves Ctrl+K to the text field', () => {
  assert.equal(opensSearch(key({ metaKey: true }), 'darwin'), true)
  assert.equal(opensSearch(key({ metaKey: true, key: 'K' }), 'darwin'), true)
  assert.equal(opensSearch(key({ ctrlKey: true }), 'darwin'), false)
})

test('Windows and Linux open Search with Ctrl+K only', () => {
  for (const p of ['win32', 'linux']) {
    assert.equal(opensSearch(key({ ctrlKey: true }), p), true)
    assert.equal(opensSearch(key({ metaKey: true }), p), false)
  }
})

test('other keys and modifiers leave Search closed', () => {
  assert.equal(opensSearch(key({ metaKey: true, shiftKey: true }), 'darwin'), false)
  assert.equal(opensSearch(key({ ctrlKey: true, altKey: true }), 'linux'), false)
  assert.equal(opensSearch(key({ ctrlKey: true, key: 'j' }), 'linux'), false)
})
