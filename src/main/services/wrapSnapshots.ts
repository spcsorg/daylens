// Frozen daily wrap snapshots — weekly/monthly wraps sum these instead of
// re-aggregating live blocks so stat cards and narrative always agree.

import type { Database } from 'better-sqlite3'
import {
  freezeDailyWrapSnapshot as freezeDailyWrapSnapshotQuery,
  getFrozenWrapSnapshotsForDates,
  sumFrozenWrapSnapshots,
} from '../db/queries'
import { buildWrappedFactsFromPayload } from '../lib/wrappedNarrative'
import { getTimelineDayPayload } from './workBlocks'
import { getDb } from './database'

export interface FrozenDayWrapSnapshot {
  date: string
  totalSeconds: number
  workSeconds: number
  leisureSeconds: number
  dominantWorkSubject: string | null
  factsJson: string
  frozenAt: number
}

export function freezeWrapSnapshotForDate(db: Database, dateStr: string, liveSession: ReturnType<typeof import('./tracking').getCurrentSession> | null = null): FrozenDayWrapSnapshot | null {
  const payload = getTimelineDayPayload(db, dateStr, liveSession)
  const facts = buildWrappedFactsFromPayload(payload)
  if (facts.quality === 'empty' || facts.quality === 'tooEarly') return null

  const dominantWorkSubject = facts.mattered.find((m) => m.intentSubject)?.intentSubject
    ?? facts.mattered[0]?.label
    ?? null

  return freezeDailyWrapSnapshotQuery(db, {
    date: dateStr,
    totalSeconds: facts.totalSeconds,
    workSeconds: facts.kindBreakdown?.work ?? facts.totalSeconds,
    leisureSeconds: facts.kindBreakdown?.leisure ?? 0,
    dominantWorkSubject,
    factsJson: JSON.stringify(facts),
  })
}

export function getFrozenSnapshots(db: Database, dates: string[]): FrozenDayWrapSnapshot[] {
  return getFrozenWrapSnapshotsForDates(db, dates)
}

export function sumFrozenDays(db: Database, dates: string[]): {
  totalSeconds: number
  workSeconds: number
  leisureSeconds: number
  daysWithActivity: number
} {
  return sumFrozenWrapSnapshots(db, dates)
}

export function freezeWrapSnapshotForDateFromMain(dateStr: string): FrozenDayWrapSnapshot | null {
  return freezeWrapSnapshotForDate(getDb(), dateStr, null)
}
