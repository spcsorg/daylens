// V2 installs over V1 as the same app, so a new V2 store starts with V1's pause and exclusions. V1 kept them in its
// config.json; this only reads that file and never opens V1's database.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ExclusionRule } from './defaults.ts'

export interface V1Privacy {
  paused: boolean
  rules: ExclusionRule[]
  // Excluded app names with no installed app to name its bundle id.
  unresolved: number
}

// Every folder V1 may have kept its settings in (src/main/services/userData.ts on main). Each is read, so a pause or
// exclusion in any of them carries.
function v1Dirs(appData: string, platform: NodeJS.Platform): string[] {
  const names = platform === 'darwin' ? ['Daylens Desktop', 'Daylens', 'DaylensWindows'] : ['Daylens', 'DaylensWindows']
  return names.map((n) => path.join(appData, n))
}

const APP_FOLDERS = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', path.join(os.homedir(), 'Applications')]

function run(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

// V1 matched an entry against the name an app shows (its localized name, which can differ from its file: "Voice Memos"
// is VoiceMemos.app) as well as its bundle id; V2 matches bundle ids. So each installed app is found by its file name
// and its shown name, and a name becomes the bundle ids of the apps it names. Built on first use.
export function appsByName(folders: readonly string[] = APP_FOLDERS): (name: string) => string[] {
  let byName: Map<string, Set<string>> | null = null
  const index = () => {
    const map = new Map<string, Set<string>>()
    if (process.platform !== 'darwin') return map
    const add = (name: string, id: string) => {
      const key = name.trim().toLowerCase()
      if (key) map.set(key, (map.get(key) ?? new Set()).add(id))
    }
    for (const folder of folders) {
      let bundles: string[]
      try {
        bundles = readdirSync(folder).filter((f) => f.endsWith('.app')).map((f) => path.join(folder, f))
      } catch {
        continue
      }
      if (bundles.length === 0) continue
      // Two values per bundle, in attribute name order: bundle id, then shown name.
      const out = run('/usr/bin/mdls', ['-raw', '-nullMarker', '', '-name', 'kMDItemCFBundleIdentifier', '-name', 'kMDItemDisplayName', ...bundles])?.split('\0')
      const meta = out?.length === bundles.length * 2 ? out : null
      bundles.forEach((bundle, i) => {
        const id = meta?.[i * 2] || run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')])?.trim()
        if (!id) return
        add(path.basename(bundle, '.app'), id)
        const shown = meta?.[i * 2 + 1]
        if (shown) add(shown.replace(/\.app$/i, ''), id)
      })
    }
    return map
  }
  return (name) => [...((byName ??= index()).get(name.trim().toLowerCase()) ?? [])]
}

const BUNDLE_ID = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i

// Same cleanup V1's settings applied to a typed site.
function host(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')
}

export function readV1Privacy(appData: string, platform: NodeJS.Platform = process.platform, resolve = appsByName()): V1Privacy | null {
  let found = false
  let paused = false
  let unresolved = 0
  const rules = new Map<string, ExclusionRule>()
  const add = (r: ExclusionRule) => rules.set(`${r.match}\0${r.value.toLowerCase()}`, r)
  for (const dir of v1Dirs(appData, platform)) {
    let config: Record<string, unknown>
    try {
      config = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8')) as Record<string, unknown>
    } catch {
      continue
    }
    if (!config || typeof config !== 'object') continue
    found = true
    if (config.trackingPaused === true) paused = true
    // V1 applied its exclusion lists only while its tracking controls were on; the pause applied either way.
    if (config.trackingControlsEnabled !== true) continue
    for (const entry of Array.isArray(config.trackingExcludedApps) ? config.trackingExcludedApps : []) {
      if (typeof entry !== 'string' || !entry.trim()) continue
      const value = entry.trim()
      if (BUNDLE_ID.test(value)) add({ match: 'app_id', value, label: value })
      else {
        const ids = resolve(value)
        if (ids.length === 0) unresolved++
        for (const id of ids) add({ match: 'app_id', value: id, label: value })
      }
    }
    for (const entry of Array.isArray(config.trackingExcludedSites) ? config.trackingExcludedSites : []) {
      if (typeof entry !== 'string') continue
      const value = host(entry)
      if (value) add({ match: 'site', value, label: value })
    }
  }
  return found ? { paused, rules: [...rules.values()], unresolved } : null
}
