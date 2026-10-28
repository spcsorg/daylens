// The Apps screen's reads: time by app over a day or a week, and one app's detail.
import type { AppTime, Source } from './types.ts'

export interface AppsView {
  from: string
  days: number
  apps: AppTime[]
  total_ms: number
  per_day: { date: string; total_ms: number }[]
  first_day: string | null
  today: string
}

export interface AppDetail {
  app: AppTime
  hours: number[]
  per_day: { date: string; ms: number }[]
  sources: Source[]
  browser: boolean
}

export type AppsQuery = { q: 'apps'; from: string; days: number } | { q: 'app'; id: string; from: string; days: number }

export interface AppsResults {
  apps: AppsView
  app: AppDetail | null
}
