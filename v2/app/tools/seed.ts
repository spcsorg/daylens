// Fills a data folder with invented days through the engine's own normalizer and storage, so the interface can be
// shown, measured and recorded without anyone's real record. Times are relative to now; today runs to the current
// minute, and the database's own clock stands still at now, so a world seeded as of one moment is the same database
// every time. Three worlds, in app/tools/worlds.ts:
//   pricing (the default): about three weeks of the launch film's spring pricing memo, every past hour already written,
//   so nothing calls an AI. `npm run demo` starts the app on it.
//   bakery: the evaluations' world, the same day twice, 8 AM to 6 PM, nothing written. Their questions are graded on it.
//   heavy: the speed budgets' world, 90 days of a heavy user in Phoenix time, every finished hour written.
// Usage: node app/tools/seed.ts --data-dir <dir> [--world pricing|bakery|heavy] [--now <ISO time>]
//   [--days N]: how many days, today the last (pricing 24, bakery 2, heavy 90)
//   bakery only: [--switch-s 45] [--history]
//   --switch-s: a busier day, a new window title that often
//   --now: seed as of that moment, so an evaluation always sees the same day
//   --history: today also has a page read at 1 AM and an early morning known only from browser history, while Daylens
//   wasn't running
import { existsSync, mkdirSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { Normalizer, Privacy } from '../../capture/normalize.ts'
import type { Kind, Line, LineOf, ObsByKind } from '../../capture/protocol.ts'
import { Store } from '../../capture/store.ts'
import { buildPacket } from '../../engine/packet.ts'
import { PACKET } from '../../engine/hourWriter.ts'
import { Storage } from '../../storage/index.ts'
import { AgentStore } from '../../capture/agents/store.ts'
import type { AgentRecord } from '../../capture/agents/types.ts'
import { bakery, heavy, PAGES, pricing, type WorldDay } from './worlds.ts'

const { values } = parseArgs({
  options: { 'data-dir': { type: 'string' }, world: { type: 'string', default: 'pricing' }, days: { type: 'string' }, 'switch-s': { type: 'string' }, now: { type: 'string' }, history: { type: 'boolean', default: false } },
})
const dir = values['data-dir']
if (!dir || !['pricing', 'bakery', 'heavy'].includes(values.world)) {
  process.stderr.write('usage: seed.ts --data-dir <dir> [--world pricing|bakery|heavy]\n')
  process.exit(64)
}
// The same days and hours on every machine; the bench runs the app in the same timezone.
if (values.world === 'heavy') process.env.TZ = 'America/Phoenix'
if (existsSync(`${dir}/daylens-v2.sqlite`)) {
  process.stderr.write('refusing to seed a folder that already has a database\n')
  process.exit(1)
}
mkdirSync(dir, { recursive: true })

const MIN = 60_000
const HOUR = 60 * MIN
const tzOffset = -new Date().getTimezoneOffset()
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
let seq = 0
// One capture run per day seeded: the engine counts time as recorded only inside a run.
let run = 'run-seed'
function line<K extends Kind>(kind: K, obs: ObsByKind[K], wallMs: number): Line {
  return {
    v: 1,
    run,
    seq: seq++,
    boot: 'boot-seed',
    t: { wall_ms: wallMs, mono_us: wallMs * 1000, tz: 'Example/Town', tz_offset_min: tzOffset },
    platform: 'macos',
    source: 'seed',
    kind,
    obs,
  } as Line
}

const now = values.now !== undefined ? Date.parse(values.now) : Date.now()
if (!Number.isFinite(now)) throw new Error('--now must be a time')
const clock = () => now
const store = new Store(dir, { now: clock })
const storage = new Storage(store, dir, { deletionStallMs: Infinity, now: clock })
const agents = Object.assign(new AgentStore(store.database, clock), storage.agentPolicy())
const normalizer = new Normalizer(store, new Privacy(store.exclusions()))
storage.attachCapture({ interrupt: () => normalizer.interrupt({ wall_ms: Date.now(), mono_us: null, boot: null }), setPrivacy: (p) => normalizer.setPrivacy(p) })
const switchMs = values['switch-s'] ? Number(values['switch-s']) * 1000 : null

// Daylens wasn't running from `from` to `to`: what the browser's history holds there shows as history only.
function notRunning(from: number, to: number): void {
  if (to > from) store.writeGapNow({ reason: 'service_down', scope: 'all', run: null, start: { wall_ms: from, mono_us: null, boot: null }, detail: { clean_stop: true } }, { wall_ms: to, mono_us: null, boot: null })
}

function page(t: number, title: string, source: 'browser_ext' | 'browser_history'): void {
  const ext = source === 'browser_ext'
  store.insertObservation({
    run: ext ? 'run-seed-ext' : 'history-seed', seq: seq++, boot: ext ? 'boot-seed' : 'history', platform: 'macos', source, kind: ext ? 'page' : 'visit', event_wall_ms: t, event_mono_us: ext ? t * 1000 : 0,
    tz: 'Example/Town', tz_offset_min: tzOffset, app_id: 'com.google.Chrome', app_name: 'Google Chrome', app_path: ext ? '/Applications/Google Chrome.app' : null, pid: ext ? 100 : null,
    window: ext ? 'ext:1' : null, title, title_raw: null, title_state: 'ok', state: ext ? 'normal' : null, detail: null, url: PAGES[title]!,
  })
}

function seedDay(dayStart: number, until: number, day: WorldDay): void {
  const ran = day.filter((h) => !('history' in h && h.history) && dayStart + h.hour * HOUR < until)
  const from = dayStart + (ran[0]?.hour ?? 24) * HOUR
  const to = Math.min(until, dayStart + (ran.length ? ran.at(-1)!.hour + 1 : 24) * HOUR)
  if (ran.length) store.startRun(line('hello', { awake_us: 0, helper: 'seed', boot_identity: 'kernel', version: '1', pid: 1, os: 'seed', permissions: { accessibility: 'granted' }, config: { heartbeat_s: 15, idle_threshold_s: 120, reconcile_s: 60 } }, from) as LineOf<'hello'>)
  // The lid opens: after last night's sleep, nothing is recorded until the computer is known to be in use again.
  if (ran.length) normalizer.handle(line('power', { state: 'resume_user' }, from))
  const history = day.filter((h) => 'history' in h && h.history)
  if (history.some((h) => h.hour * HOUR < from - dayStart)) notRunning(dayStart, Math.min(from, until))
  if (ran.length && history.some((h) => dayStart + h.hour * HOUR >= to)) notRunning(to, Math.min(dayStart + 24 * HOUR, until))
  for (const h of day) {
    const hourStart = dayStart + h.hour * HOUR
    if (hourStart >= until) break
    if ('away' in h) {
      normalizer.handle(line('power', { state: 'sleep' }, hourStart))
      normalizer.handle(line('power', { state: 'resume_user' }, hourStart + HOUR - 1000))
      continue
    }
    for (const [i, [m, a, title]] of h.segs.entries()) {
      const t = hourStart + m * MIN
      if (t >= until) break
      if (h.history) {
        page(t, title, 'browser_history')
        continue
      }
      normalizer.handle(line('focus', { trigger: 'app_changed', app: a, window: { window: `w${h.hour}${i}`, title, title_state: 'ok' } }, t))
      if (PAGES[title]) page(t, title, 'browser_ext')
      const next = h.segs[i + 1]?.[0] ?? 60
      const step = switchMs ?? 60_000
      for (let s = t + step, n = 1; s < Math.min(hourStart + next * MIN, until); s += step, n++) {
        const shown = switchMs ? `${title} (${n})` : title
        normalizer.handle(line('focus', { trigger: switchMs ? 'title_changed' : 'reconcile', app: a, window: { window: `w${h.hour}${i}`, title: shown, title_state: 'ok' } }, s))
      }
    }
  }
  if (ran.length) store.recordHeartbeat(line('heartbeat', { awake_us: 0, permissions: { accessibility: 'granted' }, registrations: { focus: true, session: true, power: true }, titles: 'ok', stall_ms: 0, dropped: 0 }, to))
  // The lid closes at the end of the day; without it the last window runs on past the hour for a moment.
  if (ran.length && to < until) normalizer.handle(line('power', { state: 'sleep' }, to))
}

// An agent session's turns, each opened by a prompt; a turn still going at `until` has no end yet.
function agentTurns(hourStart: number, until: number, h: WorldDay[number]): void {
  if ('away' in h || !h.agent) return
  const { agent, session, dir, turns } = h.agent
  const at = (m: number) => hourStart + m * MIN
  if (at(turns[0]![0]) >= until) return
  const records: AgentRecord[] = [{ t: 'session', session, origin: 'interactive', parent: null, client: 'cli', dir, branch: 'main', at: at(turns[0]![0]) }]
  for (const [i, [start, end]] of turns.entries()) {
    if (at(start) >= until) break
    const key = `${session}:${i}`
    records.push({ t: 'turn', key, session, dir, branch: 'main', opener: 'user', start: at(start), replayed: false }, { t: 'user', key: `${key}:u`, session, turn: key, act: 'prompt', basis: 'marked', at: at(start) })
    for (let m = start + 1; m < end && at(m) < until; m++) records.push({ t: 'activity', key, session, at: at(m) })
    if (at(end) <= until) records.push({ t: 'end', key, state: 'completed', at: at(end) })
  }
  agents.apply(agent, records)
}

const today = new Date(now)
const count = Number(values.days ?? (values.world === 'heavy' ? 90 : values.world === 'bakery' ? 2 : 24))
const starts = Array.from({ length: count }, (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - (count - 1 - i)))
const world = values.world === 'bakery' ? bakery(count, values.history) : values.world === 'heavy' ? heavy(count) : pricing(starts.map((d) => d.getDay()))
for (const [i, d] of starts.entries()) {
  run = `run-seed-${count - 1 - i}`
  const until = i === count - 1 ? now : d.getTime() + 24 * HOUR
  seedDay(d.getTime(), until, world[i]!)
  for (const h of world[i]!) agentTurns(d.getTime() + h.hour * HOUR, until, h)
}
store.flush(true)
storage.start()
await storage.derivationSettled()

// The hours as the hour writer would have written them, citing what it would have cited; an hour still running isn't
// written yet.
for (const [i, d] of starts.entries()) {
  for (const h of world[i]!) {
    const start = d.getTime() + h.hour * HOUR
    if ('away' in h || !h.written || start + HOUR > now) continue
    const basis = storage.hourBasis(start)
    const { refs } = buildPacket(storage, { start_wall_ms: start, tz, tz_offset_min: -new Date(start).getTimezoneOffset() }, PACKET)
    const observations = Object.values(refs).flatMap((r) => (r.kind === 'observations' ? r.ids : []))
    storage.writeHour({ start_wall_ms: start, tz, status: 'written', ...h.written, outcome: null, suggestion: null, observations, writer: 'seed' }, basis)
  }
}
storage.stop()
store.close()
process.stdout.write(`seeded ${dir}\n`)
