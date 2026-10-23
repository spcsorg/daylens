// Retrieval's own read-only view of the database, for search, Ask and the MCP server. It never migrates or writes:
// the capture service owns the schema, and a schema this build was not written for is refused, not guessed at.
import Database from 'better-sqlite3'
import { presenceFromCapture } from '../capture/agents/attribution.ts'
import { dbHostLookup, memoryHostLookup, resolveHost, type HostLookup, type HostSpan } from '../capture/agents/store.ts'
import type { Agent } from '../capture/agents/types.ts'
import { HOUR_MS, hoursOf, MAX_INTERVAL_MS } from '../storage/derive.ts'
import { readHour, type Hour } from '../storage/hours.ts'
import { matchesSite, pendingTombstones, type Tombstone } from '../storage/rules.ts'
import { STORAGE_MIGRATIONS } from '../storage/schema.ts'

export const KNOWN_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([4])

export class UnknownSchemaError extends Error {}

export type SourceKind = 'page' | 'file' | 'window'

/** When, and in which app, something was on screen: [from, to). */
export interface Sighting {
  app_id: string | null
  from_wall_ms: number
  to_wall_ms: number
}

export interface Source {
  kind: SourceKind
  app_id: string | null
  app_name: string | null
  // The window or page title it was seen under; for a file, the title the name was read from.
  title: string | null
  url: string | null
  file: string | null
  ms: number
  first_wall_ms: number
  last_wall_ms: number
  // Each stretch it was seen in this hour, with the app it was seen in: a page can be open in more than one.
  sightings: Sighting[]
}

export interface AppTime {
  app_id: string | null
  app_name: string | null
  ms: number
}

export interface HourGap {
  reason: string
  ms: number
}

export interface HourView {
  start_wall_ms: number
  end_wall_ms: number
  // From the recorded activity; null for an hour that has only written text.
  tz_offset_min: number | null
  // The written or corrected hour as every screen shows it; null while the hour is facts only.
  hour: Hour | null
  recorded_ms: number
  // The stretches of the hour with recorded activity, each with its app, in order.
  sightings: Sighting[]
  apps: AppTime[]
  sources: Source[]
  gaps: HourGap[]
}

export interface AgentTurn {
  start_wall_ms: number
  // The turn's end, else its last activity: the agent never counts as working past it.
  end_wall_ms: number
  end_state: string | null
}

export interface AgentSessionWork {
  agent: string
  session_id: string
  origin: string
  project_dir: string | null
  branch: string | null
  // The app the session ran in, when known.
  app_id: string | null
  turns: AgentTurn[]
  // When the person sent a message to the agent; what was said is never read.
  user_messages_wall_ms: number[]
}

interface IntervalRow {
  start_wall_ms: number
  end_wall_ms: number
  tz_offset_min: number
  app_id: string | null
  app_name: string | null
  title: string | null
  url: string | null
  site: string | null
  files: string
}

/** The open, read-only connection to a database whose schema this build knows. */
export function openReadOnly(file: string): Database.Database {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    checkSchema(db)
  } catch (err) {
    db.close()
    throw err
  }
  return db
}

export function checkSchema(db: Database.Database): void {
  const meta = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'migrations')`).all()
  if (meta.length < 2) throw new UnknownSchemaError('this is not a Daylens V2 database that storage has set up')
  const v = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined
  if (!v || !KNOWN_SCHEMA_VERSIONS.has(Number(v.value))) throw new UnknownSchemaError(`unsupported schema version ${v?.value ?? 'none'}`)
  const applied = new Set((db.prepare('SELECT name FROM migrations').all() as { name: string }[]).map((r) => r.name))
  const missing = STORAGE_MIGRATIONS.filter((m) => !applied.has(m.name)).map((m) => m.name)
  if (missing.length > 0) throw new UnknownSchemaError(`storage has not finished setting up this database (missing ${missing.join(', ')})`)
}

/** What was read over [from, to): the apps and sites it showed. */
export interface ReadSpan {
  from: number
  to: number
  apps: readonly (string | null | undefined)[]
  sites: readonly (string | null | undefined)[]
}

/** Whether a deletion takes out any of what was read: the whole span for a range, else the app or the site in it. */
export function deletionCovers(t: Tombstone, r: ReadSpan): boolean {
  if (!(r.to > (t.from_wall_ms ?? Number.NEGATIVE_INFINITY) && r.from < (t.to_wall_ms ?? Number.POSITIVE_INFINITY))) return false
  if (t.kind === 'range') return true
  if (t.kind === 'source') return r.apps.some((a) => a?.toLowerCase() === t.app_id)
  return r.sites.some((s) => matchesSite(s?.toLowerCase().replace(/^www\./, '') ?? null, t.site!))
}

/** What remains of [s, e) once every pending deletion that covers the row has taken its span out. */
function fenced(i: IntervalRow, pending: readonly Tombstone[]): [number, number][] {
  let parts: [number, number][] = [[i.start_wall_ms, i.end_wall_ms]]
  for (const t of pending) {
    const covers = t.kind === 'range' || (t.kind === 'source' ? i.app_id?.toLowerCase() === t.app_id : matchesSite(i.site?.toLowerCase().replace(/^www\./, '') ?? null, t.site!))
    if (!covers) continue
    const from = t.from_wall_ms ?? Number.NEGATIVE_INFINITY
    const to = t.to_wall_ms ?? Number.POSITIVE_INFINITY
    parts = parts.flatMap(([s, e]): [number, number][] => {
      if (e <= from || s >= to) return [[s, e]]
      const out: [number, number][] = []
      if (s < from) out.push([s, from])
      if (e > to) out.push([to, e])
      return out
    })
  }
  return parts
}

function sourcesOf(i: IntervalRow): { kind: SourceKind; key: string; file: string | null }[] {
  if (i.url) return [{ kind: 'page', key: `p\u0000${i.url}`, file: null }]
  const files = i.files ? i.files.split(' ').filter(Boolean) : []
  if (files.length > 0) return files.map((f) => ({ kind: 'file' as const, key: `f\u0000${(i.app_id ?? '').toLowerCase()}\u0000${f.toLowerCase()}`, file: f }))
  if (i.title) return [{ kind: 'window', key: `w\u0000${(i.app_id ?? '').toLowerCase()}\u0000${i.title}`, file: null }]
  return []
}

/** A pending deletion's plan for one session, as storage/agentDeletion.ts wrote it. */
interface AgentPlan {
  spans: [number, number][]
  removes: boolean
  // The deleted app; null for a range.
  app: string | null
  from: number
  to: number
}

interface PlanTurn {
  start_wall_ms: number
  last_activity_wall_ms: number
  end_wall_ms: number | null
  end_state: string | null
}

/**
 * A turn as a session's plans will leave it, or null when one removes it, as runSession in storage/agentDeletion.ts
 * does: a turn begun in a planned span goes; one begun before the deletion that runs on past the first span's start is
 * cut where the first span it reaches begins, and its end state is 'missing' when its end fell inside the deleted time
 * or had no time.
 */
function applyPlans(t: PlanTurn, plans: readonly AgentPlan[]): PlanTurn | null {
  let turn = { ...t }
  for (const p of plans) {
    if (p.spans.some(([a, b]) => turn.start_wall_ms >= a && turn.start_wall_ms < b)) return null
    const first = p.spans[0]?.[0]
    if (first === undefined || first === Number.MIN_SAFE_INTEGER) continue
    if (!(turn.start_wall_ms < p.from && (turn.last_activity_wall_ms > first || (turn.end_wall_ms ?? Number.NEGATIVE_INFINITY) > first))) continue
    const last = Math.max(turn.last_activity_wall_ms, turn.end_wall_ms ?? 0)
    const at = p.spans.find(([a]) => a < last)?.[0]
    if (at === undefined) continue
    const missing = turn.end_state !== null && (turn.end_wall_ms === null || (turn.end_wall_ms > at && turn.end_wall_ms < p.to))
    turn = {
      start_wall_ms: turn.start_wall_ms,
      last_activity_wall_ms: Math.min(turn.last_activity_wall_ms, at),
      end_wall_ms: turn.end_wall_ms !== null && turn.end_wall_ms > at ? at : turn.end_wall_ms,
      end_state: missing ? 'missing' : turn.end_state,
    }
  }
  return turn
}

export class Reader {
  readonly db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  static open(file: string): Reader {
    return new Reader(openReadOnly(file))
  }

  close(): void {
    this.db.close()
  }

  /**
   * Reads the search index and its entries once, in order, so the first searches after the reader opens do not wait
   * on scattered disk reads; the system keeps the file in its cache, not this process. Returns the bytes read.
   */
  warmSearch(): number {
    const sum = (sql: string) => this.db.prepare(sql).pluck().get() as number
    return (
      sum('SELECT coalesce(sum(length(block)), 0) FROM search_data') +
      sum('SELECT coalesce(sum(length(sz)), 0) FROM search_docsize') +
      sum(`SELECT coalesce(sum(length(title) + length(url) + length(files) + length(hour_text)), 0) FROM search_docs`)
    )
  }

  /** The newest deletion so far. Deletion ids only grow, so whatever was read after this can be checked against later ones. */
  deletionMark(): number {
    return (this.db.prepare('SELECT coalesce(max(id), 0) FROM deletions').pluck().get() as number)
  }

  /** Every deletion begun after the mark, pending or finished. */
  deletionsSince(mark: number): Tombstone[] {
    return this.db.prepare(`SELECT id, kind, from_wall_ms, to_wall_ms, lower(app_id) AS app_id, lower(site) AS site, state FROM deletions WHERE id > ? ORDER BY id`).all(mark) as Tombstone[]
  }

  /** Every app ever recorded, with the name it was last recorded under, so text naming one can be recognised. */
  apps(): { app_id: string; app_name: string | null }[] {
    return this.db.prepare('SELECT app_id, app_name FROM intervals WHERE app_id IS NOT NULL AND id IN (SELECT max(id) FROM intervals GROUP BY app_id)').all() as { app_id: string; app_name: string | null }[]
  }

  /** The hour as every screen shows it (corrections win, pending deletions already applied), or null. */
  writtenHour(id: number): Hour | null {
    return readHour(this.db, id)
  }

  /** Each local hour that starts in [from, to) and has recorded activity or a written hour, oldest first. */
  hours(fromWallMs: number, toWallMs: number): HourView[] {
    return this.db.transaction(() => this.hoursNow(fromWallMs, toWallMs))()
  }

  hourAt(startWallMs: number): HourView | null {
    return this.hours(startWallMs, startWallMs + 1).find((h) => h.start_wall_ms === startWallMs) ?? null
  }

  private hoursNow(from: number, to: number): HourView[] {
    const pending = pendingTombstones(this.db)
    // An hour that starts inside [from, to) can reach an hour past `to` in a zone east of UTC; read one hour either side.
    const rows = this.db
      .prepare(
        `SELECT start_wall_ms, end_wall_ms, tz_offset_min, app_id, app_name, title, url, site, files FROM intervals
         WHERE start_wall_ms >= ? AND start_wall_ms < ? AND end_wall_ms > ? ORDER BY start_wall_ms, id`,
      )
      .all(from - HOUR_MS - MAX_INTERVAL_MS, to + HOUR_MS, from - HOUR_MS) as IntervalRow[]
    const byHour = new Map<number, { tz: number; apps: Map<string, AppTime>; sources: Map<string, Source>; recorded: number; sightings: Sighting[] }>()
    for (const i of rows) {
      for (const [s, e] of fenced(i, pending)) {
        for (const h of hoursOf(s, e, i.tz_offset_min)) {
          if (h < from || h >= to) continue
          const cs = Math.max(s, h)
          const ce = Math.min(e, h + HOUR_MS)
          if (ce < cs) continue
          const ms = ce - cs
          let slot = byHour.get(h)
          if (!slot) byHour.set(h, (slot = { tz: i.tz_offset_min, apps: new Map(), sources: new Map(), recorded: 0, sightings: [] }))
          slot.recorded += ms
          const piece = slot.sightings.at(-1)
          if (piece && piece.app_id === i.app_id && cs <= piece.to_wall_ms) piece.to_wall_ms = Math.max(piece.to_wall_ms, ce)
          else slot.sightings.push({ app_id: i.app_id, from_wall_ms: cs, to_wall_ms: ce })
          const appKey = (i.app_id ?? '').toLowerCase()
          const app = slot.apps.get(appKey) ?? { app_id: i.app_id, app_name: i.app_name, ms: 0 }
          app.ms += ms
          slot.apps.set(appKey, app)
          for (const src of sourcesOf(i)) {
            const prev = slot.sources.get(src.key)
            if (prev) {
              prev.ms += ms
              const last = prev.sightings.at(-1)!
              if (last.app_id === i.app_id && cs <= last.to_wall_ms) last.to_wall_ms = Math.max(last.to_wall_ms, ce)
              else prev.sightings.push({ app_id: i.app_id, from_wall_ms: cs, to_wall_ms: ce })
              prev.first_wall_ms = Math.min(prev.first_wall_ms, cs)
              // The title and the app are those it was last seen with.
              if (ce >= prev.last_wall_ms) {
                prev.last_wall_ms = ce
                prev.title = i.title
                prev.app_id = i.app_id
                prev.app_name = i.app_name
              }
            } else {
              slot.sources.set(src.key, { kind: src.kind, app_id: i.app_id, app_name: i.app_name, title: i.title, url: i.url, file: src.file, ms, first_wall_ms: cs, last_wall_ms: ce, sightings: [{ app_id: i.app_id, from_wall_ms: cs, to_wall_ms: ce }] })
            }
          }
        }
      }
    }
    const written = this.db.prepare('SELECT id, start_wall_ms FROM hours WHERE start_wall_ms >= ? AND start_wall_ms < ? ORDER BY start_wall_ms').all(from, to) as { id: number; start_wall_ms: number }[]
    const hourRows = new Map<number, Hour>()
    for (const w of written) {
      const h = readHour(this.db, w.id)
      if (h) hourRows.set(w.start_wall_ms, h)
    }
    const starts = [...new Set([...byHour.keys(), ...hourRows.keys()])].sort((a, b) => a - b)
    const ends = new Map(starts.map((s) => [s, hourRows.get(s)?.end_wall_ms ?? s + HOUR_MS]))
    const gaps = starts.length ? this.gapsOver(starts[0]!, Math.max(...ends.values()), pending) : () => []
    return starts.map((start) => {
      const slot = byHour.get(start)
      const hour = hourRows.get(start) ?? null
      const end = ends.get(start)!
      return {
        start_wall_ms: start,
        end_wall_ms: end,
        tz_offset_min: slot?.tz ?? null,
        hour,
        recorded_ms: slot?.recorded ?? 0,
        sightings: slot?.sightings ?? [],
        apps: [...(slot?.apps.values() ?? [])].sort((a, b) => b.ms - a.ms),
        sources: [...(slot?.sources.values() ?? [])].sort((a, b) => b.ms - a.ms || a.first_wall_ms - b.first_wall_ms),
        gaps: gaps(start, end),
      }
    })
  }

  /**
   * Agent sessions with a turn in [from, to), as pending deletions will leave them, read from the plan each deletion
   * wrote with its tombstone (storage/agentDeletion.ts), as the deletion worker carries it out: for each session still
   * in a plan, the turns and messages that begin in its planned spans go, a turn that began before the deletion and ran
   * on into them ends where the first of them it reaches begins (an end inside the deleted time, or with no time, says
   * only 'missing'), and its app is read without the spans the deletion forgets. Null when the agent reader has never
   * been enabled on this database.
   */
  agentWork(fromWallMs: number, toWallMs: number): AgentSessionWork[] | null {
    if (!this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_turns'`).get()) return null
    return this.db.transaction(() => this.agentWorkNow(fromWallMs, toWallMs))()
  }

  private agentPlans(): Map<string, AgentPlan[]> {
    const plans = new Map<string, AgentPlan[]>()
    const rows = this.db
      .prepare(
        `SELECT a.agent, a.session_id, a.spans, a.removes, d.kind, lower(d.app_id) AS app_id, d.from_wall_ms, d.to_wall_ms FROM deletion_agent a
         JOIN deletions d ON d.id = a.tombstone_id WHERE d.state = 'pending' ORDER BY a.tombstone_id`,
      )
      .all() as { agent: Agent; session_id: string; spans: string; removes: number; kind: string; app_id: string | null; from_wall_ms: number | null; to_wall_ms: number | null }[]
    for (const r of rows) {
      const key = `${r.agent}\u0000${r.session_id}`
      const list = plans.get(key) ?? []
      list.push({
        spans: JSON.parse(r.spans) as [number, number][],
        removes: r.removes === 1,
        app: r.kind === 'range' ? null : r.app_id,
        from: r.from_wall_ms ?? Number.MIN_SAFE_INTEGER,
        to: r.to_wall_ms ?? Number.MAX_SAFE_INTEGER,
      })
      plans.set(key, list)
    }
    return plans
  }

  private agentWorkNow(from: number, to: number): AgentSessionWork[] {
    const plans = this.agentPlans()
    const hosts = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_hosts'`).get() ? dbHostLookup(this.db) : null
    const turns = this.db
      .prepare(
        `SELECT t.agent, t.session_id, t.start_wall_ms, t.last_activity_wall_ms, t.end_wall_ms, t.end_state,
                coalesce(s.origin, 'interactive') AS origin, coalesce(t.project_dir, s.project_dir) AS project_dir, coalesce(t.branch, s.branch) AS branch
         FROM agent_turns t LEFT JOIN agent_sessions s ON s.agent = t.agent AND s.session_id = t.session_id
         WHERE t.replayed = 0 AND t.start_wall_ms < ? AND coalesce(t.end_wall_ms, t.last_activity_wall_ms) >= ? ORDER BY t.start_wall_ms, t.id`,
      )
      .all(to, from) as (PlanTurn & { agent: Agent; session_id: string; origin: string; project_dir: string | null; branch: string | null })[]
    const after = hosts && plans.size > 0 ? this.hostsAfter(plans, turns) : hosts
    const sessions = new Map<string, AgentSessionWork>()
    for (const t of turns) {
      const key = `${t.agent}\u0000${t.session_id}`
      const kept = applyPlans(t, plans.get(key) ?? [])
      if (!kept) continue
      const end = kept.end_wall_ms ?? kept.last_activity_wall_ms
      if (end < from) continue
      let s = sessions.get(key)
      if (!s) {
        const host = after ? resolveHost(after, t.agent, t.session_id, t.start_wall_ms) : null
        sessions.set(key, (s = { agent: t.agent, session_id: t.session_id, origin: t.origin, project_dir: t.project_dir, branch: t.branch, app_id: host?.app_id ?? null, turns: [], user_messages_wall_ms: [] }))
      }
      s.turns.push({ start_wall_ms: t.start_wall_ms, end_wall_ms: end, end_state: kept.end_state })
    }
    const acts = this.db.prepare(`SELECT wall_ms FROM agent_events WHERE kind = 'user' AND detail IN ('prompt', 'queued', 'steer', 'answer') AND agent = ? AND session_id = ? AND wall_ms >= ? AND wall_ms < ? ORDER BY wall_ms`)
    for (const s of sessions.values()) {
      const planned = plans.get(`${s.agent}\u0000${s.session_id}`) ?? []
      for (const { wall_ms } of acts.all(s.agent, s.session_id, from, to) as { wall_ms: number }[]) {
        // Half-open, as the deletion removes events: one at a span's start goes, though a cut turn ends there.
        if (planned.some((p) => p.spans.some(([a, b]) => wall_ms >= a && wall_ms < b))) continue
        if (s.turns.some((t) => wall_ms >= t.start_wall_ms && wall_ms <= t.end_wall_ms)) s.user_messages_wall_ms.push(wall_ms)
      }
    }
    return [...sessions.values()]
  }

  /**
   * The apps sessions ran in as the plans will leave them, as forgetAgentTime does for each session in a plan: the
   * spans begun inside the deletion's range go (for an app, only that app's), and the one in force at its end holds
   * from its end; a session that loses records and is left with nothing loses them all.
   */
  private hostsAfter(plans: ReadonlyMap<string, readonly AgentPlan[]>, turns: readonly { agent: Agent; session_id: string }[]): HostLookup {
    const look = dbHostLookup(this.db)
    const keys = new Map<string, { agent: Agent; session: string }>()
    for (const t of turns) {
      for (let x: string | null = t.session_id; x !== null && !keys.has(`${t.agent}\n${x}`); x = look.parent(t.agent, x)) keys.set(`${t.agent}\n${x}`, { agent: t.agent, session: x })
    }
    const rows = this.db.prepare('SELECT id, app_id, app_path, basis, from_wall_ms FROM agent_hosts WHERE agent = ? AND session_id = ? ORDER BY from_wall_ms, id')
    const spans: (HostSpan & { agent: string; session_id: string; from_wall_ms: number })[] = []
    const parents: { agent: string; session_id: string; parent: string }[] = []
    for (const { agent, session } of keys.values()) {
      let list = rows.all(agent, session) as (HostSpan & { from_wall_ms: number })[]
      for (const p of plans.get(`${agent}\u0000${session}`) ?? []) {
        if (p.removes && !this.leftAfter(agent, session, p)) {
          list = []
          continue
        }
        const theirs = (h: HostSpan) => p.app === null || h.app_id?.toLowerCase() === p.app
        const inForce = list.filter((h) => h.from_wall_ms <= p.to).at(-1)
        list = list.filter((h) => !(h.from_wall_ms >= p.from && h.from_wall_ms < p.to && theirs(h)))
        if (inForce && inForce.from_wall_ms >= p.from && inForce.from_wall_ms < p.to && theirs(inForce)) list = [...list, { ...inForce, from_wall_ms: p.to }].sort((x, y) => x.from_wall_ms - y.from_wall_ms)
      }
      for (const h of list) spans.push({ ...h, agent, session_id: session })
      const p = look.parent(agent, session)
      if (p !== null) parents.push({ agent, session_id: session, parent: p })
    }
    return memoryHostLookup(spans, parents)
  }

  /** Whether a session keeps anything once a plan has run: a turn, an event, a subagent, or its own session row. */
  private leftAfter(agent: Agent, session: string, p: AgentPlan): boolean {
    const inSpans = (at: number) => p.spans.some(([a, b]) => at >= a && at < b)
    const turns = (this.db.prepare('SELECT start_wall_ms FROM agent_turns WHERE agent = ? AND session_id = ?').pluck().all(agent, session) as number[]).filter((at) => !inSpans(at))
    if (turns.length > 0) return true
    if ((this.db.prepare('SELECT wall_ms FROM agent_events WHERE agent = ? AND session_id = ?').pluck().all(agent, session) as number[]).some((at) => !inSpans(at))) return true
    if (this.db.prepare('SELECT 1 FROM agent_sessions WHERE agent = ? AND parent_session_id = ?').get(agent, session)) return true
    // With no turns left, the session row goes for an app deletion, and for a range one if the session began inside it.
    const first = this.db.prepare('SELECT first_wall_ms FROM agent_sessions WHERE agent = ? AND session_id = ?').pluck().get(agent, session) as number | undefined
    return first !== undefined && p.app === null && !(first >= p.from && first < p.to)
  }


  /**
   * Gaps in [from, to), read once and then cut to each hour: the presence read looks back for the last state before
   * `from`, which costs about as much as the read itself on a large file, so it must not run once per hour. A pending
   * range deletion already applies, as the deletion will leave them: a gap that begins inside it goes, pauses included,
   * and presence is read as attribution reads it.
   */
  private gapsOver(from: number, to: number, pending: readonly Tombstone[]): (hourFrom: number, hourTo: number) => HourGap[] {
    const ranges = pending.filter((t) => t.kind === 'range').map((t) => [t.from_wall_ms ?? Number.MIN_SAFE_INTEGER, t.to_wall_ms ?? Number.MAX_SAFE_INTEGER] as const)
    const rows = this.db
      .prepare(`SELECT reason, start_wall_ms AS s, end_wall_ms AS end FROM capture_gaps WHERE scope = 'all' AND start_wall_ms < ? AND coalesce(end_wall_ms, ?) > ?`)
      .all(to, to, from) as { reason: string; s: number; end: number | null }[]
    const spans: { reason: string; s: number; e: number }[] = []
    // The deletion's fence has already cut and split the gaps crossing the range's edges; those inside it go.
    for (const g of rows) if (!ranges.some(([a, b]) => g.s >= a && g.s < b)) spans.push({ reason: g.reason, s: g.s, e: g.end ?? to })
    // Presence leaves out every range deletion's rows itself, pending or done, and ends a lock, sleep or idle where one begins.
    const presence = presenceFromCapture(this.db, from, to)
    for (const k of ['locked', 'asleep', 'idle'] as const) for (const p of presence[k]) spans.push({ reason: k, s: p.start, e: p.end })
    return (hourFrom, hourTo) => {
      const out = new Map<string, number>()
      for (const g of spans) {
        const ms = Math.min(g.e, hourTo) - Math.max(g.s, hourFrom)
        if (ms > 0) out.set(g.reason, (out.get(g.reason) ?? 0) + ms)
      }
      return [...out].map(([reason, ms]) => ({ reason, ms })).sort((a, b) => b.ms - a.ms)
    }
  }
}
