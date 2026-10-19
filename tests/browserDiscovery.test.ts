import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveCanonicalBrowser } from '../src/main/lib/appIdentity.ts'
import { getBrowserEntries, getBrowserStatus, groupDiscoveredBrowsers } from '../src/main/services/browser.ts'
import {
  discoverMacBrowserHistoryLocations,
  isAutomationBrowserInstall,
  isMacWebBrowserPlist,
  parseLaunchServicesBrowserDump,
  type BrowserApplication,
} from '../src/main/services/browserRegistry.ts'

function tempHomeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'daylens-browser-home-'))
}

function touch(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, '')
}

async function withWindowsHome<T>(homeDir: string, run: () => Promise<T> | T): Promise<T> {
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE
  const originalPlatform = process.platform

  process.env.HOME = homeDir
  process.env.USERPROFILE = homeDir
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value:        'win32',
  })

  try {
    return await run()
  } finally {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome

    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value:        originalPlatform,
    })
  }
}

test('windows browser discovery finds Arc, Dia, and Comet Chromium profiles', async () => {
  const homeDir = tempHomeDir()
  const local = path.join(homeDir, 'AppData', 'Local')

  const arcHistoryPath = path.join(local, 'The Browser Company', 'Arc', 'User Data', 'Default', 'History')
  const diaHistoryPath = path.join(local, 'Dia', 'User Data', 'Profile 1', 'History')
  const cometHistoryPath = path.join(local, 'Comet', 'Default', 'History')

  touch(arcHistoryPath)
  touch(diaHistoryPath)
  touch(cometHistoryPath)

  const entries = await withWindowsHome(homeDir, () => getBrowserEntries())

  const arc = entries.find((entry) => entry.bundleId === 'arc.exe')
  assert.equal(arc?.name, 'Arc')
  assert.equal(arc?.historyPath, arcHistoryPath)
  assert.equal(resolveCanonicalBrowser(arc?.bundleId).canonicalBrowserId, 'arc')

  const dia = entries.find((entry) => entry.bundleId === 'dia.exe:Profile 1')
  assert.equal(dia?.name, 'Dia (Profile 1)')
  assert.equal(dia?.historyPath, diaHistoryPath)
  assert.equal(resolveCanonicalBrowser(dia?.bundleId).canonicalBrowserId, 'dia')

  const comet = entries.find((entry) => entry.bundleId === 'comet.exe')
  assert.equal(comet?.name, 'Comet')
  assert.equal(comet?.historyPath, cometHistoryPath)
  assert.equal(resolveCanonicalBrowser(comet?.bundleId).canonicalBrowserId, 'comet')
})

test('browser diagnostics always expose a discoveredBrowsers array', async () => {
  const homeDir = tempHomeDir()
  const local = path.join(homeDir, 'AppData', 'Local')
  const arcHistoryPath = path.join(local, 'The Browser Company', 'Arc', 'User Data', 'Default', 'History')

  touch(arcHistoryPath)

  await withWindowsHome(homeDir, () => {
    const status = getBrowserStatus()
    assert.ok(Array.isArray(status.discoveredBrowsers))
    const arc = status.discoveredBrowsers.find((entry) => entry.bundleId === 'arc.exe')
    assert.equal(arc?.historyPath, arcHistoryPath)
    assert.equal(arc?.historyExists, true)
  })
})

test('browser diagnostics expose safariHistoryAccess, defaulting to unknown until a WebKit poll runs', async () => {
  const homeDir = tempHomeDir()
  await withWindowsHome(homeDir, () => {
    const status = getBrowserStatus()
    // Nothing in this test suite drives an actual WebKit poll (that requires a
    // live Electron-backed DB — see the gap noted in the PR this test shipped
    // with), so the status should still read 'unknown' rather than having
    // latched into 'ok'/'denied' from unrelated state.
    assert.equal(status.safariHistoryAccess, 'unknown')
  })
})

test('LaunchServices http/https handlers discover Zen without a browser-name list', () => {
  const dump = `
--------------------------------------------------------------------------------
bundle id:                  Zen (0x20e4)
path:                       /Applications/Zen Test.app (0x3cf0)
name:                       Zen
identifier:                 app.zen-browser.zen
more flags:                 web-browser
claimed schemes:            file:, http:, https:
--------------------------------------------------------------------------------
bundle id:                  VLC (0x20e5)
path:                       /Applications/VLC.app (0x3cf1)
name:                       VLC
identifier:                 org.videolan.vlc
claimed schemes:            http:, https:
--------------------------------------------------------------------------------
`

  const applications = parseLaunchServicesBrowserDump(dump)
  assert.deepEqual(applications.map((application) => ({
    name: application.name,
    bundleId: application.bundleId,
    family: application.family,
  })), [{
    name: 'Zen',
    bundleId: 'app.zen-browser.zen',
    family: 'webkit',
  }])
})

test('mac browser history discovery maps a newly discovered Gecko browser to places.sqlite', () => {
  const homeDir = tempHomeDir()
  const placesPath = path.join(
    homeDir,
    'Library',
    'Application Support',
    'Zen',
    'Profiles',
    'abc.default',
    'places.sqlite',
  )
  touch(placesPath)
  const applications: BrowserApplication[] = [{
    name: 'Zen',
    bundleId: 'app.zen-browser.zen',
    appPath: '/Applications/Zen.app',
    family: 'firefox',
    source: 'launch_services',
  }]

  const locations = discoverMacBrowserHistoryLocations(applications, homeDir)
  assert.equal(locations.length, 1)
  assert.equal(locations[0].historyPath, placesPath)
  assert.equal(locations[0].family, 'firefox')
  assert.equal(locations[0].bundleId, 'app.zen-browser.zen')
})

test('an app that only opens links is not a browser', () => {
  const urlTypes = (...schemes: string[]) => ({ CFBundleURLTypes: [{ CFBundleURLSchemes: schemes }] })
  // ChatGPT/Codex and Parallels claim http/https but browse nothing.
  assert.equal(isMacWebBrowserPlist(urlTypes('codex', 'http', 'https')), false)
  assert.equal(isMacWebBrowserPlist(urlTypes('http', 'https', 'pdfm')), false)
  assert.equal(isMacWebBrowserPlist({
    ...urlTypes('http', 'https'),
    NSUserActivityTypes: ['NSUserActivityTypeBrowsingWeb'],
  }), true)
  assert.equal(isMacWebBrowserPlist({
    ...urlTypes('http', 'https', 'file'),
    CFBundleDocumentTypes: [{ CFBundleTypeRole: 'Viewer', CFBundleTypeExtensions: ['html', 'htm'] }],
  }), true)
  // A Windows-app shim that edits every file type is not a browser either.
  assert.equal(isMacWebBrowserPlist({
    ...urlTypes('http', 'https'),
    CFBundleDocumentTypes: [{ CFBundleTypeRole: 'Editor', CFBundleTypeExtensions: ['*', 'html'] }],
  }), false)
})

test('automation browser installs are recognised', () => {
  assert.equal(isAutomationBrowserInstall({
    bundleId: 'com.google.chrome.for.testing',
    appPath: '/Applications/Google Chrome for Testing.app',
  }), true)
  assert.equal(isAutomationBrowserInstall({
    bundleId: 'org.chromium.Chromium',
    appPath: '/Users/me/.agent-browser/browsers/chromium/Chromium.app',
  }), true)
  assert.equal(isAutomationBrowserInstall({
    bundleId: 'org.chromium.Chromium',
    appPath: '/Users/me/Library/Caches/ms-playwright/chromium-1243/Chromium.app',
  }), true)
  assert.equal(isAutomationBrowserInstall({
    bundleId: 'org.mozilla.firefox',
    appPath: '/Users/me/Applications/Daylens Test Browsers/Firefox.app',
  }), false)
})

test('mac discovery groups profiles and skips sandbox, staging, and app-internal history', () => {
  const homeDir = tempHomeDir()
  const support = path.join(homeDir, 'Library', 'Application Support')
  for (const profile of ['Default', 'Profile 2', 'Profile 3']) {
    touch(path.join(support, 'Dia', 'User Data', profile, 'History'))
  }
  touch(path.join(homeDir, 'Library', 'Safari', 'History.db'))
  for (const profile of ['A', 'B', 'C']) {
    touch(path.join(homeDir, 'Library', 'Containers', 'com.apple.Safari', 'Data', 'Library', 'Safari', 'Profiles', profile, 'History.db'))
  }
  touch(path.join(support, 'Google', 'Chrome', 'Default', 'History'))
  touch(path.join(support, 'Google', 'Chrome Canary', 'Default', 'History'))
  touch(path.join(support, 'Google', 'Chrome for Testing', 'Default', 'History'))
  touch(path.join(support, 'com.openai.atlas', 'browser-data', 'host', 'Default', 'History'))
  touch(path.join(support, 'com.openai.atlas', 'browser-data', 'host', 'login-staging-5757D7FB', 'History'))
  touch(path.join(support, 'Codex', 'Default', 'History'))
  touch(path.join(support, 'Codex', 'Default', 'Partitions', 'codex-mcp-app-sandbox%3Ashared', 'History'))

  const app = (name: string, bundleId: string, family: BrowserApplication['family'], appPath = `/Applications/${name}.app`): BrowserApplication =>
    ({ name, bundleId, appPath, family, source: 'launch_services' })
  const locations = discoverMacBrowserHistoryLocations([
    app('Dia', 'company.thebrowser.dia', 'chromium'),
    app('Safari', 'com.apple.Safari', 'webkit'),
    app('Google Chrome', 'com.google.Chrome', 'chromium'),
    app('Google Chrome Canary', 'com.google.Chrome.canary', 'chromium'),
    app('ChatGPT Atlas', 'com.openai.atlas', 'chromium'),
    app('Google Chrome for Testing', 'com.google.chrome.for.testing', 'chromium', `${homeDir}/.agent-browser/Google Chrome for Testing.app`),
  ], homeDir)

  const relative = (location: { historyPath: string }) => path.relative(homeDir, location.historyPath)
  const ownerOf = (fragment: string) => locations.find((location) => relative(location).includes(fragment))?.name
  assert.equal(ownerOf('Chrome Canary'), 'Google Chrome Canary')
  assert.equal(ownerOf(path.join('Google', 'Chrome', 'Default')), 'Google Chrome')
  assert.equal(ownerOf('Chrome for Testing'), undefined)
  assert.equal(ownerOf('login-staging'), undefined)
  assert.equal(ownerOf('Partitions'), undefined)
  // Atlas shares only its vendor (openai) with Codex, so Codex data stays out.
  assert.equal(ownerOf(path.join('Codex', 'Default')), undefined)
  assert.equal(ownerOf('com.openai.atlas'), 'ChatGPT Atlas')

  const entries = locations.map((location) => ({
    name: location.profileId === 'default' ? location.name : `${location.name} (${location.profileId})`,
    bundleId: location.profileId === 'default' ? location.bundleId : `${location.bundleId}:${location.profileId}`,
  }))
  assert.equal(entries.length, 10)
  assert.deepEqual(groupDiscoveredBrowsers(entries), {
    discoveredCount: 5,
    discovered: [
      { name: 'ChatGPT Atlas', profileCount: 1 },
      { name: 'Dia', profileCount: 3 },
      { name: 'Google Chrome', profileCount: 1 },
      { name: 'Google Chrome Canary', profileCount: 1 },
      { name: 'Safari', profileCount: 4 },
    ],
  })
})
