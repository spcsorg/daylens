// Pausing as the extension connections see it. Storage records and enforces every pause: nothing stamped inside one
// is stored, whichever path writes it, so these connections only ask and report.

import type { AppIdentity } from './protocol.ts'

export type PauseFor = 'hour' | 'tomorrow' | 'until_resumed'

export interface PauseState {
  paused: boolean
  since_wall_ms: number | null
  // null while paused means until resumed.
  until_wall_ms: number | null
}

export interface PauseControl {
  // The pause of everything, set from the app; the extension only reports it.
  state(): PauseState
  // One browser, paused from one profile's extension popup; null until is "until you resume". A profile resumes only
  // its own pause: the browser stays paused while another profile's is in force.
  pauseBrowser(browser: AppIdentity, untilWallMs: number | null, profile: string | null): void
  resumeBrowser(browser: AppIdentity, profile: string | null): void
}

interface StoragePauses {
  paused(): { since_wall_ms: number; until_wall_ms: number | null } | null
  pauseApp(appId: string, until: PauseFor | number | null, holder: string | null): unknown
  resumeApp(appId: string, holder: string | null): void
}

export function storagePause(storage: StoragePauses): PauseControl {
  // A browser is paused by the identity the helper reports for it in front; one that cannot be named is refused.
  const appOf = (b: AppIdentity) => {
    if (b.identity_state !== 'ok' || !b.app_id) throw new Error('browser_unidentified')
    return b.app_id
  }
  return {
    state: () => {
      const p = storage.paused()
      return { paused: p !== null, since_wall_ms: p?.since_wall_ms ?? null, until_wall_ms: p?.until_wall_ms ?? null }
    },
    pauseBrowser: (b, until, profile) => void storage.pauseApp(appOf(b), until, profile),
    resumeBrowser: (b, profile) => storage.resumeApp(appOf(b), profile),
  }
}

// The browser profile an extension pauses for: an id it made up, kept in that profile alone.
export function profileOf(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null
}

// The id an extension gives a pause or resume; the reply to it carries the id back, so a status another browser's
// change sent meanwhile is never taken for it.
export function reqOf(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v) ? v : null
}
