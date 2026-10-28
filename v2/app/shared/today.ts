// Today's reads: an open hour, where you left off, the week and the month.
import type { AppTime, Source } from './types.ts'

export interface HourDetail {
  start_ms: number
  detail: string | null
  sources: Source[]
}

export interface WeekBlock {
  start_ms: number
  title: string
  written: boolean
}

export interface WeekView {
  start: string
  days: { date: string; total_ms: number; blocks: WeekBlock[] }[]
  apps: AppTime[]
  total_ms: number
  first_day: string | null
  today: string
}

export interface MonthView {
  month: string
  days: { date: string; total_ms: number; apps: AppTime[] }[]
  apps: AppTime[]
  total_ms: number
  first_day: string | null
  today: string
}

export type TodayQuery = { q: 'hour'; start_ms: number } | { q: 'left_off' } | { q: 'week'; start: string } | { q: 'month'; month: string }

export interface TodayResults {
  hour: HourDetail
  left_off: Source[]
  week: WeekView
  month: MonthView
}
