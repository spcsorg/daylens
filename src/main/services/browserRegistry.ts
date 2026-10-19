import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  getLinuxBrowserHistoryLocations,
  isLinuxBrowserApplication,
  resolveLinuxBrowserApplication,
} from './linuxBrowserRegistry'
import { isWindowsBrowserApplication, resolveWindowsBrowserApplication } from './windowsBrowserRegistry'

export type BrowserFamily = 'chromium' | 'firefox' | 'webkit'

export interface BrowserApplication {
  name: string
  bundleId: string
  appPath: string
  family: BrowserFamily
  source: 'launch_services' | 'info_plist'
}

export interface BrowserHistoryLocation extends BrowserApplication {
  historyPath: string
  profileId: string
}

export interface BrowserCandidate {
  bundleId?: string | null
  appName?: string | null
  executablePath?: string | null
}

const LSREGISTER_PATH =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const REGISTRY_CACHE_MS = 60_000
const HISTORY_CACHE_MS = 5 * 60_000
const MAX_HISTORY_SCAN_DEPTH = 6
const SKIPPED_SCAN_DIRECTORIES = new Set([
  'cache',
  'caches',
  'code cache',
  'gpucache',
  'indexeddb',
  'local storage',
  'service worker',
  'session storage',
  'storage',
  // Electron/Chromium webview partitions inside an app, not a browser profile.
  'partitions',
])
const AUTOMATION_PATH_PATTERN = /\b(?:for testing|staging|sandbox)\b/i
const AUTOMATION_BROWSER_BUNDLE_IDS = new Set(['com.google.chrome.for.testing'])

let registryCache: { readAt: number; applications: BrowserApplication[] } | null = null
let historyCache: { readAt: number; locations: BrowserHistoryLocation[] } | null = null

function unique<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = keyFor(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizedPath(value: string): string {
  try {
    return path.resolve(value).toLowerCase()
  } catch {
    return value.toLowerCase()
  }
}

function appBundlePath(value: string | null | undefined): string | null {
  const raw = value?.trim()
  if (!raw) return null
  const match = raw.match(/^(.+?\.app)(?:\/|$)/i)
  return match?.[1] ?? (raw.toLowerCase().endsWith('.app') ? raw : null)
}

function plistJson(appPath: string): Record<string, unknown> | null {
  try {
    const raw = execFileSync(
      'plutil',
      ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2_000,
      },
    )
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function plistString(plist: Record<string, unknown>, key: string): string | null {
  const value = plist[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function registeredSchemes(plist: Record<string, unknown>): Set<string> {
  const schemes = new Set<string>()
  const urlTypes = plist.CFBundleURLTypes
  if (!Array.isArray(urlTypes)) return schemes

  for (const value of urlTypes) {
    if (!value || typeof value !== 'object') continue
    const typeSchemes = (value as Record<string, unknown>).CFBundleURLSchemes
    if (!Array.isArray(typeSchemes)) continue
    for (const scheme of typeSchemes) {
      if (typeof scheme === 'string') schemes.add(scheme.trim().toLowerCase())
    }
  }
  return schemes
}

function handlesWebUrls(plist: Record<string, unknown>): boolean {
  const schemes = registeredSchemes(plist)
  return schemes.has('http') && schemes.has('https')
}

// Claiming http/https only means an app opens links (ChatGPT/Codex, Parallels
// do). A browser also advertises web-browsing Handoff or views HTML documents.
function declaresWebBrowsing(plist: Record<string, unknown>): boolean {
  const activityTypes = plist.NSUserActivityTypes
  if (Array.isArray(activityTypes) && activityTypes.includes('NSUserActivityTypeBrowsingWeb')) return true

  const documentTypes = plist.CFBundleDocumentTypes
  if (!Array.isArray(documentTypes)) return false
  return documentTypes.some((value) => {
    if (!value || typeof value !== 'object') return false
    const documentType = value as Record<string, unknown>
    if (documentType.CFBundleTypeRole !== 'Viewer') return false
    const contentTypes = Array.isArray(documentType.LSItemContentTypes) ? documentType.LSItemContentTypes : []
    const extensions = Array.isArray(documentType.CFBundleTypeExtensions) ? documentType.CFBundleTypeExtensions : []
    return contentTypes.includes('public.html') || extensions.includes('html') || extensions.includes('htm')
  })
}

export function isMacWebBrowserPlist(plist: Record<string, unknown>): boolean {
  return handlesWebUrls(plist) && declaresWebBrowsing(plist)
}

/** Test/agent builds (Chrome for Testing, Playwright caches, hidden tool
 *  folders) are automation, not the person's browsing. */
export function isAutomationBrowserInstall(application: Pick<BrowserApplication, 'bundleId' | 'appPath'>): boolean {
  if (AUTOMATION_BROWSER_BUNDLE_IDS.has(application.bundleId.toLowerCase())) return true
  const segments = application.appPath.split('/')
  return segments.some((segment) => segment.startsWith('.') && segment.length > 1)
    || /\/Library\/Caches\//i.test(application.appPath)
}

const browserVerdictByAppPath = new Map<string, boolean>()

// Re-checks a LaunchServices candidate against its Info.plist. An unreadable
// plist keeps the LaunchServices verdict.
function qualifiesAsMacBrowser(application: BrowserApplication): boolean {
  if (isAutomationBrowserInstall(application)) return false
  const cacheKey = normalizedPath(application.appPath)
  const cached = browserVerdictByAppPath.get(cacheKey)
  if (cached !== undefined) return cached
  const plist = fs.existsSync(path.join(application.appPath, 'Contents', 'Info.plist'))
    ? plistJson(application.appPath)
    : null
  const verdict = plist ? isMacWebBrowserPlist(plist) : true
  browserVerdictByAppPath.set(cacheKey, verdict)
  return verdict
}

function classifyMacBrowserFamily(appPath: string): BrowserFamily {
  if (
    fs.existsSync(path.join(appPath, 'Contents', 'Resources', 'omni.ja'))
    || fs.existsSync(path.join(appPath, 'Contents', 'Resources', 'browser', 'omni.ja'))
  ) {
    return 'firefox'
  }

  try {
    const frameworksPath = path.join(appPath, 'Contents', 'Frameworks')
    const frameworks = fs.readdirSync(frameworksPath)
    if (frameworks.some((entry) =>
      /\sframework\.framework$/i.test(entry)
      || /^arccore\.framework$/i.test(entry)
      || /(?:chromium|chrome|electron|cef).*\.framework$/i.test(entry))) {
      return 'chromium'
    }
  } catch {
    // A WebKit app may have no app-private browser framework.
  }

  return 'webkit'
}

function inspectMacBrowserApplication(appPath: string): BrowserApplication | null {
  const normalizedAppPath = appBundlePath(appPath)
  if (!normalizedAppPath) return null
  const plist = plistJson(normalizedAppPath)
  if (!plist || !isMacWebBrowserPlist(plist)) return null

  const bundleId = plistString(plist, 'CFBundleIdentifier')
  const name = plistString(plist, 'CFBundleDisplayName')
    ?? plistString(plist, 'CFBundleName')
    ?? path.basename(normalizedAppPath, '.app')
  if (!bundleId) return null
  if (isAutomationBrowserInstall({ bundleId, appPath: normalizedAppPath })) return null

  return {
    name,
    bundleId,
    appPath: normalizedAppPath,
    family: classifyMacBrowserFamily(normalizedAppPath),
    source: 'info_plist',
  }
}

// Same-install identity across capture backends: the poll backend only knows
// the executable path when the active-window module reports no bundle id,
// while macOS focus events report the real CFBundleIdentifier. Reading the
// .app bundle's Info.plist maps the path onto that same identifier so one
// install never mints two identities. Results — including misses — are cached
// because this sits on the capture poll.
const bundleIdentifierByAppPath = new Map<string, string | null>()

export function macBundleIdentifierForExecutablePath(
  executablePath: string | null | undefined,
): string | null {
  const bundlePath = appBundlePath(executablePath)
  if (!bundlePath || !bundlePath.startsWith('/')) return null
  const cacheKey = normalizedPath(bundlePath)
  const cached = bundleIdentifierByAppPath.get(cacheKey)
  if (cached !== undefined) return cached
  const plist = plistJson(bundlePath)
  const bundleId = plist ? plistString(plist, 'CFBundleIdentifier') : null
  bundleIdentifierByAppPath.set(cacheKey, bundleId)
  return bundleId
}

export function parseLaunchServicesBrowserDump(dump: string): BrowserApplication[] {
  const applications: BrowserApplication[] = []
  const records = dump.split(/\n-{40,}\n/g)

  for (const record of records) {
    const claimedSchemes = record.match(/^claimed schemes:\s+(.+?)\s*$/im)?.[1] ?? ''
    if (!/(?:^|[,\s])http:(?:$|[,\s])/i.test(claimedSchemes)) continue
    if (!/(?:^|[,\s])https:(?:$|[,\s])/i.test(claimedSchemes)) continue
    const isRegisteredWebBrowser =
      /^more flags:\s+.*\bweb-browser\b/im.test(record)
      || /^claimed UTIs:\s+.*\bcom\.apple\.default-app\.web-browser\b/im.test(record)
      || /\bNSUserActivityTypeBrowsingWeb\b/.test(record)
    if (!isRegisteredWebBrowser) continue

    const appPath = record.match(/^path:\s+(.+?\.app)(?:\s+\(0x[0-9a-f]+\))?\s*$/im)?.[1]?.trim()
    const bundleId = record.match(/^identifier:\s+([^\s]+)\s*$/im)?.[1]?.trim()
    const name = record.match(/^displayName:\s+(.+?)\s*$/im)?.[1]?.trim()
      ?? record.match(/^name:\s+(.+?)\s*$/im)?.[1]?.trim()
    if (!appPath || !bundleId || !name) continue

    applications.push({
      name,
      bundleId,
      appPath,
      family: classifyMacBrowserFamily(appPath),
      source: 'launch_services',
    })
  }

  return unique(applications, (app) => app.bundleId.toLowerCase())
}

const execFileAsync = promisify(execFile)

// Populate the registry cache off the main thread. The synchronous reader falls
// back to `lsregister -dump`, a ~4s subprocess plus ~1.5s of parsing on macOS —
// catastrophic when it runs lazily on a user's first Apps/Timeline click. Run
// the same discovery asynchronously at startup so the subprocess never blocks
// the main thread and the cache is warm before the first interaction. Exact
// behaviour of the sync path is preserved; this only changes when it runs.
export async function prewarmBrowserRegistry(): Promise<void> {
  if (process.platform !== 'darwin') return
  if (registryCache && Date.now() - registryCache.readAt < REGISTRY_CACHE_MS) return

  const helperCandidates = [
    ...(process.resourcesPath ? [path.join(process.resourcesPath, 'build', 'capture-helper')] : []),
    path.join(__dirname, '..', '..', 'build', 'capture-helper'),
    path.join(process.cwd(), 'build', 'capture-helper'),
  ]

  for (const helperPath of helperCandidates) {
    if (!fs.existsSync(helperPath)) continue
    try {
      const { stdout } = await execFileAsync(helperPath, [], {
        encoding: 'utf8',
        env: { ...process.env, DAYLENS_CAPTURE_HELPER_BROWSER_DISCOVERY: '1' },
        timeout: 5_000,
        maxBuffer: 8 * 1024 * 1024,
      })
      const parsed = JSON.parse(stdout) as BrowserApplication[]
      if (Array.isArray(parsed) && parsed.length > 0) {
        registryCache = {
          readAt: Date.now(),
          applications: parsed.map((application) => ({
            ...application,
            family: classifyMacBrowserFamily(application.appPath),
            source: 'launch_services' as const,
          })).filter(qualifiesAsMacBrowser),
        }
        historyCache = null
        return
      }
    } catch {
      // Helper unavailable or returned nothing — fall through to lsregister.
    }
  }

  try {
    const { stdout } = await execFileAsync(LSREGISTER_PATH, ['-dump'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 10_000,
    })
    registryCache = { readAt: Date.now(), applications: parseLaunchServicesBrowserDump(stdout).filter(qualifiesAsMacBrowser) }
    historyCache = null
  } catch {
    // Leave the cache cold; the lazy synchronous path still resolves on first use.
  }
}

let prewarmInFlight: Promise<void> | null = null

// Kick off a single background refresh; callers get whatever is cached now.
function ensureRegistryWarming(): void {
  if (prewarmInFlight) return
  prewarmInFlight = prewarmBrowserRegistry().finally(() => { prewarmInFlight = null })
}

function getBrowserApplications(): BrowserApplication[] {
  if (process.platform !== 'darwin') return []
  // Never block a synchronous read path on the ~5s LaunchServices dump. If the
  // cache is missing or stale, refresh it in the background and serve what we
  // have (an empty list until the first warm completes). Common browsers are
  // resolved from the app catalog before this fallback, so only obscure
  // non-catalog browsers are momentarily undetected right after launch.
  if (!registryCache || Date.now() - registryCache.readAt >= REGISTRY_CACHE_MS) {
    ensureRegistryWarming()
  }
  return registryCache?.applications ?? []
}

function candidateMatchesApplication(candidate: BrowserCandidate, application: BrowserApplication): boolean {
  const bundleId = candidate.bundleId?.trim().toLowerCase()
  if (bundleId && bundleId === application.bundleId.toLowerCase()) return true

  const candidatePaths = [candidate.executablePath, candidate.bundleId]
    .map(appBundlePath)
    .filter((value): value is string => Boolean(value))
    .map(normalizedPath)
  return candidatePaths.includes(normalizedPath(application.appPath))
}

export function resolveBrowserApplication(candidate: BrowserCandidate): BrowserApplication | null {
  if (process.platform === 'win32') return resolveWindowsBrowserApplication(candidate)
  if (process.platform === 'linux') return resolveLinuxBrowserApplication(candidate)
  if (process.platform !== 'darwin') return null

  for (const possiblePath of [candidate.executablePath, candidate.bundleId]) {
    const inspected = inspectMacBrowserApplication(possiblePath ?? '')
    if (!inspected) continue
    const applications = unique(
      [...(registryCache?.applications ?? []), inspected],
      (application) => application.bundleId.toLowerCase(),
    )
    registryCache = { readAt: Date.now(), applications }
    historyCache = null
    return inspected
  }

  return getBrowserApplications()
    .find((application) => candidateMatchesApplication(candidate, application))
    ?? null
}

export function isBrowserApplication(candidate: BrowserCandidate): boolean {
  if (process.platform === 'win32') return isWindowsBrowserApplication(candidate)
  if (process.platform === 'linux') return isLinuxBrowserApplication(candidate)
  return resolveBrowserApplication(candidate) !== null
}

function scanForHistoryFiles(root: string): string[] {
  const found: string[] = []
  const visit = (directory: string, depth: number) => {
    if (depth > MAX_HISTORY_SCAN_DEPTH) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isFile() && (entry.name === 'History' || entry.name === 'History.db' || entry.name === 'places.sqlite')) {
        found.push(fullPath)
        continue
      }
      if (!entry.isDirectory() || SKIPPED_SCAN_DIRECTORIES.has(entry.name.toLowerCase())) continue
      visit(fullPath, depth + 1)
    }
  }

  visit(root, 0)
  return found
}

function nameTokens(value: string): string[] {
  const ignored = new Set(['app', 'browser', 'com', 'company', 'org', 'the', 'www'])
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !ignored.has(token))
}

// The bundle id's vendor label (`openai` in com.openai.codex) counts only when
// the app is named after it ("Brave Browser"); otherwise it matches every
// sibling product's data folder (Codex data under com.openai.atlas).
function identityTokens(application: BrowserApplication): string[] {
  const named = new Set([...nameTokens(application.name), ...nameTokens(path.basename(application.appPath, '.app'))])
  const labels = application.bundleId.split('.')
  const vendor = labels.length >= 3 ? labels[1].toLowerCase() : null
  const fromBundle = nameTokens(application.bundleId).filter((token) => token !== vendor || named.has(token))
  return unique([...named, ...fromBundle], (token) => token)
}

function historyPathMatchesFamily(historyPath: string, family: BrowserFamily): boolean {
  const base = path.basename(historyPath)
  if (family === 'firefox') return base === 'places.sqlite'
  if (family === 'webkit') return base === 'History.db' || base === 'History'
  return base === 'History'
}

function identityPathScore(candidatePath: string, application: BrowserApplication): number {
  const lowerPath = candidatePath.toLowerCase()
  return identityTokens(application).reduce(
    (score, token) => score + (lowerPath.includes(token) ? token.length : 0),
    0,
  )
}

function profileIdForHistoryPath(historyPath: string): string {
  const parent = path.basename(path.dirname(historyPath))
  if (/^default$/i.test(parent)) return 'default'
  if (/^profile \d+$/i.test(parent)) return parent
  if (/profiles?$/i.test(parent)) return 'default'
  return parent || 'default'
}

export function discoverMacBrowserHistoryLocations(
  applications = getBrowserApplications(),
  home = os.homedir(),
): BrowserHistoryLocation[] {
  const appSupport = path.join(home, 'Library', 'Application Support')
  const containers = path.join(home, 'Library', 'Containers')
  // A history file found under several browsers' roots (Chrome and Chrome
  // Canary both live under Google/) belongs to the one whose identity it
  // matches most closely.
  const best = new Map<string, { location: BrowserHistoryLocation; score: number }>()

  for (const application of applications) {
    if (isAutomationBrowserInstall(application)) continue
    const roots = new Set<string>()
    const considerChildren = (root: string, maxDepth: number) => {
      let current = [root]
      for (let depth = 0; depth <= maxDepth; depth++) {
        const next: string[] = []
        for (const directory of current) {
          let entries: fs.Dirent[]
          try {
            entries = fs.readdirSync(directory, { withFileTypes: true })
          } catch {
            continue
          }
          for (const entry of entries) {
            if (!entry.isDirectory()) continue
            const child = path.join(directory, entry.name)
            if (identityPathScore(path.relative(appSupport, child), application) > 0) roots.add(child)
            next.push(child)
          }
        }
        current = next
      }
    }

    considerChildren(appSupport, 1)
    const containerRoot = path.join(containers, application.bundleId)
    if (fs.existsSync(containerRoot)) roots.add(containerRoot)
    if (identityTokens(application).includes('safari')) {
      roots.add(path.join(home, 'Library', 'Safari'))
    }

    const historyPaths = unique(
      [...roots].flatMap((root) => scanForHistoryFiles(root)),
      normalizedPath,
    )
    for (const historyPath of historyPaths) {
      if (!historyPathMatchesFamily(historyPath, application.family)) continue
      const relativePath = path.relative(home, historyPath)
      if (AUTOMATION_PATH_PATTERN.test(relativePath)) continue
      const key = normalizedPath(historyPath)
      const score = identityPathScore(relativePath, application)
      const current = best.get(key)
      if (current && current.score >= score) continue
      best.set(key, {
        score,
        location: { ...application, historyPath, profileId: profileIdForHistoryPath(historyPath) },
      })
    }
  }

  return [...best.values()].map((entry) => entry.location)
}

export function getMacBrowserHistoryLocations(): BrowserHistoryLocation[] {
  if (process.platform !== 'darwin') return []
  if (!historyCache || Date.now() - historyCache.readAt >= HISTORY_CACHE_MS) {
    historyCache = {
      readAt: Date.now(),
      locations: discoverMacBrowserHistoryLocations(),
    }
  }
  return historyCache.locations
}

export { getLinuxBrowserHistoryLocations }
