// Runs the native helper, watches its heartbeat, restarts it, and records every gap with its reason.
// Logs carry codes and counts only, never observation content.

import { spawn, type ChildProcess } from 'node:child_process'
import type { GapPoint, GapReason, GapScope, Normalizer } from './normalize.ts'
import { MAX_LINE_BYTES, parseLine, type Line, type LineOf, type RejectReason } from './protocol.ts'
import type { Store } from './store.ts'

export interface SupervisorOptions {
  helperPath: string
  helperArgs?: string[]
  env?: NodeJS.ProcessEnv
  heartbeatMs?: number
  hangAfterMs?: number
  tickMs?: number
  backoffInitialMs?: number
  backoffMaxMs?: number
  stableMs?: number
  crashLoopCount?: number
  unavailableRetryMs?: number
  shutdownGraceMs?: number
  now?: () => number
  hrtimeMs?: () => number
  log?: (msg: string) => void
}

type Required<T> = { [K in keyof T]-?: T[K] }

const DEFAULTS = {
  helperArgs: [] as string[],
  env: process.env,
  heartbeatMs: 15_000,
  hangAfterMs: 45_000,
  tickMs: 5_000,
  backoffInitialMs: 500,
  backoffMaxMs: 30_000,
  stableMs: 60_000,
  crashLoopCount: 5,
  unavailableRetryMs: 300_000,
  shutdownGraceMs: 1_500,
  now: Date.now,
  hrtimeMs: () => Number(process.hrtime.bigint() / 1_000_000n),
  log: (msg: string) => process.stderr.write(`[capture] ${msg}\n`),
}

const SAFE_STDERR = /^[a-z_]+=[A-Za-z0-9_.:-]{0,64}( [a-z_]+=[A-Za-z0-9_.:-]{0,64})*$/

export interface SupervisorStats {
  lines: number
  rejected: Record<RejectReason, number>
  restarts: number
  hangs: number
  crashes: number
  linesLost: number
  lateTicks: number
  heartbeats: number
  heartbeatMaxGapMs: number
}

export class Supervisor {
  private readonly o: Required<SupervisorOptions>
  private readonly store: Store
  private readonly normalizer: Normalizer
  private child: ChildProcess | null = null
  private run: string | null = null
  private lastSeq = -1
  private lastLine: GapPoint | null = null
  private lastHeartbeat: { point: GapPoint; mono_us: number; awake_us: number | null; boot: string } | null = null
  private linesSinceHello = 0
  private stderrBuf = ''
  private lastAliveTouch = 0
  private allGap: { id: number; reason: GapReason } | null = null
  // Closed at hello but not yet confirmed by a heartbeat; a crash before then continues the same gap.
  private recovering: { id: number; reason: GapReason } | null = null
  private titlesGap: number | null = null
  private registrationGaps = new Map<'focus' | 'session' | 'power', number>()
  private rejectGap: { id: number; count: number; startWall: number } | null = null
  private awakeSilenceMs = 0
  private lastTick: { wall: number; hr: number } | null = null
  private ticker: ReturnType<typeof setInterval> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private backoffMs: number
  private fastFailures = 0
  private spawnedAtHr = 0
  private killedForHang = false
  private stopping = false
  private stdoutBuf = ''
  private discardingLongLine = false
  readonly stats: SupervisorStats = {
    lines: 0,
    rejected: { too_long: 0, not_json: 0, unsupported_version: 0, malformed: 0 },
    restarts: 0,
    hangs: 0,
    crashes: 0,
    linesLost: 0,
    lateTicks: 0,
    heartbeats: 0,
    heartbeatMaxGapMs: 0,
  }

  constructor(store: Store, normalizer: Normalizer, opts: SupervisorOptions) {
    this.o = { ...DEFAULTS, ...opts } as Required<SupervisorOptions>
    this.store = store
    this.normalizer = normalizer
    this.backoffMs = this.o.backoffInitialMs
    // Dropped writes may include the row the normalizer is extending: start fresh and re-read the present state.
    store.onOverflow = () => normalizer.interrupt(this.lastLine ?? this.servicePoint())
    store.onRecovered = () => this.send({ op: 'snapshot' })
  }

  start(): void {
    const now = this.o.now()
    const prev = this.store.previousCoverage()
    if (prev) this.store.closeDanglingGaps({ wall_ms: prev.endWallMs, mono_us: null, boot: null })
    this.openAllGap(
      prev ? 'service_down' : 'service_starting',
      prev ? { wall_ms: Math.min(prev.endWallMs, now), mono_us: null, boot: null } : this.servicePoint(),
      prev ? { clean_stop: prev.clean } : null,
    )
    this.store.markServiceStarted()
    this.store.flush()
    this.lastTick = { wall: now, hr: this.o.hrtimeMs() }
    this.ticker = setInterval(() => this.tick(), this.o.tickMs)
    this.spawnHelper()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.ticker) clearInterval(this.ticker)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    const child = this.child
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      this.send({ op: 'shutdown' })
      const timer = setTimeout(() => child.kill('SIGKILL'), this.o.shutdownGraceMs)
      await exited
      clearTimeout(timer)
    }
    const end = this.servicePoint()
    this.normalizer.interrupt(end)
    if (this.titlesGap !== null) this.store.closeGap(this.titlesGap, end)
    this.closeRegistrationGaps(end)
    if (this.allGap) this.store.closeGap(this.allGap.id, end)
    if (this.run) this.store.endRun(this.run, end.wall_ms, 'service_stopped')
    this.store.markServiceStopped(end.wall_ms)
    this.store.flush()
    const r = this.stats.rejected
    this.o.log(
      `stats lines=${this.stats.lines} heartbeats=${this.stats.heartbeats} heartbeat_max_gap_ms=${this.stats.heartbeatMaxGapMs} late_ticks=${this.stats.lateTicks} ` +
        `hangs=${this.stats.hangs} crashes=${this.stats.crashes} restarts=${this.stats.restarts} lines_lost=${this.stats.linesLost} ` +
        `rejected=${r.too_long + r.not_json + r.unsupported_version + r.malformed}`,
    )
  }

  // Re-read the present from the helper, as after lost lines.
  requestSnapshot(): void {
    this.send({ op: 'snapshot' })
  }

  helperPid(): number | null {
    return this.child?.pid ?? null
  }

  // --- process lifecycle --------------------------------------------------

  private spawnHelper(): void {
    if (this.stopping) return
    this.run = null
    this.lastSeq = -1
    this.lastHeartbeat = null
    this.awakeSilenceMs = 0
    this.killedForHang = false
    this.stdoutBuf = ''
    this.discardingLongLine = false
    this.spawnedAtHr = this.o.hrtimeMs()
    let child: ChildProcess
    try {
      child = spawn(this.o.helperPath, this.o.helperArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: this.o.env, windowsHide: true })
    } catch (err) {
      this.onSpawnError(err)
      return
    }
    this.child = child
    this.stderrBuf = ''
    // A failed kill also raises 'error'; only a child that never got a pid failed to spawn.
    child.on('error', (err) => {
      if (child.pid === undefined && this.child === child) this.onSpawnError(err)
    })
    child.stdin?.on('error', () => {})
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (this.child === child) this.onStdout(chunk)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (this.child === child) this.onStderr(chunk)
    })
    // 'close' fires after stdout has drained, so no line from this child can arrive after its gap opens.
    child.on('close', (code, signal) => this.onExit(child, code, signal))
  }

  private onStderr(chunk: string): void {
    let buf = this.stderrBuf + chunk
    let nl = buf.indexOf('\n')
    while (nl !== -1) {
      const t = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (t) this.o.log(SAFE_STDERR.test(t) ? `helper ${t}` : 'helper stderr line redacted')
      nl = buf.indexOf('\n')
    }
    this.stderrBuf = buf.length > 1024 ? '' : buf
  }

  private onSpawnError(err: unknown): void {
    const code = (err as { code?: unknown })?.code
    this.o.log(`helper spawn failed code=${typeof code === 'string' ? code : 'unknown'}`)
    this.child = null
    this.ensureAllGap('helper_unavailable', this.lastLine ?? this.servicePoint(), { spawn_error: typeof code === 'string' ? code : 'unknown' })
    this.scheduleRestart(this.o.unavailableRetryMs)
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return
    this.child = null
    // A half-written last line is lost with the process; it is not a protocol error.
    this.stdoutBuf = ''
    if (this.stopping) return
    const upMs = this.o.hrtimeMs() - this.spawnedAtHr
    const at = this.lastLine ?? this.servicePoint()
    if (this.run) this.store.endRun(this.run, at.wall_ms, this.killedForHang ? 'hung' : 'crashed')
    if (this.killedForHang) {
      this.o.log('helper killed after hang')
    } else {
      this.stats.crashes++
      this.o.log(`helper exited code=${code ?? 'none'} signal=${signal ?? 'none'}`)
      this.normalizer.interrupt(at)
      this.ensureAllGap('helper_crashed', at, { exit_code: code, signal })
    }
    this.fastFailures = upMs < this.o.stableMs ? this.fastFailures + 1 : 0
    if (upMs >= this.o.stableMs) this.backoffMs = this.o.backoffInitialMs
    if (this.fastFailures >= this.o.crashLoopCount) {
      if (this.allGap) {
        this.store.updateGap(this.allGap.id, { reason: 'helper_unavailable', detail: { fast_failures: this.fastFailures } })
        this.allGap.reason = 'helper_unavailable'
      }
      this.scheduleRestart(this.o.unavailableRetryMs)
      return
    }
    this.scheduleRestart(this.backoffMs)
    this.backoffMs = Math.min(this.backoffMs * 2, this.o.backoffMaxMs)
  }

  private scheduleRestart(delayMs: number): void {
    if (this.stopping || this.restartTimer) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.stats.restarts++
      this.spawnHelper()
    }, delayMs)
  }

  // --- watchdog -----------------------------------------------------------

  // Silence counts only time this service itself was awake and on schedule, so a
  // sleeping machine or a suspended service is never mistaken for a hung helper.
  private tick(): void {
    const wall = this.o.now()
    const hr = this.o.hrtimeMs()
    const last = this.lastTick ?? { wall, hr }
    this.lastTick = { wall, hr }
    const dWall = wall - last.wall
    const dHr = hr - last.hr
    const late = dWall > this.o.tickMs * 2 || dHr > this.o.tickMs * 2 || dWall < 0
    if (wall - this.lastAliveTouch >= 60_000) {
      this.lastAliveTouch = wall
      this.store.touchAlive(wall)
    }
    if (late) {
      this.stats.lateTicks++
      return
    }
    if (!this.child) return
    this.awakeSilenceMs += dHr
    if (this.awakeSilenceMs >= this.o.hangAfterMs) this.onHang()
  }

  private onHang(): void {
    const child = this.child
    if (!child) return
    this.stats.hangs++
    this.o.log(`helper hung silence_ms=${Math.round(this.awakeSilenceMs)}`)
    const at = this.lastHeartbeat?.point ?? this.lastLine ?? this.servicePoint()
    this.normalizer.interrupt(at)
    this.ensureAllGap('helper_hung', at, { awake_silence_ms: Math.round(this.awakeSilenceMs) })
    this.killedForHang = true
    this.awakeSilenceMs = 0
    child.kill('SIGKILL')
  }

  // --- line handling ------------------------------------------------------

  private onStdout(chunk: string): void {
    let buf = this.stdoutBuf + chunk
    let nl = buf.indexOf('\n')
    while (nl !== -1) {
      const raw = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (this.discardingLongLine) this.discardingLongLine = false
      else if (raw.trim()) this.onRawLine(raw)
      nl = buf.indexOf('\n')
    }
    if (buf.length > MAX_LINE_BYTES) {
      if (!this.discardingLongLine) this.reject('too_long')
      this.discardingLongLine = true
      buf = ''
    }
    this.stdoutBuf = buf
  }

  private onRawLine(raw: string): void {
    const r = parseLine(raw)
    if (!r.ok) {
      this.reject(r.reason)
      return
    }
    this.onLine(r.line)
  }

  private reject(reason: RejectReason): void {
    this.stats.rejected[reason]++
    this.o.log(`line rejected reason=${reason}`)
    const now = this.o.now()
    if (this.rejectGap && now - this.rejectGap.startWall < 60_000) {
      this.rejectGap.count++
      this.store.updateGap(this.rejectGap.id, { detail: { count: this.rejectGap.count } })
      this.store.setGapEnd(this.rejectGap.id, { wall_ms: now, mono_us: null, boot: null })
      return
    }
    const id = this.store.openGap({ reason: 'protocol_rejected', scope: 'all', run: this.run, start: { wall_ms: now, mono_us: null, boot: null }, detail: { count: 1 } })
    this.store.closeGap(id, { wall_ms: now, mono_us: null, boot: null })
    this.rejectGap = { id, count: 1, startWall: now }
  }

  private onLine(line: Line): void {
    this.stats.lines++
    const point: GapPoint = { wall_ms: line.t.wall_ms, mono_us: line.t.mono_us, boot: line.boot }

    if (this.run === null) {
      if (line.kind !== 'hello' || line.seq !== 0) {
        this.reject('malformed')
        return
      }
      this.onHello(line)
    } else if (line.run !== this.run) {
      this.reject('malformed')
      return
    } else if (line.seq !== this.lastSeq + 1) {
      const missing = line.seq - this.lastSeq - 1
      if (missing <= 0) {
        this.reject('malformed')
        return
      }
      this.stats.linesLost += missing
      this.o.log(`lines lost count=${missing}`)
      const from = this.lastLine ?? point
      this.normalizer.interrupt(from)
      const id = this.store.openGap({ reason: 'lines_lost', scope: 'all', run: this.run, start: from, detail: { missing } })
      this.store.closeGap(id, point)
      this.send({ op: 'snapshot' })
    }
    this.lastSeq = line.seq
    this.lastLine = point
    this.linesSinceHello++

    switch (line.kind) {
      case 'hello':
        return
      case 'heartbeat':
        return this.onHeartbeat(line, point)
      case 'power':
        this.normalizer.handle(line)
        if (line.obs.state === 'resume') this.send({ op: 'snapshot' })
        return
      case 'session':
        this.normalizer.handle(line)
        if (line.obs.state === 'unlocked' && !line.obs.snapshot) this.send({ op: 'snapshot' })
        return
      case 'loss': {
        const o = line.obs
        this.o.log(`helper dropped focus work count=${o.count}`)
        const id = this.store.openGap({ reason: 'events_dropped', scope: 'focus', run: this.run, start: { wall_ms: o.from_wall_ms, mono_us: null, boot: line.boot }, detail: { count: o.count } })
        this.store.closeGap(id, { wall_ms: o.to_wall_ms, mono_us: null, boot: line.boot })
        // What was dropped may include the latest change; re-read the present.
        this.normalizer.interrupt({ wall_ms: o.to_wall_ms, mono_us: null, boot: line.boot })
        this.send({ op: 'snapshot' })
        return
      }
      case 'bye':
        this.o.log(`helper bye reason=${/^[a-z_]{1,32}$/.test(line.obs.reason) ? line.obs.reason : 'other'}`)
        return
      default:
        this.normalizer.handle(line)
    }
  }

  private onHello(line: LineOf<'hello'>): void {
    this.run = line.run
    this.o.log(`helper hello pid=${line.obs.pid} accessibility=${line.obs.permissions.accessibility}`)
    this.store.startRun(line)
    this.awakeSilenceMs = 0
    this.linesSinceHello = 0
    const point: GapPoint = { wall_ms: line.t.wall_ms, mono_us: line.t.mono_us, boot: line.boot }
    if (this.allGap) {
      this.store.closeGap(this.allGap.id, point)
      this.recovering = this.allGap
      this.allGap = null
    }
    if (this.titlesGap !== null) {
      this.store.closeGap(this.titlesGap, point)
      this.titlesGap = null
    }
    this.lastHeartbeat = { point, mono_us: line.t.mono_us, awake_us: null, boot: line.boot }
  }

  private onHeartbeat(line: LineOf<'heartbeat'>, point: GapPoint): void {
    this.awakeSilenceMs = 0
    this.recovering = null
    const prev = this.lastHeartbeat
    // Awake time stops while the machine sleeps (dark wakes included), so a long awake gap between
    // heartbeats means the helper itself stalled, whether or not a sleep notice arrived.
    if (prev && prev.awake_us !== null && prev.boot === line.boot) {
      const awakeGapMs = Math.round((line.obs.awake_us - prev.awake_us) / 1000)
      this.stats.heartbeatMaxGapMs = Math.max(this.stats.heartbeatMaxGapMs, awakeGapMs)
      if (awakeGapMs > this.o.heartbeatMs * 2.5) {
        this.o.log(`helper stalled between heartbeats awake_ms=${awakeGapMs}`)
        const id = this.store.openGap({ reason: 'helper_stalled', scope: 'all', run: this.run, start: prev.point, detail: { awake_silence_ms: awakeGapMs } })
        this.store.closeGap(id, point)
      }
    }
    this.stats.heartbeats++
    this.lastHeartbeat = { point, mono_us: line.t.mono_us, awake_us: line.obs.awake_us, boot: line.boot }
    this.store.recordHeartbeat(line)
    this.onRegistrations(line, point)
    this.normalizer.onTitleChannel(line.obs.titles, line.t.wall_ms)
    // The main loop is alive but the title worker is stuck in one call: only a restart frees it.
    if (line.obs.stall_ms >= this.o.hangAfterMs && this.child) {
      this.stats.hangs++
      this.o.log(`title worker stuck stall_ms=${line.obs.stall_ms}; restarting helper`)
      this.normalizer.interrupt(point)
      this.ensureAllGap('helper_hung', point, { channel: 'titles', stall_ms: line.obs.stall_ms }, false)
      this.killedForHang = true
      this.child.kill('SIGKILL')
      return
    }
    const titlesDown = line.obs.titles !== 'ok'
    if (titlesDown && this.titlesGap === null) {
      this.titlesGap = this.store.openGap({ reason: 'titles_unavailable', scope: 'titles', run: this.run, start: point, detail: { state: line.obs.titles } })
    } else if (!titlesDown && this.titlesGap !== null) {
      this.store.closeGap(this.titlesGap, point)
      this.titlesGap = null
    }
  }

  // An event source the helper could not subscribe to is a gap in that source until it is in place.
  private onRegistrations(line: LineOf<'heartbeat'>, point: GapPoint): void {
    for (const source of ['focus', 'session', 'power'] as const) {
      const ok = line.obs.registrations[source]
      const open = this.registrationGaps.get(source)
      if (!ok && open === undefined) {
        this.o.log(`helper ${source} events unavailable`)
        this.registrationGaps.set(source, this.store.openGap({ reason: 'events_unavailable', scope: source as GapScope, run: this.run, start: point, detail: null }))
      } else if (ok && open !== undefined) {
        this.store.closeGap(open, point)
        this.registrationGaps.delete(source)
      }
    }
  }

  private closeRegistrationGaps(at: GapPoint): void {
    for (const id of this.registrationGaps.values()) this.store.closeGap(id, at)
    this.registrationGaps.clear()
  }

  // --- helpers ------------------------------------------------------------

  private servicePoint(): GapPoint {
    return { wall_ms: this.o.now(), mono_us: null, boot: null }
  }

  private openAllGap(reason: GapReason, start: GapPoint, detail: Record<string, number | boolean | string | null> | null): void {
    const id = this.store.openGap({ reason, scope: 'all', run: this.run, start, detail })
    this.allGap = { id, reason }
  }

  // One all-scope gap at a time; a second failure before recovery extends the first.
  private ensureAllGap(reason: GapReason, start: GapPoint, detail: Record<string, number | boolean | string | null>, closeTitles = true): void {
    // A titles gap that led to this restart stays open until the new helper is up, so it is bounded by recovery.
    if (closeTitles && this.titlesGap !== null) {
      this.store.closeGap(this.titlesGap, start)
      this.titlesGap = null
    }
    this.closeRegistrationGaps(start)
    // A helper that dies right after hello, before sending anything else, continues the same outage.
    if (!this.allGap && this.recovering && this.linesSinceHello <= 1) {
      this.store.reopenGap(this.recovering.id)
      this.allGap = this.recovering
    }
    this.recovering = null
    if (this.allGap) {
      this.store.updateGap(this.allGap.id, { detail: { ...detail, also: reason } })
      return
    }
    this.openAllGap(reason, start, detail)
  }

  private send(msg: { op: 'shutdown' | 'snapshot' }): void {
    const stdin = this.child?.stdin
    if (stdin && stdin.writable) stdin.write(JSON.stringify(msg) + '\n')
  }
}
