import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const originalFs = require('original-fs') as typeof fs
const asar = require('@electron/asar')
const { verifyPackage, verifyPackages } = require('../scripts/verify-packaged-natives.js')
const afterPack = require('../scripts/afterPack-native-modules.js').default

const files = [
  'dist/main/main.js',
  'dist/main/preload.js',
  'dist/mcp-server/index.cjs',
  'dist/range-worker/index.cjs',
  'dist/embed-worker/index.cjs',
  'dist/capture-relay/index.cjs',
  'dist/renderer/main_window/assets/index.js',
  'dist/renderer/main_window/assets/index.css',
  'node_modules/better-sqlite3/package.json',
  'node_modules/better-sqlite3/lib/index.js',
  'node_modules/better-sqlite3/lib/database.js',
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  'node_modules/bindings/package.json',
  'node_modules/bindings/bindings.js',
  'node_modules/file-uri-to-path/package.json',
  'node_modules/file-uri-to-path/index.js',
  'node_modules/@paymoapp/active-window/package.json',
  'node_modules/@paymoapp/active-window/dist/index.js',
  'node_modules/@paymoapp/active-window/build/Release/PaymoActiveWindow.node',
  'node_modules/keytar/package.json',
  'node_modules/keytar/lib/keytar.js',
  'node_modules/keytar/build/Release/keytar.node',
]

async function fixture(
  t: TestContext,
  { omit = '', unpack = true, main = 'dist/main/main.js' } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-package-test-'))
  t.after(() => originalFs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source')
  const output = path.join(root, 'output')
  fs.mkdirSync(output)
  if (omit !== 'app-normalization.v1.json') {
    fs.writeFileSync(path.join(output, 'app-normalization.v1.json'), '{}')
  }
  for (const entry of files.filter((entry) => entry !== omit)) {
    const target = path.join(source, entry)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, entry.endsWith('.json') ? '{}' : 'fixture')
  }
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ main }))
  fs.writeFileSync(
    path.join(source, 'dist/renderer/main_window/index.html'),
    '<script src="./assets/index.js"></script><link href="./assets/index.css" rel="stylesheet">',
  )
  const archive = path.join(output, 'app.asar')
  await asar.createPackageWithOptions(source, archive, unpack ? { unpack: '**/*.node' } : {})
  return { root, source, output, archive }
}

test('complete release archive passes without requiring unpacked JavaScript copies', async (t) => {
  const { archive } = await fixture(t)
  assert.doesNotThrow(() => verifyPackage(archive))
})

test('legacy Forge archive is rejected with the supported packaging command', async (t) => {
  const { archive } = await fixture(t, { main: '.vite/build/main.js' })
  assert.throws(() => verifyPackage(archive), /unsupported main entry.*npm run package/)
})

test('native files on disk cannot hide a missing SQLite JavaScript module in the archive', async (t) => {
  const entry = 'node_modules/better-sqlite3/lib/index.js'
  const { archive } = await fixture(t, { omit: entry })
  const target = path.join(`${archive}.unpacked`, entry)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, 'fixture')
  assert.throws(
    () => verifyPackage(archive),
    /missing archive entry.*better-sqlite3\/lib\/index.js/,
  )
})

test('missing renderer assets and background workers fail package validation', async (t) => {
  for (const omit of ['dist/renderer/main_window/assets/index.js', 'dist/range-worker/index.cjs']) {
    const { archive } = await fixture(t, { omit })
    assert.throws(() => verifyPackage(archive), /missing archive entry/)
  }
})

test('the normalization map is required as an external runtime resource', async (t) => {
  const { archive } = await fixture(t, { omit: 'app-normalization.v1.json' })
  assert.throws(() => verifyPackage(archive), /missing the app-normalization.v1.json resource/)
})

test('native bindings must be registered as unpacked and exist on disk', async (t) => {
  const packed = await fixture(t, { unpack: false })
  assert.throws(() => verifyPackage(packed.archive), /must unpack.*better-sqlite3/)
  const { archive } = await fixture(t)
  fs.unlinkSync(
    path.join(
      `${archive}.unpacked`,
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    ),
  )
  assert.throws(() => verifyPackage(archive), /missing unpacked archive file/)
})

test('packaging hook fails rather than succeeding with no archive', async (t) => {
  const { root, source } = await fixture(t)
  const emptyOutput = path.join(root, 'empty')
  fs.mkdirSync(emptyOutput)
  assert.throws(() => verifyPackages(emptyOutput), /No app.asar/)
  await assert.rejects(
    afterPack({ appOutDir: emptyOutput, packager: { info: { projectDir: source } } }),
    /No app.asar/,
  )
})

test('packaging hook rejects an incomplete archive even when there is nothing to repair', async (t) => {
  const { source, output } = await fixture(t, { main: '.vite/build/main.js', unpack: false })
  await assert.rejects(
    afterPack({ appOutDir: output, packager: { info: { projectDir: source } } }),
    /unsupported main entry/,
  )
})

test('local package commands use the release pipeline without publishing', async () => {
  const metadata = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))
  for (const command of ['package', 'make']) {
    assert.match(metadata.scripts[command], /^npm run build:all && electron-builder /)
    assert.match(metadata.scripts[command], /--publish never/)
    assert.match(metadata.scripts[command], /--config electron-builder.config.js/)
  }
  const { loadConfigFromFile } = require('vite')
  const { config } = await loadConfigFromFile(
    { command: 'serve', mode: 'development' },
    path.resolve('forge.config.ts'),
  )
  assert.ok(config.hooks?.prePackage)
  await assert.rejects(
    config.hooks.prePackage({} as never, 'darwin', 'arm64'),
    /npm run package or npm run make/,
  )
})
