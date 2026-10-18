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

// Why a run that holds the screen must give it back, or null. Input shows as idle time below what has passed since the
// run took the screen.
export function stopReason(s: Signals, idleAtStart: number, heldS: number): string | null {
  if (!s.marker()) return 'the away marker was removed'
  if (s.locked()) return 'the screen locked'
  if (s.idleSeconds() < idleAtStart + heldS - 1) return 'someone is using the Mac'
  return null
}

export interface Clock {
  now(): number
  every(fn: () => void, ms: number): () => void
}

// Checks every tick from the moment the run takes the screen and calls onStop once, with the first reason found.
export function watch(s: Signals, clock: Clock, onStop: (reason: string) => void, intervalMs = 250): () => void {
  const start = clock.now()
  const idleAtStart = s.idleSeconds()
  let done = false
  const cancel = clock.every(() => {
    if (done) return
    const reason = stopReason(s, idleAtStart, (clock.now() - start) / 1000)
    if (reason === null) return
    done = true
    cancel()
    onStop(reason)
  }, intervalMs)
  return () => {
    done = true
    cancel()
  }
}

export interface Killer {
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void
  alive(pid: number): boolean
  sleep(ms: number): Promise<void>
}

// Ends every process the run launched: TERM first, then KILL for any still running after the grace period.
export async function endAll(pids: Iterable<number>, k: Killer, graceMs = 1500): Promise<void> {
  const list = [...pids]
  for (const p of list) if (k.alive(p)) k.kill(p, 'SIGTERM')
  for (let waited = 0; waited < graceMs && list.some((p) => k.alive(p)); waited += 100) await k.sleep(100)
  for (const p of list) if (k.alive(p)) k.kill(p, 'SIGKILL')
}

// Whether the run may launch a browser or bring a window forward now: only after the gate passed, and only while the
// marker is still there.
export function mayTakeScreen(held: boolean, s: Signals): boolean {
  return held && s.marker()
}

// Exit code for a run ended by a signal or its own failure. A queue stops on it too.
export const ABORTED_EXIT = 70

export interface Proc {
  on(event: string, fn: (arg?: unknown) => void): unknown
}

// A runner that is told to stop, or fails, ends what it launched the same way as when someone touches the Mac.
// SIGKILL cannot be caught.
export function onAbort(proc: Proc, stop: (reason: string) => void): void {
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) proc.on(sig, () => stop(`the runner received ${sig}`))
  const failed = (e: unknown) => stop(`the runner failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  proc.on('uncaughtException', failed)
  proc.on('unhandledRejection', failed)
}
