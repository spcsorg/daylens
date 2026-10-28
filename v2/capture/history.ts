// Browser history readers (macOS): visits from Chrome, Edge, Arc, Dia and Firefox profiles. Each visit is an
// observation of kind 'visit' and goes through the store's admission gate, so pause, exclusions, deletions and
// retention apply as they do to capture. A visit shows a page was opened, not how long it was read, so it gets no time.
// Private windows never reach history files; Guest profiles and visits synced from other devices or added by
// extensions are skipped.

import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { chmodSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cleanAddress } from './address.ts'
import { cleanTitle, type ObservationRow } from './normalize.ts'

export type Family = 'chromium' | 'firefox'

export interface HistoryBrowser {
  name: string
  app_id: string
  family: Family
  // Under ~/Library/Application Support.
  dir: string[]
}

export const MAC_HISTORY_BROWSERS: readonly HistoryBrowser[] = [
  { name: 'Google Chrome', app_id: 'com.google.Chrome', family: 'chromium', dir: ['Google', 'Chrome'] },
  { name: 'Microsoft Edge', app_id: 'com.microsoft.edgemac', family: 'chromium', dir: ['Microsoft Edge'] },
  { name: 'Arc', app_id: 'company.thebrowser.Browser', family: 'chromium', dir: ['Arc', 'User Data'] },
  { name: 'Dia', app_id: 'company.thebrowser.dia', family: 'chromium', dir: ['Dia', 'User Data'] },
  { name: 'Firefox', app_id: 'org.mozilla.firefox', family: 'firefox', dir: ['Firefox'] },
]

export interface HistoryProfile {
  browser: HistoryBrowser
  // The profile's folder relative to the browser's, which names it in the run.
  profile: string
  file: string
}

export interface Visit {
  id: number
  wall_ms: number
  url: string
  title: string | null
}

// Chromium's profile list. A folder it does not list (Guest, System, a leftover) is not read.
function chromiumProfiles(root: string): string[] {
  try {
    const state = JSON.parse(readFileSync(path.join(root, 'Local State'), 'utf8')) as { profile?: { info_cache?: Record<string, { is_guest?: boolean }> } }
    return Object.entries(state.profile?.info_cache ?? {})
      .filter(([dir, info]) => !info?.is_guest && dir !== 'Guest Profile' && dir !== 'System Profile' && !dir.includes('/') && !dir.includes('..'))
      .map(([dir]) => dir)
  } catch {
    return []
  }
}

// Firefox's profile list, from profiles.ini.
function firefoxProfiles(root: string): string[] {
  let text: string
  try {
    text = readFileSync(path.join(root, 'profiles.ini'), 'utf8')
  } catch {
    return []
  }
  const out: string[] = []
  let p: { path?: string; relative: boolean } | null = null
  const end = () => {
    if (p?.path) out.push(p.relative ? p.path : path.resolve(p.path))
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^\[/.test(line)) {
      end()
      p = /^\[Profile\d+\]/i.test(line) ? { relative: true } : null
    } else if (p && /^Path=/i.test(line)) p.path = line.slice(5).trim()
    else if (p && /^IsRelative=0/i.test(line)) p.relative = false
  }
  end()
  return out
}

/** Every verified profile of a supported browser under `home` that has a history file. */
export function historyProfiles(home: string, browsers: readonly HistoryBrowser[] = MAC_HISTORY_BROWSERS): HistoryProfile[] {
  const out: HistoryProfile[] = []
  for (const browser of browsers) {
    const root = path.join(home, 'Library', 'Application Support', ...browser.dir)
    const dirs = browser.family === 'chromium' ? chromiumProfiles(root) : firefoxProfiles(root)
    for (const profile of dirs) {
      const file = path.resolve(root, profile, browser.family === 'chromium' ? 'History' : 'places.sqlite')
      if (existsSync(file)) out.push({ browser, profile, file })
    }
  }
  return out
}

// Chromium times are microseconds since 1601; Firefox's since 1970.
const CHROMIUM_EPOCH_US = 11_644_473_600_000_000n
const CHAIN_END = 0x20000000
// Subframe navigations and searches generated from a keyword are not pages the person opened.
const CHROMIUM_SKIPPED_CORES = new Set([3, 4, 10])
// visit_source: 1 is browsed on this computer; synced, extension and imported visits are other values.
const CHROMIUM_BROWSED = 1
// Embedded resources, downloads and framed links are not page views.
const FIREFOX_SKIPPED_TYPES = new Set([4, 7, 8])
// moz_historyvisits.source: synced from another device.
const FIREFOX_SYNCED = 4
// A visit reached by a permanent or temporary redirect; the visit it came from was a hop, not a page.
const FIREFOX_REDIRECTED = '5, 6'
const BATCH = 2000

function columns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name))
}

/** Visits after `afterId` dated `fromWallMs` or later, oldest first, and the id to continue from. */
export function readVisits(db: Database.Database, family: Family, afterId: number, fromWallMs: number): { visits: Visit[]; lastId: number } {
  const visits: Visit[] = []
  let lastId = afterId
  if (family === 'chromium') {
    const v = columns(db, 'visits')
    const source = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'visit_source'`).get() !== undefined
    const rows = db
      .prepare(
        `SELECT v.id, v.visit_time AS t, v.transition AS tr, u.url, u.title, u.hidden,
           ${v.has('originator_cache_guid') ? 'v.originator_cache_guid' : "''"} AS origin, ${source ? 's.source' : 'NULL'} AS source
         FROM visits v JOIN urls u ON u.id = v.url ${source ? 'LEFT JOIN visit_source s ON s.id = v.id' : ''}
         WHERE v.id > ? AND v.visit_time >= ? ORDER BY v.id LIMIT ${BATCH}`,
      )
      .safeIntegers(true)
      .all(BigInt(afterId), BigInt(fromWallMs) * 1000n + CHROMIUM_EPOCH_US) as { id: bigint; t: bigint; tr: bigint; url: string; title: string | null; hidden: bigint; origin: string | null; source: bigint | null }[]
    for (const r of rows) {
      lastId = Number(r.id)
      const tr = Number(BigInt.asIntN(32, r.tr))
      if ((tr & CHAIN_END) === 0 || CHROMIUM_SKIPPED_CORES.has(tr & 0xff)) continue
      if (r.hidden !== 0n || (r.origin ?? '') !== '' || (r.source !== null && Number(r.source) !== CHROMIUM_BROWSED)) continue
      visits.push({ id: lastId, wall_ms: Number((r.t - CHROMIUM_EPOCH_US) / 1000n), url: r.url, title: r.title })
    }
    return { visits, lastId }
  }
  const synced = columns(db, 'moz_historyvisits').has('source')
  const rows = db
    .prepare(
      `SELECT v.id, v.visit_date AS t, v.visit_type AS type, ${synced ? 'v.source' : 'NULL'} AS source, p.url, p.title, p.hidden
       FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id WHERE v.id > ? AND v.visit_date >= ?
         AND NOT EXISTS (SELECT 1 FROM moz_historyvisits r WHERE r.from_visit = v.id AND r.visit_type IN (${FIREFOX_REDIRECTED})) ORDER BY v.id LIMIT ${BATCH}`,
    )
    .all(afterId, fromWallMs * 1000) as { id: number; t: number; type: number; source: number | null; url: string; title: string | null; hidden: number }[]
  for (const r of rows) {
    lastId = r.id
    if (FIREFOX_SKIPPED_TYPES.has(r.type) || r.source === FIREFOX_SYNCED || r.hidden !== 0) continue
    visits.push({ id: r.id, wall_ms: Math.floor(r.t / 1000), url: r.url, title: r.title })
  }
  return { visits, lastId }
}

function stamp(file: string): string {
  try {
    const s = statSync(file)
    return `${s.size}:${s.mtimeMs}`
  } catch {
    return '-'
  }
}

const SIDE_FILES = ['', '-wal', '-journal']

/**
 * Copies a history file and its log while the browser runs: browsers hold their history locked, so it cannot be read
 * in place. A copy taken while the browser wrote is taken again. Returns the copy, which the caller removes.
 */
export async function snapshot(file: string, dir: string, attempts = 3): Promise<string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const copy = path.join(dir, 'history.sqlite')
  for (let i = 0; i < attempts; i++) {
    removeSnapshot(dir)
    const before = SIDE_FILES.map((s) => stamp(file + s))
    for (const s of SIDE_FILES) {
      if (existsSync(file + s)) await copyFile(file + s, copy + s, constants.COPYFILE_FICLONE)
    }
    if (SIDE_FILES.every((s, j) => stamp(file + s) === before[j])) return copy
  }
  removeSnapshot(dir)
  throw Object.assign(new Error('history kept changing while it was copied'), { code: 'HISTORY_CHANGING' })
}

/**
 * Where a data folder's history copies go: the user's own temporary folder (private, and excluded from backups on
 * macOS), not the data folder. A copy left by a crash is removed when the reader next starts.
 */
export function historyCopyDir(dataDir: string): string {
  return path.join(os.tmpdir(), `daylens-history-${createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 16)}`)
}

export function removeSnapshot(dir: string): void {
  if (!existsSync(dir)) return
  for (const f of readdirSync(dir)) rmSync(path.join(dir, f), { force: true })
}

export interface VisitSink {
  insertObservation(row: ObservationRow): number
  // Whether nothing forbidden (a pause, a deletion, for a visit an exclusion) covers this row's app or site between two times.
  acceptExtension(row: ObservationRow, fromWallMs: number, toWallMs: number): boolean
  meta(key: string): string | null
  setMeta(key: string, value: string | null): void
}

export interface BrowserReadState {
  name: string
  app_id: string
  // ok: every profile was read; unreadable: at least one could not be.
  state: 'ok' | 'unreadable'
}

interface Cursor {
  id: number
  // Visits before this are not read: the start of the day history was first read, or when a profile was found later.
  from: number
}

export interface HistoryReaderOptions {
  home: string
  copyDir: string
  intervalMs: number
  now?: () => number
  log?: (msg: string) => void
  browsers?: readonly HistoryBrowser[]
}

export const FROM_KEY = 'history_from_wall_ms'
export const STATUS_KEY = 'history_browsers'
const cursorKey = (run: string) => `history_cursor:${run}`

export function localDayStart(wallMs: number): number {
  const d = new Date(wallMs)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function historyRun(p: HistoryProfile): string {
  return `history:${p.browser.app_id}:${p.profile}`
}

export class HistoryReader {
  private readonly sink: VisitSink
  private readonly o: HistoryReaderOptions
  private readonly now: () => number
  private readonly log: (msg: string) => void
  private readonly cursors = new Map<string, Cursor>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null
  private stopped = false
  private status = ''

  constructor(sink: VisitSink, o: HistoryReaderOptions) {
    this.sink = sink
    this.o = o
    this.now = o.now ?? Date.now
    this.log = o.log ?? (() => {})
  }

  start(): void {
    removeSnapshot(this.o.copyDir)
    const tick = () => {
      this.running = this.readAll().finally(() => {
        this.running = null
        if (!this.stopped) this.timer = setTimeout(tick, this.o.intervalMs)
      })
    }
    tick()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    await this.running
    removeSnapshot(this.o.copyDir)
  }

  // Readers start at the beginning of the day history is first read; a profile found on a later day starts when found.
  private cursor(run: string): Cursor {
    let c = this.cursors.get(run)
    if (c) return c
    const stored = this.sink.meta(cursorKey(run))
    if (stored) c = JSON.parse(stored) as Cursor
    else {
      const now = this.now()
      let from = Number(this.sink.meta(FROM_KEY))
      if (!(from > 0)) {
        from = localDayStart(now)
        this.sink.setMeta(FROM_KEY, String(from))
      }
      c = { id: 0, from: localDayStart(now) === from ? from : now }
      this.sink.setMeta(cursorKey(run), JSON.stringify(c))
    }
    this.cursors.set(run, c)
    return c
  }

  async readAll(): Promise<void> {
    const states = new Map<string, BrowserReadState>()
    for (const p of historyProfiles(this.o.home, this.o.browsers)) {
      if (this.stopped) return
      const s = states.get(p.browser.app_id) ?? { name: p.browser.name, app_id: p.browser.app_id, state: 'ok' }
      states.set(p.browser.app_id, s)
      try {
        await this.readProfile(p)
      } catch (err) {
        s.state = 'unreadable'
        this.log(`history read failed browser=${p.browser.app_id} code=${(err as { code?: unknown })?.code ?? 'unknown'}`)
      } finally {
        removeSnapshot(this.o.copyDir)
      }
    }
    const status = JSON.stringify([...states.values()])
    if (status !== this.status) {
      this.status = status
      this.sink.setMeta(STATUS_KEY, status)
    }
  }

  private async readProfile(p: HistoryProfile): Promise<void> {
    const run = historyRun(p)
    const c = this.cursor(run)
    const copy = await snapshot(p.file, this.o.copyDir)
    const db = new Database(copy)
    try {
      db.pragma('query_only = 1')
      for (;;) {
        const r = readVisits(db, p.browser.family, c.id, c.from)
        for (const v of r.visits) this.insert(p, run, v)
        if (r.lastId === c.id) break
        c.id = r.lastId
        this.sink.setMeta(cursorKey(run), JSON.stringify(c))
      }
    } finally {
      db.close()
    }
  }

  private insert(p: HistoryProfile, run: string, v: Visit): void {
    const url = cleanAddress(v.url)
    if (url === null) return
    const title = v.title === null ? null : cleanTitle(v.title).title
    const row: ObservationRow = {
      run,
      seq: v.id,
      boot: 'history',
      platform: process.platform,
      source: 'browser_history',
      kind: 'visit',
      event_wall_ms: v.wall_ms,
      event_mono_us: 0,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      tz_offset_min: -new Date(v.wall_ms).getTimezoneOffset(),
      app_id: p.browser.app_id,
      app_name: p.browser.name,
      app_path: null,
      pid: null,
      window: null,
      title,
      title_raw: null,
      title_state: title === null ? 'empty' : 'ok',
      state: null,
      detail: null,
      url,
    }
    // A browser keeps one title per address, rewritten by later visits and title changes up to this read; it is kept
    // only if nothing forbidden covers that span.
    if (title !== null && !this.sink.acceptExtension(row, v.wall_ms, Math.max(v.wall_ms, this.now()))) {
      row.title = null
      row.title_state = 'empty'
    }
    this.sink.insertObservation(row)
  }
}
