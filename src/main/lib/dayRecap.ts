// Tracks whether a day already has a user-facing recap so the morning
// yesterday-recap notification does not repeat work the user already saw.

import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

export interface DayRecapState {
  /** Local YYYY-MM-DD dates with a finalized recap (Analyze Day, day summary, or wrap). */
  recapGeneratedDates?: string[]
}

function statePath(): string {
  return path.join(app.getPath('userData'), 'day-recap-state.json')
}

export function readDayRecapState(): DayRecapState {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as DayRecapState
  } catch {
    return {}
  }
}

export function writeDayRecapState(state: DayRecapState): void {
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2))
}

export function hasDayRecapForDate(dateStr: string): boolean {
  const dates = readDayRecapState().recapGeneratedDates ?? []
  return dates.includes(dateStr)
}

export function recordDayRecapGenerated(dateStr: string): void {
  const state = readDayRecapState()
  const dates = new Set(state.recapGeneratedDates ?? [])
  dates.add(dateStr)
  writeDayRecapState({ recapGeneratedDates: [...dates].sort() })
}
