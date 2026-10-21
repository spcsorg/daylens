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
  // One browser, paused from its extension's popup; null until is "until you resume".
  pauseBrowser(browser: AppIdentity, untilWallMs: number | null): void
  resumeBrowser(browser: AppIdentity): void
}

interface StoragePauses {
  paused(): { since_wall_ms: number; until_wall_ms: number | null } | null
  pauseApp(appId: string, until: PauseFor | number | null): unknown
  resumeApp(appId: string): void
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
    pauseBrowser: (b, until) => void storage.pauseApp(appOf(b), until),
    resumeBrowser: (b) => storage.resumeApp(appOf(b)),
  }
}
