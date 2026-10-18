// When a live run may take the screen. A run starts only when someone said they are away (the marker file) and the Mac
// agrees: idle long enough that nobody is reading at it, or the display asleep. A locked screen means away, but a run
// cannot drive a locked Mac, so it waits.

import os from 'node:os'
import path from 'node:path'

export const DEFAULT_MARKER = path.join(os.homedir(), '.daylens-live-away')
// A test-harness setting: two minutes without input happens while someone reads.
export const AWAY_IDLE_S = 600
// Exit code for a run that did not start, or stopped, because someone may be at the Mac. A queue stops on it.
export const NOT_AWAY_EXIT = 75

export interface Signals {
  marker(): boolean
  locked(): boolean
  displayAsleep(): boolean
  idleSeconds(): number
}

export type Gate = 'no_marker' | 'present' | 'locked' | 'away'

export function gate(s: Signals, idleS = AWAY_IDLE_S): Gate {
  if (!s.marker()) return 'no_marker'
  if (s.locked()) return 'locked'
  if (s.displayAsleep() || s.idleSeconds() >= idleS) return 'away'
  return 'present'
}
