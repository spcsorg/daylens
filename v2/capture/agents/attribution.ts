// Joins agent turns with what capture knows about the person: was anyone at the computer while the agent worked?
// Derived on read, never stored, so it always reflects the latest observations and corrections.

import type Database from 'better-sqlite3'
import type { EventRow, TurnRow } from './store.ts'

export type Presence = 'present' | 'away' | 'asleep' | 'unknown'

export interface Interval {
  start: number
  end: number
}

export interface PresenceSpan extends Interval {
  state: Presence
  // Why the person counts as away: the screen was locked, or input went idle.
  why?: 'locked' | 'idle'
}

export interface PresenceInputs {
  // Times capture was running. Outside them nothing is known, so nothing is claimed.
  covered: Interval[]
  locked: Interval[]
  asleep: Interval[]
  idle: Interval[]
  // Capture gaps inside covered time.
  unknown: Interval[]
}

function clip(list: Interval[], from: number, to: number): Interval[] {
  return list.map((i) => ({ start: Math.max(i.start, from), end: Math.min(i.end, to) })).filter((i) => i.end > i.start)
}

// The person's state at every moment in [from, to). Asleep wins over locked, locked over unknown, unknown over idle.
export function presenceTimeline(from: number, to: number, inputs: PresenceInputs): PresenceSpan[] {
  const layers: [Interval[], Presence, PresenceSpan['why']][] = [
    [clip(inputs.asleep, from, to), 'asleep', undefined],
    [clip(inputs.locked, from, to), 'away', 'locked'],
    [clip(inputs.unknown, from, to), 'unknown', undefined],
    [clip(inputs.idle, from, to), 'away', 'idle'],
  ]
  const covered = clip(inputs.covered, from, to)
  const cuts = new Set<number>([from, to])
  for (const [list] of layers) for (const i of list) cuts.add(i.start).add(i.end)
  for (const i of covered) cuts.add(i.start).add(i.end)
  const points = [...cuts].sort((a, b) => a - b)
  const out: PresenceSpan[] = []
  for (let k = 0; k + 1 < points.length; k++) {
    const a = points[k]!
    const b = points[k + 1]!
    const mid = a + (b - a) / 2
    let state: Presence = covered.some((i) => i.start <= mid && mid < i.end) ? 'present' : 'unknown'
    let why: PresenceSpan['why']
    for (const [list, s, w] of layers) {
      if (list.some((i) => i.start <= mid && mid < i.end)) {
        state = s
        why = w
        break
      }
    }
    const last = out[out.length - 1]
    if (last && last.state === state && last.why === why && last.end === a) last.end = b
    else out.push(why ? { start: a, end: b, state, why } : { start: a, end: b, state })
  }
  return out
}

export interface WorkSegment extends Interval {
  agent: string
  session: string
  turn: string
  project: string | null
  origin: string
  opener: string
  activity: 'working' | 'waiting'
  presence: Presence
  why?: 'locked' | 'idle'
}

// A turn covers its start to its end, or to its last recorded activity when no end was written; never longer.
export function turnSpan(t: TurnRow): Interval | null {
  const end = t.end_wall_ms ?? t.last_activity_wall_ms
  return end > t.start_wall_ms ? { start: t.start_wall_ms, end } : null
}

export function agentSegments(turns: readonly TurnRow[], events: readonly EventRow[], presence: readonly PresenceSpan[]): WorkSegment[] {
  const waits = new Map<string, Interval[]>()
  for (const e of events) {
    if (e.kind !== 'wait' || e.turn_key === null || e.end_wall_ms === null) continue
    const list = waits.get(e.turn_key) ?? []
    list.push({ start: e.wall_ms, end: e.end_wall_ms })
    waits.set(e.turn_key, list)
  }
  const out: WorkSegment[] = []
  for (const t of turns) {
    const span = turnSpan(t)
    if (!span) continue
    const pieces: { start: number; end: number; activity: 'working' | 'waiting' }[] = []
    let cursor = span.start
    for (const w of (waits.get(t.turn_key) ?? []).sort((a, b) => a.start - b.start)) {
      const ws = Math.max(w.start, cursor)
      const we = Math.min(w.end, span.end)
      if (we <= ws) continue
      if (ws > cursor) pieces.push({ start: cursor, end: ws, activity: 'working' })
      pieces.push({ start: ws, end: we, activity: 'waiting' })
      cursor = we
    }
    if (cursor < span.end) pieces.push({ start: cursor, end: span.end, activity: 'working' })
    for (const p of pieces) {
      for (const s of presence) {
        const a = Math.max(p.start, s.start)
        const b = Math.min(p.end, s.end)
        if (b <= a) continue
        const seg: WorkSegment = {
          start: a,
          end: b,
          agent: t.agent,
          session: t.session_id,
          turn: t.turn_key,
          project: t.project_dir,
          origin: t.origin,
          opener: t.opened_by,
          activity: p.activity,
          presence: s.state,
        }
        if (s.why) seg.why = s.why
        out.push(seg)
      }
    }
  }
  return out
}

export function unionMs(list: readonly Interval[]): number {
  const sorted = [...list].sort((a, b) => a.start - b.start)
  let total = 0
  let cs = -Infinity
  let ce = -Infinity
  for (const i of sorted) {
    if (i.start > ce) {
      if (ce > cs) total += ce - cs
      cs = i.start
      ce = i.end
    } else if (i.end > ce) ce = i.end
  }
  if (ce > cs) total += ce - cs
  return total
}

export interface WindowSummary {
  // Agent working time, counted once however many sessions ran at the same moment.
  working: Record<Presence, number>
  waiting: number
  sessions: { agent: string; session: string; project: string | null; origin: string; working_ms: number }[]
  user: { at: number; agent: string; session: string; act: string; basis: string | null }[]
}

export function summarize(segments: readonly WorkSegment[], events: readonly EventRow[], from: number, to: number): WindowSummary {
  const inWindow = segments.map((s) => ({ ...s, start: Math.max(s.start, from), end: Math.min(s.end, to) })).filter((s) => s.end > s.start)
  const working = { present: 0, away: 0, asleep: 0, unknown: 0 } as Record<Presence, number>
  for (const p of Object.keys(working) as Presence[]) working[p] = unionMs(inWindow.filter((s) => s.activity === 'working' && s.presence === p))
  const bySession = new Map<string, WindowSummary['sessions'][number] & { spans: Interval[] }>()
  for (const s of inWindow) {
    const k = `${s.agent}\u0000${s.session}`
    const e = bySession.get(k) ?? { agent: s.agent, session: s.session, project: s.project, origin: s.origin, working_ms: 0, spans: [] }
    if (s.activity === 'working') e.spans.push(s)
    bySession.set(k, e)
  }
  const sessions = [...bySession.values()].map(({ spans, ...rest }) => ({ ...rest, working_ms: unionMs(spans) }))
  return {
    working,
    waiting: unionMs(inWindow.filter((s) => s.activity === 'waiting')),
    sessions,
    user: events
      .filter((e) => e.kind === 'user' && e.wall_ms >= from && e.wall_ms < to)
      .map((e) => ({ at: e.wall_ms, agent: e.agent, session: e.session_id, act: e.detail, basis: e.basis })),
  }
}

const LOCK_START = new Set(['locked', 'console_disconnect', 'remote_disconnect', 'logoff'])
const LOCK_END = new Set(['unlocked', 'console_connect', 'remote_connect', 'logon'])

// Presence inputs from the capture tables: session, power and input observations, helper runs, and capture gaps.
export function presenceFromCapture(db: Database.Database, from: number, to: number): PresenceInputs {
  const rows = db
    .prepare(
      `SELECT kind, state, event_wall_ms AS at FROM observations
       WHERE kind IN ('session', 'power', 'input') AND event_wall_ms < ?
         AND (event_wall_ms >= ? OR id IN (SELECT max(id) FROM observations WHERE kind IN ('session', 'power', 'input') AND event_wall_ms < ? GROUP BY kind))
       ORDER BY event_wall_ms, id`,
    )
    .all(to, from, from) as { kind: string; state: string; at: number }[]
  const open: Record<'locked' | 'asleep' | 'idle', number | null> = { locked: null, asleep: null, idle: null }
  const inputs: PresenceInputs = { covered: [], locked: [], asleep: [], idle: [], unknown: [] }
  const closeIf = (k: 'locked' | 'asleep' | 'idle', at: number) => {
    if (open[k] !== null) inputs[k].push({ start: open[k]!, end: at })
    open[k] = null
  }
  for (const r of rows) {
    if (r.kind === 'session') {
      if (LOCK_START.has(r.state)) open.locked ??= r.at
      else if (LOCK_END.has(r.state)) closeIf('locked', r.at)
    } else if (r.kind === 'power') {
      if (r.state === 'sleep') open.asleep ??= r.at
      else if (r.state === 'resume' || r.state === 'resume_user') closeIf('asleep', r.at)
    } else if (r.kind === 'input') {
      if (r.state === 'idle') open.idle ??= r.at
      else if (r.state === 'active') closeIf('idle', r.at)
    }
  }
  for (const k of ['locked', 'asleep', 'idle'] as const) closeIf(k, to)
  const runs = db
    .prepare('SELECT started_wall_ms AS s, coalesce(ended_wall_ms, last_heartbeat_wall_ms, started_wall_ms) AS e FROM capture_runs WHERE started_wall_ms < ? AND coalesce(ended_wall_ms, last_heartbeat_wall_ms, started_wall_ms) > ?')
    .all(to, from) as { s: number; e: number }[]
  inputs.covered = runs.map((r) => ({ start: r.s, end: r.e }))
  const gaps = db
    .prepare(
      `SELECT start_wall_ms AS s, coalesce(end_wall_ms, ?) AS e FROM capture_gaps
       WHERE scope IN ('all', 'session', 'power') AND reason != 'excluded' AND start_wall_ms < ? AND coalesce(end_wall_ms, ?) > ?`,
    )
    .all(to, to, to, from) as { s: number; e: number }[]
  inputs.unknown = gaps.map((g) => ({ start: g.s, end: g.e }))
  return inputs
}
