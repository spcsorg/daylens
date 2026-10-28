import type { PauseControl, PauseState } from '../../capture/pause.ts'
import type { AppIdentity } from '../../capture/protocol.ts'

// Records what the extension connections asked for; storage's own pause tests cover what a pause stores.
export class MemoryPause implements PauseControl {
  current: PauseState = { paused: false, since_wall_ms: null, until_wall_ms: null }
  browsers: { app_id: string | null; until_wall_ms: number | null }[] = []
  state(): PauseState {
    return this.current
  }
  pauseBrowser(browser: AppIdentity, untilWallMs: number | null): void {
    this.browsers.push({ app_id: browser.app_id, until_wall_ms: untilWallMs })
  }
  resumeBrowser(browser: AppIdentity): void {
    this.browsers = this.browsers.filter((b) => b.app_id !== browser.app_id)
  }
}
