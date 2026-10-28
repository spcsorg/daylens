// Search opens with Cmd+K on macOS (the app menu's item owns it) and Ctrl+K on Windows and Linux (the window's handler).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { opensSearch } from '../../app/renderer/src/screens/search/shortcut.ts'

const key = (k: Partial<KeyboardEvent>) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: 'k', ...k })

test('on macOS the window handles neither Cmd+K (the menu item does) nor Ctrl+K (the text field’s)', () => {
  assert.equal(opensSearch(key({ metaKey: true }), 'darwin'), false)
  assert.equal(opensSearch(key({ ctrlKey: true }), 'darwin'), false)
})

test('Windows and Linux open Search with Ctrl+K only', () => {
  for (const p of ['win32', 'linux']) {
    assert.equal(opensSearch(key({ ctrlKey: true }), p), true)
    assert.equal(opensSearch(key({ ctrlKey: true, key: 'K' }), p), true)
    assert.equal(opensSearch(key({ metaKey: true }), p), false)
  }
})

test('other keys and modifiers leave Search closed', () => {
  assert.equal(opensSearch(key({ ctrlKey: true, shiftKey: true }), 'win32'), false)
  assert.equal(opensSearch(key({ ctrlKey: true, altKey: true }), 'linux'), false)
  assert.equal(opensSearch(key({ ctrlKey: true, key: 'j' }), 'linux'), false)
})
