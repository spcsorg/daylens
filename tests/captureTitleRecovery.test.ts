// Window-title capture health on a real-shaped day. The sample mix is the two
// days measured on a Mac where capture health read "can't see what you're
// working on": the Accessibility grant was fine, but every app that claimed
// http/https links was treated as a browser, so its titles were stripped, and
// browser time was graded as blind even though history supplied its pages.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { insertFocusEvents, listNativeCaptureTitleStatsByApp, countWebsiteVisitsByBrowserSince } from '../src/main/db/focusEventRepository.ts'
import type { FocusEventInsert } from '../src/main/core/evidence/focusEvent.ts'
import { resolveCanonicalApp } from '../src/main/lib/appIdentity.ts'
import { isAutomationBrowserInstall, isMacWebBrowserPlist } from '../src/main/services/browserRegistry.ts'
import { deriveWindowTitleHealth, summarizeCaptureContext } from '../src/main/services/captureTitleHealth.ts'
import { deriveCaptureVerificationStatus } from '../src/main/services/permissionWatcher.ts'

interface FixtureApp {
  bundleId: string
  name: string
  appPath: string
  plist: Record<string, unknown>
  samples: number
  // Samples whose window title the helper can read (AX), before any strip.
  readableTitles: number
}

const urlTypes = (...schemes: string[]) => ({ CFBundleURLTypes: [{ CFBundleURLSchemes: schemes }] })
const browsingWeb = { NSUserActivityTypes: ['NSUserActivityTypeBrowsingWeb'] }

// Info.plist keys copied from the installed apps.
const APPS: FixtureApp[] = [
  { bundleId: 'company.thebrowser.dia', name: 'Dia', appPath: '/Applications/Dia.app', plist: { ...urlTypes('http', 'https'), ...browsingWeb }, samples: 3020, readableTitles: 3020 },
  { bundleId: 'net.whatsapp.WhatsApp', name: 'WhatsApp', appPath: '/Applications/WhatsApp.app', plist: {}, samples: 297, readableTitles: 291 },
  { bundleId: 'com.anthropic.claudefordesktop', name: 'Claude', appPath: '/Applications/Claude.app', plist: urlTypes('claude'), samples: 222, readableTitles: 219 },
  { bundleId: 'com.google.chrome.for.testing', name: 'Google Chrome for Testing', appPath: '/Users/me/.agent-browser/browsers/chrome-155/Google Chrome for Testing.app', plist: { ...urlTypes('http', 'https', 'file'), ...browsingWeb }, samples: 200, readableTitles: 200 },
  { bundleId: 'com.openai.codex', name: 'ChatGPT', appPath: '/Applications/ChatGPT.app', plist: urlTypes('codex', 'http', 'https'), samples: 141, readableTitles: 141 },
  { bundleId: 'com.mitchellh.ghostty', name: 'Ghostty', appPath: '/Applications/Ghostty.app', plist: {}, samples: 69, readableTitles: 67 },
  { bundleId: 'com.anysphere.sand', name: 'Cursor', appPath: '/Applications/Cursor.app', plist: urlTypes('cursor'), samples: 52, readableTitles: 45 },
  { bundleId: 'org.mozilla.firefox', name: 'Firefox', appPath: '/Users/me/Applications/Daylens Test Browsers/Firefox.app', plist: { ...urlTypes('http', 'https', 'file'), ...browsingWeb }, samples: 50, readableTitles: 50 },
  { bundleId: 'com.parallels.desktop.console', name: 'Parallels Desktop', appPath: '/Applications/Parallels Desktop.app', plist: urlTypes('http', 'https', 'pdfm'), samples: 21, readableTitles: 21 },
]

function catalogBrowser(app: FixtureApp): boolean {
  return resolveCanonicalApp(app.bundleId, app.name).defaultCategory === 'browsing'
}

function claimsWebUrls(plist: Record<string, unknown>): boolean {
  const types = (plist.CFBundleURLTypes as Array<{ CFBundleURLSchemes: string[] }> | undefined) ?? []
  const schemes = new Set(types.flatMap((type) => type.CFBundleURLSchemes))
  return schemes.has('http') && schemes.has('https')
}

const oldIsBrowser = (app: FixtureApp) => claimsWebUrls(app.plist) || catalogBrowser(app)
const newIsBrowser = (app: FixtureApp) =>
  (isMacWebBrowserPlist(app.plist) && !isAutomationBrowserInstall(app)) || catalogBrowser(app)

const SINCE = 1_000_000

// Stores what the capture gate would persist: browser titles are stripped.
function captureDay(isBrowser: (app: FixtureApp) => boolean) {
  const db = createProductionTestDatabase()
  const events: FocusEventInsert[] = []
  for (const app of APPS) {
    const stripped = isBrowser(app)
    for (let i = 0; i < app.samples; i++) {
      events.push({
        ts_ms: SINCE + events.length,
        mono_ns: (SINCE + events.length) * 1_000_000,
        event_type: i === 0 ? 'app_activated' : 'window_changed',
        app_bundle_id: app.bundleId,
        app_name: app.name,
        pid: 1,
        window_title: !stripped && i < app.readableTitles ? `${app.name} window ${i}` : null,
        url: null,
        page_title: null,
        source: 'nsworkspace_event',
        confidence: 'observed',
        platform: 'darwin',
        schema_ver: 2,
      })
    }
  }
  insertFocusEvents(db, events)
  const insertVisit = db.prepare(`
    INSERT INTO website_visits (domain, url, visit_time, visit_time_us, browser_bundle_id)
    VALUES ('example.com', ?, ?, ?, ?)
  `)
  for (let i = 0; i < 224; i++) insertVisit.run(`https://example.com/${i}`, SINCE + i, i, 'company.thebrowser.dia')
  for (let i = 0; i < 5; i++) insertVisit.run(`https://example.com/p2/${i}`, SINCE + i, i, 'company.thebrowser.dia:Profile 2')
  const lookup = new Map(APPS.map((app) => [app.bundleId, app]))
  const stats = summarizeCaptureContext(
    listNativeCaptureTitleStatsByApp(db, SINCE),
    countWebsiteVisitsByBrowserSince(db, SINCE),
    (bundleId) => isBrowser(lookup.get(bundleId ?? '')!),
  )
  db.close()
  return stats
}

test('only real browsers are browsers: link handlers and automation installs are not', () => {
  const browsers = APPS.filter(newIsBrowser).map((app) => app.name)
  assert.deepEqual(browsers, ['Dia', 'Firefox'])
  assert.deepEqual(
    APPS.filter(oldIsBrowser).map((app) => app.name),
    ['Dia', 'Google Chrome for Testing', 'ChatGPT', 'Firefox', 'Parallels Desktop'],
  )
})

test('title-capture rate recovers on the measured day', () => {
  const before = captureDay(oldIsBrowser)
  // Old metric: titled share of every sample.
  assert.equal(before.recentSamples, 4072)
  assert.equal(before.recentSamplesWithTitle, 622)
  assert.equal(Math.round((before.recentSamplesWithTitle / before.recentSamples) * 1000) / 10, 15.3)

  const after = captureDay(newIsBrowser)
  assert.equal(after.recentSamples, 4072)
  assert.equal(after.recentSamplesWithTitle, 984)
  assert.equal(after.browserSamples, 3070)
  assert.equal(after.browserSamplesWithHistory, 3020)
  assert.equal(after.samplesWithContext, 4004)
  assert.equal(Math.round((after.samplesWithContext / after.recentSamples) * 1000) / 10, 98.3)
  assert.equal(deriveWindowTitleHealth(after).status, 'healthy')

  // The grant verdict sees only apps whose titles are stored.
  assert.equal(after.titleEligibleSamples, 1002)
  assert.equal(after.titleEligibleWithTitle, 984)
  assert.equal(deriveCaptureVerificationStatus({
    axTrusted: true,
    recentSamples: after.titleEligibleSamples,
    recentSamplesWithTitle: after.titleEligibleWithTitle,
  }), 'healthy')
})

test('a quarter hour in a browser is no longer a dead-grant alarm', () => {
  const browserOnly = summarizeCaptureContext(
    [{ appBundleId: 'company.thebrowser.dia', appName: 'Dia', samples: 90, withTitle: 0, lastCapturedAtMs: null }],
    [],
    () => true,
  )
  // Previously every sample counted toward the grant check: 0 of 90 → blind.
  assert.equal(deriveCaptureVerificationStatus({ axTrusted: true, recentSamples: 90, recentSamplesWithTitle: 0 }), 'blind')
  assert.equal(deriveCaptureVerificationStatus({
    axTrusted: true,
    recentSamples: browserOnly.titleEligibleSamples,
    recentSamplesWithTitle: browserOnly.titleEligibleWithTitle,
  }), 'waiting')
  assert.deepEqual(deriveWindowTitleHealth(browserOnly), { status: 'missing', blindCause: 'browser_history' })
})

test('a stale grant is still caught and blamed on window titles', () => {
  const stale = summarizeCaptureContext(
    [
      { appBundleId: 'net.whatsapp.WhatsApp', appName: 'WhatsApp', samples: 40, withTitle: 0, lastCapturedAtMs: null },
      { appBundleId: 'company.thebrowser.dia', appName: 'Dia', samples: 40, withTitle: 0, lastCapturedAtMs: null },
    ],
    [{ browserBundleId: 'company.thebrowser.dia', visits: 3 }],
    (bundleId) => bundleId === 'company.thebrowser.dia',
  )
  assert.equal(deriveCaptureVerificationStatus({
    axTrusted: true,
    recentSamples: stale.titleEligibleSamples,
    recentSamplesWithTitle: stale.titleEligibleWithTitle,
  }), 'blind')
  assert.deepEqual(deriveWindowTitleHealth(stale), { status: 'degraded', blindCause: 'window_titles' })
})
