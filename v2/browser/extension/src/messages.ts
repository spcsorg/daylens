// Between the popup and the background script.

export type PauseFor = 'hour' | 'tomorrow' | 'until_resumed'

export type PopupRequest = { t: 'status' } | { t: 'pause'; for: PauseFor } | { t: 'resume' } | { t: 'open' } | { t: 'connect' }

export interface PopupState {
  // unpaired: this browser reaches Daylens over the local connection and has not been connected to it yet.
  daylens: 'connecting' | 'connected' | 'not_running' | 'not_installed' | 'unpaired'
  // All of Daylens, paused from the app.
  capture: 'running' | 'paused'
  until_wall_ms: number | null
  // This browser only, paused from the popup. null until is "until you resume".
  paused: boolean
  paused_until_wall_ms: number | null
  // Connect was pressed and Daylens has not confirmed yet.
  connecting_pair: boolean
  opened?: boolean
}
