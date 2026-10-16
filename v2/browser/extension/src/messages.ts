// Between the popup and the background script.

export type PauseFor = 'hour' | 'tomorrow' | 'until_resumed'

export type PopupRequest = { t: 'status' } | { t: 'pause'; for: PauseFor } | { t: 'resume' } | { t: 'open' }

export interface PopupState {
  daylens: 'connecting' | 'connected' | 'not_running' | 'not_installed'
  capture: 'running' | 'paused'
  until_wall_ms: number | null
  opened?: boolean
}
