import type { AppIdentity, Line, ObsByKind, Kind, Platform } from '../../capture/protocol.ts'

let seq = 0
export function resetSeq(): void {
  seq = 0
}

export function line<K extends Kind>(kind: K, obs: ObsByKind[K], wallMs: number, opts: { platform?: Platform; source?: string; run?: string } = {}): Line {
  return {
    v: 1,
    run: opts.run ?? 'run-test',
    seq: seq++,
    boot: 'boot-test',
    t: { wall_ms: wallMs, mono_us: wallMs * 1000, tz: 'Example/Town', tz_offset_min: -300 },
    platform: opts.platform ?? 'macos',
    source: opts.source ?? 'test',
    kind,
    obs,
  } as Line
}

export function app(appId: string | null, extra: Partial<AppIdentity> = {}): AppIdentity {
  return {
    app_id: appId,
    name: appId,
    path: null,
    pid: 100,
    registered_browser: false,
    engine: 'none',
    signer: null,
    version_info: null,
    identity_state: appId === null ? 'access_denied' : 'ok',
    store: null,
    ...extra,
  }
}

export function focus(a: AppIdentity, title: string | null, wallMs: number, trigger: ObsByKind['focus']['trigger'] = 'title_changed', window = 'w1'): Line {
  return line('focus', { trigger, app: a, window: { window, title, title_state: title === null ? 'unavailable' : 'ok' } }, wallMs)
}
