// Pause: nothing is stored from the moment Daylens is paused until it resumes, and the pause itself is a gap.
// Every line is judged by its own event time, so a late timer or a sleeping machine never stretches or shortens it.

import type { GapPoint, GapStart } from './normalize.ts'

export type PauseFor = 'hour' | 'tomorrow' | 'until_resumed'

export interface PauseState {
  paused: boolean
  since_wall_ms: number | null
  // null while paused means until resumed.
  until_wall_ms: number | null
}

export interface PauseStore {
  meta(key: string): string | null
  setMeta(key: string, value: string | null): void
  openGap(gap: GapStart): number
  closeGap(id: number, end: GapPoint): void
}

export interface PauseOptions {
  now?: () => number
  // Where "until tomorrow" ends. There is no start-of-day setting yet, so the default is the next local midnight.
  tomorrow?: (nowMs: number) => number
  onChange?: (state: PauseState, at: GapPoint) => void
}

const META_KEY = 'pause'
const HOUR_MS = 3_600_000
// setTimeout cannot wait longer than this; a longer wait is re-armed.
const MAX_TIMER_MS = 2 ** 31 - 1

export function nextLocalMidnight(nowMs: number): number {
  const d = new Date(nowMs)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

function point(wallMs: number): GapPoint {
  return { wall_ms: wallMs, mono_us: null, boot: null }
}

export class Pause {
  private readonly store: PauseStore
  private readonly now: () => number
  private readonly tomorrow: (nowMs: number) => number
  private readonly onChange: (state: PauseState, at: GapPoint) => void
  private since: number | null = null
  private until: number | null = null
  private gap: number | null = null
  // Finished pauses, kept so a line stamped inside one but delivered later is still dropped.
  private done: { since_wall_ms: number; until_wall_ms: number }[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(store: PauseStore, opts: PauseOptions = {}) {
    this.store = store
    this.now = opts.now ?? Date.now
    this.tomorrow = opts.tomorrow ?? nextLocalMidnight
    this.onChange = opts.onChange ?? (() => {})
  }

  // A pause that outlived a service restart continues; the downtime itself is already a service gap.
  restore(): void {
    const raw = this.store.meta(META_KEY)
    if (raw === null) return
    let saved: { since_wall_ms?: unknown; until_wall_ms?: unknown; done?: unknown }
    try {
      saved = JSON.parse(raw)
    } catch {
      this.store.setMeta(META_KEY, null)
      return
    }
    if (Array.isArray(saved.done)) {
      for (const d of saved.done) {
        if (d && typeof d.since_wall_ms === 'number' && typeof d.until_wall_ms === 'number') this.done.push({ since_wall_ms: d.since_wall_ms, until_wall_ms: d.until_wall_ms })
      }
    }
    if (typeof saved.since_wall_ms !== 'number') return
    const until = typeof saved.until_wall_ms === 'number' ? saved.until_wall_ms : null
    const now = this.now()
    if (until !== null && until <= now) {
      this.done.push({ since_wall_ms: saved.since_wall_ms, until_wall_ms: until })
      this.persist()
      return
    }
    this.since = saved.since_wall_ms
    this.until = until
    this.gap = this.store.openGap({ reason: 'paused', scope: 'all', run: null, start: point(now), detail: { restored: true } })
    this.arm()
  }

  state(): PauseState {
    this.expireIfDue(this.now())
    return { paused: this.since !== null, since_wall_ms: this.since, until_wall_ms: this.until }
  }

  pause(kind: PauseFor): PauseState {
    const now = this.now()
    this.expireIfDue(now)
    const until = kind === 'hour' ? now + HOUR_MS : kind === 'tomorrow' ? this.tomorrow(now) : null
    const fresh = this.since === null
    if (fresh) {
      this.since = now
      this.gap = this.store.openGap({ reason: 'paused', scope: 'all', run: null, start: point(now), detail: { for: kind } })
    }
    this.until = until
    this.persist()
    this.arm()
    const s = this.state()
    if (fresh) this.onChange(s, point(now))
    return s
  }

  resume(): PauseState {
    this.end(this.now())
    return this.state()
  }

  // Whether a line with this event time must be dropped.
  blocks(eventWallMs: number): boolean {
    this.expireIfDue(eventWallMs)
    if (this.since !== null && eventWallMs >= this.since) return true
    return this.done.some((d) => eventWallMs >= d.since_wall_ms && eventWallMs < d.until_wall_ms)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private expireIfDue(wallMs: number): void {
    if (this.since !== null && this.until !== null && wallMs >= this.until) this.end(this.until)
  }

  private end(at: number): void {
    if (this.since === null) return
    if (this.gap !== null) this.store.closeGap(this.gap, point(at))
    if (at > this.since) this.done.push({ since_wall_ms: this.since, until_wall_ms: at })
    this.since = null
    this.until = null
    this.gap = null
    this.stop()
    this.persist()
    this.onChange({ paused: false, since_wall_ms: null, until_wall_ms: null }, point(at))
  }

  private arm(): void {
    this.stop()
    if (this.until === null) return
    const wait = Math.max(0, Math.min(this.until - this.now(), MAX_TIMER_MS))
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.until !== null && this.now() >= this.until) this.end(this.until)
      else this.arm()
    }, wait)
    this.timer.unref?.()
  }

  private persist(): void {
    if (this.since === null && this.done.length === 0) return this.store.setMeta(META_KEY, null)
    this.store.setMeta(META_KEY, JSON.stringify({ since_wall_ms: this.since, until_wall_ms: this.until, done: this.done }))
  }
}
