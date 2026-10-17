// Hours as every reader sees them, and the writes both the main thread and the deletion worker make to them.
import type Database from 'better-sqlite3'
import { nfc } from './derive.ts'
import { fencedBy, matchesSite, pendingTombstones, type Tombstone } from './rules.ts'

export type HourField = 'title' | 'summary' | 'detail' | 'outcome' | 'suggestion'
export const HOUR_FIELDS: readonly HourField[] = ['title', 'summary', 'detail', 'outcome', 'suggestion']

export interface HourSource {
  app_id?: string
  site?: string
}

export interface Hour {
  id: number
  start_wall_ms: number
  end_wall_ms: number
  tz: string
  status: 'facts' | 'written'
  title: string | null
  summary: string | null
  detail: string | null
  outcome: string | null
  suggestion: string | null
  sources: HourSource[]
  writer: string | null
  version: number
  needs_rewrite: boolean
  // Fields where the user's correction replaced the written text.
  corrected: HourField[]
}

/** What a pending deletion will do to an hour: remove it, clear its text, or nothing. Readers apply it at once. */
export function pendingVerdict(h: { start_wall_ms: number; end_wall_ms: number; sources: HourSource[] }, pending: readonly Tombstone[]): { verdict: 'removed' | 'cleared' | null; by: Tombstone[] } {
  let verdict: 'removed' | 'cleared' | null = null
  const by: Tombstone[] = []
  for (const t of pending) {
    const from = t.from_wall_ms ?? Number.NEGATIVE_INFINITY
    const to = t.to_wall_ms ?? Number.POSITIVE_INFINITY
    if (!(h.end_wall_ms > from && h.start_wall_ms < to)) continue
    if (t.kind === 'range' && h.start_wall_ms >= from && h.end_wall_ms <= to) return { verdict: 'removed', by: [t] }
    if (t.kind === 'range' || h.sources.some((s) => sourceMatches(t, s))) {
      verdict = 'cleared'
      by.push(t)
    }
  }
  return { verdict, by }
}

/**
 * For every reader (screens, Ask, the MCP server): the user's latest correction of a field wins over the written text,
 * and a deletion still being carried out already applies.
 */
export function readHour(db: Database.Database, id: number): Hour | null {
  // One read transaction: the hour, its corrections and the fence all come from the same snapshot, so a deletion
  // completing in between cannot leave the old text with no fence to hide it.
  return db.transaction(() => readHourNow(db, id))()
}

function readHourNow(db: Database.Database, id: number): Hour | null {
  const h = db.prepare('SELECT * FROM hours WHERE id = ?').get(id) as (Omit<Hour, 'sources' | 'needs_rewrite' | 'corrected'> & { sources: string; needs_rewrite: number }) | undefined
  if (!h) return null
  const out: Hour = { ...h, sources: JSON.parse(h.sources) as HourSource[], needs_rewrite: h.needs_rewrite === 1, corrected: [] }
  const fence = pendingVerdict(out, pendingTombstones(db))
  // A deletion that fenced this hour when planned applies even after it has cleared the hour's sources.
  for (const t of fencedBy(db, 'hour', id)) {
    if (fence.by.some((b) => b.id === t.id)) continue
    const removes = t.kind === 'range' && (t.from_wall_ms ?? -Infinity) <= out.start_wall_ms && (t.to_wall_ms ?? Infinity) >= out.end_wall_ms
    if (removes) return null
    fence.verdict = 'cleared'
    fence.by.push(t)
  }
  if (fence.verdict === 'removed') return null
  if (fence.verdict === 'cleared') {
    for (const f of HOUR_FIELDS) out[f] = null
    return { ...out, status: 'facts', writer: null, needs_rewrite: true, sources: out.sources.filter((s) => !fence.by.some((t) => sourceMatches(t, s))) }
  }
  const active = db.prepare('SELECT field, text FROM corrections WHERE hour_id = ? AND undone_wall_ms IS NULL ORDER BY id').all(id) as { field: HourField; text: string }[]
  for (const c of active) {
    out[c.field] = c.text
    if (!out.corrected.includes(c.field)) out.corrected.push(c.field)
  }
  return out
}

/** The hour's search entry is its text as readers see it, corrections included. */
export function indexHour(db: Database.Database, id: number): void {
  const h = readHour(db, id)
  db.prepare(`DELETE FROM search_docs WHERE kind = 'hour' AND hour_id = ?`).run(id)
  if (!h) return
  const text = HOUR_FIELDS.map((f) => h[f])
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .join('\n')
  if (text) {
    db.prepare(`INSERT INTO search_docs (kind, hour_start_wall_ms, hour_id, hour_text, first_wall_ms, last_wall_ms) VALUES ('hour', ?, ?, ?, ?, ?)`).run(
      h.start_wall_ms,
      id,
      nfc(text),
      h.start_wall_ms,
      h.end_wall_ms,
    )
  }
}

export function sourceMatches(t: Pick<Tombstone, 'kind' | 'app_id' | 'site'>, s: HourSource): boolean {
  if (t.kind === 'source') return s.app_id?.toLowerCase() === t.app_id
  if (t.kind === 'site') return matchesSite(s.site?.toLowerCase().replace(/^www\./, '') ?? null, t.site!)
  return false
}

// The hour's text and the corrections on it may describe the deleted material; both go, and the hour waits for a rewrite.
export function clearHour(db: Database.Database, id: number, sources: HourSource[], t: Pick<Tombstone, 'kind' | 'app_id' | 'site'>, nowWallMs: number): void {
  const kept = sources.filter((s) => !sourceMatches(t, s))
  db.prepare('DELETE FROM corrections WHERE hour_id = ?').run(id)
  db.prepare(
    `UPDATE hours SET status = 'facts', title = NULL, summary = NULL, detail = NULL, outcome = NULL, suggestion = NULL, writer = NULL,
       sources = ?, needs_rewrite = 1, version = version + 1, updated_wall_ms = ? WHERE id = ?`,
  ).run(JSON.stringify(kept), nowWallMs, id)
  indexHour(db, id)
}
