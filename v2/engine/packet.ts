// One hour's packet: what the writer reads. Every piece of evidence has a short ID; the map from those IDs to what
// they stand for stays outside the packet, so cited IDs can be checked and stored as the hour's sources.
import path from 'node:path'
import { agentSegments, presenceTimeline, unionMs, type Interval, type PresenceSpan, type WorkSegment } from '../capture/agents/attribution.ts'
import type { EventRow } from '../capture/agents/store.ts'
import { HOUR_MS } from '../storage/derive.ts'
import type { FactInterval, HourField, Storage } from '../storage/index.ts'
import type { CalendarSource, CommitSource } from './sources.ts'

export interface PacketOptions {
  // A title unchanged in its window for this long may no longer describe the work.
  staleTitleMs: number
  // Corrections from this many hours either side of the hour are passed along.
  nearbyHours: number
  // Threads linked to an hour within this long before the hour are passed as open.
  openThreadMs: number
}

export interface PacketHour {
  start_wall_ms: number
  tz: string
  tz_offset_min: number
}

export type Ref =
  | { kind: 'observations'; ids: number[] }
  | { kind: 'agent'; agent: string; session: string }
  | { kind: 'commit'; hash: string }
  | { kind: 'event'; id: string }
  | { kind: 'away' }
  | { kind: 'gap'; ids: number[] }

export interface PacketItem {
  id: string
  app: string | null
  title?: string | null
  // Why there is no title: a browser window with no page, a title not kept or not readable.
  title_note?: string
  site?: string | null
  url?: string | null
  min: number
  away_min?: number
  from: string
  to: string
  times: number
  // The title may not describe what was happening: unchanged for a long time, or no longer readable.
  stale?: string
}

export interface PacketAgent {
  id: string
  agent: string
  project: string | null
  origin?: string
  with_you_min: number
  while_away_min: number
  unknown_min?: number
  waiting_min?: number
  messages: string[]
}

export interface Packet {
  hour: string
  tz: string
  previous_hour?: { title: string | null; summary: string | null }
  open_threads?: string[]
  corrections?: { hour: string; field: HourField; text: string }[]
  away: { id: string; from: string; to: string; why: string }[]
  unknown: { id: string; from: string; to: string; why: string }[]
  windows: PacketItem[]
  pages: PacketItem[]
  agents: PacketAgent[]
  commits: { id: string; at: string; repos: string[]; subject: string; stat?: string; while_away?: string; agents_working?: string[] }[]
  scheduled_events: { id: string; title: string; from: string; to: string; attendees?: number }[]
}

export interface BuiltPacket {
  packet: Packet
  refs: Record<string, Ref>
}

const AGENT_NAMES: Record<string, string> = { claude_code: 'Claude Code', codex: 'Codex' }

const TITLE_NOTES: Record<string, string> = {
  withheld_browser: 'browser window, page not recorded',
  withheld_unknown_app: 'title not recorded',
  unknown: 'title not recorded',
  no_permission: 'title unreadable',
  timeout: 'title unreadable',
  unavailable: 'title unreadable',
  empty: 'no title',
  no_window: 'no window',
}

const GAP_REASONS: Record<string, string> = {
  excluded: 'an excluded app was in front',
  paused: 'recording paused',
  titles_unavailable: 'window titles could not be read',
  events_dropped: 'app changes were lost',
  events_unavailable: 'app changes could not be read',
}

export function buildPacket(storage: Storage, hour: PacketHour, opts: PacketOptions, sources: { commits?: CommitSource; calendar?: CalendarSource } = {}): BuiltPacket {
  for (const [k, v] of Object.entries(opts)) if (!Number.isFinite(v) || v < 0) throw new Error(`packet option ${k} must be set`)
  const start = hour.start_wall_ms
  const end = start + HOUR_MS
  const clock = (ms: number) => new Date(ms + hour.tz_offset_min * 60_000).toISOString().slice(11, 16)
  const refs: Record<string, Ref> = {}
  const facts = storage.hourFacts(start - opts.staleTitleMs, end)
  const presence = presenceTimeline(start, end, facts.presence)
  const awaySpans = presence.filter((p) => p.state === 'away' || p.state === 'asleep')

  const packet: Packet = {
    hour: `${new Date(start + hour.tz_offset_min * 60_000).toISOString().slice(0, 10)} ${clock(start)}-${clock(end)}`,
    tz: hour.tz,
    away: [],
    unknown: [],
    windows: [],
    pages: [],
    agents: [],
    commits: [],
    scheduled_events: [],
  }

  const prev = storage.hourAt(start - HOUR_MS)
  if (prev && (prev.title || prev.summary)) packet.previous_hour = { title: prev.title, summary: prev.summary }

  const threads = new Set<string>()
  for (let t = start - Math.ceil(opts.openThreadMs / HOUR_MS) * HOUR_MS; t < start; t += HOUR_MS) {
    const h = storage.hourAt(t)
    if (h) for (const th of storage.threadsForHour(h.id)) if (th.title) threads.add(th.title)
  }
  if (threads.size) packet.open_threads = [...threads]

  const corrections: NonNullable<Packet['corrections']> = []
  for (let k = -opts.nearbyHours; k <= opts.nearbyHours; k++) {
    const h = storage.hourAt(start + k * HOUR_MS)
    if (!h) continue
    for (const f of h.corrected) corrections.push({ hour: clock(h.start_wall_ms), field: f, text: h[f] ?? '' })
  }
  if (corrections.length) packet.corrections = corrections

  let n = 0
  for (const s of awaySpans) {
    const id = `w${++n}`
    packet.away.push({ id, from: clock(s.start), to: clock(s.end), why: s.state === 'asleep' ? 'asleep' : (s.why ?? 'away') })
    refs[id] = { kind: 'away' }
  }

  n = 0
  const gapSpans: Interval[] = []
  for (const g of facts.gaps) {
    const s = Math.max(g.start_wall_ms, start)
    const e = Math.min(g.end_wall_ms ?? end, end)
    if (e <= s && !(g.start_wall_ms >= start && g.start_wall_ms < end)) continue
    const id = `g${++n}`
    packet.unknown.push({ id, from: clock(s), to: clock(e), why: GAP_REASONS[g.reason] ?? (g.scope === 'titles' ? GAP_REASONS.titles_unavailable! : 'not recording') })
    refs[id] = { kind: 'gap', ids: [g.id] }
    gapSpans.push({ start: s, end: e })
  }
  for (const p of presence) {
    if (p.state !== 'unknown' || unionMs(gapSpans.map((g) => ({ start: Math.max(g.start, p.start), end: Math.min(g.end, p.end) })).filter((g) => g.end > g.start)) >= p.end - p.start) continue
    const id = `g${++n}`
    packet.unknown.push({ id, from: clock(p.start), to: clock(p.end), why: 'not recording' })
    refs[id] = { kind: 'gap', ids: [] }
  }

  const staleness = staleTitles(facts.intervals, start, end, opts.staleTitleMs, clock)
  const items = new Map<string, { item: PacketItem; ids: number[]; spans: Interval[]; first: number; last: number; stale?: string }>()
  for (const i of facts.intervals) {
    const s = Math.max(i.start_wall_ms, start)
    const e = Math.min(i.end_wall_ms, end)
    if (e <= s) continue
    const page = i.kind === 'page'
    const key = JSON.stringify([i.kind, i.app_id ?? i.app_name, page ? i.url : null, i.title, i.title_state])
    let entry = items.get(key)
    if (!entry) {
      const item: PacketItem = { id: '', app: i.app_name, min: 0, from: '', to: '', times: 0 }
      if (i.title) item.title = i.title
      else if (!page || !i.url) item.title_note = page ? 'page not known' : (TITLE_NOTES[i.title_state ?? ''] ?? 'no title')
      // A page's site and title say what was open; its full address only when it has no title.
      if (page) {
        item.site = i.site
        if (!i.title && i.url) item.url = i.url
      }
      entry = { item, ids: [], spans: [], first: s, last: e }
      items.set(key, entry)
    }
    if (!entry.ids.includes(i.obs_id)) entry.ids.push(i.obs_id)
    entry.spans.push({ start: s, end: e })
    entry.first = Math.min(entry.first, s)
    entry.last = Math.max(entry.last, e)
    const stale = staleness.get(i.obs_id)
    if (stale && !entry.stale) entry.stale = stale
  }
  const counters = { windows: 0, pages: 0 }
  for (const [key, e] of [...items.entries()].sort((a, b) => a[1].first - b[1].first)) {
    const page = (JSON.parse(key) as string[])[0] === 'page'
    const id = page ? `p${++counters.pages}` : `i${++counters.windows}`
    const total = unionMs(e.spans)
    const away = unionMs(e.spans.flatMap((sp) => awaySpans.map((a) => ({ start: Math.max(sp.start, a.start), end: Math.min(sp.end, a.end) })).filter((x) => x.end > x.start)))
    Object.assign(e.item, { id, min: minutes(total - away), from: clock(e.first), to: clock(e.last), times: stretches(e.spans) })
    if (away > 0) e.item.away_min = minutes(away)
    if (e.stale) e.item.stale = e.stale
    ;(page ? packet.pages : packet.windows).push(orderItem(e.item))
    refs[id] = { kind: 'observations', ids: e.ids }
  }

  const segments = agentSegments(facts.turns, facts.events, presence)
  const sessions = new Map<string, { agent: string; session: string; project: string | null; origin: string; segs: WorkSegment[]; acts: EventRow[]; first: number }>()
  // A session that moves to another project counts under each project it worked in.
  const workKey = (agent: string, session: string, project: string | null) => `${agent}\u0000${session}\u0000${project ?? ''}`
  const sessionOf = (agent: string, session: string, project: string | null, origin: string, at: number) => {
    const k = workKey(agent, session, project)
    let s = sessions.get(k)
    if (!s) sessions.set(k, (s = { agent, session, project, origin, segs: [], acts: [], first: at }))
    s.first = Math.min(s.first, at)
    return s
  }
  for (const seg of segments) {
    const s = Math.max(seg.start, start)
    const e = Math.min(seg.end, end)
    if (e <= s) continue
    sessionOf(seg.agent, seg.session, seg.project, seg.origin, s).segs.push({ ...seg, start: s, end: e })
  }
  for (const ev of facts.events) {
    if (ev.kind !== 'user' || ev.wall_ms < start || ev.wall_ms >= end) continue
    const own = facts.turns.filter((t) => t.agent === ev.agent && t.session_id === ev.session_id)
    const turn = own.find((t) => ev.turn_key !== null && t.turn_key === ev.turn_key) ?? own.filter((t) => t.start_wall_ms <= ev.wall_ms).at(-1) ?? own[0]
    sessionOf(ev.agent, ev.session_id, turn?.project_dir ?? null, turn?.origin ?? 'interactive', ev.wall_ms).acts.push(ev)
  }
  n = 0
  const agentIds = new Map<string, string>()
  for (const s of [...sessions.values()].sort((a, b) => a.first - b.first)) {
    const id = `a${++n}`
    const working = s.segs.filter((g) => g.activity === 'working')
    const by = (p: (g: WorkSegment) => boolean) => minutes(unionMs(working.filter(p)))
    const a: PacketAgent = {
      id,
      agent: AGENT_NAMES[s.agent] ?? s.agent,
      project: s.project ? path.basename(s.project) : null,
      with_you_min: by((g) => g.presence === 'present'),
      while_away_min: by((g) => g.presence === 'away' || g.presence === 'asleep'),
      messages: s.acts.sort((x, y) => x.wall_ms - y.wall_ms).map((ev) => `${clock(ev.wall_ms)} ${ev.detail}${ev.basis === 'inferred' ? ' (uncertain)' : ''}`),
    }
    if (s.origin !== 'interactive') a.origin = s.origin
    const unknown = by((g) => g.presence === 'unknown')
    if (unknown > 0) a.unknown_min = unknown
    const waiting = minutes(unionMs(s.segs.filter((g) => g.activity === 'waiting')))
    if (waiting > 0) a.waiting_min = waiting
    packet.agents.push(orderAgent(a))
    refs[id] = { kind: 'agent', agent: s.agent, session: s.session }
    agentIds.set(workKey(s.agent, s.session, s.project), id)
  }

  // Commits and calendar events come from outside storage, so they pass its rules here. They belong to no app or site,
  // so a pause or deletion of everything in a span withholds them, and exclusions and per-app rules never match them.
  const admitted = (from: number, to: number) => storage.acceptsSpan(from, to)

  n = 0
  const seenCommits = new Set<string>()
  for (const c of (sources.commits?.commits(start, end) ?? []).sort((a, b) => a.at_wall_ms - b.at_wall_ms)) {
    if (c.at_wall_ms < start || c.at_wall_ms >= end || seenCommits.has(c.hash) || !admitted(c.at_wall_ms, c.at_wall_ms)) continue
    seenCommits.add(c.hash)
    const id = `c${++n}`
    const entry: Packet['commits'][number] = { id, at: clock(c.at_wall_ms), repos: c.repos, subject: c.subject }
    if (c.stat) entry.stat = c.stat
    const away = presenceAt(presence, c.at_wall_ms)
    if (away) entry.while_away = away
    const working = segments.filter((g) => g.activity === 'working' && g.start <= c.at_wall_ms && c.at_wall_ms <= g.end).map((g) => agentIds.get(workKey(g.agent, g.session, g.project)))
    const ids = [...new Set(working.filter((x): x is string => x !== undefined))]
    if (ids.length) entry.agents_working = ids
    packet.commits.push(entry)
    refs[id] = { kind: 'commit', hash: c.hash }
  }

  n = 0
  for (const ev of (sources.calendar?.events(start, end) ?? []).sort((a, b) => a.start_wall_ms - b.start_wall_ms)) {
    if (ev.end_wall_ms <= start || ev.start_wall_ms >= end || !admitted(ev.start_wall_ms, Math.max(ev.start_wall_ms, ev.end_wall_ms - 1))) continue
    const id = `k${++n}`
    const entry: Packet['scheduled_events'][number] = { id, title: ev.title, from: clock(ev.start_wall_ms), to: clock(ev.end_wall_ms) }
    if (ev.attendees !== null) entry.attendees = ev.attendees
    packet.scheduled_events.push(entry)
    refs[id] = { kind: 'event', id: ev.id }
  }

  return { packet, refs }
}

/**
 * For each interval in the hour whose title may not describe the work, why: the title has not changed in its window
 * for at least `staleMs`, or Daylens could no longer read it. Without a window ID each title counts as its own window.
 * Only the stale span before the hour is read, so the time given is the earliest sighting within it.
 */
function staleTitles(intervals: readonly FactInterval[], start: number, end: number, staleMs: number, clock: (ms: number) => string): Map<number, string> {
  const out = new Map<number, string>()
  const since = new Map<string, { title: string | null; from: number }>()
  for (const i of intervals) {
    if (i.kind !== 'focus') continue
    const win = JSON.stringify([i.app_id ?? i.app_name, i.window ?? i.title])
    const prev = since.get(win)
    const from = prev && prev.title === i.title ? prev.from : i.start_wall_ms
    since.set(win, { title: i.title, from })
    if (i.end_wall_ms <= start || i.start_wall_ms >= end || !i.title) continue
    if (i.possibly_stale_since_wall_ms !== null && i.possibly_stale_since_wall_ms < Math.min(i.end_wall_ms, end)) {
      out.set(i.obs_id, `title unreadable since ${clock(i.possibly_stale_since_wall_ms)}`)
    } else if (Math.min(i.end_wall_ms, end) - from >= staleMs && i.title.trim().toLowerCase() !== i.app_name?.trim().toLowerCase()) {
      out.set(i.obs_id, `title unchanged since at least ${clock(from)}`)
    }
  }
  return out
}

function presenceAt(spans: readonly PresenceSpan[], at: number): string | null {
  const s = spans.find((p) => p.start <= at && at < p.end)
  if (!s || s.state === 'present') return null
  if (s.state === 'asleep') return 'asleep'
  if (s.state === 'unknown') return 'unknown'
  return s.why === 'locked' ? 'screen locked' : 'idle'
}

function minutes(ms: number): number {
  return Math.round(ms / 6_000) / 10
}

function stretches(spans: readonly Interval[]): number {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  let count = 0
  let end = -Infinity
  for (const s of sorted) {
    if (s.start > end) count++
    end = Math.max(end, s.end)
  }
  return count
}

// Fixed key order keeps packets byte-identical for the same facts, so frozen packets hash the same.
function orderItem(i: PacketItem): PacketItem {
  const o: PacketItem = { id: i.id, app: i.app } as PacketItem
  for (const k of ['title', 'title_note', 'site', 'url', 'min', 'away_min', 'from', 'to', 'times', 'stale'] as const) if (i[k] !== undefined) (o as unknown as Record<string, unknown>)[k] = i[k]
  return o
}

function orderAgent(a: PacketAgent): PacketAgent {
  const o = { id: a.id, agent: a.agent, project: a.project } as PacketAgent
  for (const k of ['origin', 'with_you_min', 'while_away_min', 'unknown_min', 'waiting_min', 'messages'] as const) if (a[k] !== undefined) (o as unknown as Record<string, unknown>)[k] = a[k]
  return o
}
