// Shared normalization: everything between a validated helper line and storage.
// Privacy decisions are made per line from the identity that line carries.

import {
  DEFAULT_EXCLUSIONS,
  DISPLAY_NAME_OVERRIDES,
  KNOWN_BROWSER_APP_IDS,
  KNOWN_BROWSER_EXES,
  TRUSTED_WEB_RUNTIME_APPS,
  type ExclusionRule,
  type TrustedApp,
} from './defaults.ts'
import type { AppIdentity, ChannelState, Line, LineOf } from './protocol.ts'

export type RowKind = 'focus' | 'input' | 'session' | 'power' | 'clock' | 'presence' | 'page'
export type StoredTitleState =
  | 'ok'
  | 'empty'
  | 'no_window'
  | 'no_permission'
  | 'timeout'
  | 'unavailable'
  | 'withheld_browser'
  | 'withheld_unknown_app'
  | 'unknown'

export interface ObservationRow {
  possibly_stale_since_wall_ms?: number | null
  run: string
  seq: number
  boot: string
  platform: string
  source: string
  kind: RowKind
  event_wall_ms: number
  event_mono_us: number
  tz: string
  tz_offset_min: number
  app_id: string | null
  app_name: string | null
  app_path: string | null
  pid: number | null
  window: string | null
  title: string | null
  title_raw: string | null
  title_state: StoredTitleState | null
  state: string | null
  detail: string | null
  url?: string | null
}

export type GapReason =
  | 'service_starting'
  | 'service_down'
  | 'helper_crashed'
  | 'helper_hung'
  | 'helper_stalled'
  | 'helper_unavailable'
  | 'lines_lost'
  | 'protocol_rejected'
  | 'storage_failed'
  | 'events_dropped'
  | 'events_unavailable'
  | 'titles_unavailable'
  | 'excluded'
  | 'paused'

export type GapDetail = Record<string, number | boolean | string | null>

export interface GapPoint {
  wall_ms: number
  mono_us: number | null
  boot: string | null
}

export type GapScope = 'all' | 'titles' | 'focus' | 'session' | 'power'

export interface GapStart {
  reason: GapReason
  scope: GapScope
  run: string | null
  start: GapPoint
  detail: GapDetail | null
}

export interface Sink {
  insertObservation(row: ObservationRow): number
  // false: the extension was refused (it would cover paused or deleted time); the row is no longer open.
  extendObservation(id: number, lastSeenWallMs: number): boolean | void
  flagObservation(id: number, flag: 'possibly_stale', wallMs: number): void
  // Ends a row earlier than its last sighting, never before it began.
  retractObservation(id: number, lastSeenWallMs: number): void
  openGap(gap: GapStart): number
  updateGap(id: number, patch: { reason?: GapReason; detail?: GapDetail }): void
  closeGap(id: number, end: GapPoint): void
}

// --- title cleaning -------------------------------------------------------

// One spinner frame: a single glyph, only at the very start or end of a title.
const SPINNER_CHAR =
  '[\\u2800-\\u28FF\\u25D0-\\u25D3\\u25F0-\\u25F7\\u25DC-\\u25DF\\u2722\\u2733\\u2734\\u2736\\u2737\\u2738\\u2739\\u273A\\u273B\\u273D\\u274A\\u274B\\u00B7\\u23F3\\u231B]|\\uD83C[\\uDF11-\\uDF18]|\\uD83D[\\uDD50-\\uDD67]'
const LEADING_SPINNER = new RegExp(`^(?:${SPINNER_CHAR})\\uFE0F?\\s+`)
const TRAILING_SPINNER = new RegExp(`\\s+(?:${SPINNER_CHAR})\\uFE0F?$`)
const ONLY_SPINNER = new RegExp(`^(?:${SPINNER_CHAR})\\uFE0F?$`)
const LEADING_PERCENT = /^(?:[[(]\d{1,3}(?:\.\d+)?%[\])]\s*|\d{1,3}(?:\.\d+)?%\s*[-–—|:]\s+)/
const TRAILING_PERCENT = /(?:\s*[[(]\d{1,3}(?:\.\d+)?%[\])]|\s+[-–—|:]\s*\d{1,3}(?:\.\d+)?%)$/
const PROGRESS_BAR = /\s*\[[#=\->.\s█-▏░-▓]{4,}\]\s*/g
const BLOCK_RUN = /\s*[█-▏░-▓]{3,}\s*/g
const LEADING_COUNTER = /^\(\d{1,4}\)\s+/

export interface CleanTitle {
  title: string | null
  changed: boolean
}

export function cleanTitle(raw: string): CleanTitle {
  let t = raw.replace(/\s+/g, ' ').trim()
  for (let i = 0; i < 3; i++) {
    const before = t
    t = t
      .replace(LEADING_SPINNER, '')
      .replace(TRAILING_SPINNER, '')
      .replace(LEADING_PERCENT, '')
      .replace(TRAILING_PERCENT, '')
      .replace(LEADING_COUNTER, '')
      .replace(PROGRESS_BAR, ' ')
      .replace(BLOCK_RUN, ' ')
      .trim()
    if (ONLY_SPINNER.test(t)) t = ''
    if (t === before) break
  }
  return { title: t === '' ? null : t, changed: t !== raw }
}

// --- privacy --------------------------------------------------------------

// Why a title was withheld as 'unknown': the app ships a browser engine and is not on the trusted list,
// or the helper could not tell what engine it has.
export type TitleReason = 'browser_engine' | 'web_runtime_not_listed' | 'engine_uncertain'

export interface Classification {
  // Nothing of the app is stored; `paused` when that is because the app is paused on its own, not excluded.
  excluded: boolean
  paused?: boolean
  title: 'allowed' | 'withheld_browser' | 'withheld_unknown_app' | 'unknown'
  reason?: TitleReason
}

function trustedEntry(app: AppIdentity, appId: string | null, exe: string | null, list: readonly TrustedApp[]): TrustedApp | null {
  const signer = app.signer?.toLowerCase() ?? null
  for (const t of list) {
    if (t.app_id && appId === t.app_id.toLowerCase()) {
      // A Windows package ID already carries the publisher's identity; everything else needs a matching signer.
      if (t.signer ? signer === t.signer.toLowerCase() : app.store !== null) return t
      continue
    }
    if (!t.exe || !t.signer || exe !== t.exe || signer !== t.signer.toLowerCase()) continue
    // The file name alone is not enough: the version resource must agree.
    const vi = app.version_info
    const original = vi?.original_filename?.toLowerCase() ?? null
    const product = vi?.product_name?.toLowerCase() ?? null
    if (original === t.exe || (t.product !== undefined && product === t.product.toLowerCase())) return t
  }
  return null
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return (i >= 0 ? p.slice(i + 1) : p).toLowerCase()
}

export interface OrderingPoint {
  boot: string
  mono_us: number
  boot_identity: 'kernel' | 'clock'
}

export interface KeptTitleApp {
  id: string
  app_id: string
  signer: string | null
  effective_from_wall_ms: number
  activation?: OrderingPoint | null
}

export function canonicalKeptTitleId(id: string): string {
  const key: unknown = JSON.parse(id)
  if (!Array.isArray(key) || key[0] !== 'exe' || typeof key[1] !== 'string') return id
  // Squirrel replaces only the version directory; root, executable and signed product still bind the app.
  key[1] = key[1].replace(/([\\/])app-\d+\.\d+\.\d+(?:\.\d+)*(?:[-+][a-z0-9.-]+)?([\\/])(?=[^\\/]+\.exe$)/i, '$1app-*$2')
  return JSON.stringify(key)
}

export function keptTitleIdentity(app: AppIdentity): Omit<KeptTitleApp, 'effective_from_wall_ms' | 'activation'> | null {
  if (app.identity_state !== 'ok' || !app.app_id) return null
  const appId = app.app_id.toLowerCase()
  if (app.store) {
    // The OS-verified package family binds its publisher without a separate signer.
    if (app.store.aumid.toLowerCase() !== appId) return null
    return { id: JSON.stringify(['package', appId]), app_id: app.app_id, signer: null }
  }
  if (!app.signer) return null
  const signer = app.signer.toLowerCase()
  const exe = app.path ? basename(app.path) : null
  if (exe?.endsWith('.exe') || appId.endsWith('.exe')) {
    const vi = app.version_info
    if (!exe || (!vi?.original_filename && !vi?.product_name)) return null
    return {
      id: canonicalKeptTitleId(JSON.stringify(['exe', appId, exe, signer, vi?.original_filename?.toLowerCase() ?? null, vi?.product_name?.toLowerCase() ?? null])),
      app_id: app.app_id,
      signer: app.signer,
    }
  }
  return { id: JSON.stringify(['app', appId, signer]), app_id: app.app_id, signer: app.signer }
}

export function knownBrowser(app: AppIdentity): boolean {
  return (app.app_id !== null && KNOWN_BROWSER_APP_IDS.has(app.app_id.toLowerCase())) ||
    (app.path !== null && KNOWN_BROWSER_EXES.has(basename(app.path)))
}

export class Privacy {
  private readonly byAppId = new Set<string>()
  private readonly byExe = new Set<string>()
  private readonly bySite = new Set<string>()

  private readonly trustedApps: readonly TrustedApp[]
  private readonly keptApps: ReadonlyMap<string, KeptTitleApp>
  private readonly currentBoot: OrderingPoint | null
  private readonly pausedApps: ReadonlySet<string>

  constructor(rules: readonly ExclusionRule[] = DEFAULT_EXCLUSIONS, trustedApps: readonly TrustedApp[] = TRUSTED_WEB_RUNTIME_APPS, keptApps: readonly KeptTitleApp[] = [], currentBoot: OrderingPoint | null = null, pausedApps: readonly string[] = []) {
    this.pausedApps = new Set(pausedApps.map((a) => a.toLowerCase()))
    this.keptApps = new Map(keptApps.map((a) => [a.id, a]))
    this.currentBoot = currentBoot
    this.trustedApps = trustedApps
    for (const r of rules) (r.match === 'app_id' ? this.byAppId : r.match === 'site' ? this.bySite : this.byExe).add(r.value.toLowerCase())
  }

  siteExcluded(host: string | null): boolean {
    if (host === null) return false
    for (let h = host.toLowerCase(); ; ) {
      if (this.bySite.has(h)) return true
      const dot = h.indexOf('.')
      if (dot < 0) return false
      h = h.slice(dot + 1)
    }
  }

  /** The exclusion rule itself, shared by capture and by every other way rows enter storage (import). */
  excludes(appId: string | null, path: string | null, aumid: string | null = null): boolean {
    const id = appId?.toLowerCase() ?? null
    const exe = path ? basename(path) : null
    const a = aumid?.toLowerCase() ?? null
    return (id !== null && this.byAppId.has(id)) || (a !== null && this.byAppId.has(a)) || (exe !== null && this.byExe.has(exe))
  }

  classify(app: AppIdentity, event?: Pick<OrderingPoint, 'boot' | 'mono_us'>): Classification {
    const appId = app.app_id?.toLowerCase() ?? null
    const exe = app.path ? basename(app.path) : null
    const aumid = app.store?.aumid.toLowerCase() ?? null
    if (this.excludes(app.app_id, app.path, aumid)) return { excluded: true, title: 'withheld_unknown_app' }
    if (appId !== null && this.pausedApps.has(appId)) return { excluded: true, paused: true, title: 'withheld_unknown_app' }
    if (app.identity_state !== 'ok' || (appId === null && exe === null)) {
      return { excluded: false, title: 'withheld_unknown_app' }
    }
    // Browser rules win over both built-in and user-kept identities.
    if (knownBrowser(app)) {
      return { excluded: false, title: 'withheld_browser' }
    }
    // A browser engine is never exempted by any list, and a registered http/https handler only where decided.
    const entry = app.engine === 'browser' ? null : trustedEntry(app, appId ?? aumid, exe, this.trustedApps)
    if (app.registered_browser && !entry?.registers_links) return { excluded: false, title: 'withheld_browser' }
    if (app.engine === 'unknown') return { excluded: false, title: 'unknown', reason: 'engine_uncertain' }
    if (app.engine === 'browser') return { excluded: false, title: 'unknown', reason: 'browser_engine' }
    const activation = this.keptApps.get(keptTitleIdentity(app)?.id ?? '')?.activation
    const kept = activation?.boot_identity === 'kernel' && event !== undefined && (
      event.boot === activation.boot ? event.mono_us >= activation.mono_us
        : this.currentBoot?.boot_identity === 'kernel' && event.boot === this.currentBoot.boot
    )
    if (app.engine === 'app_runtime' && !entry && !kept) return { excluded: false, title: 'unknown', reason: 'web_runtime_not_listed' }
    return { excluded: false, title: 'allowed' }
  }
}

// --- normalizer -----------------------------------------------------------

interface OpenRow {
  id: number
  key: string
  hasTitle: boolean
  sinceWall: number
  // Set when Daylens lost the ability to read this title (permission lost, title worker stalled or degraded).
  stale: boolean
}

function envelopeRow(line: Line, kind: RowKind): ObservationRow {
  return {
    run: line.run,
    seq: line.seq,
    boot: line.boot,
    platform: line.platform,
    source: line.source,
    kind,
    event_wall_ms: line.t.wall_ms,
    event_mono_us: line.t.mono_us,
    tz: line.t.tz,
    tz_offset_min: line.t.tz_offset_min,
    app_id: null,
    app_name: null,
    app_path: null,
    pid: null,
    window: null,
    title: null,
    title_raw: null,
    title_state: null,
    state: null,
    detail: null,
  }
}

function point(line: Line): GapPoint {
  return { wall_ms: line.t.wall_ms, mono_us: line.t.mono_us, boot: line.boot }
}

// Lock states, as derivation and presence read them.
const LOCK_START = new Set(['locked', 'console_disconnect', 'remote_disconnect', 'logoff'])
const LOCK_END = new Set(['unlocked', 'console_connect', 'remote_connect', 'logon'])
// What ends the row in front: what ends intervals in derivation, and idle input, which presence counts as away.
// The *_unknown stops hold while the helper cannot show the display is on, or the screen unlocked: a new helper until it
// reports the display, an unreadable lock state, or a helper that cannot receive lock events.
type Stop = 'locked' | 'asleep' | 'display_off' | 'idle' | 'display_unknown' | 'lock_unknown'

export class Normalizer {
  private focus: OpenRow | null = null
  // When each stop in effect began.
  private readonly stops = new Map<Stop, number>()
  private readonly lastState = new Map<'input' | 'session' | 'power', OpenRow>()
  private excludedGap: number | null = null
  private excludedGapReason: 'excluded' | 'paused' = 'excluded'
  private resumedAtWall: number | null = null
  private titleChannel: ChannelState = 'ok'
  private readonly sink: Sink
  private privacy: Privacy

  constructor(sink: Sink, privacy: Privacy = new Privacy()) {
    this.sink = sink
    this.privacy = privacy
  }

  // New exclusion rules apply from the next line; callers interrupt first so no open row is extended across the change.
  setPrivacy(privacy: Privacy): void {
    this.privacy = privacy
  }

  /** Returns true when the line ended the last stop in effect: the window in front then needs a fresh read. */
  handle(line: Line): boolean {
    switch (line.kind) {
      case 'focus':
        this.onFocus(line)
        return false
      case 'input':
        this.onPresenceEvidence(line, line.obs.state === 'active' && line.obs.last_input_wall_ms >= (this.resumedAtWall ?? Infinity))
        this.onState(line, 'input', line.obs.state, JSON.stringify({ last_input_wall_ms: line.obs.last_input_wall_ms, threshold_s: line.obs.threshold_s }))
        // Away from the last input, not from when idle was noticed: the window in front ends there.
        if (line.obs.state === 'idle' && this.focus !== null && !this.stops.has('idle')) this.sink.retractObservation(this.focus.id, line.obs.last_input_wall_ms)
        return this.setStop('idle', line.obs.state === 'idle', line)
      case 'session': {
        this.onPresenceEvidence(line, line.obs.state === 'unlocked' && !line.obs.snapshot)
        if (line.obs.state === 'locked' || line.obs.state === 'console_disconnect' || line.obs.state === 'remote_disconnect') {
          this.endExcluded(line)
        }
        this.onState(line, 'session', line.obs.state, null)
        if (line.obs.state === 'unknown') return line.obs.snapshot ? this.setStop('lock_unknown', true, line) : false
        const known = this.setStop('lock_unknown', false, line)
        if (LOCK_START.has(line.obs.state)) return this.setStop('locked', true, line)
        if (LOCK_END.has(line.obs.state)) return this.setStop('locked', false, line) || known
        return known
      }
      case 'power': {
        const s = line.obs.state
        if (s === 'resume') this.resumedAtWall ??= line.t.wall_ms
        this.onPresenceEvidence(line, s === 'resume_user')
        if (s === 'sleep') {
          this.resumedAtWall = null
          this.endExcluded(line)
        }
        this.onState(line, 'power', s, null)
        if (s === 'sleep') return this.setStop('asleep', true, line)
        if (s === 'resume' || s === 'resume_user') return this.setStop('asleep', false, line)
        if (s === 'display_off') {
          this.setStop('display_unknown', false, line)
          return this.setStop('display_off', true, line)
        }
        const known = this.setStop('display_unknown', false, line)
        return this.setStop('display_off', false, line) || known
      }
      case 'clock': {
        // Clock changes are events, not states: every one is kept with its own time.
        const row = envelopeRow(line, 'clock')
        row.state = line.obs.change
        this.sink.insertObservation(row)
        return false
      }
      case 'hello':
        // A helper that is running is on an awake machine, but the display can be dark (a dark wake): nothing is
        // recorded until the helper reports the display's state.
        this.stops.delete('asleep')
        this.stops.delete('display_off')
        this.setStop('display_unknown', true, line)
        return false
      case 'heartbeat':
      case 'loss':
      case 'bye':
      // Tab lines come only from the browser host, never through a helper.
      case 'tab':
        return false
    }
  }

  // Time on either side of a stop is never one row: the row in front ends at every change, so the window is recorded
  // again from a fresh read once nothing stops it.
  private setStop(stop: Stop, on: boolean, line: Line): boolean {
    if (this.stops.has(stop) === on) return false
    if (on) this.stops.set(stop, line.t.wall_ms)
    else this.stops.delete(stop)
    this.focus = null
    this.onStopChanged(point(line))
    return !on && this.stops.size === 0
  }

  // Idle is not here: switching apps is input, and its focus line can arrive before the input line that ends idle.
  private stoppedAt(wallMs: number): boolean {
    for (const [stop, since] of this.stops) if (stop !== 'idle' && wallMs >= since) return true
    return false
  }

  /**
   * A heartbeat: the helper is running and has reported no change, so the window in front is still in front. Helpers
   * report focus only when it changes; without this, a window kept in front would end CONTINUITY_MS after it was last
   * reported. Nothing is extended while a stop is in effect. Returns true when storage refused the extension (a
   * pause, a deletion, the longest row), so the window needs a fresh read.
   */
  sighted(wallMs: number): boolean {
    const f = this.focus
    if (f === null || this.stops.size > 0) return false
    if (this.sink.extendObservation(f.id, wallMs) !== false) return false
    this.focus = null
    return true
  }

  /** A heartbeat's registrations: without lock events, whether the screen is locked cannot be known. */
  onRegistrations(sessionRegistered: boolean, line: Line): void {
    if (!sessionRegistered) this.setStop('lock_unknown', true, line)
  }

  /** A stop began or ended (for what follows the front, such as browser pages). */
  protected onStopChanged(_at: GapPoint): void {}

  /** A focus line that was taken (not one stamped inside a stop). */
  protected onFront(_line: LineOf<'focus'>): void {}

  // Title channel health: a title that cannot update is not evidence of current work.
  onTitleChannel(state: ChannelState, wallMs: number): void {
    this.titleChannel = state
    if (state === 'ok') return
    const f = this.focus
    if (!f || !f.hasTitle || f.stale) return
    this.sink.flagObservation(f.id, 'possibly_stale', wallMs)
    f.stale = true
  }

  // Lines were lost or the helper went away: forget open rows so the next line starts fresh.
  interrupt(at: GapPoint): void {
    this.focus = null
    this.lastState.clear()
    if (this.excludedGap !== null) {
      this.sink.closeGap(this.excludedGap, at)
      this.excludedGap = null
    }
  }

  // Locked or asleep is not time in the excluded app; the next focus snapshot reopens the gap if it is still in front.
  private endExcluded(line: Line): void {
    if (this.excludedGap === null) return
    this.sink.closeGap(this.excludedGap, point(line))
    this.excludedGap = null
    this.focus = null
  }

  private onFocus(line: LineOf<'focus'>): void {
    // The snapshot after a wake, while the screen is still locked, is not a row. A line stamped before the stop is kept;
    // the stop's end still ends its row.
    if (this.stoppedAt(line.t.wall_ms)) return
    this.takeFocus(line)
    this.onFront(line)
  }

  private takeFocus(line: LineOf<'focus'>): void {
    const { app, window: win } = line.obs
    const c = this.privacy.classify(app, { boot: line.boot, mono_us: line.t.mono_us })

    if (c.excluded) {
      this.focus = null
      const reason = c.paused ? 'paused' : 'excluded'
      if (this.excludedGap !== null && this.excludedGapReason !== reason) {
        this.sink.closeGap(this.excludedGap, point(line))
        this.excludedGap = null
      }
      if (this.excludedGap === null) {
        this.excludedGap = this.sink.openGap({ reason, scope: 'all', run: line.run, start: point(line), detail: null })
        this.excludedGapReason = reason
      }
      return
    }
    if (this.excludedGap !== null) {
      this.sink.closeGap(this.excludedGap, point(line))
      this.excludedGap = null
    }

    let title: string | null = null
    let titleRaw: string | null = null
    let titleState: StoredTitleState = win.title_state
    // A window the platform reports as private is never stored with its title, whatever the app.
    if (c.title !== 'allowed' || win.mode === 'private') {
      titleState = c.title !== 'allowed' ? c.title : 'withheld_browser'
    } else if (win.title !== null) {
      const cleaned = cleanTitle(win.title)
      title = cleaned.title
      if (title === null) titleState = 'empty'
      else if (cleaned.changed) titleRaw = win.title
    }

    const known = app.identity_state === 'ok'
    const key = JSON.stringify([known ? app.app_id : null, app.signer, app.store?.aumid, app.version_info, app.pid, app.identity_state, win.window, title, titleState, line.t.tz, line.t.tz_offset_min])
    // A fresh read after the title channel recovers starts a new row, even with the same title.
    const freshAfterStale = this.focus?.stale === true && this.titleChannel === 'ok'
    if (this.focus && this.focus.key === key && !freshAfterStale) {
      if (this.sink.extendObservation(this.focus.id, line.t.wall_ms) !== false) return
      this.focus = null
    }
    const row = envelopeRow(line, 'focus')
    row.app_id = known ? app.app_id : null
    row.app_name = known ? ((app.app_id && DISPLAY_NAME_OVERRIDES.get(app.app_id)) ?? app.name) : null
    row.app_path = known ? app.path : null
    row.pid = app.pid
    row.window = win.window
    row.title = title
    row.title_raw = titleRaw
    row.title_state = titleState
    row.state = app.identity_state
    row.detail = JSON.stringify({
      trigger: line.obs.trigger,
      ...(known && app.store ? { store: app.store } : {}),
      ...(c.reason && titleState === 'unknown' ? { title_reason: c.reason } : {}),
    })
    const id = this.sink.insertObservation(row)
    // A refused row (paused, deleted range) is never held open, so the first accepted line starts a fresh one.
    this.focus = id < 0 ? null : { id, key, hasTitle: title !== null, sinceWall: line.t.wall_ms, stale: false }
  }

  private onState(line: Line, kind: 'input' | 'session' | 'power', state: string, detail: string | null): void {
    const open = this.lastState.get(kind)
    if (open && open.key === state) {
      if (this.sink.extendObservation(open.id, line.t.wall_ms) !== false) return
      this.lastState.delete(kind)
    }
    const row = envelopeRow(line, kind)
    row.state = state
    row.detail = detail
    const id = this.sink.insertObservation(row)
    if (id < 0) this.lastState.delete(kind)
    else this.lastState.set(kind, { id, key: state, hasTitle: false, sinceWall: line.t.wall_ms, stale: false })
  }

  private onPresenceEvidence(line: Line, isEvidence: boolean): void {
    if (this.resumedAtWall === null || !isEvidence) return
    this.resumedAtWall = null
    const row = envelopeRow(line, 'presence')
    row.source = 'normalizer'
    row.state = 'returned'
    this.sink.insertObservation(row)
  }
}
