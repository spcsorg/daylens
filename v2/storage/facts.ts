// What was recorded in a span of time, read as one snapshot for the engine to write hours from.
import type Database from 'better-sqlite3'
import { presenceFromCapture, type PresenceInputs } from '../capture/agents/attribution.ts'
import type { EventRow, TurnRow } from '../capture/agents/store.ts'
import type { GapScope } from '../capture/normalize.ts'
import type { IntervalRow } from './derive.ts'

export interface FactInterval extends IntervalRow {
  // 'focus': the app and window in front; 'page': the page a browser showed in that time.
  kind: 'focus' | 'page'
  window: string | null
  // Daylens lost the ability to read this title from this time on, so the title is not evidence of current work.
  possibly_stale_since_wall_ms: number | null
}

export interface FactGap {
  id: number
  reason: string
  scope: GapScope
  start_wall_ms: number
  // null: still open.
  end_wall_ms: number | null
}

export interface HourFacts {
  intervals: FactInterval[]
  gaps: FactGap[]
  presence: PresenceInputs
  turns: TurnRow[]
  events: EventRow[]
}

export function readFacts(db: Database.Database, agents: { turns(from: number, to: number): TurnRow[]; events(from: number, to: number): EventRow[] } | null, from: number, to: number): HourFacts {
  const intervals = db
    .prepare(
      `SELECT i.obs_id, i.start_wall_ms, i.end_wall_ms, i.tz_offset_min, i.app_id, i.app_name, i.title, i.title_state, i.url, i.site, i.files,
              o.kind, o.window, o.possibly_stale_since_wall_ms
       FROM intervals i LEFT JOIN observations o ON o.id = i.obs_id
       WHERE i.start_wall_ms < ? AND i.end_wall_ms > ? ORDER BY i.start_wall_ms, i.obs_id`,
    )
    .all(to, from) as FactInterval[]
  const gaps = db
    .prepare(
      `SELECT id, reason, scope, start_wall_ms, end_wall_ms FROM capture_gaps
       WHERE start_wall_ms < ? AND coalesce(end_wall_ms, ?) > ? ORDER BY start_wall_ms, id`,
    )
    .all(to, Number.MAX_SAFE_INTEGER, from) as FactGap[]
  return {
    intervals,
    gaps,
    presence: presenceFromCapture(db, from, to),
    turns: agents?.turns(from, to) ?? [],
    events: agents?.events(from, to) ?? [],
  }
}
