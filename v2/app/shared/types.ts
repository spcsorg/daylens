// What the reader returns to the screens and the actions they send. Times are wall-clock milliseconds; days are local
// dates (YYYY-MM-DD). Shared by every screen and the shell; each screen's own reads and actions live in its own file.
import type { AiAction, AskEvent, AskQuery, AskResults } from './ai.ts'
import type { AppsQuery, AppsResults } from './apps.ts'
import type { OnboardingAction } from './onboarding.ts'
import type { SearchQuery, SearchResultsByQuery } from './search.ts'
import type { SettingsAction, SettingsQuery, SettingsResults } from './settings.ts'
import type { TodayQuery, TodayResults } from './today.ts'

export interface AppTime {
  id: string
  name: string
  ms: number
}

export type GapReason = 'asleep' | 'locked' | 'idle' | 'paused' | 'excluded' | 'not_running' | 'stopped' | 'nothing'

export interface HourFacts {
  apps: AppTime[]
  // Window titles and page titles, longest first.
  titles: string[]
}

export interface HourRow {
  start_ms: number
  end_ms: number
  current: boolean
  // Written by the engine; null while the hour is facts.
  title: string | null
  summary: string | null
  edited: boolean
  facts: HourFacts
  gap: GapReason | null
  // Paused or stopped inside the current hour: recorded up to here.
  recorded_until_ms: number | null
  // Filled in from browser history alone: the pages opened, with no time spent.
  from_history: boolean
}

export interface DayView {
  date: string
  today: string
  hours: HourRow[]
  total_ms: number
  first_day: string | null
}

export interface Source {
  // visit: a page opened, from browser history; it has no time of its own.
  kind: 'window' | 'page' | 'visit'
  app: AppTime
  title: string
  url: string | null
  site: string | null
  first_ms: number
  last_ms: number
  ms: number
}

export interface PauseInfo {
  since_ms: number
  until_ms: number | null
}

export interface RecordingView {
  pause: PauseInfo | null
  // An open gap where titles could not be read, and why.
  titles: 'ok' | 'no_permission' | 'degraded' | 'stalled' | null
  stopped_since_ms: number | null
  last_heartbeat_ms: number | null
  first_day: string | null
  // Earliest recorded moment of the current day, and whether earlier hours came from history.
  today_first_ms: number | null
  agents: { agent: string; state: string }[]
  // Browsers whose history Daylens reads.
  browsers: { name: string; app_id: string; state: 'ok' | 'unreadable' }[]
}

// Reads every screen or the shell makes; a screen's own reads are in its file.
type CoreQuery = { q: 'day'; date: string } | { q: 'recorded_days'; month: string } | { q: 'recording' } | { q: 'app_path'; id: string }

interface CoreResults {
  day: DayView
  recorded_days: string[]
  recording: RecordingView
  app_path: string | null
}

export type Query = CoreQuery | TodayQuery | AppsQuery | SearchQuery | SettingsQuery | AskQuery

export interface QueryResult extends CoreResults, TodayResults, AppsResults, SearchResultsByQuery, SettingsResults, AskResults {}

// Changes the reader announces so screens refetch: activity (new observations), or a shared-state change.
export type ReaderEvent = { e: 'changed'; kinds: string[] } | { e: 'activity' } | AskEvent

export type DeleteWhat =
  | { kind: 'last'; ms: number }
  | { kind: 'range'; from_wall_ms: number; to_wall_ms: number }
  | { kind: 'app'; app_id: string; from_wall_ms?: number; to_wall_ms?: number }
  | { kind: 'site'; site: string; from_wall_ms?: number; to_wall_ms?: number }
  | { kind: 'everything' }

// Actions more than one screen, the menu bar or the shell sends; a screen's own actions are in its file.
type CoreAction =
  | { a: 'pause'; until: 'hour' | 'tomorrow' | 'until_resumed' }
  | { a: 'resume' }
  | { a: 'delete'; what: DeleteWhat; never?: { match: 'app_id' | 'site'; value: string; label: string } }
  | { a: 'exclude'; rule: { match: 'app_id' | 'site'; value: string; label: string } }
  | { a: 'open_url'; url: string }
  | { a: 'open_app'; id: string }
  | { a: 'open_settings_privacy' }
  | { a: 'restart_capture' }
  | { a: 'bench'; marks: Record<string, number> }

export type Action = CoreAction | SettingsAction | OnboardingAction | AiAction

export interface ShellState {
  platform: string
  login_item: boolean
  appearance: 'light' | 'dark' | 'system'
  onboarded: boolean
  helper: { running: boolean; accessibility: string | null; titles: string | null }
  capture: 'starting' | 'running' | 'stopped' | 'failed'
  capture_error: string | null
  bench: boolean
}

export type ActionResult = { ok: true; result?: unknown } | { ok: false; error: string }
