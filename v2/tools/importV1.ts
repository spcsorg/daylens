// Private evaluation tool: builds a V2 database from a copy of a V1 Daylens database, for measuring search on real
// days. V1's file is only ever opened read-only, to copy it; the copy is read and then removed. Rows go in through
// Storage.importObservations, so V2's exclusions and deletions apply. Nothing it writes belongs in the repository.
// Usage: node tools/importV1.ts [--v1 <daylens.sqlite>] [--out <dir>] [--keep-copy]
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { cleanAddress } from '../capture/address.ts'
import { KNOWN_BROWSER_APP_IDS } from '../capture/defaults.ts'
import { cleanTitle, type ObservationRow, type RowKind } from '../capture/normalize.ts'
import { DB_FILE, Store } from '../capture/store.ts'
import { Storage } from '../storage/index.ts'

const HOME = os.homedir()
const { values } = parseArgs({
  options: {
    v1: { type: 'string', default: path.join(HOME, 'Library', 'Application Support', 'DaylensWindows', 'daylens.sqlite') },
    out: { type: 'string', default: path.join(HOME, 'Library', 'Application Support', 'Daylens V2 Eval') },
    'keep-copy': { type: 'boolean', default: false },
  },
})
const v1File = path.resolve(values.v1)
const out = path.resolve(values.out)
// The imported database holds real days: it never goes where a cloud drive syncs it. The check is on the real path, so a
// link into a synced folder (home folders linked into a drive, for one) is refused like the folder itself. Google Drive,
// Dropbox, OneDrive and Box sync through ~/Library/CloudStorage, iCloud Drive through ~/Library/Mobile Documents, and
// iCloud can sync Desktop and Documents.
const SYNCED = [['Library', 'CloudStorage'], ['Library', 'Mobile Documents'], ['Google Drive'], ['iCloud Drive'], ['Desktop'], ['Documents'], ['Projects']].map((p) => path.join(HOME, ...p))
// Home folders these apps make under names that start so: "OneDrive - Company", "Dropbox (Personal)", "Box Sync".
const SYNCED_NAMED = ['OneDrive', 'Dropbox', 'Box']
/** The real path of a folder that may not exist yet: its nearest existing parent resolved, the rest as given. */
function realOf(p: string): string {
  const rest: string[] = []
  for (let at = p; ; at = path.dirname(at)) {
    if (existsSync(at)) return path.join(realpathSync(at), ...rest.reverse())
    rest.push(path.basename(at))
    if (path.dirname(at) === at) return p
  }
}
const realOut = realOf(out)
const homes = [HOME, realOf(HOME)]
const synced = (x: string) =>
  SYNCED.flatMap((p) => [p, realOf(p)]).some((p) => x === p || x.startsWith(p + path.sep)) ||
  homes.some((h) => x.startsWith(h + path.sep) && SYNCED_NAMED.some((n) => x.slice(h.length + 1).split(path.sep)[0]!.startsWith(n)))
if (synced(out) || synced(realOut)) throw new Error(`refusing ${out}: it syncs to a cloud drive`)
if (!existsSync(v1File)) throw new Error(`no V1 database at ${v1File}`)
mkdirSync(out, { recursive: true })
// The output folder's database is replaced; V1's file must never be one of the files that removes.
if (path.dirname(realpathSync(v1File)) === realpathSync(out)) throw new Error(`refusing ${out}: it holds the V1 database; choose another output folder`)

// One SELECT-only transaction on V1 for the whole copy, so the copy is a consistent snapshot even while V1 writes.
const copy = path.join(out, `.v1-copy-${process.pid}.sqlite`)
const t0 = performance.now()
// A backup that fails partway can leave part of the copy; the finally below removes it too.
try {
  {
    const v1 = new Database(v1File, { readonly: true, fileMustExist: true })
    try {
      await v1.backup(copy, { progress: () => 1 << 30 })
    } finally {
      v1.close()
    }
  }
  process.stderr.write(`copied V1 (${(statSync(copy).size / 1048576).toFixed(0)} MB) in ${((performance.now() - t0) / 1000).toFixed(1)} s\n`)

  const src = new Database(copy, { readonly: true, fileMustExist: true })
  interface Session { bundle_id: string; canonical_app_id: string | null; app_name: string; start_time: number; end_time: number | null; duration_sec: number; window_title: string | null }
  interface Visit { browser_bundle_id: string | null; url: string | null; page_title: string | null; visit_time: number; duration_sec: number; source: string }
  interface StateEvent { event_ts: number; event_type: string }
  const sessions = src.prepare('SELECT bundle_id, canonical_app_id, app_name, start_time, end_time, duration_sec, window_title FROM app_sessions ORDER BY start_time, id').all() as Session[]
  const visits = src.prepare(`SELECT browser_bundle_id, url, page_title, visit_time, duration_sec, source FROM website_visits WHERE url IS NOT NULL ORDER BY visit_time, id`).all() as Visit[]
  const states = src.prepare('SELECT event_ts, event_type FROM activity_state_events ORDER BY event_ts, id').all() as StateEvent[]
  src.close()

  // V1 names an app by bundle id or by executable path; V2 uses the bundle id where V1 ever recorded one.
  const byCanonical = new Map<string, Map<string, number>>()
  const canonicalOf = new Map<string, string>()
  for (const s of sessions) {
    if (!s.canonical_app_id) continue
    canonicalOf.set(s.bundle_id, s.canonical_app_id)
    if (s.bundle_id.startsWith('/')) continue
    const m = byCanonical.get(s.canonical_app_id) ?? new Map<string, number>()
    m.set(s.bundle_id, (m.get(s.bundle_id) ?? 0) + 1)
    byCanonical.set(s.canonical_app_id, m)
  }
  const appIdOf = (raw: string): string => {
    const id = raw.startsWith('/') ? raw : raw.split(':')[0]!
    const canonical = canonicalOf.get(id)
    const ids = canonical ? byCanonical.get(canonical) : undefined
    if (!ids) return id
    return [...ids].sort((a, b) => b[1] - a[1])[0]![0]
  }
  const isBrowser = (appId: string) => KNOWN_BROWSER_APP_IDS.has(appId.toLowerCase())
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone

  type Ev = { t: number; order: number; row: Partial<ObservationRow> & { kind: RowKind; url?: string | null } }
  const events: Ev[] = []
  // Capture sights the window in front every 60 s; V1 kept only a session's start and length, so each minute of a
  // session becomes a sighting, and a browser's sighting carries the page it was on. Without them every row
  // would end 90 s after it began.
  const SIGHTING_MS = 60_000
  const pagesByApp = new Map<string, Visit[]>()
  for (const v of visits) {
    if (!v.browser_bundle_id) continue
    const id = appIdOf(v.browser_bundle_id)
    const list = pagesByApp.get(id) ?? []
    list.push(v)
    pagesByApp.set(id, list)
  }
  const pageAt = (appId: string, from: number, to: number): Visit[] => {
    const list = pagesByApp.get(appId)
    if (!list) return []
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid]!.visit_time < from) lo = mid + 1
      else hi = mid
    }
    const outList: Visit[] = []
    for (let i = lo; i < list.length && list[i]!.visit_time < to; i++) outList.push(list[i]!)
    return outList
  }
  const pageRow = (appId: string, appName: string, v: Visit) => {
    const url = cleanAddress(v.url)
    return url ? { kind: 'page' as const, app_id: appId, app_name: appName, title: v.page_title ? cleanTitle(v.page_title).title : null, title_state: 'ok' as const, state: 'normal', url } : null
  }

  const covered: [number, number][] = []
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]!
    const appId = appIdOf(s.bundle_id)
    const next = sessions[i + 1]?.start_time ?? Number.POSITIVE_INFINITY
    const end = Math.min(Math.max(s.end_time ?? s.start_time + s.duration_sec * 1000, s.start_time), next)
    covered.push([s.start_time, end])
    const browser = isBrowser(appId)
    const title = browser || !s.window_title ? null : cleanTitle(s.window_title).title
    const focus = { kind: 'focus' as const, app_id: appId, app_name: s.app_name, window: 'v1', title, title_state: (browser ? 'withheld_browser' : title ? 'ok' : 'unavailable') as ObservationRow['title_state'], state: 'ok' }
    const pages = browser ? pageAt(appId, s.start_time, end) : []
    let current: Visit | null = null
    let p = 0
    for (let t = s.start_time; t < end || t === s.start_time; t += SIGHTING_MS) {
      events.push({ t, order: 0, row: focus })
      while (p < pages.length && pages[p]!.visit_time <= t) current = pages[p++]!
      const at = current ? pageRow(appId, s.app_name, current) : null
      if (at) events.push({ t, order: 1, row: at })
      while (p < pages.length && pages[p]!.visit_time < Math.min(t + SIGHTING_MS, end)) {
        current = pages[p++]!
        const r = pageRow(appId, s.app_name, current)
        if (r) events.push({ t: current.visit_time, order: 1, row: r })
      }
    }
  }

  // The front tab V1 read while no V1 session says what was in front (after its foreground capture stopped): the
  // browser was in front on that page for the visit's length.
  covered.sort((a, b) => a[0] - b[0])
  const isCovered = (t: number) => {
    let lo = 0
    let hi = covered.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const [s, e] = covered[mid]!
      if (t < s) hi = mid - 1
      else if (t >= e) lo = mid + 1
      else return true
    }
    return false
  }
  for (const v of visits) {
    if (!v.browser_bundle_id || !v.source.startsWith('active_') || isCovered(v.visit_time)) continue
    const appId = appIdOf(v.browser_bundle_id)
    const name = appId.split('.').at(-1) ?? appId
    const r = pageRow(appId, name, v)
    if (!r) continue
    const focus = { kind: 'focus' as const, app_id: appId, app_name: name, window: 'v1', title: null, title_state: 'withheld_browser' as const, state: 'ok' }
    for (let t = v.visit_time; t < v.visit_time + Math.max(1, v.duration_sec) * 1000; t += SIGHTING_MS) {
      events.push({ t, order: 0, row: focus })
      events.push({ t, order: 1, row: r })
    }
  }

  const STATE: Record<string, { kind: RowKind; state: string }> = {
    lock_screen: { kind: 'session', state: 'locked' },
    unlock_screen: { kind: 'session', state: 'unlocked' },
    suspend: { kind: 'power', state: 'sleep' },
    resume: { kind: 'power', state: 'resume' },
    idle_start: { kind: 'input', state: 'idle' },
    idle_end: { kind: 'input', state: 'active' },
  }
  for (const e of states) {
    const m = STATE[e.event_type]
    if (m) events.push({ t: e.event_ts, order: -1, row: { kind: m.kind, state: m.state } })
  }
  events.sort((a, b) => a.t - b.t || a.order - b.order)

  for (const f of ['', '-wal', '-shm', '-journal']) rmSync(path.join(out, DB_FILE + f), { force: true })
  const store = new Store(out)
  // A one-shot import runs no deletions, so capture never needs checkpointing back from the deletion worker.
  const storage = new Storage(store, out, { deletionStallMs: Infinity })
  let seq = 0
  let imported = 0
  let refused = 0
  const CHUNK = 20_000
  for (let i = 0; i < events.length; i += CHUNK) {
    const rows = events.slice(i, i + CHUNK).map(({ t, row }) => ({
      run: 'v1-import', seq: seq++, boot: 'v1', platform: 'macos', source: 'v1_import', event_wall_ms: t, event_mono_us: t * 1000, tz: zone, tz_offset_min: -new Date(t).getTimezoneOffset(),
      app_id: null, app_name: null, app_path: null, pid: null, window: null, title: null, title_raw: null, title_state: null, state: null, detail: null, url: null, ...row,
    }) as ObservationRow & { url?: string | null })
    const r = storage.importObservations(rows)
    imported += r.imported
    refused += r.refused
  }
  await storage.derivationSettled()
  const count = (t: string) => store.database.prepare(`SELECT count(*) FROM ${t}`).pluck().get() as number
  const span = store.database.prepare('SELECT min(start_wall_ms) AS a, max(end_wall_ms) AS b FROM intervals').get() as { a: number; b: number }
  const summary = {
    v1: { sessions: sessions.length, visits: visits.length, state_events: states.length },
    imported,
    refused,
    intervals: count('intervals'),
    search_docs: count('search_docs'),
    from: new Date(span.a).toISOString(),
    to: new Date(span.b).toISOString(),
  }
  storage.stop()
  store.database.pragma('wal_checkpoint(TRUNCATE)')
  store.close()
  process.stdout.write(JSON.stringify({ ...summary, database: path.join(out, DB_FILE), size_mb: Math.round(statSync(path.join(out, DB_FILE)).size / 1048576) }, null, 2) + '\n')
} finally {
  if (!values['keep-copy']) for (const f of [copy, `${copy}-wal`, `${copy}-shm`]) rmSync(f, { force: true })
}
