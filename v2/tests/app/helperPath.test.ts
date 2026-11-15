// The capture helper the app starts on each platform, from source and packaged.
import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { helperPath } from '../../app/main/helperPath.ts'

const V2 = path.join(path.sep, 'src', 'daylens', 'v2')
const RESOURCES = path.join(path.sep, 'Daylens', 'resources')

test('macOS starts the Swift helper: its release build from source, its own app bundle packaged', () => {
  assert.equal(helperPath('darwin', false, V2, RESOURCES), path.join(V2, 'native', 'macos', '.build', 'release', 'daylens-capture-macos'))
  assert.equal(helperPath('darwin', true, V2, RESOURCES), path.join(RESOURCES, '..', 'Helpers', 'Daylens.app', 'Contents', 'MacOS', 'daylens-capture-macos'))
})

test('Windows starts the published C# helper, never the Mac one', () => {
  assert.equal(helperPath('win32', false, V2, RESOURCES), path.join(V2, 'native', 'windows', 'publish', 'daylens-capture-windows.exe'))
  assert.equal(helperPath('win32', true, V2, RESOURCES), path.join(RESOURCES, 'daylens-capture-windows.exe'))
})

test('Linux has no capture helper yet, so none is chosen', () => {
  assert.equal(helperPath('linux', false, V2, RESOURCES), null)
  assert.equal(helperPath('linux', true, V2, RESOURCES), null)
})
