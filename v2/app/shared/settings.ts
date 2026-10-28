// Settings' reads and actions: what is kept out, how long history is kept, login and appearance.
import type { AppTime } from './types.ts'

export interface Exclusion {
  match: 'app_id' | 'exe' | 'site'
  value: string
  label: string
  is_default: boolean
}

export interface PrivacyView {
  exclusions: Exclusion[]
  retention_days: number | null
  // Apps seen recently, to pick one to keep out.
  seen_apps: AppTime[]
}

export type SettingsQuery = { q: 'privacy' }

export interface SettingsResults {
  privacy: PrivacyView
}

export type SettingsAction =
  | { a: 'unexclude'; match: 'app_id' | 'exe' | 'site'; value: string }
  | { a: 'retention'; days: number | null }
  | { a: 'login_item'; on: boolean }
  | { a: 'appearance'; mode: 'light' | 'dark' | 'system' }
