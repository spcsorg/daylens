// Helper → capture service wire protocol. Spec: v2/protocol/PROTOCOL.md.

export const PROTOCOL_VERSION = 1
export const MAX_LINE_BYTES = 16 * 1024
export const MAX_TITLE_CHARS = 1024
export const MAX_URL_CHARS = 2048

export type Platform = 'macos' | 'windows' | 'linux'

export interface EventTime {
  wall_ms: number
  mono_us: number
  tz: string
  tz_offset_min: number
}

export type PermissionState = 'granted' | 'denied' | 'not_applicable'
export interface Permissions {
  accessibility: PermissionState
}
export type ChannelState = 'ok' | 'degraded' | 'stalled' | 'no_permission'

export interface HelloObs {
  helper: string
  version: string
  pid: number
  os: string
  permissions: Permissions
  config: { heartbeat_s: number; idle_threshold_s: number; reconcile_s: number }
}
export interface Registrations {
  focus: boolean
  session: boolean
  power: boolean
}
export interface HeartbeatObs {
  awake_us: number
  permissions: Permissions
  registrations: Registrations
  titles: ChannelState
  stall_ms: number
  dropped: number
}
export type IdentityState = 'ok' | 'access_denied' | 'timeout' | 'gone' | 'none' | 'unresolved'
export interface AppIdentity {
  app_id: string | null
  name: string | null
  path: string | null
  pid: number | null
  registered_browser: boolean
  identity_state: IdentityState
  store: { aumid: string; package: string | null } | null
}
export type TitleState = 'ok' | 'empty' | 'no_window' | 'no_permission' | 'timeout' | 'unavailable'
export type WindowMode = 'normal' | 'private' | 'unknown'
export interface WindowInfo {
  window: string | null
  title: string | null
  title_state: TitleState
  // Set only when the platform can tell a private window from a normal one; absent means not reported.
  mode?: WindowMode
}
export type FocusTrigger = 'app_changed' | 'window_changed' | 'title_changed' | 'reconcile' | 'snapshot'
export interface FocusObs {
  trigger: FocusTrigger
  app: AppIdentity
  window: WindowInfo
}
export interface InputObs {
  state: 'idle' | 'active'
  last_input_wall_ms: number
  threshold_s: number
  snapshot: boolean
}
export type SessionState =
  | 'locked'
  | 'unlocked'
  | 'console_disconnect'
  | 'console_connect'
  | 'remote_connect'
  | 'remote_disconnect'
  | 'logoff'
  | 'logon'
  | 'unknown'
export interface SessionObs {
  state: SessionState
  snapshot: boolean
}
export type PowerState = 'sleep' | 'resume' | 'resume_user' | 'display_off' | 'display_on' | 'display_dim'
export interface PowerObs {
  state: PowerState
}
export interface ClockObs {
  change: 'time_changed' | 'timezone_changed'
}
export interface LossObs {
  channel: 'focus'
  count: number
  from_wall_ms: number
  to_wall_ms: number
}
export interface ByeObs {
  reason: string
}
export type TabTrigger = 'activated' | 'focus' | 'updated' | 'removed' | 'snapshot' | 'startup' | 'paused'
export type TabUnknownReason = 'no_focused_window' | 'not_normal' | 'no_tab' | 'no_address' | 'paused'
// From the browser extension through its native host, never from a capture helper. `browser` is the process that
// launched the host, found by the host itself, not reported by the extension.
export interface TabObs {
  trigger: TabTrigger
  state: 'page' | 'unknown'
  reason: TabUnknownReason | null
  browser: AppIdentity
  extension: string
  window: string | null
  tab: string | null
  url: string | null
  title: string | null
  // Set on a reply to the service's snapshot request: the focus epoch that request named.
  epoch?: number
}

export interface ObsByKind {
  hello: HelloObs
  heartbeat: HeartbeatObs
  focus: FocusObs
  input: InputObs
  session: SessionObs
  power: PowerObs
  clock: ClockObs
  loss: LossObs
  bye: ByeObs
  tab: TabObs
}
export type Kind = keyof ObsByKind

interface EnvelopeBase<K extends Kind> {
  v: typeof PROTOCOL_VERSION
  run: string
  seq: number
  boot: string
  t: EventTime
  platform: Platform
  source: string
  kind: K
  obs: ObsByKind[K]
}
export type Line = { [K in Kind]: EnvelopeBase<K> }[Kind]
export type LineOf<K extends Kind> = EnvelopeBase<K>

export type RejectReason = 'too_long' | 'not_json' | 'unsupported_version' | 'malformed'
export type ParseResult = { ok: true; line: Line } | { ok: false; reason: RejectReason; detail: string }

// Details name fields only; never echo values, which can carry titles.
class Malformed extends Error {}

function fail(detail: string): never {
  throw new Malformed(detail)
}

type Obj = Record<string, unknown>

function obj(v: unknown, at: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`${at}: expected object`)
  return v as Obj
}
function str(o: Obj, k: string, max = 256): string {
  const v = o[k]
  if (typeof v !== 'string' || v.length > max) fail(`${k}: expected string <= ${max}`)
  return v
}
function strOrNull(o: Obj, k: string, max = 2048): string | null {
  const v = o[k]
  if (v === null || v === undefined) return null
  if (typeof v !== 'string' || v.length > max) fail(`${k}: expected string|null <= ${max}`)
  return v
}
function int(o: Obj, k: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const v = o[k]
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) fail(`${k}: expected integer in [${min}, ${max}]`)
  return v
}
function intOrNull(o: Obj, k: string): number | null {
  const v = o[k]
  if (v === null || v === undefined) return null
  return int(o, k)
}
function bool(o: Obj, k: string): boolean {
  const v = o[k]
  if (typeof v !== 'boolean') fail(`${k}: expected boolean`)
  return v
}
function boolOr(o: Obj, k: string, fallback: boolean): boolean {
  return o[k] === undefined ? fallback : bool(o, k)
}
function oneOf<T extends string>(o: Obj, k: string, allowed: readonly T[]): T {
  const v = o[k]
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) fail(`${k}: expected one of ${allowed.join('|')}`)
  return v as T
}

const PLATFORMS = ['macos', 'windows', 'linux'] as const
const PERMISSION_STATES = ['granted', 'denied', 'not_applicable'] as const
const CHANNEL_STATES = ['ok', 'degraded', 'stalled', 'no_permission'] as const
const IDENTITY_STATES = ['ok', 'access_denied', 'timeout', 'gone', 'none', 'unresolved'] as const
const TITLE_STATES = ['ok', 'empty', 'no_window', 'no_permission', 'timeout', 'unavailable'] as const
const FOCUS_TRIGGERS = ['app_changed', 'window_changed', 'title_changed', 'reconcile', 'snapshot'] as const
const SESSION_STATES = [
  'locked',
  'unlocked',
  'console_disconnect',
  'console_connect',
  'remote_connect',
  'remote_disconnect',
  'logoff',
  'logon',
  'unknown',
] as const
const POWER_STATES = ['sleep', 'resume', 'resume_user', 'display_off', 'display_on', 'display_dim'] as const
const CLOCK_CHANGES = ['time_changed', 'timezone_changed'] as const
const TAB_TRIGGERS = ['activated', 'focus', 'updated', 'removed', 'snapshot', 'startup', 'paused'] as const
const TAB_UNKNOWN_REASONS = ['no_focused_window', 'not_normal', 'no_tab', 'no_address', 'paused'] as const
const EXTENSION_ID_RE = /^[A-Za-z0-9@._{}-]{1,128}$/
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/
const SOURCE_RE = /^[a-z][a-z0-9_]{0,31}$/

function permissions(v: unknown): Permissions {
  const o = obj(v, 'permissions')
  return { accessibility: oneOf(o, 'accessibility', PERMISSION_STATES) }
}

function appIdentity(v: unknown): AppIdentity {
  const o = obj(v, 'app')
  let store: AppIdentity['store'] = null
  if (o.store !== null && o.store !== undefined) {
    const s = obj(o.store, 'store')
    store = { aumid: str(s, 'aumid', 512), package: strOrNull(s, 'package', 512) }
  }
  return {
    app_id: strOrNull(o, 'app_id', 1024),
    name: strOrNull(o, 'name', 512),
    path: strOrNull(o, 'path', 2048),
    pid: intOrNull(o, 'pid'),
    registered_browser: bool(o, 'registered_browser'),
    identity_state: oneOf(o, 'identity_state', IDENTITY_STATES),
    store,
  }
}

function windowInfo(v: unknown): WindowInfo {
  const o = obj(v, 'window')
  const title = strOrNull(o, 'title', MAX_TITLE_CHARS)
  const title_state = oneOf(o, 'title_state', TITLE_STATES)
  if ((title === null) === (title_state === 'ok')) fail('title: present exactly when title_state is ok')
  const info: WindowInfo = { window: strOrNull(o, 'window', 64), title, title_state }
  if (o.mode !== undefined && o.mode !== null) info.mode = oneOf(o, 'mode', ['normal', 'private', 'unknown'] as const)
  return info
}

const OBS: { [K in Kind]: (o: Obj) => ObsByKind[K] } = {
  hello: (o) => {
    const c = obj(o.config, 'config')
    return {
      helper: str(o, 'helper', 64),
      version: str(o, 'version', 64),
      pid: int(o, 'pid'),
      os: str(o, 'os', 128),
      permissions: permissions(o.permissions),
      config: {
        heartbeat_s: int(c, 'heartbeat_s', 1, 3600),
        idle_threshold_s: int(c, 'idle_threshold_s', 1, 86400),
        reconcile_s: int(c, 'reconcile_s', 1, 86400),
      },
    }
  },
  heartbeat: (o) => {
    const r = obj(o.registrations, 'registrations')
    return {
      awake_us: int(o, 'awake_us'),
      permissions: permissions(o.permissions),
      registrations: { focus: bool(r, 'focus'), session: bool(r, 'session'), power: bool(r, 'power') },
      titles: oneOf(o, 'titles', CHANNEL_STATES),
      stall_ms: int(o, 'stall_ms'),
      dropped: int(o, 'dropped'),
    }
  },
  focus: (o) => ({
    trigger: oneOf(o, 'trigger', FOCUS_TRIGGERS),
    app: appIdentity(o.app),
    window: windowInfo(o.window),
  }),
  input: (o) => ({
    state: oneOf(o, 'state', ['idle', 'active'] as const),
    last_input_wall_ms: int(o, 'last_input_wall_ms'),
    threshold_s: int(o, 'threshold_s', 1, 86400),
    snapshot: boolOr(o, 'snapshot', false),
  }),
  session: (o) => ({ state: oneOf(o, 'state', SESSION_STATES), snapshot: boolOr(o, 'snapshot', false) }),
  power: (o) => ({ state: oneOf(o, 'state', POWER_STATES) }),
  clock: (o) => ({ change: oneOf(o, 'change', CLOCK_CHANGES) }),
  loss: (o) => {
    const from_wall_ms = int(o, 'from_wall_ms')
    const to_wall_ms = int(o, 'to_wall_ms')
    if (to_wall_ms < from_wall_ms) fail('to_wall_ms: before from_wall_ms')
    return { channel: oneOf(o, 'channel', ['focus'] as const), count: int(o, 'count', 1), from_wall_ms, to_wall_ms }
  },
  bye: (o) => ({ reason: str(o, 'reason', 128) }),
  tab: (o) => {
    const state = oneOf(o, 'state', ['page', 'unknown'] as const)
    const extension = str(o, 'extension', 128)
    if (!EXTENSION_ID_RE.test(extension)) fail('extension: bad id')
    const obs: TabObs = {
      trigger: oneOf(o, 'trigger', TAB_TRIGGERS),
      state,
      reason: o.reason === null || o.reason === undefined ? null : oneOf(o, 'reason', TAB_UNKNOWN_REASONS),
      browser: appIdentity(o.browser),
      extension,
      window: strOrNull(o, 'window', 64),
      tab: strOrNull(o, 'tab', 64),
      url: strOrNull(o, 'url', MAX_URL_CHARS),
      title: strOrNull(o, 'title', MAX_TITLE_CHARS),
    }
    if (o.epoch !== undefined && o.epoch !== null) obs.epoch = int(o, 'epoch')
    if (state === 'page' && (obs.url === null || obs.reason !== null)) fail('tab: a page has a url and no reason')
    if (state === 'unknown' && (obs.url !== null || obs.title !== null || obs.reason === null)) fail('tab: unknown has a reason and no url or title')
    return obs
  },
}

export function parseLine(raw: string): ParseResult {
  if (raw.length > MAX_LINE_BYTES || Buffer.byteLength(raw, 'utf8') > MAX_LINE_BYTES) {
    return { ok: false, reason: 'too_long', detail: '' }
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'not_json', detail: '' }
  }
  try {
    const e = obj(value, 'line')
    if (e.v !== PROTOCOL_VERSION) return { ok: false, reason: 'unsupported_version', detail: typeof e.v === 'number' ? String(e.v) : '' }
    const run = str(e, 'run', 64)
    const boot = str(e, 'boot', 64)
    if (!ID_RE.test(run)) fail('run: bad id')
    if (!ID_RE.test(boot)) fail('boot: bad id')
    const source = str(e, 'source', 32)
    if (!SOURCE_RE.test(source)) fail('source: bad name')
    const t = obj(e.t, 't')
    const kind = e.kind
    if (typeof kind !== 'string' || !Object.hasOwn(OBS, kind)) fail('kind: unknown')
    const k = kind as Kind
    const line = {
      v: PROTOCOL_VERSION,
      run,
      seq: int(e, 'seq'),
      boot,
      t: {
        wall_ms: int(t, 'wall_ms'),
        mono_us: int(t, 'mono_us'),
        tz: str(t, 'tz', 64),
        tz_offset_min: int(t, 'tz_offset_min', -18 * 60, 18 * 60),
      },
      platform: oneOf(e, 'platform', PLATFORMS),
      source,
      kind: k,
      obs: OBS[k](obj(e.obs, 'obs')),
    } as Line
    return { ok: true, line }
  } catch (err) {
    if (err instanceof Malformed) return { ok: false, reason: 'malformed', detail: err.message }
    throw err
  }
}
