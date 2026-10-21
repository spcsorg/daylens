// Deletion in two parts. The fence runs on the capture thread in one short transaction: the tombstone goes in force
// for capture and import, and rows crossing the range edges are trimmed or split. The rest (removing rows, search
// entries, hours, threads and reads) runs in a worker thread with its own connection, in short transactions, so
// capture never waits on it for long and the user's action returns at once.
import type Database from 'better-sqlite3'
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ObservationRow } from '../capture/normalize.ts'
import { MAX_ROW_SPAN_MS, SCRUB_PENDING } from '../capture/store.ts'
import { Derived, HOUR_MS, MAX_INTERVAL_MS } from './derive.ts'
import { clearHour, sourceMatches, type HourSource } from './hours.ts'
import { Rules, tombstoneMatches, type Tombstone } from './rules.ts'
import { immediateRetrying } from './tx.ts'
import { ScrubUnavailableError, scrubAll, scrubBlocked } from './scrub.ts'
import { pruneChangeLog } from './changes.ts'
import { leafRowid, readStructure, segmentCount, type FtsSegment, type FtsStructure } from './ftsStructure.ts'
import { dbHostLookup, resolveHost } from '../capture/agents/store.ts'
import type { Agent } from '../capture/agents/types.ts'

export interface DeletionResult {
  tombstone: number
  observations: number
  intervals: number
  searchDocs: number
  hoursRemoved: number
  hoursCleared: number
  assistantReads: number
  agentRecords: number
  // Whether the old pages were also moved out of the write-ahead log when the removal finished; if not, storage
  // keeps retrying and announces when they are gone.
  purged: boolean
}

type Obs = ObservationRow & { id: number; last_seen_wall_ms: number; url?: string | null }
type Spec = Pick<Tombstone, 'kind' | 'from_wall_ms' | 'to_wall_ms' | 'app_id' | 'site'>

// Agent session tables exist once the agent reader has been enabled.
function hasAgentTables(db: Database.Database): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_events'`).get() !== undefined
}

function hasAgentHosts(db: Database.Database): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_hosts'`).get() !== undefined
}

function hasUrl(db: Database.Database): boolean {
  return db.prepare(`SELECT 1 FROM pragma_table_info('observations') WHERE name = 'url'`).get() !== undefined
}

// SQL narrows the candidates; tombstoneMatches decides (sites are matched on the parsed address).
function prefilter(db: Database.Database, t: Spec): string {
  return t.kind === 'range' ? '1' : t.kind === 'source' ? 'lower(app_id) = @app' : hasUrl(db) ? 'url IS NOT NULL' : '0'
}

function intervalMatch(t: Spec): string {
  return t.kind === 'range' ? '1' : t.kind === 'source' ? 'lower(app_id) = @app' : `(site = @site OR site LIKE '%.' || @site)`
}

function bounds(t: Spec) {
  const from = t.from_wall_ms ?? Number.MIN_SAFE_INTEGER
  const to = t.to_wall_ms ?? Number.MAX_SAFE_INTEGER
  return { from, to, app: t.app_id, site: t.site, lo: from - MAX_INTERVAL_MS }
}

/**
 * Inside the fence transaction: rows crossing an edge keep only their parts outside the range, and one that spans
 * it is split in two. Each bound is an edge (an app deleted across all time has only its end, the moment it was
 * deleted); the scan before an edge is limited by MAX_INTERVAL_MS.
 */
export function fenceEdges(db: Database.Database, t: Spec, allocateId: () => number): void {
  const args = bounds(t)
  const { from, to } = args
  const pre = prefilter(db, t)
  const matches = (o: Obs) => tombstoneMatches(t, o.app_id, o.url ?? null)
  const cols = (db.prepare('PRAGMA table_info(observations)').all() as { name: string }[]).map((c) => c.name)
  const insertCopy = db.prepare(`INSERT INTO observations (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`)
  if (t.from_wall_ms !== null) {
    for (const o of (db.prepare(`SELECT * FROM observations WHERE event_wall_ms >= @lo AND event_wall_ms < @from AND last_seen_wall_ms > @from AND ${pre}`).all(args) as Obs[]).filter(matches)) {
      if (o.last_seen_wall_ms > to) insertCopy.run({ ...o, id: allocateId(), event_wall_ms: to, event_mono_us: o.event_mono_us + (to - o.event_wall_ms) * 1000 })
      db.prepare('UPDATE observations SET last_seen_wall_ms = ? WHERE id = ?').run(from, o.id)
    }
  }
  if (t.to_wall_ms === null) return
  // A row that crosses the end began inside the range and at most MAX_ROW_SPAN_MS before it.
  const toLo = Math.max(from, to - MAX_ROW_SPAN_MS)
  for (const o of (db.prepare(`SELECT * FROM observations WHERE event_wall_ms >= @toLo AND event_wall_ms < @to AND last_seen_wall_ms > @to AND ${pre}`).all({ ...args, toLo }) as Obs[]).filter(matches)) {
    db.prepare('UPDATE observations SET event_wall_ms = ?, event_mono_us = ? WHERE id = ?').run(to, o.event_mono_us + (to - o.event_wall_ms) * 1000, o.id)
  }
}

/**
 * Inside the fence transaction, with the tombstone: everything later steps must reach, before any of it changes.
 * Hours: those the deletion removes or clears. Threads and assistant reads: those linked to them, and reads over
 * the range or of the app or site. Search entries: only the hours cut by a range edge need rebuilding; entries
 * wholly inside the range are deleted by query, which stays correct after a restart.
 */
export function planDeletion(db: Database.Database, tombstoneId: number, t: Spec): void {
  const { from, to, app, site } = bounds(t)
  const item = db.prepare('INSERT OR IGNORE INTO deletion_work (tombstone_id, kind, ref) VALUES (?, ?, ?)')
  // The hours an edge cuts through.
  const edgeHours = db.prepare(`SELECT DISTINCT hour_start_wall_ms AS h FROM search_docs WHERE kind = 'activity' AND hour_start_wall_ms > ? AND hour_start_wall_ms < ?`)
  for (const edge of [t.from_wall_ms, t.to_wall_ms]) {
    if (edge === null) continue
    for (const { h } of edgeHours.all(edge - HOUR_MS, edge) as { h: number }[]) item.run(tombstoneId, 'doc_hour', h)
  }
  const hours = db.prepare('SELECT id, sources FROM hours WHERE end_wall_ms > ? AND start_wall_ms < ?').all(from, to) as { id: number; sources: string }[]
  for (const h of hours) {
    if (t.kind === 'range' || (JSON.parse(h.sources) as HourSource[]).some((s) => sourceMatches(t, s))) item.run(tombstoneId, 'hour', h.id)
  }
  const planned = `(SELECT ref FROM deletion_work WHERE tombstone_id = ? AND kind = 'hour')`
  db.prepare(`INSERT OR IGNORE INTO deletion_work SELECT ?, 'thread', thread_id FROM thread_hours WHERE hour_id IN ${planned}`).run(tombstoneId, tombstoneId)
  db.prepare(`INSERT OR IGNORE INTO deletion_work SELECT ?, 'read', read_id FROM assistant_read_items WHERE hour_id IN ${planned}`).run(tombstoneId, tombstoneId)
  if (t.kind === 'range') {
    db.prepare(`INSERT OR IGNORE INTO deletion_work SELECT ?, 'read', id FROM assistant_reads WHERE to_wall_ms > ? AND from_wall_ms < ?`).run(tombstoneId, from, to)
  } else {
    const match = t.kind === 'source' ? 'i.app_id = @app' : `(i.site = @site OR i.site LIKE '%.' || @site)`
    db.prepare(
      `INSERT OR IGNORE INTO deletion_work SELECT @id, 'read', i.read_id FROM assistant_read_items i JOIN assistant_reads a ON a.id = i.read_id
       WHERE ${match} AND a.to_wall_ms > @from AND a.from_wall_ms < @to`,
    ).run({ id: tombstoneId, app, site, from, to })
  }
  db.prepare(`INSERT OR IGNORE INTO deletion_fence SELECT tombstone_id, kind, ref FROM deletion_work WHERE tombstone_id = ? AND kind IN ('hour', 'thread', 'read')`).run(tombstoneId)
}

const ROWS_PER_STEP = 500
const DOCS_PER_STEP = 50
const HOURS_PER_STEP = 25
// A transaction stops taking on more rows, pages or index merging after this long, so capture's flushes never wait
// long for the lock.
const FTS_STEP_MS = 20
// Search index pages one merge step starts with; it follows how long each step takes, like the scrub's batches.
const MERGE_PAGES = 16
const MAX_MERGE_PAGES = 1024
// FTS5_MAX_LEVEL: a merge of all segments puts them on level min(levels + 1, 64) - 1.
const FTS_MAX_LEVEL = 64

interface SegmentAtStart extends FtsSegment {
  last: Buffer | null
}

interface MergeRound {
  level: number
  // The oldest input: the first segment of the merge level until the merge finishes and removes its inputs. Inputs
  // keep their ids while it runs, so no other segment can take this one meanwhile.
  firstId: number
  inProgress: boolean
  oldest: boolean
  start: SegmentAtStart[]
}

/**
 * Where a merge of every segment started now would run, if its output would be the oldest segment; null if not. This
 * follows fts5IndexOptimizeStruct: segments on more than one level all move, oldest first, to a new last level; if
 * they are already on one level they stay there, and the output is the oldest only if that is one of the last two.
 * A merge in progress whose inputs are all segments but its own output is continued as it is: null.
 */
function mergePlan(s: FtsStructure, total: number): { level: number; firstId: number } | null {
  if (total < 2) return null
  for (const [i, l] of s.levels.entries()) {
    const n = l.segments.length
    if (n === total) return i >= s.levels.length - 2 ? { level: i, firstId: l.segments[0]!.id } : null
    if (n > 0 && n === total - 1 && l.nMerge === n) return null
  }
  const deepest = s.levels.findLast((l) => l.segments.length > 0)!
  return { level: Math.min(s.levels.length + 1, FTS_MAX_LEVEL) - 1, firstId: deepest.segments[0]!.id }
}

function oursInProgress(s: FtsStructure, r: MergeRound): boolean {
  const l = s.levels[r.level]
  return l !== undefined && l.nMerge > 0 && l.segments[0]?.id === r.firstId
}

// FTS5 keeps a delete marker unless the merge's output is the only segment on the last level.
function outputIsOldest(s: FtsStructure, level: number): boolean {
  return s.levels.length === level + 2 && s.levels[level + 1]!.segments.length === 1
}

function intact(s: FtsStructure, x: SegmentAtStart, leaf: Database.Statement): boolean {
  return s.levels.some((l) =>
    l.segments.some((g) => g.id === x.id && g.pgnoFirst === x.pgnoFirst && g.pgnoLast === x.pgnoLast && (x.last === null || x.last.equals(leaf.get(leafRowid(g.id, g.pgnoLast)) as Buffer))),
  )
}

// FTS5's 'rebuild' reads columns by the index's names, and search_docs names the address url; 'delete-all' removes
// every index row and starts the structure over, and the entries are then indexed again as they are.
function reindex(db: Database.Database): void {
  db.exec(`INSERT INTO search (search) VALUES ('delete-all')`)
  db.exec('INSERT INTO search (rowid, title, address, files, hour_text) SELECT id, title, url, files, hour_text FROM search_docs')
}

/**
 * One transaction that starts a merge of every segment, or prepares the index so the next one can. 'clean' when the
 * index holds nothing a removal left behind: it has no segments, or it was rebuilt from search_docs. 'prepared' when
 * this transaction only made a merge with the oldest output possible next time. Otherwise the round started: whether
 * its output is the oldest segment, and whether it is still in progress.
 */
function startMergeRound(db: Database.Database, pages: number, merge: (n: number) => void, leaf: Database.Statement): MergeRound | 'clean' | 'prepared' {
  const s = readStructure(db)
  const total = s === null ? 0 : segmentCount(s)
  if (s === null || total === 0) return 'clean'
  let plan = mergePlan(s, total)
  const oldest = plan !== null
  if (plan === null) {
    const onlyLevel0 = s.levels[0] !== undefined && s.levels[0].segments.length === total
    if (onlyLevel0) {
      // Every segment on level 0 above empty levels. A new segment lands on level 0 and moves any segment no bigger
      // than itself there, so an index of a page or so stays in this shape; one no bigger than a first merge step
      // is rebuilt instead. A bigger one is merged to level 1 first, which leaves room for a new segment below it.
      const indexPages = s.levels[0]!.segments.reduce((n, g) => n + (g.pgnoLast > 0 ? g.pgnoLast - g.pgnoFirst + 1 : 0), 0)
      if (indexPages <= MERGE_PAGES) {
        reindex(db)
        return 'clean'
      }
      if (total >= 2) plan = { level: 0, firstId: s.levels[0]!.segments[0]!.id }
    }
    if (plan === null) {
      // Rewriting one entry as it is adds a segment on level 0, which puts the segments on two levels (or two on
      // level 0) for the next merge. With no entries left, the rebuild has nothing to read.
      const id = db.prepare('SELECT max(id) FROM search_docs').pluck().get() as number | null
      if (id === null) {
        reindex(db)
        return 'clean'
      }
      db.prepare('UPDATE search_docs SET title = title WHERE id = ?').run(id)
      return 'prepared'
    }
  }
  const start = s.levels.flatMap((l) => l.segments.map((g) => ({ ...g, last: g.pgnoLast > 0 ? (leaf.get(leafRowid(g.id, g.pgnoLast)) as Buffer) : null })))
  merge(-pages)
  const after = readStructure(db)!
  const { level } = plan
  const round: MergeRound = { ...plan, inProgress: false, oldest, start }
  round.inProgress = oursInProgress(after, round)
  if (!oldest) return round
  const others = after.levels.some((l, i) => l.nMerge > 0 && i !== level)
  const left = segmentCount(after)
  const done = after.levels.length === level + 2 && left <= 1 && after.levels[level + 1]!.segments.length === left
  if (others || (round.inProgress ? !outputIsOldest(after, level) : !done)) throw new Error('the search index merge did not start as planned; nothing is reported purged')
  return round
}

// Reads the search index into the cache outside any write transaction, so merging it finds its pages in memory.
export function warmSearchIndex(db: Database.Database): void {
  db.prepare('SELECT count(*) AS n, sum(length(block)) AS b FROM search_data').get()
}

/**
 * Search entries go with FTS5's plain delete, which stops them matching at once but leaves their terms in the
 * index's segments until those are merged. This marker, set in the same transaction, makes the purge merge them away
 * before it scrubs (Deleter.mergeSearchIfPending).
 */
export const FTS_MERGE_PENDING = `INSERT INTO meta (key, value) VALUES ('fts_merge_pending', '1') ON CONFLICT (key) DO UPDATE SET value = value + 1`

/** Runs `fn` inside the caller's transaction; if it changed anything, the index owes a merge. */
function ftsRemoval<T>(db: Database.Database, fn: () => T): T {
  const changes = db.prepare('SELECT total_changes() AS n').pluck()
  const before = changes.get() as number
  const out = fn()
  if ((changes.get() as number) > before) db.prepare(FTS_MERGE_PENDING).run()
  return out
}

/** Runs `each` for items in order until all are done or FTS_STEP_MS has passed; returns how many it ran. */
function timeBoxed<T>(items: readonly T[], each: (item: T) => void): number {
  const start = performance.now()
  let n = 0
  for (const item of items) {
    each(item)
    n++
    if (performance.now() - start > FTS_STEP_MS) break
  }
  return n
}

export interface PruneResult {
  removed: number
  data: number
  batches: number
  maxTransactionMs: number
  // Whether the removed rows' old pages also left the write-ahead log; if not, storage retries until they do.
  purged: boolean
}

/**
 * One retention batch, each part its own short transaction: announcements older than `logKeepFrom`, and, when a
 * cutoff is set, observations, intervals, gaps and reads before it, then search entries and hours, time-boxed.
 */
export const RETENTION_PURGE_PENDING = `INSERT INTO meta (key, value) VALUES ('retention_purge_pending', '1') ON CONFLICT (key) DO NOTHING`

// Set by builds that rewrote the file with VACUUM instead; a file that still has it is scrubbed too.
const SCRUB_MARKERS = `SELECT key, value FROM meta WHERE key IN ('page_scrub_pending', 'vacuum_pending')`

export function pruneStep(db: Database.Database, cutoff: number | null, logKeepFrom: number, batch = ROWS_PER_STEP, onTransaction: (ms: number) => void = () => {}): { removed: number; data: number } {
  // Each transaction that removes content also records that the log must still be purged, so a crash before the
  // checkpoint cannot lose that obligation.
  const timed = <T>(fn: () => T): T => {
    const t = performance.now()
    const out = immediateRetrying(db, () => {
      const before = db.prepare('SELECT total_changes() AS n').get() as { n: number }
      const result = fn()
      if ((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n > before.n) {
        db.prepare(RETENTION_PURGE_PENDING).run()
        db.prepare(SCRUB_PENDING).run()
      }
      return result
    })
    onTransaction(performance.now() - t)
    return out
  }
  const logRows = timed(() => pruneChangeLog(db, logKeepFrom, batch))
  if (cutoff === null) return { removed: logRows, data: 0 }
  let n = 0
  // A row that began before the cutoff but still covers kept time is trimmed to the cutoff, not deleted: capture may
  // still be extending it. Rows span at most MAX_ROW_SPAN_MS, which bounds the scan.
  timed(() => {
    db.prepare(
      `UPDATE observations SET event_mono_us = event_mono_us + (? - event_wall_ms) * 1000, event_wall_ms = ?
       WHERE event_wall_ms >= ? AND event_wall_ms < ? AND last_seen_wall_ms > ?`,
    ).run(cutoff, cutoff, cutoff - MAX_ROW_SPAN_MS, cutoff, cutoff)
    db.prepare('UPDATE intervals SET start_wall_ms = ? WHERE start_wall_ms >= ? AND start_wall_ms < ? AND end_wall_ms > ?').run(cutoff, cutoff - MAX_INTERVAL_MS, cutoff, cutoff)
  })
  for (const sql of [
    'DELETE FROM observations WHERE id IN (SELECT id FROM observations WHERE event_wall_ms < ? ORDER BY event_wall_ms LIMIT ?)',
    'DELETE FROM intervals WHERE id IN (SELECT id FROM intervals WHERE start_wall_ms < ? ORDER BY start_wall_ms LIMIT ?)',
    'DELETE FROM capture_gaps WHERE id IN (SELECT id FROM capture_gaps WHERE end_wall_ms < ? LIMIT ?)',
    'DELETE FROM assistant_reads WHERE id IN (SELECT id FROM assistant_reads WHERE to_wall_ms < ? LIMIT ?)',
    ...(hasAgentTables(db)
      ? [
          'DELETE FROM agent_events WHERE id IN (SELECT id FROM agent_events WHERE coalesce(end_wall_ms, wall_ms) < ? LIMIT ?)',
          'DELETE FROM agent_turns WHERE id IN (SELECT id FROM agent_turns WHERE max(last_activity_wall_ms, coalesce(end_wall_ms, 0)) < ? LIMIT ?)',
          'DELETE FROM agent_sessions WHERE id IN (SELECT id FROM agent_sessions WHERE last_wall_ms < ? LIMIT ?)',
          'UPDATE agent_sources SET state = NULL WHERE rowid IN (SELECT rowid FROM agent_sources WHERE updated_wall_ms < ? AND state IS NOT NULL LIMIT ?)',
        ]
      : []),
  ]) {
    n += timed(() => db.prepare(sql).run(cutoff, batch).changes)
  }
  const docs = (db.prepare('SELECT id FROM search_docs WHERE hour_start_wall_ms < ? AND last_wall_ms < ? LIMIT ?').all(cutoff, cutoff, DOCS_PER_STEP) as { id: number }[]).map((r) => r.id)
  const hours = (db.prepare('SELECT id FROM hours WHERE end_wall_ms <= ? LIMIT ?').all(cutoff, HOURS_PER_STEP) as { id: number }[]).map((r) => r.id)
  const delDoc = db.prepare('DELETE FROM search_docs WHERE id = ?')
  const delHourDocs = db.prepare(`DELETE FROM search_docs WHERE kind = 'hour' AND hour_id = ?`)
  const delHour = db.prepare('DELETE FROM hours WHERE id = ?')
  for (let i = 0; i < docs.length; ) {
    i += timed(() => ftsRemoval(db, () => timeBoxed(docs.slice(i), (id) => (n += delDoc.run(id).changes))))
  }
  for (let i = 0; i < hours.length; ) {
    i += timed(() =>
      ftsRemoval(db, () =>
        timeBoxed(hours.slice(i), (id) => {
          delHourDocs.run(id)
          n += delHour.run(id).changes
        }),
      ),
    )
  }
  return { removed: n + logRows, data: n }
}

export type DeletionStep = 'observations' | 'intervals' | 'search' | 'hours' | 'threads'

/** Removes everything a tombstone covers, in short transactions, driven by its planned work. Safe to run again. */
export class Deleter {
  private readonly db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  /**
   * Agent session records in [from, to): events and turns that began inside go, and anything that crosses the start is
   * cut there. A session keeps only the span of its remaining turns, and goes if none remain and it began inside.
   */
  private deleteAgentRange(from: number, to: number): number {
    const db = this.db
    const events = db.prepare(`SELECT id, session_id, detail FROM agent_events WHERE wall_ms >= @from AND wall_ms < @to LIMIT ${ROWS_PER_STEP}`)
    const turns = db.prepare(`SELECT id, session_id, project_dir, branch FROM agent_turns WHERE start_wall_ms >= @from AND start_wall_ms < @to LIMIT ${ROWS_PER_STEP}`)
    let n = this.removeById('agent_events', () => events.all({ from, to }) as { id: number }[])
    n += this.removeById('agent_turns', () => turns.all({ from, to }) as { id: number }[])
    const own = 't.agent = agent_sessions.agent AND t.session_id = agent_sessions.session_id'
    immediateRetrying(db, () => {
      db.prepare('UPDATE agent_events SET end_wall_ms = @from WHERE wall_ms < @from AND end_wall_ms > @from').run({ from })
      db.prepare(
        `UPDATE agent_turns SET last_activity_wall_ms = min(last_activity_wall_ms, @from), end_wall_ms = CASE WHEN end_wall_ms > @from THEN @from ELSE end_wall_ms END
         WHERE start_wall_ms < @from AND (last_activity_wall_ms > @from OR end_wall_ms > @from)`,
      ).run({ from })
      n += db.prepare(`DELETE FROM agent_sessions WHERE last_wall_ms >= @from AND first_wall_ms < @to AND NOT EXISTS (SELECT 1 FROM agent_turns t WHERE ${own}) AND first_wall_ms >= @from`).run({ from, to }).changes
      db.prepare(
        `UPDATE agent_sessions SET
           first_wall_ms = (SELECT min(start_wall_ms) FROM agent_turns t WHERE ${own}),
           last_wall_ms = (SELECT max(max(last_activity_wall_ms, coalesce(end_wall_ms, 0))) FROM agent_turns t WHERE ${own})
         WHERE last_wall_ms >= @from AND first_wall_ms < @to AND EXISTS (SELECT 1 FROM agent_turns t WHERE ${own})`,
      ).run({ from, to })
      n += db.prepare(`UPDATE agent_sessions SET last_wall_ms = @from WHERE first_wall_ms < @from AND last_wall_ms > @from AND NOT EXISTS (SELECT 1 FROM agent_turns t WHERE ${own})`).run({ from }).changes
      // A log read since the range began may hold parser state (open turn, folder, message fingerprints) from inside it.
      db.prepare('UPDATE agent_sources SET state = NULL WHERE updated_wall_ms >= @from AND state IS NOT NULL').run({ from })
    })
    return n
  }

  /**
   * Agent records of sessions known to have run in the app, for the time they ran in it within [from, to): the
   * sessions with a span in it, and their subagents at any depth, each record judged by the app its session resolves
   * to at its time (a subagent with a span of its own elsewhere stays). A session left with no turns goes. Sessions
   * whose app is not known stay.
   */
  private deleteAgentHost(app: string, from: number, to: number): number {
    const db = this.db
    const look = dbHostLookup(db)
    const roots = db.prepare('SELECT DISTINCT agent, session_id FROM agent_hosts WHERE lower(app_id) = ?').all(app) as { agent: Agent; session_id: string }[]
    const children = db.prepare('SELECT session_id FROM agent_sessions WHERE agent = ? AND parent_session_id = ?')
    const sessions = new Map<string, { agent: Agent; session: string }>()
    for (const queue = roots.map((x) => ({ agent: x.agent, session: x.session_id })); queue.length > 0; ) {
      const next = queue.shift()!
      const k = `${next.agent}\n${next.session}`
      if (sessions.has(k)) continue
      sessions.set(k, next)
      for (const c of children.all(next.agent, next.session) as { session_id: string }[]) queue.push({ agent: next.agent, session: c.session_id })
    }
    const inApp = (agent: Agent, session: string, at: number) => resolveHost(look, agent, session, at)?.app_id?.toLowerCase() === app
    const pages = {
      agent_events: db.prepare(`SELECT id, wall_ms AS at FROM agent_events WHERE agent = @agent AND session_id = @session AND wall_ms >= @from AND wall_ms < @to AND id > @after ORDER BY id LIMIT ${ROWS_PER_STEP}`),
      agent_turns: db.prepare(`SELECT id, start_wall_ms AS at FROM agent_turns WHERE agent = @agent AND session_id = @session AND start_wall_ms >= @from AND start_wall_ms < @to AND id > @after ORDER BY id LIMIT ${ROWS_PER_STEP}`),
    }
    let n = 0
    // Session rows go only after every record is judged: a subagent resolves through its parent's row.
    const affected: { agent: Agent; session: string }[] = []
    for (const { agent, session } of sessions.values()) {
      let removed = 0
      for (const [table, page] of Object.entries(pages)) {
        const del = db.prepare(`DELETE FROM ${table} WHERE id = ?`)
        for (let after = 0; ; ) {
          const rows = page.all({ agent, session, from, to, after }) as { id: number; at: number }[]
          if (rows.length === 0) break
          removed += this.removeRows(del, rows.filter((row) => inApp(agent, session, row.at)))
          after = rows[rows.length - 1]!.id
        }
      }
      n += removed
      const ownSpan = db.prepare(
        `SELECT 1 FROM agent_hosts h WHERE h.agent = ? AND h.session_id = ? AND lower(h.app_id) = ? AND h.from_wall_ms < ?
           AND coalesce((SELECT min(x.from_wall_ms) FROM agent_hosts x WHERE x.agent = h.agent AND x.session_id = h.session_id AND x.from_wall_ms > h.from_wall_ms), ${Number.MAX_SAFE_INTEGER}) > ?`,
      ).get(agent, session, app, to, from)
      if (removed > 0 || ownSpan !== undefined) affected.push({ agent, session })
    }
    for (const { agent, session } of affected) {
      immediateRetrying(db, () => {
        n += db.prepare(`DELETE FROM agent_sessions WHERE agent = ? AND session_id = ? AND NOT EXISTS (SELECT 1 FROM agent_turns t WHERE t.agent = agent_sessions.agent AND t.session_id = agent_sessions.session_id)`).run(agent, session).changes
        // Parser state of the session's logs can describe what was removed (an open turn, message fingerprints).
        db.prepare('UPDATE agent_sources SET state = NULL WHERE agent = ? AND session_id = ? AND state IS NOT NULL').run(agent, session)
      })
    }
    return n
  }

  /**
   * Removes rows by id until `candidates` names none. Candidates are read outside any write transaction, which also
   * brings their pages into the cache, and each transaction removes them one at a time until FTS_STEP_MS has passed:
   * a batch sized by how long the last one took can still meet pages the disk has to supply, with the lock held.
   */
  private removeById(table: string, candidates: () => { id: number }[]): number {
    const del = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`)
    let total = 0
    for (let rows = candidates(); rows.length > 0; rows = candidates()) total += this.removeRows(del, rows)
    return total
  }

  private removeRows(del: Database.Statement, rows: readonly { id: number }[]): number {
    let total = 0
    for (let i = 0; i < rows.length; ) {
      const batch = rows.slice(i)
      i += immediateRetrying(this.db, () => timeBoxed(batch, ({ id }) => (total += del.run(id).changes)))
    }
    return total
  }

  private withFtsRemoval<T>(fn: () => T): T {
    return immediateRetrying(this.db, () => ftsRemoval(this.db, fn))
  }

  /** Retention, off the capture thread: batches until nothing is older than the cutoff, then the log is purged. */
  prune(cutoff: number | null, logKeepFrom: number): PruneResult {
    const r: PruneResult = { removed: 0, data: 0, batches: 0, maxTransactionMs: 0, purged: true }
    if (cutoff !== null) warmSearchIndex(this.db)
    for (;;) {
      const step = pruneStep(this.db, cutoff, logKeepFrom, ROWS_PER_STEP, (ms) => (r.maxTransactionMs = Math.max(r.maxTransactionMs, ms)))
      r.removed += step.removed
      r.data += step.data
      r.batches++
      if (step.removed === 0) break
    }
    try {
      r.purged = this.db.prepare(`SELECT 1 FROM meta WHERE key = 'retention_purge_pending'`).get() === undefined || this.checkpointRetention()
    } catch (err) {
      // The removal is done either way; without a scrub it stays unpurged, and storage's retries report why.
      if (!(err instanceof ScrubUnavailableError)) throw err
      r.purged = false
    }
    return r
  }

  /** Checkpoints and, if it completed, clears the retention purge marker; false while a reader still holds old pages. */
  checkpointRetention(): boolean {
    if (!this.scrubIfPending() || !this.checkpoint()) return false
    immediateRetrying(this.db, () => this.db.prepare(`DELETE FROM meta WHERE key = 'retention_purge_pending'`).run())
    return true
  }

  /**
   * Zeroes free space inside every b-tree page once since the last removal, in slices that each hold the lock for
   * about FTS_STEP_MS and give capture the lock first, so the checkpoint after it leaves no removed text on disk.
   * Throws ScrubUnavailableError when the scrub cannot run (scrubBlocked): nothing is then reported purged.
   */
  scrubIfPending(): boolean {
    this.mergeSearchIfPending()
    const markers = this.db.prepare(SCRUB_MARKERS).all() as { key: string; value: string }[]
    if (markers.length === 0) return true
    const blocked = scrubBlocked(this.db)
    if (blocked !== null) throw new ScrubUnavailableError(blocked)
    scrubAll(this.db, FTS_STEP_MS, (fn) => immediateRetrying(this.db, fn))
    immediateRetrying(this.db, () => {
      const clear = this.db.prepare('DELETE FROM meta WHERE key = ? AND value = ?')
      for (const m of markers) clear.run(m.key, m.value)
    })
    return true
  }

  /**
   * Merges the search index once since the last removal of search entries, in steps that each hold the lock for about
   * FTS_STEP_MS and give capture the lock first. A removal leaves the entry in its segment and adds a delete marker
   * that carries the same terms. A merge drops an entry whose marker is among its inputs, but it drops the marker
   * itself only when its output is the oldest segment (FTS5's fts5IndexMergeLevel). So the index is clean once a merge
   * of every segment that existed when the round began has finished with its output the oldest segment at every step.
   * One merge of all segments is started per round (startMergeRound); later steps continue it, so segments capture
   * adds meanwhile neither join nor restart it. Each step owes a scrub: the pages it replaces leave free space behind.
   */
  mergeSearchIfPending(onTransaction: (ms: number) => void = () => {}): void {
    const db = this.db
    const marker = db.prepare(`SELECT value FROM meta WHERE key = 'fts_merge_pending'`).pluck().get() as string | undefined
    if (marker === undefined) return
    warmSearchIndex(db)
    const changes = db.prepare('SELECT total_changes() AS n').pluck()
    const leaf = db.prepare('SELECT block FROM search_data WHERE id = ?').pluck()
    const autocheckpoint = db.pragma('wal_autocheckpoint', { simple: true }) as number
    db.pragma('wal_autocheckpoint = 0')
    let pages = MERGE_PAGES
    const step = <T>(fn: () => T): T => {
      const t = performance.now()
      const out = immediateRetrying(db, () => {
        const n = changes.get() as number
        const r = fn()
        // The merge command itself counts as one change.
        if ((changes.get() as number) - n >= 2) db.prepare(SCRUB_PENDING).run()
        return r
      })
      const ms = performance.now() - t
      onTransaction(ms)
      db.pragma('wal_checkpoint(PASSIVE)')
      if (ms > FTS_STEP_MS) pages = Math.max(1, Math.floor(pages / 2))
      else if (ms < FTS_STEP_MS / 2) pages = Math.min(MAX_MERGE_PAGES, Math.ceil(pages * 1.5))
      return out
    }
    // FTS5 rejects a bound value for the page count.
    const merge = (n: number) => db.exec(`INSERT INTO search (search, rank) VALUES ('merge', ${n})`)
    try {
      for (;;) {
        const round = step(() => startMergeRound(db, pages, merge, leaf))
        if (round === 'clean') break
        if (round === 'prepared') continue
        let { oldest } = round
        let ours = round.inProgress
        for (;;) {
          const settled = step(() => {
            const s = readStructure(db)!
            if (ours) {
              if (!oursInProgress(s, round)) ours = false
              else if (oldest && !outputIsOldest(s, round.level)) throw new Error('the search index merge left the oldest segment; nothing is reported purged')
            }
            if (!ours && s.levels.every((l) => l.nMerge === 0)) {
              // A partly merged segment always belongs to a merge in progress, so with none in progress a segment
              // of the round's start is either gone or exactly as it was.
              if (round.start.some((x) => intact(s, x, leaf))) oldest = false
              return true
            }
            merge(pages)
            if (ours && !oursInProgress(readStructure(db)!, round)) ours = false
            return false
          })
          if (settled) break
        }
        if (oldest) break
      }
    } finally {
      db.pragma(`wal_autocheckpoint = ${autocheckpoint}`)
    }
    immediateRetrying(db, () => db.prepare(`DELETE FROM meta WHERE key = 'fts_merge_pending' AND value = ?`).run(marker))
  }

  /** A scrub owed by any removal, then the checkpoint: true once no old copy is left in the files. */
  purgeFile(): boolean {
    return this.scrubIfPending() && this.checkpoint()
  }

  /** Moves old pages out of the write-ahead log; false while a reader's snapshot still holds them. Waits only briefly. */
  checkpoint(): boolean {
    const wait = this.db.pragma('busy_timeout', { simple: true }) as number
    this.db.pragma('busy_timeout = 100')
    try {
      const [res] = this.db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number; log: number; checkpointed: number }[]
      return res !== undefined && res.busy === 0 && res.log === 0
    } finally {
      this.db.pragma(`busy_timeout = ${wait}`)
    }
  }

  private work(tombstoneId: number, kind: 'doc_hour' | 'hour' | 'thread' | 'read', limit: number): number[] {
    return (this.db.prepare('SELECT ref FROM deletion_work WHERE tombstone_id = ? AND kind = ? ORDER BY ref LIMIT ?').all(tombstoneId, kind, limit) as { ref: number }[]).map((r) => r.ref)
  }

  private done(tombstoneId: number, kind: string, refs: number[]): void {
    const del = this.db.prepare('DELETE FROM deletion_work WHERE tombstone_id = ? AND kind = ? AND ref = ?')
    for (const ref of refs) del.run(tombstoneId, kind, ref)
  }

  /** `stopAfter` ends the run after a step, as a crash there would (tests). */
  run(tombstoneId: number, nowWallMs: number, opts: { stopAfter?: DeletionStep } = {}): DeletionResult {
    const db = this.db
    const t = db.prepare('SELECT id, kind, from_wall_ms, to_wall_ms, app_id, site, state FROM deletions WHERE id = ?').get(tombstoneId) as Tombstone | undefined
    const r: DeletionResult = { tombstone: tombstoneId, observations: 0, intervals: 0, searchDocs: 0, hoursRemoved: 0, hoursCleared: 0, assistantReads: 0, agentRecords: 0, purged: false }
    if (!t) return r
    const stop = (step: DeletionStep) => {
      if (opts.stopAfter === step) throw new Error(`stopped after ${step}`)
    }
    const rules = new Rules(db, () => nowWallMs)
    const derived = new Derived(db, { cut: (s, e, row) => rules.cut(s, e, row), admit: (row) => rules.accepts(row.event_wall_ms, row.app_id, row.url) })
    const args = bounds(t)
    const { from, to } = args
    const bounded = t.from_wall_ms !== null && t.to_wall_ms !== null
    const pre = prefilter(db, t)
    const ivMatch = intervalMatch(t)
    const matches = (o: { app_id: string | null; url?: string | null }) => tombstoneMatches(t, o.app_id, o.url ?? null)

    if (t.kind === 'site') {
      // Before the browser step there are no page addresses, so no observation can belong to a site.
      const withUrl = hasUrl(db)
      const page = withUrl
        ? db.prepare(`SELECT id, app_id, url, title FROM observations WHERE url IS NOT NULL AND event_wall_ms >= @from AND event_wall_ms < @to AND id > @after ORDER BY id LIMIT 2000`)
        : null
      const del = db.prepare('DELETE FROM observations WHERE id = ?')
      for (let after = 0; page !== null; ) {
        const rows = page.all({ ...args, after }) as Obs[]
        if (rows.length === 0) break
        r.observations += this.removeRows(del, rows.filter(matches))
        after = rows[rows.length - 1]!.id
      }
    } else {
      const candidates = db.prepare(`SELECT id, app_id, title FROM observations WHERE event_wall_ms >= @from AND event_wall_ms < @to AND ${pre} LIMIT ${ROWS_PER_STEP}`)
      r.observations += this.removeById('observations', () => candidates.all(args) as { id: number }[])
    }
    stop('observations')
    const ivCandidates = db.prepare(`SELECT id, app_id, site, title FROM intervals WHERE ${ivMatch} AND start_wall_ms >= @from AND start_wall_ms < @to LIMIT ${ROWS_PER_STEP}`)
    r.intervals += this.removeById('intervals', () => ivCandidates.all(args) as { id: number }[])
    if (t.to_wall_ms !== null) {
      // Rows around the range (trimmed, split, or whose next row is gone) get their intervals again; with no start,
      // only those around its end.
      for (let at: number | null = bounded ? from : to, rows = 200; at !== null; ) {
        const s: number = at
        const t0 = performance.now()
        at = immediateRetrying(db, () => derived.rederiveStep(s, to, rows))
        const ms = performance.now() - t0
        rows = ms > FTS_STEP_MS ? Math.max(20, Math.floor(rows / 2)) : ms < FTS_STEP_MS / 2 ? Math.min(5000, Math.ceil(rows * 1.5)) : rows
      }
    }
    stop('intervals')

    // Search: entries in hours wholly inside the range (or, across all time, every entry of the app or site) go by
    // query; hours cut by a range edge are rebuilt from the intervals that remain, as planned.
    const inside = `hour_start_wall_ms >= @from AND hour_start_wall_ms + ${HOUR_MS} <= @to AND ${ivMatch}`
    warmSearchIndex(db)
    const docIds = db.prepare(`SELECT id FROM search_docs WHERE kind = 'activity' AND ${inside} LIMIT ${DOCS_PER_STEP}`)
    const delDoc = db.prepare('DELETE FROM search_docs WHERE id = ?')
    for (let ids = docIds.all(args) as { id: number }[]; ids.length > 0; ids = docIds.all(args) as { id: number }[]) {
      const batch = ids
      r.searchDocs += this.withFtsRemoval(() => timeBoxed(batch, ({ id }) => delDoc.run(id)))
    }
    const docCount = db.prepare(`SELECT count(*) AS n FROM search_docs WHERE kind = 'activity'`)
    for (let hours = this.work(tombstoneId, 'doc_hour', HOURS_PER_STEP); hours.length > 0; hours = this.work(tombstoneId, 'doc_hour', HOURS_PER_STEP)) {
      const batch = hours
      r.searchDocs += this.withFtsRemoval(() => {
        const before = (docCount.get() as { n: number }).n
        const ran = timeBoxed(batch, (h) => derived.rebuildDocs([h]))
        this.done(tombstoneId, 'doc_hour', batch.slice(0, ran))
        return Math.max(0, before - (docCount.get() as { n: number }).n)
      })
    }
    if (t.kind === 'range' && hasAgentTables(db)) r.agentRecords += this.deleteAgentRange(from, to)
    if (t.kind === 'source' && t.app_id !== null && hasAgentTables(db) && hasAgentHosts(db)) r.agentRecords += this.deleteAgentHost(t.app_id, from, to)
    if (t.kind === 'range') {
      immediateRetrying(db, () => {
        db.prepare('UPDATE capture_gaps SET end_wall_ms = ? WHERE start_wall_ms < ? AND end_wall_ms > ?').run(from, from, from)
        db.prepare(`DELETE FROM capture_gaps WHERE start_wall_ms >= ? AND start_wall_ms < ? AND reason != 'paused'`).run(from, to)
      })
    }
    stop('search')

    // Hours: wholly inside a deleted range they go; otherwise the hour loses its text and waits for a rewrite.
    for (let ids = this.work(tombstoneId, 'hour', HOURS_PER_STEP); ids.length > 0; ids = this.work(tombstoneId, 'hour', HOURS_PER_STEP)) {
      const batch = ids
      this.withFtsRemoval(() => {
        const ran = timeBoxed(batch, (id) => {
          const h = db.prepare('SELECT id, start_wall_ms, end_wall_ms, sources FROM hours WHERE id = ?').get(id) as
            | { id: number; start_wall_ms: number; end_wall_ms: number; sources: string }
            | undefined
          if (!h) return
          if (t.kind === 'range' && h.start_wall_ms >= from && h.end_wall_ms <= to) {
            db.prepare('DELETE FROM search_docs WHERE hour_id = ?').run(h.id)
            db.prepare('DELETE FROM hours WHERE id = ?').run(h.id)
            r.hoursRemoved++
          } else {
            clearHour(db, h.id, JSON.parse(h.sources) as HourSource[], t, nowWallMs)
            r.hoursCleared++
          }
        })
        this.done(tombstoneId, 'hour', batch.slice(0, ran))
      })
    }
    stop('hours')

    // Threads: one left with no hours goes; one still linked elsewhere keeps its id and waits for a new title.
    for (let ids = this.work(tombstoneId, 'thread', HOURS_PER_STEP); ids.length > 0; ids = this.work(tombstoneId, 'thread', HOURS_PER_STEP)) {
      const batch = ids
      immediateRetrying(db, () => {
        const ran = timeBoxed(batch, (id) => {
          const left = (db.prepare('SELECT count(*) AS n FROM thread_hours WHERE thread_id = ?').get(id) as { n: number }).n
          if (left === 0) db.prepare('DELETE FROM threads WHERE id = ?').run(id)
          else db.prepare(`UPDATE threads SET title = '', needs_rewrite = 1, updated_wall_ms = ? WHERE id = ?`).run(nowWallMs, id)
        })
        this.done(tombstoneId, 'thread', batch.slice(0, ran))
      })
    }
    stop('threads')
    // Reads go as planned: over the range, of the app or site, or of an affected hour.
    const delRead = db.prepare('DELETE FROM assistant_reads WHERE id = ?')
    for (let ids = this.work(tombstoneId, 'read', HOURS_PER_STEP); ids.length > 0; ids = this.work(tombstoneId, 'read', HOURS_PER_STEP)) {
      const batch = ids
      immediateRetrying(db, () => {
        const ran = timeBoxed(batch, (id) => (r.assistantReads += delRead.run(id).changes))
        this.done(tombstoneId, 'read', batch.slice(0, ran))
      })
    }
    immediateRetrying(db, () => {
      // A thread created inside a deleted range with no hours at all goes too.
      if (t.kind === 'range') db.prepare('DELETE FROM threads WHERE created_wall_ms >= ? AND created_wall_ms < ? AND id NOT IN (SELECT thread_id FROM thread_hours)').run(from, to)
      db.prepare(`DELETE FROM deletion_work WHERE tombstone_id = ?`).run(tombstoneId)
      db.prepare(`DELETE FROM deletion_fence WHERE tombstone_id = ?`).run(tombstoneId)
      db.prepare(`UPDATE deletions SET state = 'done' WHERE id = ? AND state = 'pending'`).run(tombstoneId)
      db.prepare(SCRUB_PENDING).run()
    })
    return r
  }

  /**
   * Moves old pages out of the write-ahead log and marks the tombstone purged; false while a reader's snapshot still
   * holds them (the caller retries). Waits only briefly, since a reader may hold its snapshot for a long time.
   */
  purge(tombstoneId: number): boolean {
    if (!this.scrubIfPending() || !this.checkpoint()) return false
    this.db.prepare(`UPDATE deletions SET state = 'purged' WHERE id = ? AND state = 'done'`).run(tombstoneId)
    return true
  }
}

/** The deletion worker thread, started on first use; jobs run one at a time, in order. */
export class DeletionWorker {
  private worker: Worker | null = null
  private next = 1
  // Each job remembers its worker: a closed worker exiting fails only the jobs it was given.
  private readonly pending = new Map<number, { worker: Worker; resolve: (r: unknown) => void; reject: (e: Error) => void }>()
  private readonly file: string
  private idle: ReturnType<typeof setTimeout> | null = null
  // Shared with the worker: non-zero while capture is writing.
  private readonly want = new Int32Array(new SharedArrayBuffer(4))

  constructor(file: string) {
    this.file = file
  }

  /** Whether any job is queued or running. */
  get busy(): boolean {
    return this.pending.size > 0
  }

  /** Capture is about to write (true) or done (false); the worker starts no write transaction in between. */
  captureWriting(on: boolean): void {
    if (on) Atomics.add(this.want, 0, 1)
    else {
      Atomics.sub(this.want, 0, 1)
      Atomics.notify(this.want, 0)
    }
  }

  // An idle worker holds about 22 MB, so it exits a while after its last job and starts again on the next.
  private static readonly IDLE_EXIT_MS = 30_000

  run(tombstone: number, nowWallMs: number): Promise<DeletionResult> {
    return this.send({ op: 'delete', tombstone, now: nowWallMs }) as Promise<DeletionResult>
  }

  purge(tombstone: number): Promise<boolean> {
    return this.send({ op: 'purge', tombstone }) as Promise<boolean>
  }

  prune(cutoff: number | null, logKeepFrom: number): Promise<PruneResult> {
    return this.send({ op: 'prune', cutoff, logKeepFrom }) as Promise<PruneResult>
  }

  checkpoint(): Promise<boolean> {
    return this.send({ op: 'checkpoint' }) as Promise<boolean>
  }

  purgeFile(): Promise<boolean> {
    return this.send({ op: 'purge_file' }) as Promise<boolean>
  }

  private send(job: Record<string, unknown>): Promise<unknown> {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    const w = this.ensure()
    const id = this.next++
    w.ref()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { worker: w, resolve, reject })
      w.postMessage({ id, ...job })
    })
  }

  private ensure(): Worker {
    if (this.worker) return this.worker
    // The worker is a sibling module: .ts when run from source, .js when built.
    const ext = path.extname(fileURLToPath(import.meta.url))
    const w = new Worker(new URL(`./deletionWorker${ext}`, import.meta.url), { workerData: { file: this.file, want: this.want } })
    w.on('message', (m: { id: number; result?: unknown; error?: string }) => {
      const p = this.pending.get(m.id)
      this.pending.delete(m.id)
      if (![...this.pending.values()].some((p) => p.worker === w)) {
        w.unref()
        this.idle = setTimeout(() => void this.close(), DeletionWorker.IDLE_EXIT_MS)
        this.idle.unref()
      }
      if (!p) return
      if (m.error === undefined) p.resolve(m.result)
      else p.reject(new Error(m.error))
    })
    w.on('error', (err) => this.failAll(w, err as Error))
    w.on('exit', () => {
      if (this.worker === w) this.worker = null
      this.failAll(w, new Error('deletion worker stopped'))
    })
    this.worker = w
    return w
  }

  private failAll(w: Worker, err: Error): void {
    for (const [id, p] of this.pending) {
      if (p.worker !== w) continue
      this.pending.delete(id)
      p.reject(err)
    }
  }

  async close(): Promise<void> {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    const w = this.worker
    this.worker = null
    if (w) await w.terminate()
  }
}
