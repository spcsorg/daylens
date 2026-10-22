// Storage at realistic size: a year of a heavy user's capture, written through the real store, derivation and
// search index; then search, deletion, retention and live-write timings, and the size on disk.
// Usage: node tools/storagebench.ts --out <dir> [--days 365] [--switch-s 30]
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import type { ObservationRow } from '../capture/normalize.ts'
import { Store } from '../capture/store.ts'
import { Storage, type DeletionHandle } from '../storage/index.ts'

const { values } = parseArgs({ options: { out: { type: 'string' }, days: { type: 'string', default: '365' }, 'switch-s': { type: 'string', default: '30' } } })
if (!values.out) throw new Error('--out <dir>')
const DAYS = Number(values.days)
const SWITCH_MS = Number(values['switch-s']) * 1000
const dir = path.resolve(values.out)
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

let seed = 0x5eed
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
// Zipf-like: a few items are used all the time, most rarely.
const skewed = <T>(xs: readonly T[]): T => xs[Math.floor(xs.length * rand() ** 3)]!

const WORDS = (
  'billing invoice onboarding funnel pricing roadmap hiring interview contract launch release migration schema storage capture ' +
  'retention privacy security audit review design prototype figma sketch analytics dashboard metrics revenue churn cohort ' +
  'campaign newsletter partner investor deck budget forecast quarterly planning sprint backlog incident outage postmortem ' +
  'kubernetes postgres sqlite electron swift windows macos browser extension mobile android ios tablet keyboard accessibility ' +
  'translation kinyarwanda kigali nairobi lagos berlin travel visa flight hotel dentist insurance tax mortgage school'
).split(' ')
const PROJECTS = Array.from({ length: 40 }, (_, i) => `${pick(WORDS)}-${pick(WORDS)}${i}`)
const EXT = ['ts', 'tsx', 'md', 'json', 'swift', 'cs', 'py', 'sql', 'css', 'yml']
const FILES = Array.from({ length: 3000 }, () => `${pick(WORDS)}${pick(['', 'Service', 'Store', 'View', '.test', 'Utils'])}.${pick(EXT)}`)
const SITES = Array.from({ length: 600 }, (_, i) => `${pick(WORDS)}${i % 7 === 0 ? '-' + pick(WORDS) : ''}.${pick(['com', 'io', 'org', 'dev', 'app', 'co'])}`)
const PEOPLE = Array.from({ length: 300 }, (_, i) => `${pick(['Amani', 'Keza', 'Jordan', 'Sam', 'Noor', 'Ines', 'Kofi', 'Mei', 'Ravi', 'Lena'])} ${String.fromCharCode(65 + (i % 26))}.`)
const sentence = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ')

interface AppDef {
  id: string
  name: string
  share: number
  title: () => { title: string | null; url: string | null; state: string }
}
const APPS: AppDef[] = [
  { id: 'com.todesktop.230313mzl4w4u92', name: 'Cursor', share: 22, title: () => ({ title: `${skewed(FILES)} — ${skewed(PROJECTS)}`, url: null, state: 'ok' }) },
  { id: 'com.google.Chrome', name: 'Google Chrome', share: 26, title: () => {
      const site = skewed(SITES)
      return { title: `${sentence(2 + Math.floor(rand() * 5))} - ${site}`, url: `https://${rand() < 0.3 ? 'www.' : ''}${site}/${pick(WORDS)}/${Math.floor(rand() * 5000)}`, state: 'ok' }
    } },
  { id: 'com.tinyspeck.slackmacgap', name: 'Slack', share: 12, title: () => ({ title: `${pick(['#', '#', 'DM '])}${rand() < 0.5 ? skewed(PEOPLE) : pick(WORDS)} - ${pick(['Acme', 'Andersen'])} - Slack`, url: null, state: 'ok' }) },
  { id: 'com.mitchellh.ghostty', name: 'Ghostty', share: 10, title: () => ({ title: `${pick(['npm test', 'git status', 'vim', 'node', 'ssh'])} ~/Code/${skewed(PROJECTS)}`, url: null, state: 'ok' }) },
  { id: 'com.apple.mail', name: 'Mail', share: 6, title: () => ({ title: `${sentence(3 + Math.floor(rand() * 6))} — ${skewed(PEOPLE)}`, url: null, state: 'ok' }) },
  { id: 'notion.id', name: 'Notion', share: 6, title: () => ({ title: `${sentence(2 + Math.floor(rand() * 3))}`, url: null, state: 'ok' }) },
  { id: 'com.figma.Desktop', name: 'Figma', share: 5, title: () => ({ title: `${skewed(PROJECTS)} – ${pick(['Flows', 'Screens', 'Components', 'Explorations'])}`, url: null, state: 'ok' }) },
  { id: 'com.apple.finder', name: 'Finder', share: 4, title: () => ({ title: pick(['Downloads', 'Desktop', 'Documents', skewed(PROJECTS)]), url: null, state: 'ok' }) },
  { id: 'com.anthropic.claudefordesktop', name: 'Claude', share: 5, title: () => ({ title: `${sentence(3)} - Claude`, url: null, state: 'ok' }) },
  { id: 'com.apple.Safari', name: 'Safari', share: 4, title: () => ({ title: null, url: null, state: 'withheld_browser' }) },
]
const SHARE_TOTAL = APPS.reduce((s, a) => s + a.share, 0)
function pickApp(): AppDef {
  let x = rand() * SHARE_TOTAL
  for (const a of APPS) if ((x -= a.share) < 0) return a
  return APPS[0]!
}

const OFFSET_MIN = 120
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const END = Date.UTC(2026, 9, 17) - OFFSET_MIN * 60_000 // local midnight
const START = END - DAYS * DAY_MS
const clock = { t: START }
const now = () => clock.t

const store = new Store(dir, { now })
store.close()
const store2 = new Store(dir, { now })
const ins = store2.database.prepare('UPDATE observations SET url = ? WHERE id = ?')
const storage = new Storage(store2, dir, { deletionStallMs: Infinity, now })
const pendingUrls: [string, number][] = []
const prevFlushed = store2.onFlushed
store2.onFlushed = (ids) => {
  // Capture writes addresses on the browser branch; here they are set before derivation reads them.
  if (pendingUrls.length) store2.database.transaction(() => { for (const [u, id] of pendingUrls.splice(0)) ins.run(u, id) })()
  prevFlushed(ids)
}

function row(kind: ObservationRow['kind'], t: number, extra: Partial<ObservationRow>): ObservationRow {
  return {
    run: 'bench', seq: 0, boot: 'b', platform: 'macos', source: 'bench', kind, event_wall_ms: t, event_mono_us: t * 1000, tz: 'Africa/Kigali', tz_offset_min: OFFSET_MIN,
    app_id: null, app_name: null, app_path: null, pid: null, window: null, title: null, title_raw: null, title_state: null, state: null, detail: null, ...extra,
  }
}

const flushTimes: number[] = []
const realFlush = store2.flush.bind(store2)
store2.flush = () => {
  const t = performance.now()
  const ok = realFlush()
  flushTimes.push(performance.now() - t)
  return ok
}

const t0 = performance.now()
let focusRows = 0
let ops = 0
for (let d = 0; d < DAYS; d++) {
  const dayStart = START + d * DAY_MS
  const weekend = new Date(dayStart + OFFSET_MIN * 60_000).getUTCDay() % 6 === 0
  const activeHours = weekend ? 4 : 10
  let t = dayStart + 9 * HOUR_MS
  const stop = t + activeHours * HOUR_MS
  store2.insertObservation(row('session', t, { state: 'unlocked' }))
  store2.insertObservation(row('input', t, { state: 'active' }))
  while (t < stop) {
    const a = pickApp()
    const ti = a.title()
    clock.t = t
    const id = store2.insertObservation(row('focus', t, { app_id: a.id, app_name: a.name, pid: 100, window: 'w', title: ti.title, title_state: ti.state as ObservationRow['title_state'], state: 'ok', detail: '{"trigger":"title_changed"}' }))
    if (ti.url) pendingUrls.push([ti.url, id])
    focusRows++
    const dwell = Math.max(3000, Math.round(-Math.log(1 - rand()) * SWITCH_MS))
    for (let s = 60_000; s < dwell; s += 60_000) {
      store2.extendObservation(id, t + s)
      ops++
    }
    t += dwell
    ops++
    if (rand() < 0.01) {
      store2.insertObservation(row('input', t, { state: 'idle' }))
      t += Math.round(rand() * 20 * 60_000)
      store2.insertObservation(row('input', t, { state: 'active' }))
    }
  }
  store2.insertObservation(row('session', stop, { state: 'locked' }))
  store2.flush()
  clock.t = stop
  for (let h = 0; h < activeHours; h++) {
    storage.writeHour({
      start_wall_ms: dayStart + (9 + h) * HOUR_MS, tz: 'Africa/Kigali', status: 'written', writer: 'bench',
      title: sentence(5), summary: sentence(30), detail: sentence(60), outcome: sentence(10), suggestion: rand() < 0.3 ? sentence(12) : null,
      sources: [{ app_id: pick(APPS).id }, { app_id: pick(APPS).id }, { site: skewed(SITES) }],
    }, storage.hourBasis(dayStart + (9 + h) * HOUR_MS))
    storage.recordUsage({ kind: 'hour', provider: 'anthropic', model: 'bench', input_tokens: 3000, output_tokens: 400, cost_micro_usd: 900 })
  }
  for (let k = 0; k < 4; k++) storage.recordUsage({ kind: 'answer', provider: 'anthropic', model: 'bench', input_tokens: 8000, output_tokens: 600, cost_micro_usd: 2600 })
  if (d % 30 === 29) process.stderr.write(`day ${d + 1}: ${focusRows} focus rows, ${((performance.now() - t0) / 1000).toFixed(0)} s\n`)
}
store2.flush()
const ingestS = (performance.now() - t0) / 1000
const db = store2.database
const count = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n
const rows = { observations: count('observations'), focus_generated: focusRows, intervals: count('intervals'), search_docs: count('search_docs'), hours: count('hours'), usage_ledger: count('usage_ledger') }

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}
const round = (x: number) => Math.round(x * 100) / 100

// Sizes: checkpoint first so the main file holds everything.
db.pragma('wal_checkpoint(TRUNCATE)')
const fileBytes = () => readdirSync(dir).filter((f) => f.startsWith('daylens-v2.sqlite')).reduce((s, f) => s + statSync(path.join(dir, f)).size, 0)
const sizeMb = fileBytes() / 1048576
let byTable: Record<string, number> = {}
try {
  for (const r of db.prepare(`SELECT name, sum(pgsize) AS b FROM dbstat GROUP BY name ORDER BY b DESC`).all() as { name: string; b: number }[]) byTable[r.name] = round(r.b / 1048576)
} catch {
  byTable = { unavailable: 0 }
}

// Search: typical queries, warm, then the same with a date filter.
const common = APPS[0]!.name
const queries: Record<string, string> = {
  common_word: 'billing',
  two_words: 'onboarding funnel',
  prefix_3: 'mig',
  file_name: FILES[0]!,
  site: SITES[1]!,
  person: PEOPLE[3]!.split(' ')[0]!,
  rare_word: 'mortgage dentist',
  app_name_in_title: common,
  no_match: 'zzzqqq',
}
const search: Record<string, { hits: number; p50_ms: number; p95_ms: number; max_ms: number; p50_last_30d_ms: number }> = {}
for (const [k, q] of Object.entries(queries)) {
  const times: number[] = []
  const recent: number[] = []
  let hits = 0
  for (let i = 0; i < 40; i++) {
    let t = performance.now()
    hits = storage.search(q).length
    times.push(performance.now() - t)
    t = performance.now()
    storage.search(q, { fromWallMs: END - 30 * DAY_MS })
    recent.push(performance.now() - t)
  }
  search[k] = { hits, p50_ms: round(pct(times, 50)), p95_ms: round(pct(times, 95)), max_ms: round(Math.max(...times)), p50_last_30d_ms: round(pct(recent, 50)) }
}

// Live writes at a year's size: one second of capture per flush, the way the service runs.
const live: number[] = []
// Live capture happens at the end of the timeline, after the year of history.
let lt = END + HOUR_MS
let liveId = store2.insertObservation(row('focus', lt, { app_id: APPS[0]!.id, app_name: 'Cursor', title: 'live.ts — bench', title_state: 'ok', state: 'ok' }))
store2.flush()
flushTimes.length = 0
for (let i = 0; i < 600; i++) {
  lt += 1000
  clock.t = lt
  if (i % 30 === 0) liveId = store2.insertObservation(row('focus', lt, { app_id: APPS[i % 5]!.id, app_name: 'x', title: `live ${i}.ts — bench`, title_state: 'ok', state: 'ok' }))
  else store2.extendObservation(liveId, lt)
  const t = performance.now()
  store2.flush()
  live.push(performance.now() - t)
}

// Deletion at a year's size: how fast the call responds, how long the worker takes, and the worst stall of this
// (the capture) thread meanwhile.
async function timedDelete(f: () => DeletionHandle) {
  const lags: number[] = []
  let last = performance.now()
  const tick = setInterval(() => {
    const now = performance.now()
    lags.push(now - last - 5)
    last = now
  }, 5)
  const t = performance.now()
  const h = f()
  const respond = performance.now() - t
  const r = await h.done
  const total = performance.now() - t
  await h.purged
  clearInterval(tick)
  return { respond_ms: round(respond), done_ms: round(total), worst_stall_ms: round(Math.max(0, ...lags)), ...r }
}
// Let the ingest's background work settle (a year written in seconds, then 600 back-to-back flushes): measured
// right after that burst, the first deletion's capture-thread stall is that work, not the deletion.
await new Promise((r) => setTimeout(r, 2000))
clock.t = END + HOUR_MS + 700_000
const delLast = await timedDelete(() => storage.deleteLast(10 * 60_000))
clock.t = END + 2 * HOUR_MS
const delSource = await timedDelete(() => storage.deleteSource(APPS[6]!.id))
const delSite = await timedDelete(() => storage.deleteSite(SITES[1]!))
const timed = <T>(f: () => T): [T, number] => {
  const t = performance.now()
  const r = f()
  return [r, round(performance.now() - t)]
}
const [, rebuildMs] = timed(() => storage.derived.rebuild())

// Retention: drop the oldest month in the worker, as scheduled retention does, watching this (the capture) thread.
storage.stop()
const sizeBeforePrune = fileBytes() / 1048576
await storage.setRetentionDays(DAYS - 30)
storage.stop()
const pruneLags: number[] = []
let pruneLast = performance.now()
const pruneTick = setInterval(() => {
  const n = performance.now()
  pruneLags.push(n - pruneLast - 5)
  pruneLast = n
}, 5)
const pruneStart = performance.now()
const pruned = await storage.prune()
const pruneMs = performance.now() - pruneStart
clearInterval(pruneTick)

const result = {
  days: DAYS,
  mean_dwell_s: SWITCH_MS / 1000,
  rows,
  ingest: { seconds: round(ingestS), ops_per_s: Math.round((focusRows + ops) / ingestS) },
  size: { total_mb: round(sizeMb), per_month_mb: round((sizeMb / DAYS) * 30.44), by_table_mb: byTable },
  live_flush_ms: { p50: round(pct(live, 50)), p95: round(pct(live, 95)), p99: round(pct(live, 99)), max: round(Math.max(...live)) },
  search,
  deletion: { last_ten_minutes: delLast, one_app_all_year: delSource, one_site_all_year: delSite },
  rebuild_intervals_and_docs_ms: rebuildMs,
  retention_drop_one_month: {
    batches: pruned.batches,
    removed: pruned.removed,
    max_worker_transaction_ms: round(pruned.maxTransactionMs),
    total_s: round(pruneMs / 1000),
    worst_capture_thread_stall_ms: round(Math.max(0, ...pruneLags)),
    size_before_mb: round(sizeBeforePrune),
  },

}
store2.close()
writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2))
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
