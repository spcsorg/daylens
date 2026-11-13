import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { registerMacBrowserHosts } from '../../capture/browserHosts.ts'
import { CHROMIUM_EXTENSION_IDS } from '../../capture/pairing.ts'
import { tempDir } from '../support/tmp.ts'

const dirs = [
  ['Google', 'Chrome'], ['Microsoft Edge'], ['Arc', 'User Data'], ['Dia', 'User Data'], ['Mozilla'], ['Google', 'Chrome for Testing'],
]
const hostFile = (home: string, dir: string[]) => path.join(home, 'Library', 'Application Support', ...dir, 'NativeMessagingHosts', 'app.daylens.browser.json')

function setup() {
  const root = tempDir('daylens-browser-hosts-')
  const home = path.join(root, 'Invented home')
  const helper = path.join(root, 'Daylens.app', 'Contents', 'Helpers', 'Daylens.app', 'Contents', 'MacOS', 'daylens-capture-macos')
  mkdirSync(path.dirname(helper), { recursive: true })
  writeFileSync(helper, '#!/bin/sh\nexit 0\n')
  chmodSync(helper, 0o755)
  for (const dir of dirs) mkdirSync(path.join(home, 'Library', 'Application Support', ...dir), { recursive: true })
  mkdirSync(path.join(home, 'Library', 'Application Support', 'Firefox'), { recursive: true })
  return { root, home, helper }
}

test('a Mac install registers its packaged helper with every supported browser', async () => {
  const { home, helper } = setup()
  assert.deepEqual(await registerMacBrowserHosts(home, helper), [])
  for (const dir of dirs) {
    const manifest = JSON.parse(readFileSync(hostFile(home, dir), 'utf8'))
    assert.equal(manifest.path, helper)
    assert.equal(manifest.type, 'stdio')
    assert.equal(manifest.name, 'app.daylens.browser')
    if (dir[0] === 'Mozilla') {
      assert.deepEqual(manifest.allowed_extensions, ['browser@daylens.app'])
      assert.equal(manifest.allowed_origins, undefined)
    } else {
      assert.deepEqual(manifest.allowed_origins, CHROMIUM_EXTENSION_IDS.map(id => `chrome-extension://${id}/`))
      assert.equal(manifest.allowed_extensions, undefined)
    }
  }
})

test('reopening from a new install path repairs only the Daylens host', async () => {
  const { root, home, helper } = setup()
  await registerMacBrowserHosts(home, helper)
  const other = path.join(path.dirname(hostFile(home, dirs[0]!)), 'another.host.json')
  writeFileSync(other, 'another app')
  const moved = path.join(root, 'Moved Daylens.app', 'capture')
  mkdirSync(path.dirname(moved), { recursive: true })
  writeFileSync(moved, '#!/bin/sh\nexit 0\n')
  chmodSync(moved, 0o755)
  assert.deepEqual(await registerMacBrowserHosts(home, moved), [])
  assert.equal(JSON.parse(readFileSync(hostFile(home, dirs[0]!), 'utf8')).path, moved)
  assert.equal(readFileSync(other, 'utf8'), 'another app')
})

test('one unwritable browser is reported while the other hosts are still registered', async () => {
  const { home, helper } = setup()
  const blocked = path.dirname(hostFile(home, dirs[0]!))
  mkdirSync(path.dirname(blocked), { recursive: true })
  writeFileSync(blocked, 'not a directory')
  assert.deepEqual(await registerMacBrowserHosts(home, helper), ['Google Chrome'])
  assert.ok(existsSync(hostFile(home, ['Mozilla'])))
})

test('a missing packaged helper never creates a broken manifest', async () => {
  const { home, helper } = setup()
  assert.equal((await registerMacBrowserHosts(home, `${helper}-missing`)).length, dirs.length)
  assert.equal(existsSync(hostFile(home, dirs[0]!)), false)
})

test('absent browsers get no new folders, and correct manifests are not rewritten', async () => {
  const { root, helper, home } = setup()
  const absent = path.join(root, 'Empty home')
  assert.deepEqual(await registerMacBrowserHosts(absent, helper), [])
  assert.equal(existsSync(absent), false)
  await registerMacBrowserHosts(home, helper)
  const file = hostFile(home, dirs[0]!)
  const before = statSync(file).mtimeMs
  await new Promise(resolve => setTimeout(resolve, 20))
  await registerMacBrowserHosts(home, helper)
  assert.equal(statSync(file).mtimeMs, before)
})
