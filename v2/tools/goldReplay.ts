// Replays a frozen gold day into a fresh V2 database the way V2 would have recorded it, then builds its hour packets.
// V1 capture rows become helper protocol lines run through the service normalizer, so V2's own exclusions, title
// rules and merging decide what is kept; browser visits reach storage through the extension's page gate; agent
// sessions are read from the frozen copy of the day's logs; commits and calendar events come from frozen files.
// Usage: node tools/goldReplay.ts --gold <dir> --date <YYYY-MM-DD> --tz <IANA zone> --utc-offset-min <n>
//          --hours <hours, such as 9-17> --extension-browsers <bundle IDs> --stale-title-min <n> --nearby-hours <n>
//          --open-thread-min <n> --out <dir>
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { backfill } from '../capture/agents/backfill.ts'
import { AgentReader, homeRoots } from '../capture/agents/reader.ts'
import { AgentStore } from '../capture/agents/store.ts'
import { BrowserPages } from '../capture/browser.ts'
import { DELETION_STALL_MS } from '../capture/defaults.ts'
import { Privacy } from '../capture/normalize.ts'
import { ServiceNormalizer } from '../capture/pipeline.ts'
import type { AppIdentity, Engine, Kind, Line, ObsByKind } from '../capture/protocol.ts'
import { Store } from '../capture/store.ts'
import { buildPacket, type BuiltPacket, type PacketOptions } from '../engine/packet.ts'
import type { CalendarEvent, CalendarSource, Commit, CommitSource } from '../engine/sources.ts'
import { HOUR_MS } from '../storage/derive.ts'
import { Storage } from '../storage/index.ts'

export interface GoldDay {
  goldDir: string
  date: string
  tz: string
  utcOffsetMin: number
  hours: number[]
  // Browsers the Daylens extension runs in; only their visits become pages.
  extensionBrowsers: string[]
  packet: PacketOptions
  dataDir?: string
}

interface V1Event {
  id: number
  ts_ms: number
  event_type: string
  source: string
  app_bundle_id: string | null
  app_name: string | null
  pid: number | null
  window_title: string | null
}

interface V1Visit {
  id: number
  visit_time: number
  url: string | null
  page_title: string | null
  browser_bundle_id: string | null
}

interface Identity {
  app_id: string
  path: string | null
  engine: Engine
  signer: string | null
  registered_browser: boolean
}

// The helper's reconcile period: a window still in front is sighted again this often.
const SIGHTING_MS = 60_000
const IDLE_THRESHOLD_S = 120
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop'
const INVISIBLE = /[‎‏‪-‬⁨⁩]/g

function jsonl<T>(file: string): T[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T)
}

/** Every frozen file must match its recorded hash before anything is built from it. */
export function verifyManifest(dir: string): void {
  const manifest = JSON.parse(readFileSync(path.join(dir, 'MANIFEST.sha256.json'), 'utf8')) as Record<string, string>
  const bad = Object.entries(manifest).filter(([f, h]) => createHash('sha256').update(readFileSync(path.join(dir, f))).digest('hex') !== h)
  if (bad.length) throw new Error(`frozen files changed: ${bad.map(([f]) => f).join(', ')}`)
}

export async function replayGoldDay(day: GoldDay): Promise<{ storage: Storage; store: Store; packets: Map<number, BuiltPacket>; close: () => void }> {
  const raw = path.join(day.goldDir, 'raw')
  verifyManifest(raw)
  const offsetMs = day.utcOffsetMin * 60_000
  const dayStart = Date.parse(`${day.date}T00:00:00Z`) - offsetMs
  const dataDir = day.dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'daylens-gold-'))
  const now = () => dayStart + 48 * HOUR_MS
  const store = new Store(dataDir, { now })
  const storage = new Storage(store, dataDir, { deletionStallMs: DELETION_STALL_MS, now })
  const identities = JSON.parse(readFileSync(path.join(day.goldDir, 'raw', 'app-identities.json'), 'utf8')) as Record<string, Identity>

  let seq = 0
  let run = 'gold-1'
  const mk = <K extends Kind>(kind: K, obs: ObsByKind[K], wallMs: number, source = 'gold'): Line =>
    ({ v: 1, run, seq: seq++, boot: 'gold', t: { wall_ms: wallMs, mono_us: wallMs * 1000, tz: day.tz, tz_offset_min: day.utcOffsetMin }, platform: 'macos', source, kind, obs }) as Line

  let extSeq = 0
  const replies: number[] = []
  const pages = new BrowserPages(store, new Privacy(store.exclusions()), { now })
  const conn = pages.connect({ send: (msg) => void (msg.epoch !== null && replies.push(msg.epoch)) })
  const normalizer = new ServiceNormalizer(store, new Privacy(store.exclusions()), pages)
  storage.attachCapture({ interrupt: () => {}, setPrivacy: (p) => normalizer.setPrivacy(p) })

  const appOf = (e: V1Event): AppIdentity => {
    const id = e.app_bundle_id ? identities[e.app_bundle_id] : undefined
    const name = e.app_name?.replace(INVISIBLE, '').trim() ?? null
    if (!e.app_bundle_id) return { app_id: null, name, path: null, pid: e.pid, registered_browser: false, engine: 'unknown', signer: null, version_info: null, identity_state: 'unresolved', store: null }
    return {
      app_id: e.app_bundle_id,
      name,
      path: id?.path ?? null,
      pid: e.pid,
      registered_browser: id?.registered_browser ?? false,
      engine: id?.engine ?? 'unknown',
      signer: id?.signer ?? null,
      version_info: null,
      identity_state: 'ok',
      store: null,
    }
  }

  const visits = jsonl<V1Visit>(path.join(raw, 'v1-website_visits.jsonl')).filter((v) => v.url && v.browser_bundle_id !== null && day.extensionBrowsers.includes(v.browser_bundle_id))
  const seenVisit = new Set<string>()
  const pageAt = (t: number, bundle: string): V1Visit | null => {
    let last: V1Visit | null = null
    for (const v of visits) if (v.browser_bundle_id === bundle && v.visit_time <= t) last = v
    return last
  }
  let front: { app: AppIdentity; title: string | null; sightedAt: number } | null = null
  // Nothing is sighted while the screen is locked, the machine sleeps, or capture is down or stopped.
  const off = { locked: false, asleep: false, down: false, stopped: false }
  const held = () => off.locked || off.asleep || off.down || off.stopped
  const tab = (v: V1Visit, at: number, trigger: 'updated' | 'snapshot', epoch?: number) => {
    if (!front?.app.app_id || front.app.app_id !== v.browser_bundle_id) return
    const obs: ObsByKind['tab'] = { trigger, state: 'page', reason: null, browser: front.app, extension: EXTENSION_ID, window: '1', tab: '1', url: v.url, title: v.page_title }
    if (epoch !== undefined) obs.epoch = epoch
    pages.onTab(conn, { v: 1, run: 'gold-ext', seq: extSeq++, boot: 'gold', t: { wall_ms: at, mono_us: at * 1000, tz: day.tz, tz_offset_min: day.utcOffsetMin }, platform: 'macos', source: 'browser_ext', kind: 'tab', obs } as never)
  }
  const answerSnapshots = (at: number) => {
    while (replies.length) {
      const epoch = replies.shift()!
      const v = front?.app.app_id ? pageAt(at, front.app.app_id) : null
      if (v) tab(v, at, 'snapshot', epoch)
    }
  }
  const sendFocus = (trigger: ObsByKind['focus']['trigger'], at: number) => {
    if (!front) return
    normalizer.handle(mk('focus', { trigger, app: front.app, window: { window: null, title: front.title, title_state: front.title === null ? 'unavailable' : 'ok' } }, at, trigger === 'reconcile' ? 'reconcile' : 'nsworkspace'))
    front.sightedAt = at
    answerSnapshots(at)
  }
  const sightUntil = (t: number) => {
    while (front && !held() && front.sightedAt + SIGHTING_MS < t) sendFocus('reconcile', front.sightedAt + SIGHTING_MS)
  }
  const hello = (at: number) =>
    store.startRun(mk('hello', { awake_us: at * 1000, helper: 'gold', boot_identity: 'kernel', version: '0', pid: 1, os: 'macos', permissions: { accessibility: 'granted' }, config: { heartbeat_s: 15, idle_threshold_s: IDLE_THRESHOLD_S, reconcile_s: 60 } }, at) as never)

  const events = jsonl<V1Event>(path.join(raw, 'v1-focus_events.jsonl'))
  const FOCUS = new Set(['app_activated', 'window_changed'])
  // V1 logged an app switch before reading the window's title; the V2 helper reads it with the switch.
  const titledNext = new Set<number>()
  for (let k = 0; k < events.length; k++) {
    const e = events[k]!
    if (!FOCUS.has(e.event_type) || e.window_title) continue
    let next: V1Event | undefined
    for (let j = k + 1; j < events.length && !next; j++) {
      const x = events[j]!
      if (FOCUS.has(x.event_type) || x.event_type === 'lock' || x.event_type === 'sleep') next = x
    }
    if (next && FOCUS.has(next.event_type) && next.app_bundle_id === e.app_bundle_id && next.pid === e.pid && next.window_title) titledNext.add(e.id)
  }
  hello(events[0]!.ts_ms)
  let openGap: number | null = null
  let lastSwitch: number | null = null
  let visitIdx = 0
  const point = (at: number) => ({ wall_ms: at, mono_us: at * 1000, boot: 'gold' })
  // The capture normalizer keeps a window's row open across a lock or sleep, so time after the return would never
  // become an interval; the replay starts a fresh row there, as capture is meant to.
  const away = (at: number) => normalizer.interrupt(point(at))
  for (const e of events) {
    for (; visitIdx < visits.length && visits[visitIdx]!.visit_time <= e.ts_ms; visitIdx++) {
      const v = visits[visitIdx]!
      const k = `${v.visit_time}|${v.url}`
      if (seenVisit.has(k)) continue
      seenVisit.add(k)
      sightUntil(v.visit_time)
      if (!held()) tab(v, v.visit_time, 'updated')
    }
    sightUntil(e.ts_ms)
    const at = e.ts_ms
    if (e.event_type === 'app_activated' && e.source === 'nsworkspace_event') lastSwitch = at
    switch (e.event_type) {
      case 'app_activated':
      case 'window_changed': {
        if (titledNext.has(e.id)) break
        const app = appOf(e)
        const title = e.window_title?.replace(INVISIBLE, '').trim() || null
        const same = front && front.app.app_id === app.app_id && front.app.pid === app.pid
        if (same && front!.title === title) {
          if (!held()) sendFocus('reconcile', at)
          break
        }
        front = { app, title, sightedAt: at }
        if (!held()) sendFocus(same ? 'title_changed' : 'app_changed', at)
        break
      }
      case 'lock':
        if (e.source !== 'nsworkspace_event') break
        normalizer.handle(mk('session', { state: 'locked', snapshot: false }, at))
        away(at)
        off.locked = true
        break
      case 'unlock':
        if (e.source !== 'nsworkspace_event') break
        normalizer.handle(mk('session', { state: 'unlocked', snapshot: false }, at))
        off.locked = false
        if (!held()) sendFocus('snapshot', at)
        break
      case 'sleep':
        if (e.source !== 'nsworkspace_event') break
        normalizer.handle(mk('power', { state: 'sleep' }, at))
        away(at)
        off.asleep = true
        break
      case 'wake':
        if (e.source !== 'nsworkspace_event') break
        normalizer.handle(mk('power', { state: 'resume' }, at))
        off.asleep = false
        if (!held()) sendFocus('snapshot', at)
        break
      case 'idle_started':
        normalizer.handle(mk('input', { state: 'idle', last_input_wall_ms: idleLastInput(at, lastSwitch), threshold_s: IDLE_THRESHOLD_S, snapshot: false }, at))
        break
      case 'idle_ended':
        normalizer.handle(mk('input', { state: 'active', last_input_wall_ms: at, threshold_s: IDLE_THRESHOLD_S, snapshot: false }, at))
        break
      case 'capture_failed':
        if (openGap === null) openGap = store.openGap({ reason: 'helper_unavailable', scope: 'all', run, start: point(at), detail: null })
        away(at)
        off.down = true
        break
      case 'capture_recovered':
        if (openGap !== null) store.closeGap(openGap, point(at))
        openGap = null
        off.down = false
        if (!held()) sendFocus('snapshot', at)
        break
      case 'capture_stopped':
        away(at)
        store.endRun(run, at, 'stopped')
        off.stopped = true
        break
      case 'capture_started':
        run = `gold-${Number(run.slice(5)) + 1}`
        seq = 0
        hello(at)
        off.stopped = false
        if (!held()) sendFocus('snapshot', at)
        break
    }
  }
  if (openGap !== null) throw new Error('a capture gap in the frozen rows never closed')
  store.flush(true)

  const agents = new AgentStore(store.database)
  const reader = new AgentReader(agents, homeRoots(path.join(raw, 'agent-home'), {}), {
    reconcileMs: 3_600_000,
    backfill: async (roots) => (await backfill(store.database, dataDir, roots, () => {})).merged,
  })
  await reader.start()
  await reader.settle()
  await reader.stop()

  storage.start()
  await storage.derivationSettled()

  const commitRows = JSON.parse(readFileSync(path.join(raw, 'commits.json'), 'utf8')) as { id: string; time: string; repos: string[]; subject: string; stat: string | null }[]
  const clockMs = (hhmmss: string) => {
    const [h, m, s] = hhmmss.split(':').map(Number)
    return dayStart + ((h! * 60 + m!) * 60 + (s ?? 0)) * 1000
  }
  const allCommits: Commit[] = commitRows.map((c) => ({ hash: c.id.replace(/^git:/, ''), at_wall_ms: clockMs(c.time), repos: c.repos, subject: c.subject, stat: c.stat }))
  const commits: CommitSource = { commits: (from, to) => allCommits.filter((c) => c.at_wall_ms >= from && c.at_wall_ms < to) }
  const allEvents: CalendarEvent[] = []
  for (const row of jsonl<{ id: number; payload_json: string }>(path.join(raw, 'v1-calendar.jsonl'))) {
    const evs = (JSON.parse(row.payload_json) as { events: { title: string; startClock: string; durationMinutes: number; attendeeCount: number | null }[] }).events
    evs.forEach((ev, i) => {
      const m = /^(\d+)(?::(\d+))?(am|pm)$/.exec(ev.startClock)
      if (!m) throw new Error(`unreadable calendar time ${ev.startClock}`)
      const start = dayStart + (((Number(m[1]) % 12) + (m[3] === 'pm' ? 12 : 0)) * 60 + Number(m[2] ?? 0)) * 60_000
      allEvents.push({ id: `cal:${row.id}#${i}`, title: ev.title, start_wall_ms: start, end_wall_ms: start + ev.durationMinutes * 60_000, attendees: ev.attendeeCount })
    })
  }
  const calendar: CalendarSource = { events: (from, to) => allEvents.filter((e) => e.end_wall_ms > from && e.start_wall_ms < to) }

  const packets = new Map<number, BuiltPacket>()
  for (const h of day.hours) packets.set(h, buildPacket(storage, { start_wall_ms: dayStart + h * HOUR_MS, tz: day.tz, tz_offset_min: day.utcOffsetMin }, day.packet, { commits, calendar }))
  return {
    storage,
    store,
    packets,
    close: () => {
      storage.stop()
      store.close()
    },
  }
}

/**
 * When the person last gave input before V1 noticed idle. V1 kept no input times: idle was noticed a threshold after
 * the last input, but an app switch recorded later than that is input too, so away cannot start before it.
 */
export function idleLastInput(noticeMs: number, lastSwitchMs: number | null): number {
  return Math.min(noticeMs, Math.max(noticeMs - IDLE_THRESHOLD_S * 1000, lastSwitchMs ?? -Infinity))
}

export function parseHours(spec: string): number[] {
  return spec.split(',').flatMap((part) => {
    const [a, b] = part.split('-').map(Number)
    return b === undefined ? [a!] : Array.from({ length: b - a! + 1 }, (_, i) => a! + i)
  })
}

export function writePackets(out: string, packets: Map<number, BuiltPacket>): Record<string, string> {
  mkdirSync(path.join(out, 'packets'), { recursive: true })
  mkdirSync(path.join(out, 'refs'), { recursive: true })
  const manifest: Record<string, string> = {}
  for (const [h, b] of packets) {
    const name = `hour_${String(h).padStart(2, '0')}.json`
    for (const [dir, body] of [['packets', JSON.stringify(b.packet)], ['refs', JSON.stringify(b.refs)]] as const) {
      writeFileSync(path.join(out, dir, name), body)
      manifest[`${dir}/${name}`] = createHash('sha256').update(body).digest('hex')
    }
  }
  writeFileSync(path.join(out, 'MANIFEST.sha256.json'), JSON.stringify(manifest, null, 1))
  return manifest
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      gold: { type: 'string' },
      date: { type: 'string' },
      tz: { type: 'string' },
      'utc-offset-min': { type: 'string' },
      hours: { type: 'string' },
      'extension-browsers': { type: 'string' },
      'stale-title-min': { type: 'string' },
      'nearby-hours': { type: 'string' },
      'open-thread-min': { type: 'string' },
      out: { type: 'string' },
    },
  })
  for (const k of ['gold', 'date', 'tz', 'utc-offset-min', 'hours', 'extension-browsers', 'stale-title-min', 'nearby-hours', 'open-thread-min', 'out'] as const) {
    if (values[k] === undefined) throw new Error(`--${k} is required`)
  }
  const r = await replayGoldDay({
    goldDir: values.gold!,
    date: values.date!,
    tz: values.tz!,
    utcOffsetMin: Number(values['utc-offset-min']),
    hours: parseHours(values.hours!),
    extensionBrowsers: values['extension-browsers']!.split(','),
    packet: { staleTitleMs: Number(values['stale-title-min']) * 60_000, nearbyHours: Number(values['nearby-hours']), openThreadMs: Number(values['open-thread-min']) * 60_000 },
  })
  writePackets(values.out!, r.packets)
  for (const [h, b] of r.packets) console.log(`${String(h).padStart(2, '0')}:00 ${JSON.stringify(b.packet).length} bytes, ${b.packet.windows.length} windows, ${b.packet.pages.length} pages, ${b.packet.agents.length} agents, ${b.packet.commits.length} commits`)
  r.close()
}
