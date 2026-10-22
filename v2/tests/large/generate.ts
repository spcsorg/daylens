// A database at the size of more than a year of heavy use (at least LARGE_MIN_MB), written through the real store and
// derivation, with one app whose titles carry a canary. Built once per generator version into the temp folder, since
// it takes minutes; each test works on a cloned copy.
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ObservationRow } from '../../capture/normalize.ts'
import { DB_FILE, Store } from '../../capture/store.ts'
import { Storage } from '../../storage/index.ts'

export const LARGE_MIN_MB = 285
export const CANARY_APP = 'com.example.canary'
export const CANARY = 'Quokkacanary'
const VERSION = 1
const DAYS = 520
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const OFFSET_MIN = 120
// Local midnight at the end of the generated history; live writes in tests start after it.
export const LARGE_END = Date.UTC(2026, 9, 17) - OFFSET_MIN * 60_000

let seed = 0x5eed
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
const skewed = <T>(xs: readonly T[]): T => xs[Math.floor(xs.length * rand() ** 3)]!
const WORDS = 'billing invoice onboarding funnel pricing roadmap hiring contract launch release migration schema storage capture retention privacy security audit review design prototype analytics dashboard revenue campaign partner budget forecast planning sprint incident outage kubernetes postgres sqlite electron swift windows browser extension mobile keyboard translation travel visa flight hotel insurance tax school'.split(' ')
const sentence = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ')
const PROJECTS = Array.from({ length: 40 }, (_, i) => `${pick(WORDS)}-${pick(WORDS)}${i}`)
const FILES = Array.from({ length: 3000 }, () => `${pick(WORDS)}${pick(['', 'Service', 'Store', 'View', '.test'])}.${pick(['ts', 'md', 'swift', 'cs', 'py'])}`)
const SITES = Array.from({ length: 600 }, (_, i) => `${pick(WORDS)}${i}.${pick(['com', 'io', 'org', 'dev'])}`)

const APPS: { id: string; name: string; share: number; title: () => string }[] = [
  { id: 'com.todesktop.230313mzl4w4u92', name: 'Cursor', share: 22, title: () => `${skewed(FILES)} — ${skewed(PROJECTS)}` },
  { id: 'com.google.Chrome', name: 'Google Chrome', share: 26, title: () => `${sentence(2 + Math.floor(rand() * 5))} - ${skewed(SITES)}` },
  { id: 'com.tinyspeck.slackmacgap', name: 'Slack', share: 12, title: () => `#${pick(WORDS)} - Acme - Slack` },
  { id: 'com.mitchellh.ghostty', name: 'Ghostty', share: 10, title: () => `${pick(['npm test', 'git status', 'vim'])} ~/Code/${skewed(PROJECTS)}` },
  { id: 'com.apple.mail', name: 'Mail', share: 6, title: () => sentence(3 + Math.floor(rand() * 6)) },
  { id: 'notion.id', name: 'Notion', share: 6, title: () => sentence(2 + Math.floor(rand() * 3)) },
  { id: 'com.figma.Desktop', name: 'Figma', share: 5, title: () => `${skewed(PROJECTS)} – Screens` },
  { id: CANARY_APP, name: 'Canary', share: 3, title: () => `${CANARY} ${Math.floor(rand() * 1e6)} ${sentence(3)}` },
]
const SHARE_TOTAL = APPS.reduce((s, a) => s + a.share, 0)
function pickApp() {
  let x = rand() * SHARE_TOTAL
  for (const a of APPS) if ((x -= a.share) < 0) return a
  return APPS[0]!
}

function row(t: number, extra: Partial<ObservationRow>): ObservationRow {
  return {
    run: 'large', seq: 0, boot: 'b', platform: 'macos', source: 'large', kind: 'focus', event_wall_ms: t, event_mono_us: t * 1000, tz: 'Africa/Kigali', tz_offset_min: OFFSET_MIN,
    app_id: null, app_name: null, app_path: null, pid: null, window: null, title: null, title_raw: null, title_state: null, state: null, detail: null, ...extra,
  }
}

async function build(dir: string): Promise<void> {
  const clock = { t: LARGE_END - DAYS * DAY_MS }
  const now = () => clock.t
  const store = new Store(dir, { now })
  const storage = new Storage(store, dir, { deletionStallMs: Infinity, now })
  for (let d = 0; d < DAYS; d++) {
    const dayStart = LARGE_END - (DAYS - d) * DAY_MS
    let t = dayStart + 9 * HOUR_MS
    const stop = t + 10 * HOUR_MS
    while (t < stop) {
      const a = pickApp()
      clock.t = t
      const id = store.insertObservation(row(t, { app_id: a.id, app_name: a.name, pid: 100, window: 'w', title: a.title(), title_state: 'ok', state: 'ok' }))
      const dwell = Math.max(3000, Math.round(-Math.log(1 - rand()) * 30_000))
      for (let s = 60_000; s < dwell; s += 60_000) store.extendObservation(id, t + s)
      t += dwell
    }
    store.flush()
    clock.t = stop
  }
  store.flush()
  await storage.derivationSettled()
  storage.stop()
  store.database.pragma('wal_checkpoint(TRUNCATE)')
  store.close()
}

/** A fresh copy of the large database in its own folder. */
export async function largeDatabase(): Promise<string> {
  const cache = path.join(os.tmpdir(), `daylens-v2-large-${VERSION}`)
  if (!existsSync(path.join(cache, DB_FILE))) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'daylens-v2-large-build-'))
    await build(tmp)
    const mb = statSync(path.join(tmp, DB_FILE)).size / 1048576
    if (mb < LARGE_MIN_MB) throw new Error(`generated ${mb.toFixed(0)} MB, under ${LARGE_MIN_MB} MB`)
    rmSync(cache, { recursive: true, force: true })
    renameSync(tmp, cache)
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'daylens-v2-large-'))
  mkdirSync(dir, { recursive: true })
  for (const f of readdirSync(cache)) if (f.startsWith(DB_FILE)) copyFileSync(path.join(cache, f), path.join(dir, f), constants.COPYFILE_FICLONE)
  return dir
}
