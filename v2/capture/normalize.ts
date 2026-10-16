// Shared normalization: everything between a validated helper line and storage.
// Privacy decisions are made per line from the identity that line carries.

import {
  DEFAULT_EXCLUSIONS,
  DISPLAY_NAME_OVERRIDES,
  KNOWN_BROWSER_APP_IDS,
  KNOWN_BROWSER_EXES,
  KNOWN_NON_BROWSER_APP_IDS,
  type ExclusionRule,
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

export interface ObservationRow {
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
  extendObservation(id: number, lastSeenWallMs: number): void
  flagObservation(id: number, flag: 'possibly_stale', wallMs: number): void
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

export interface Classification {
  excluded: boolean
  title: 'allowed' | 'withheld_browser' | 'withheld_unknown_app'
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return (i >= 0 ? p.slice(i + 1) : p).toLowerCase()
}

export class Privacy {
  private readonly byAppId = new Set<string>()
  private readonly byExe = new Set<string>()
  private readonly bySite = new Set<string>()

  constructor(rules: readonly ExclusionRule[] = DEFAULT_EXCLUSIONS) {
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

  classify(app: AppIdentity): Classification {
    const appId = app.app_id?.toLowerCase() ?? null
    const exe = app.path ? basename(app.path) : null
    const aumid = app.store?.aumid.toLowerCase() ?? null
    const excluded =
      (appId !== null && this.byAppId.has(appId)) ||
      (aumid !== null && this.byAppId.has(aumid)) ||
      (exe !== null && this.byExe.has(exe))
    if (excluded) return { excluded: true, title: 'withheld_unknown_app' }
    if (app.identity_state !== 'ok' || (appId === null && exe === null)) {
      return { excluded: false, title: 'withheld_unknown_app' }
    }
    const browser =
      (app.registered_browser && !(appId !== null && KNOWN_NON_BROWSER_APP_IDS.has(appId))) ||
      (appId !== null && KNOWN_BROWSER_APP_IDS.has(appId)) ||
      (exe !== null && KNOWN_BROWSER_EXES.has(exe))
    return { excluded: false, title: browser ? 'withheld_browser' : 'allowed' }
  }
}

// --- normalizer -----------------------------------------------------------

interface OpenRow {
  id: number
  key: string
  hasTitle: boolean
  sinceWall: number
  // Why the title is possibly stale: the title channel could not update it, or input went on while it never changed.
  stale: 'channel' | 'input' | null
}

export interface NormalizerOptions {
  staleAfterMs?: number
}

export const DEFAULT_STALE_AFTER_MS = 15 * 60_000

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

export class Normalizer {
  private focus: OpenRow | null = null
  private readonly lastState = new Map<'input' | 'session' | 'power', OpenRow>()
  private excludedGap: number | null = null
  private resumedAtWall: number | null = null
  private titleChannel: ChannelState = 'ok'
  private activeSince: number | null = null
  private readonly sink: Sink
  private readonly privacy: Privacy
  private readonly staleAfterMs: number

  constructor(sink: Sink, privacy: Privacy = new Privacy(), opts: NormalizerOptions = {}) {
    this.sink = sink
    this.privacy = privacy
    this.staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  }

  handle(line: Line): void {
    switch (line.kind) {
      case 'focus':
        return this.onFocus(line)
      case 'input':
        this.onPresenceEvidence(line, line.obs.state === 'active' && line.obs.last_input_wall_ms >= (this.resumedAtWall ?? Infinity))
        if (line.obs.state === 'idle') this.activeSince = null
        else this.activeSince ??= line.t.wall_ms
        this.checkInputStale(line.t.wall_ms)
        return this.onState(line, 'input', line.obs.state, JSON.stringify({ last_input_wall_ms: line.obs.last_input_wall_ms, threshold_s: line.obs.threshold_s }))
      case 'session':
        this.onPresenceEvidence(line, line.obs.state === 'unlocked' && !line.obs.snapshot)
        if (line.obs.state === 'locked' || line.obs.state === 'console_disconnect' || line.obs.state === 'remote_disconnect') {
          this.endExcluded(line)
          this.activeSince = null
        }
        return this.onState(line, 'session', line.obs.state, null)
      case 'power':
        if (line.obs.state === 'resume') this.resumedAtWall ??= line.t.wall_ms
        this.onPresenceEvidence(line, line.obs.state === 'resume_user')
        if (line.obs.state === 'sleep') {
          this.resumedAtWall = null
          this.activeSince = null
          this.endExcluded(line)
        }
        return this.onState(line, 'power', line.obs.state, null)
      case 'clock': {
        // Clock changes are events, not states: every one is kept with its own time.
        const row = envelopeRow(line, 'clock')
        row.state = line.obs.change
        this.sink.insertObservation(row)
        return
      }
      case 'hello':
      case 'heartbeat':
      case 'loss':
      case 'bye':
      // Tab lines come only from the browser host, never through a helper.
      case 'tab':
        return
    }
  }

  // Title channel health: a title that cannot update is not evidence of current work.
  onTitleChannel(state: ChannelState, wallMs: number): void {
    this.titleChannel = state
    if (state !== 'ok') this.flagStale('channel', wallMs)
    this.checkInputStale(wallMs)
  }

  // The spec's input-aware rule: a title unchanged for a long time while input keeps happening.
  private checkInputStale(wallMs: number): void {
    const f = this.focus
    if (!f || this.activeSince === null) return
    if (wallMs - Math.max(f.sinceWall, this.activeSince) >= this.staleAfterMs) this.flagStale('input', wallMs)
  }

  private flagStale(reason: 'channel' | 'input', wallMs: number): void {
    const f = this.focus
    if (!f || !f.hasTitle || f.stale !== null) return
    this.sink.flagObservation(f.id, 'possibly_stale', wallMs)
    f.stale = reason
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
    const { app, window: win } = line.obs
    const c = this.privacy.classify(app)

    if (c.excluded) {
      this.focus = null
      if (this.excludedGap === null) {
        this.excludedGap = this.sink.openGap({ reason: 'excluded', scope: 'all', run: line.run, start: point(line), detail: null })
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
    const key = JSON.stringify([known ? app.app_id : null, app.pid, app.identity_state, win.window, title, titleState, line.t.tz, line.t.tz_offset_min])
    // A fresh read after the title channel recovers starts a new row, even with the same title.
    const freshAfterStale = this.focus?.stale === 'channel' && this.titleChannel === 'ok'
    if (this.focus && this.focus.key === key && !freshAfterStale) {
      this.sink.extendObservation(this.focus.id, line.t.wall_ms)
      this.checkInputStale(line.t.wall_ms)
      return
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
    row.detail = JSON.stringify({ trigger: line.obs.trigger, ...(known && app.store ? { store: app.store } : {}) })
    this.focus = { id: this.sink.insertObservation(row), key, hasTitle: title !== null, sinceWall: line.t.wall_ms, stale: null }
  }

  private onState(line: Line, kind: 'input' | 'session' | 'power', state: string, detail: string | null): void {
    const open = this.lastState.get(kind)
    if (open && open.key === state) {
      this.sink.extendObservation(open.id, line.t.wall_ms)
      return
    }
    const row = envelopeRow(line, kind)
    row.state = state
    row.detail = detail
    this.lastState.set(kind, { id: this.sink.insertObservation(row), key: state, hasTitle: false, sinceWall: line.t.wall_ms, stale: null })
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
