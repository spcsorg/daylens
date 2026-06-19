// Frozen daily wrap snapshots — weekly/monthly wraps sum these instead of
// re-aggregating live blocks so stat cards and narrative always agree.

import type { Database } from 'better-sqlite3'
import {
  freezeDailyWrapSnapshot as freezeDailyWrapSnapshotQuery,
  getFrozenWrapSnapshotsForDates,
  sumFrozenWrapSnapshots,
} from '../db/queries'
import { buildWrappedFactsFromPayload } from '../lib/wrappedNarrative'
import { buildWeekDateRange } from '../lib/weekDateRange'
import { getTimelineDayPayload } from './workBlocks'
import { getDb } from './database'
import type { AppCategory } from '@shared/types'

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

export interface WeekDayWrapAggregate {
  date: string
  totalSeconds: number
  workSeconds: number
  leisureSeconds: number
  source: 'frozen' | 'live'
  dominantWorkSubject: string | null
  dominantCategory: AppCategory | 'unknown'
}

export interface WeekWrapAggregateBundle {
  weekStart: string
  weekEnd: string
  days: WeekDayWrapAggregate[]
  totalSeconds: number
  workSeconds: number
  leisureSeconds: number
  daysWithActivity: number
  frozenDayCount: number
}

function dominantCategoryFromFactsJson(factsJson: string): AppCategory | 'unknown' {
  try {
    const facts = JSON.parse(factsJson) as { dominantCategory?: AppCategory }
    return facts.dominantCategory ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function liveDayAggregate(db: Database, date: string): WeekDayWrapAggregate {
  const payload = getTimelineDayPayload(db, date, null)
  const facts = buildWrappedFactsFromPayload(payload)
  return {
    date,
    totalSeconds: facts.totalSeconds,
    workSeconds: facts.kindBreakdown?.work ?? 0,
    leisureSeconds: facts.kindBreakdown?.leisure ?? 0,
    source: 'live',
    dominantWorkSubject: facts.mattered[0]?.intentSubject ?? facts.mattered[0]?.label ?? null,
    dominantCategory: facts.dominantCategory ?? 'unknown',
  }
}

/** Prefer frozen daily snapshots; fall back to live blocks for days not yet frozen. */
export function getWeekWrapAggregates(db: Database, weekStartStr: string): WeekWrapAggregateBundle {
  const { weekStart, weekEnd, dates } = buildWeekDateRange(weekStartStr)
  const frozenByDate = new Map(
    getFrozenWrapSnapshotsForDates(db, dates).map((row) => [row.date, row]),
  )

  const days = dates.map((date) => {
    const frozen = frozenByDate.get(date)
    if (frozen && frozen.totalSeconds > 0) {
      return {
        date,
        totalSeconds: frozen.totalSeconds,
        workSeconds: frozen.workSeconds,
        leisureSeconds: frozen.leisureSeconds,
        source: 'frozen' as const,
        dominantWorkSubject: frozen.dominantWorkSubject,
        dominantCategory: dominantCategoryFromFactsJson(frozen.factsJson),
      }
    }
    return liveDayAggregate(db, date)
  })

  const activeDays = days.filter((day) => day.totalSeconds > 0)
  return {
    weekStart,
    weekEnd,
    days,
    totalSeconds: activeDays.reduce((sum, day) => sum + day.totalSeconds, 0),
    workSeconds: activeDays.reduce((sum, day) => sum + day.workSeconds, 0),
    leisureSeconds: activeDays.reduce((sum, day) => sum + day.leisureSeconds, 0),
    daysWithActivity: activeDays.length,
    frozenDayCount: activeDays.filter((day) => day.source === 'frozen').length,
  }
}

export function getWrapAggregatesForDates(db: Database, dates: string[]): WeekDayWrapAggregate[] {
  const frozenByDate = new Map(
    getFrozenWrapSnapshotsForDates(db, dates).map((row) => [row.date, row]),
  )
  return dates.map((date) => {
    const frozen = frozenByDate.get(date)
    if (frozen && frozen.totalSeconds > 0) {
      return {
        date,
        totalSeconds: frozen.totalSeconds,
        workSeconds: frozen.workSeconds,
        leisureSeconds: frozen.leisureSeconds,
        source: 'frozen' as const,
        dominantWorkSubject: frozen.dominantWorkSubject,
        dominantCategory: dominantCategoryFromFactsJson(frozen.factsJson),
      }
    }
    return liveDayAggregate(db, date)
  })
}

export function getWrapAggregatesForDatesFromMain(dates: string[]): WeekDayWrapAggregate[] {
  return getWrapAggregatesForDates(getDb(), dates)
}

export function getWeekWrapAggregatesFromMain(weekStartStr: string): WeekWrapAggregateBundle {
  return getWeekWrapAggregates(getDb(), weekStartStr)
}
