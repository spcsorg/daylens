// Browser pages from the Daylens extension. A page is stored only while the helper reports that same browser in
// front and the extension, after that browser came to the front, says its focused normal window shows the page.
// Anything missing means no page: the page row is ended with an explicit unknown row, never left running.
// The browser's own window title stays withheld by the normalizer; only the extension's tab title is stored here.

import { addressHost, cleanAddress } from './address.ts'
import { cleanTitle, type GapPoint, type ObservationRow, type Privacy, type Sink } from './normalize.ts'
import type { AppIdentity, Line, LineOf } from './protocol.ts'

export type EndReason =
  | 'no_focused_window'
  | 'not_normal'
  | 'no_tab'
  | 'no_address'
  | 'paused'
  | 'app_changed'
  | 'window_changed'
  | 'disconnected'
  | 'lines_lost'
  | 'excluded'

export interface BrowserLink {
  send(msg: { op: 'snapshot'; epoch: number | null }): void
}

interface Claim {
  line: LineOf<'tab'>
  order: number
}

interface Conn {
  link: BrowserLink
  run: string | null
  lastSeq: number
  claim: Claim | null
  browser: AppIdentity | null
}

// One stretch of one app and window in front. A page needs evidence from inside its own epoch: a snapshot reply that
// names it, or a line whose event time on the same boot's monotonic clock is not before the epoch began.
interface Front {
  app: AppIdentity
  window: string | null
  epoch: number
  boot: string
  mono_us: number
}

interface Effective {
  key: string
  conn: number
  line: LineOf<'tab'>
  rowId: number | null
  gapId: number | null
}

export function sameBrowser(front: AppIdentity, b: AppIdentity): boolean {
  if (front.identity_state !== 'ok' || b.identity_state !== 'ok') return false
  if (front.pid === null || b.pid === null || front.pid !== b.pid) return false
  if (front.app_id !== null && b.app_id !== null && front.app_id.toLowerCase() !== b.app_id.toLowerCase()) return false
  return true
}

function appKey(app: AppIdentity): string {
  return JSON.stringify([app.identity_state === 'ok' ? app.app_id?.toLowerCase() : null, app.pid, app.identity_state])
}

export interface BrowserPagesOptions {
  now?: () => number
  log?: (msg: string) => void
}

export class BrowserPages {
  private readonly sink: Sink
  private readonly privacy: Privacy
  private readonly now: () => number
  private readonly log: (msg: string) => void
  private readonly conns = new Map<number, Conn>()
  private nextConn = 1
  private order = 0
  private epoch = 0
  private front: Front | null = null
  private effective: Effective | null = null
  // The last page that was stored; an unknown row is due when the page timeline stops showing it.
  private showingPage = false

  constructor(sink: Sink, privacy: Privacy, opts: BrowserPagesOptions = {}) {
    this.sink = sink
    this.privacy = privacy
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (() => {})
  }

  connectionCount(): number {
    return this.conns.size
  }

  connect(link: BrowserLink): number {
    const id = this.nextConn++
    this.conns.set(id, { link, run: null, lastSeq: -1, claim: null, browser: null })
    return id
  }

  disconnect(id: number): void {
    const c = this.conns.get(id)
    if (!c) return
    this.conns.delete(id)
    if (this.effective?.conn === id) this.recompute({ wall_ms: this.now(), mono_us: null, boot: null }, 'disconnected', null)
  }

  // A tab line from the host on connection `id`, already validated and outside any pause.
  onTab(id: number, line: LineOf<'tab'>): void {
    const c = this.conns.get(id)
    if (!c) return
    if (c.run !== null && line.run !== c.run) {
      this.log('browser line rejected reason=run_changed')
      return
    }
    const jumped = c.run !== null && line.seq !== c.lastSeq + 1
    c.run = line.run
    c.lastSeq = line.seq
    c.browser = line.obs.browser
    if (jumped) {
      // A dropped line may have been the one saying the page ended.
      this.log('browser lines lost')
      c.claim = null
      this.recompute(this.timeFrom(line), 'lines_lost', line)
      c.link.send({ op: 'snapshot', epoch: this.front?.epoch ?? null })
      return
    }
    if (this.privacy.classify(line.obs.browser).excluded) {
      c.claim = null
      return
    }
    c.claim = { line, order: ++this.order }
    this.recompute(this.timeFrom(line), line.obs.reason ?? 'no_tab', line)
  }

  // Every helper focus line. A different app or window in front withdraws every page until that window is confirmed.
  onFront(line: LineOf<'focus'>): void {
    const app = line.obs.app
    const win = line.obs.window.window
    const sameApp = this.front !== null && appKey(this.front.app) === appKey(app)
    if (sameApp && this.front!.window === win && line.obs.trigger !== 'window_changed') return
    this.front = { app, window: win, epoch: ++this.epoch, boot: line.boot, mono_us: line.t.mono_us }
    this.recompute(this.timeFrom(line), sameApp ? 'window_changed' : 'app_changed', line)
    for (const c of this.conns.values()) {
      if (c.browser === null || sameBrowser(app, c.browser)) c.link.send({ op: 'snapshot', epoch: this.front.epoch })
    }
  }

  // Helper lines were lost, the helper went away, or Daylens paused: forget everything; gaps already cover the time.
  interrupt(at: GapPoint): void {
    if (this.effective?.gapId != null) this.sink.closeGap(this.effective.gapId, at)
    this.effective = null
    this.showingPage = false
    this.front = null
    for (const c of this.conns.values()) c.claim = null
  }

  requestSnapshots(): void {
    for (const c of this.conns.values()) c.link.send({ op: 'snapshot', epoch: this.front?.epoch ?? null })
  }

  private fresh(line: LineOf<'tab'>, front: Front): boolean {
    if (line.obs.epoch !== undefined) return line.obs.epoch === front.epoch
    return line.boot === front.boot && line.t.mono_us >= front.mono_us
  }

  private timeFrom(line: Line): GapPoint {
    return { wall_ms: line.t.wall_ms, mono_us: line.t.mono_us, boot: line.boot }
  }

  private winner(): { id: number; claim: Claim } | null {
    const front = this.front
    if (!front) return null
    let best: { id: number; claim: Claim } | null = null
    for (const [id, c] of this.conns) {
      const cl = c.claim
      if (!cl || cl.line.obs.state !== 'page' || !this.fresh(cl.line, front)) continue
      if (!sameBrowser(front.app, cl.line.obs.browser)) continue
      if (!best || cl.order > best.claim.order) best = { id, claim: cl }
    }
    return best
  }

  private recompute(at: GapPoint, why: EndReason, cause: Line | null): void {
    const w = this.winner()
    // The winner owns the page now; earlier claims from other profiles are retired, so when the owner withdraws or
    // goes away the page is unknown until someone makes a fresh claim.
    if (w) for (const [id, c] of this.conns) if (id !== w.id) c.claim = null
    const url = w ? cleanAddress(w.claim.line.obs.url) : null
    if (!w || url === null) return this.setNone(at, w ? 'no_address' : why, cause)
    const title = w.claim.line.obs.title === null ? null : cleanTitle(w.claim.line.obs.title)
    const b = w.claim.line.obs.browser
    const key = JSON.stringify([w.id, b.pid, w.claim.line.obs.window, url, title?.title ?? null])
    const cur = this.effective
    if (cur && cur.key === key) {
      if (cur.rowId !== null) this.sink.extendObservation(cur.rowId, at.wall_ms)
      return
    }
    this.closeCurrentGap(at)
    if (this.privacy.siteExcluded(addressHost(url))) {
      if (this.showingPage) this.insertUnknown(w.claim.line, at, 'excluded', 'browser_ext')
      this.showingPage = false
      this.effective = {
        key,
        conn: w.id,
        line: w.claim.line,
        rowId: null,
        gapId: this.sink.openGap({ reason: 'excluded', scope: 'all', run: w.claim.line.run, start: at, detail: { source: 'site' } }),
      }
      return
    }
    const row = this.baseRow(w.claim.line, at, 'browser_ext')
    row.window = w.claim.line.obs.window === null ? null : `ext:${w.claim.line.obs.window}`
    row.title = title?.title ?? null
    row.title_raw = title && title.changed && title.title !== null ? w.claim.line.obs.title : null
    row.title_state = row.title === null ? 'empty' : 'ok'
    row.state = 'normal'
    row.url = url
    row.detail = JSON.stringify({ trigger: w.claim.line.obs.trigger, tab: w.claim.line.obs.tab, extension: w.claim.line.obs.extension })
    this.effective = { key, conn: w.id, line: w.claim.line, rowId: this.sink.insertObservation(row), gapId: null }
    this.showingPage = true
  }

  private setNone(at: GapPoint, why: EndReason, cause: Line | null): void {
    const cur = this.effective
    if (!cur) return
    this.closeCurrentGap(at)
    if (this.showingPage) {
      const source = cause?.kind === 'tab' ? 'browser_ext' : 'normalizer'
      this.insertUnknown(cause?.kind === 'tab' ? cause : cur.line, at, why, source)
    }
    this.effective = null
    this.showingPage = false
  }

  private closeCurrentGap(at: GapPoint): void {
    if (this.effective?.gapId != null) this.sink.closeGap(this.effective.gapId, at)
  }

  private insertUnknown(about: LineOf<'tab'>, at: GapPoint, why: EndReason, source: string): void {
    const row = this.baseRow(about, at, source)
    row.state = 'unknown'
    row.detail = JSON.stringify({ reason: why })
    this.sink.insertObservation(row)
  }

  private baseRow(line: LineOf<'tab'>, at: GapPoint, source: string): ObservationRow {
    const b = line.obs.browser
    const sameBoot = at.boot === line.boot && at.mono_us !== null
    return {
      run: line.run,
      seq: line.seq,
      boot: line.boot,
      platform: line.platform,
      source,
      kind: 'page',
      event_wall_ms: at.wall_ms,
      event_mono_us: sameBoot ? at.mono_us! : line.t.mono_us + Math.max(0, at.wall_ms - line.t.wall_ms) * 1000,
      tz: line.t.tz,
      tz_offset_min: line.t.tz_offset_min,
      app_id: b.app_id,
      app_name: b.name,
      app_path: b.path,
      pid: b.pid,
      window: null,
      title: null,
      title_raw: null,
      title_state: null,
      state: null,
      detail: null,
      url: null,
    }
  }
}
