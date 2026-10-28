// What an assistant asked Daylens to change. The MCP server only files a request; the app carries it out through
// the same path as its own buttons: at once for a change that only records less (pause, a new exclusion), and only
// after the person says yes in Daylens for anything that deletes, records more or changes what the record says. A
// request not settled within REQUEST_TTL_MS expires, and a settled one is kept a day, for the log, then removed.
import type Database from 'better-sqlite3'
import type { ChangeBus } from './changes.ts'
import type { Migration } from './migrations.ts'

export const REQUEST_TTL_MS = 10 * 60_000
const KEEP_SETTLED_MS = 86_400_000

export type RequestChange =
  | { kind: 'pause'; until: 'hour' | 'tomorrow' }
  | { kind: 'resume' }
  | { kind: 'exclude'; match: 'app_id' | 'site'; value: string; label: string }
  | { kind: 'unexclude'; match: 'app_id' | 'site'; value: string; label: string }
  | { kind: 'correct'; hour_id: number; hour_start_wall_ms: number; title?: string; summary?: string }
  | { kind: 'delete'; what: { kind: 'last'; ms: number } | { kind: 'range'; from_wall_ms: number; to_wall_ms: number } | { kind: 'app'; app_id: string; label: string; from_wall_ms?: number; to_wall_ms?: number } | { kind: 'site'; site: string; from_wall_ms?: number; to_wall_ms?: number } | { kind: 'everything' } }
  | { kind: 'retention'; days: number | null }

export type RequestState = 'pending' | 'running' | 'done' | 'declined' | 'failed' | 'expired'

export interface AssistantRequest {
  id: number
  assistant: string
  at_wall_ms: number
  change: RequestChange
  state: RequestState
  settled_wall_ms: number | null
  error: string | null
}

/** Whether the change only makes Daylens record less, reversibly, so it runs without asking. */
export function runsWithoutAsking(c: RequestChange): boolean {
  return c.kind === 'pause' || c.kind === 'exclude'
}

export const assistantRequestsMigration: Migration = {
  name: 'assistant_requests',
  up: (db) =>
    db.exec(`
      CREATE TABLE assistant_requests (
        id INTEGER PRIMARY KEY,
        assistant TEXT NOT NULL,
        at_wall_ms INTEGER NOT NULL,
        change TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        settled_wall_ms INTEGER,
        error TEXT
      );
      CREATE INDEX assistant_requests_state ON assistant_requests(state);
    `),
}

interface Row {
  id: number
  assistant: string
  at_wall_ms: number
  change: string
  state: RequestState
  settled_wall_ms: number | null
  error: string | null
}

const fromRow = (r: Row): AssistantRequest => ({ ...r, change: JSON.parse(r.change) as RequestChange })

export function fileRequest(db: Database.Database, bus: ChangeBus, assistant: string, change: RequestChange, now: number): number {
  return bus.commit('assistant_request', {}, () => {
    db.prepare(`DELETE FROM assistant_requests WHERE coalesce(settled_wall_ms, at_wall_ms) < ?`).run(now - KEEP_SETTLED_MS)
    return Number(db.prepare('INSERT INTO assistant_requests (assistant, at_wall_ms, change) VALUES (?, ?, ?)').run(assistant, now, JSON.stringify(change)).lastInsertRowid)
  })
}

export function request(db: Database.Database, id: number): AssistantRequest | null {
  const r = db.prepare('SELECT * FROM assistant_requests WHERE id = ?').get(id) as Row | undefined
  return r ? fromRow(r) : null
}

/** Requests still waiting, oldest first, with those past their time already shown as expired. */
export function pendingRequests(db: Database.Database, now: number): AssistantRequest[] {
  return (db.prepare(`SELECT * FROM assistant_requests WHERE state = 'pending' ORDER BY id`).all() as Row[]).map(fromRow).map((r) => (r.at_wall_ms + REQUEST_TTL_MS <= now ? { ...r, state: 'expired' } : r))
}

/** Requests filed in the last day, newest first. */
export function recentRequests(db: Database.Database, now: number): AssistantRequest[] {
  return (db.prepare(`SELECT * FROM assistant_requests WHERE at_wall_ms >= ? ORDER BY id DESC`).all(now - KEEP_SETTLED_MS) as Row[])
    .map(fromRow)
    .map((r) => (r.state === 'pending' && r.at_wall_ms + REQUEST_TTL_MS <= now ? { ...r, state: 'expired' } : r))
}

/**
 * Moves a request on: pending to running (claimed, about to be carried out), declined or expired; running to done or
 * failed. Anything else is refused, so a request is carried out at most once, and one past its time only expires.
 * Returns whether the request is now in `state`.
 */
export function settleRequest(db: Database.Database, bus: ChangeBus, id: number, state: Exclude<RequestState, 'pending'>, error: string | null, now: number): boolean {
  return bus.commit('assistant_request', { id }, () => {
    const r = db.prepare('SELECT at_wall_ms, state FROM assistant_requests WHERE id = ?').get(id) as { at_wall_ms: number; state: RequestState } | undefined
    const from = state === 'done' || state === 'failed' ? 'running' : 'pending'
    if (!r || r.state !== from) return false
    const final = from === 'pending' && state === 'running' && r.at_wall_ms + REQUEST_TTL_MS <= now ? 'expired' : state
    db.prepare('UPDATE assistant_requests SET state = ?, settled_wall_ms = ?, error = ? WHERE id = ?').run(final, final === 'running' ? null : now, error, id)
    return final === state
  })
}

const when = (ms: number) => new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
/** Without control or direction marks, which could reorder or hide what the person reads. */
export const stripMarks = (t: string) => t.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, ' ')

/** Text an assistant chose, as plain characters: no marks, and no quotes to break out of ours. */
export const plain = (t: string) => stripMarks(t).replace(/["«»“”„‟″〝〞〟＂]/g, "'")
// Names and text come from the assistant, which may have read them off a page: always quoted, never phrasing.
export const quoted = (t: string, max = 120) => `“${plain(t.length > max ? `${t.slice(0, max - 1)}…` : t)}”`
const span = (w: { from_wall_ms?: number; to_wall_ms?: number }) => (w.from_wall_ms !== undefined && w.to_wall_ms !== undefined ? ` from ${when(w.from_wall_ms)} to ${when(w.to_wall_ms)}` : ', on every day')

/** The request in one sentence, built from its fields alone, as the card, the notification and the assistant see it. */
export function describeRequest(c: RequestChange): string {
  switch (c.kind) {
    case 'pause':
      return c.until === 'hour' ? 'Pause recording for an hour' : 'Pause recording until tomorrow'
    case 'resume':
      return 'Resume recording'
    case 'exclude':
      return `Stop recording ${c.match === 'site' ? 'the site' : 'the app'} ${quoted(c.label)}`
    case 'unexclude':
      return `Record ${c.match === 'site' ? 'the site' : 'the app'} ${quoted(c.label)} again`
    case 'correct': {
      const fields = [c.title !== undefined ? `title to ${quoted(c.title, 512)}` : null, c.summary !== undefined ? `summary to ${quoted(c.summary, 512)}` : null].filter(Boolean)
      return `Change the ${when(c.hour_start_wall_ms)} hour’s ${fields.join(' and its ')}`
    }
    case 'delete': {
      const w = c.what
      if (w.kind === 'last') return `Delete everything recorded in the last ${Math.round(w.ms / 60_000)} minutes`
      if (w.kind === 'range') return `Delete everything recorded from ${when(w.from_wall_ms)} to ${when(w.to_wall_ms)}`
      if (w.kind === 'app') return `Delete everything recorded in the app ${quoted(w.label)}${span(w)}`
      if (w.kind === 'site') return `Delete everything recorded on the site ${quoted(w.site)}${span(w)}`
      return 'Delete everything Daylens has recorded'
    }
    case 'retention':
      return c.days === null ? 'Keep history forever' : `Keep only the last ${c.days} days of history, deleting anything older`
  }
}
