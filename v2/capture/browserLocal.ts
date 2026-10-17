// The extension's local connection: a WebSocket on 127.0.0.1, used where the browser cannot find a native messaging
// host (the Windows Store package). Nothing from a connection is used until four checks pass, in this order:
//   1. Host is 127.0.0.1:<port> and Origin is an allowed extension; web pages cannot forge Origin.
//   2. The connecting process runs as this user and belongs to a browser (found by the capture helper); its browser is
//      the identity a native host would stamp, so the front-app gate works the same.
//   3. The extension names a pairing made for that same origin.
//   4. Both sides prove they hold that pairing's secret (see pairing.ts). The extension sends no page before step 4.
// Logs carry codes and counts only.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type net from 'node:net'
import type { BrowserPages } from './browser.ts'
import type { Pause, PauseState } from './pause.ts'
import {
  extensionOfOrigin,
  isNonce,
  isPairId,
  LOCAL_PATH,
  LOCAL_PORTS,
  parsePairLink,
  proof,
  randomB64url,
  sameProof,
  transcript,
  type Pairing,
} from './pairing.ts'
import { MAX_TITLE_CHARS, MAX_URL_CHARS, parseLine, type AppIdentity, type Line, type Platform } from './protocol.ts'
import { acceptKey, encodeClose, encodeText, FrameDecoder, OP_CLOSE, OP_PING, OP_PONG, OP_TEXT, encodeFrame } from './websocket.ts'

export const LOCAL_ENV = 'DAYLENS_V2_BROWSER_LOCAL'
const MAX_MESSAGE_BYTES = 16 * 1024
const MAX_CONNECTIONS = 32
// Pairings received but not yet proven by a connection. A web page can open a daylens://pair link too; such a pairing
// can never be proven, so it only ever sits here and never displaces a real one.
const MAX_PENDING = 8
const HANDSHAKE_MS = 10_000
const META_KEY = 'browser_pairings'
const TRIGGERS = new Set(['activated', 'focus', 'updated', 'removed', 'snapshot', 'startup', 'paused'])
const REASONS = new Set(['no_focused_window', 'not_normal', 'no_tab', 'no_address', 'paused'])

export function localEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform === 'win32' || env[LOCAL_ENV] === '1'
}

export type PeerResult = { ok: true; browser: AppIdentity } | { ok: false; reason: string }
export type PeerCheck = (localPort: number, remotePort: number) => Promise<PeerResult>

// Asks the capture helper which process owns the other end of this loopback connection.
export function helperPeerCheck(helperPath: string): PeerCheck {
  return (localPort, remotePort) =>
    new Promise((resolve) => {
      execFile(helperPath, ['--tcp-peer', String(localPort), String(remotePort)], { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true }, (err, stdout) => {
        if (err && !stdout) return resolve({ ok: false, reason: 'helper_failed' })
        try {
          const r = JSON.parse(stdout) as { ok?: unknown; reason?: unknown; browser?: unknown }
          if (r.ok === true && r.browser && typeof r.browser === 'object') return resolve({ ok: true, browser: r.browser as AppIdentity })
          resolve({ ok: false, reason: typeof r.reason === 'string' && /^[a-z_]{1,32}$/.test(r.reason) ? r.reason : 'refused' })
        } catch {
          resolve({ ok: false, reason: 'helper_output' })
        }
      })
    })
}

export interface ClockPoint {
  boot: string
  wall_ms: number
  mono_us: number
}

export interface PairingStore {
  meta(key: string): string | null
  setMeta(key: string, value: string | null): void
}

interface Stored extends Pairing {
  paired_wall_ms: number
}

// Firefox gives each install a random origin, so any Firefox extension could make and prove its own pairing. A new
// Firefox pairing therefore needs the person's Allow in the app; Chromium origins are pinned to known IDs.
export function needsConfirmation(origin: string): boolean {
  return origin.startsWith('moz-extension://')
}

export interface ConfirmRequest {
  op: 'confirm_pairing'
  id: string
  browser: string | null
}

export interface BrowserLocalOptions {
  ports?: readonly number[]
  peerCheck: PeerCheck
  // Asks the app to show Allow / Don't allow; the answer comes back through decide().
  confirm?: (req: ConfirmRequest) => void
  // The capture helper's clock, so service-stamped tab lines sort with the helper's own lines.
  clock: () => ClockPoint | null
  log?: (msg: string) => void
  now?: () => number
  handshakeMs?: number
}

type ExtMessage =
  | { t: 'tab'; trigger: string; state: 'page'; window: string; tab: string | null; url: string; title: string | null; epoch?: number }
  | { t: 'tab'; trigger: string; state: 'unknown'; reason: string; epoch?: number }
  | { t: 'status' }
  | { t: 'ping' }

function idOrNull(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null
  return typeof v === 'string' && v.length <= 64 ? v : undefined
}

// Mirrors the native hosts' ExtensionMessage.parse: anything not exactly one of the extension's messages is null.
export function parseExtensionMessage(raw: string): ExtMessage | null {
  let o: Record<string, unknown>
  try {
    const v = JSON.parse(raw)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    o = v
  } catch {
    return null
  }
  if (o.t === 'status' || o.t === 'ping') return { t: o.t }
  if (o.t !== 'tab' || typeof o.trigger !== 'string' || !TRIGGERS.has(o.trigger)) return null
  if (o.epoch !== undefined && !(typeof o.epoch === 'number' && Number.isSafeInteger(o.epoch) && o.epoch >= 0)) return null
  const tag = typeof o.epoch === 'number' ? { epoch: o.epoch } : {}
  if (o.state === 'unknown') return typeof o.reason === 'string' && REASONS.has(o.reason) ? { t: 'tab', trigger: o.trigger, state: 'unknown', reason: o.reason, ...tag } : null
  if (o.state !== 'page' || typeof o.url !== 'string' || o.url.length === 0 || o.url.length > MAX_URL_CHARS) return null
  const window = idOrNull(o.window)
  const tab = idOrNull(o.tab)
  if (typeof window !== 'string' || tab === undefined) return null
  let title = typeof o.title === 'string' && o.title.length > 0 ? o.title : null
  if (title && title.length > MAX_TITLE_CHARS) {
    const cut = title.charCodeAt(MAX_TITLE_CHARS - 1)
    title = title.slice(0, cut >= 0xd800 && cut <= 0xdbff ? MAX_TITLE_CHARS - 1 : MAX_TITLE_CHARS)
  }
  return { t: 'tab', trigger: o.trigger, state: 'page', window, tab, url: o.url, title, ...tag }
}

function platformName(): Platform {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
}

function reject(socket: net.Socket, status: number): void {
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy())
}

type Phase = 'peer' | 'hello' | 'proof' | 'confirm' | 'ready' | 'closed'

class Conn {
  readonly socket: net.Socket
  readonly origin: string
  readonly extension: string
  phase: Phase = 'peer'
  browser: AppIdentity | null = null
  hello: { pair: string; nonce: string } | null = null
  pairing: (Pairing & { pending: boolean; approved?: boolean }) | null = null
  svcNonce = ''
  pagesId: number | null = null
  readonly run = randomUUID()
  seq = 0
  timer: ReturnType<typeof setTimeout> | null = null

  constructor(socket: net.Socket, origin: string, extension: string) {
    this.socket = socket
    this.origin = origin
    this.extension = extension
  }

  send(msg: object): void {
    if (this.phase !== 'closed' && this.socket.writable) this.socket.write(encodeText(JSON.stringify(msg)))
  }
}

export class BrowserLocal {
  private readonly pages: BrowserPages
  private readonly pause: Pause
  private readonly store: PairingStore
  private readonly ports: readonly number[]
  private readonly peerCheck: PeerCheck
  private readonly clock: () => ClockPoint | null
  private readonly log: (msg: string) => void
  private readonly now: () => number
  private readonly handshakeMs: number
  private server: http.Server | null = null
  private readonly conns = new Set<Conn>()
  private paired: Stored[]
  private readonly pending: (Pairing & { approved?: boolean })[] = []
  private readonly asked = new Set<string>()
  private readonly confirm: (req: ConfirmRequest) => void
  port: number | null = null

  constructor(pages: BrowserPages, pause: Pause, store: PairingStore, opts: BrowserLocalOptions) {
    this.pages = pages
    this.pause = pause
    this.store = store
    this.ports = opts.ports ?? LOCAL_PORTS
    this.peerCheck = opts.peerCheck
    this.confirm = opts.confirm ?? (() => {})
    this.clock = opts.clock
    this.log = opts.log ?? (() => {})
    this.now = opts.now ?? Date.now
    this.handshakeMs = opts.handshakeMs ?? HANDSHAKE_MS
    this.paired = this.load()
  }

  private load(): Stored[] {
    try {
      const v = JSON.parse(this.store.meta(META_KEY) ?? '[]')
      return Array.isArray(v) ? v.filter((p) => isPairId(p?.id) && typeof p.key === 'string' && typeof p.origin === 'string') : []
    } catch {
      return []
    }
  }

  private save(): void {
    this.store.setMeta(META_KEY, this.paired.length ? JSON.stringify(this.paired) : null)
  }

  // Listens on the first of the fixed ports that is free. Another process holding a port only moves Daylens along.
  async start(): Promise<boolean> {
    for (const port of this.ports) {
      const server = http.createServer({ requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192 }, (_req, res) => {
        res.writeHead(404, { connection: 'close' }).end()
      })
      server.maxConnections = MAX_CONNECTIONS
      server.on('upgrade', (req, socket) => this.onUpgrade(req, socket as net.Socket, port))
      server.on('clientError', (_err, socket) => socket.destroy())
      const ok = await new Promise<boolean>((resolve) => {
        server.once('error', (err) => {
          this.log(`browser local port taken port=${port} code=${(err as { code?: string }).code ?? 'unknown'}`)
          resolve(false)
        })
        server.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(true))
      })
      if (!ok) continue
      this.server = server
      this.port = port
      this.log(`browser local listening port=${port}`)
      return true
    }
    this.log('browser local failed code=no_port')
    return false
  }

  async stop(): Promise<void> {
    for (const c of this.conns) this.close(c, 1001)
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  // A daylens://pair link the app received from the operating system.
  addPairLink(link: string): boolean {
    const p = parsePairLink(link)
    if (!p) {
      this.log('browser pairing rejected reason=bad_link')
      return false
    }
    if (this.pending.some((x) => x.id === p.id) || this.paired.some((x) => x.id === p.id)) return true
    this.pending.push(p)
    if (this.pending.length > MAX_PENDING) {
      const dropped = this.pending.shift()!
      // A pairing waiting on the person's answer can be pushed out by a flood of links; its connections end cleanly.
      if (this.asked.delete(dropped.id)) for (const c of [...this.conns]) if (c.phase === 'confirm' && c.pairing?.id === dropped.id) this.close(c, 1008)
    }
    this.log(`browser pairing received pending=${this.pending.length}`)
    return true
  }

  pairings(): { id: string; origin: string; paired_wall_ms: number }[] {
    return this.paired.map(({ id, origin, paired_wall_ms }) => ({ id, origin, paired_wall_ms }))
  }

  unpair(id: string): boolean {
    const before = this.paired.length
    this.paired = this.paired.filter((p) => p.id !== id)
    if (this.paired.length === before) return false
    this.save()
    for (const c of this.conns) if (c.pairing?.id === id) this.close(c, 1008)
    this.log('browser pairing removed')
    return true
  }

  status(s: PauseState): void {
    for (const c of this.conns) if (c.phase === 'ready') c.send(this.statusOf(s))
  }

  private statusOf(s: PauseState): object {
    return { t: 'status', daylens: 'connected', capture: s.paused ? 'paused' : 'running', until_wall_ms: s.until_wall_ms }
  }

  private onUpgrade(req: http.IncomingMessage, socket: net.Socket, port: number): void {
    socket.on('error', () => {})
    const h = req.headers
    const origin = typeof h.origin === 'string' ? h.origin : ''
    const extension = extensionOfOrigin(origin)
    let why: string | null = null
    if (socket.remoteAddress !== '127.0.0.1') why = 'not_loopback'
    else if (h.host !== `127.0.0.1:${port}`) why = 'host'
    else if (extension === null) why = 'origin'
    else if (req.method !== 'GET' || (req.url ?? '') !== LOCAL_PATH) why = 'path'
    else if (h['sec-websocket-version'] !== '13' || String(h.upgrade).toLowerCase() !== 'websocket') why = 'not_websocket'
    else if (this.conns.size >= MAX_CONNECTIONS) why = 'busy'
    const accept = typeof h['sec-websocket-key'] === 'string' ? acceptKey(h['sec-websocket-key']) : null
    if (!why && accept === null) why = 'not_websocket'
    if (why) {
      this.log(`browser local refused reason=${why}`)
      return reject(socket, why === 'busy' ? 503 : why === 'origin' || why === 'host' || why === 'not_loopback' ? 403 : 400)
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.setNoDelay(true)
    const c = new Conn(socket, origin, extension!)
    this.conns.add(c)
    c.timer = setTimeout(() => {
      if (c.phase !== 'ready') {
        this.log(`browser local refused reason=handshake_timeout phase=${c.phase}`)
        this.close(c, 1008)
      }
    }, this.handshakeMs)
    const decoder = new FrameDecoder(MAX_MESSAGE_BYTES)
    socket.on('data', (chunk: Buffer) => {
      for (const f of decoder.feed(chunk)) {
        if (c.phase === 'closed') return
        if (f.op === OP_TEXT) void this.onMessage(c, f.text, port)
        else if (f.op === OP_PING) socket.write(encodeFrame(OP_PONG, f.data))
        else if (f.op === OP_CLOSE) return this.close(c, 1000)
      }
      if (decoder.failed) {
        this.log(`browser local closed reason=${decoder.failed}`)
        this.close(c, 1002)
      }
    })
    socket.on('close', () => this.closed(c))
    void this.peerCheck(port, socket.remotePort ?? 0).then(
      (r) => {
        if (c.phase === 'closed') return
        if (!r.ok) {
          this.log(`browser local refused reason=peer_${r.reason}`)
          return this.close(c, 1008)
        }
        c.browser = r.browser
        c.phase = 'hello'
        if (c.hello) void this.challenge(c, port)
      },
      () => this.close(c, 1008),
    )
  }

  private async onMessage(c: Conn, text: string, port: number): Promise<void> {
    if (c.phase === 'ready') return this.onReady(c, text)
    let o: Record<string, unknown>
    try {
      o = JSON.parse(text)
    } catch {
      return this.refuse(c, 'not_json')
    }
    if (o.t === 'hello' && !c.hello && (c.phase === 'peer' || c.phase === 'hello')) {
      if (o.v !== 1 || !isPairId(o.pair) || !isNonce(o.nonce)) return this.refuse(c, 'bad_hello')
      c.hello = { pair: o.pair, nonce: o.nonce }
      if (c.phase === 'hello') await this.challenge(c, port)
      return
    }
    if (o.t === 'proof' && c.phase === 'proof') return this.verify(c, o.proof, port)
    this.refuse(c, 'out_of_order')
  }

  private async challenge(c: Conn, port: number): Promise<void> {
    const hello = c.hello!
    const stored = this.paired.find((p) => p.id === hello.pair && p.origin === c.origin)
    const pend = stored ? null : this.pending.find((p) => p.id === hello.pair && p.origin === c.origin)
    if (!stored && !pend) {
      c.send({ t: 'unpaired' })
      this.log('browser local refused reason=unpaired')
      return this.close(c, 1008)
    }
    c.pairing = { ...(stored ?? pend)!, pending: !stored }
    c.svcNonce = randomB64url(32)
    c.phase = 'proof'
    const mine = await proof(c.pairing.key, transcript('service', c.origin, port, hello.pair, hello.nonce, c.svcNonce))
    c.send({ t: 'challenge', v: 1, nonce: c.svcNonce, proof: mine })
  }

  private async verify(c: Conn, theirs: unknown, port: number): Promise<void> {
    const p = c.pairing!
    const want = await proof(p.key, transcript('extension', c.origin, port, p.id, c.hello!.nonce, c.svcNonce))
    if (c.phase !== 'proof') return
    if (!sameProof(theirs, want)) return this.refuse(c, 'bad_proof')
    const live = this.pending.find((x) => x.id === p.id)
    if (p.pending && needsConfirmation(p.origin) && !live?.approved) {
      // Proven, so a real extension in a real browser made it; the person decides whether it may connect.
      if (c.timer) clearTimeout(c.timer)
      c.timer = null
      c.phase = 'confirm'
      c.send({ t: 'awaiting' })
      if (!this.asked.has(p.id)) {
        this.asked.add(p.id)
        this.confirm({ op: 'confirm_pairing', id: p.id, browser: c.browser?.name ?? null })
        this.log('browser pairing awaiting confirmation')
      }
      return
    }
    this.ready(c, p)
  }

  // The app's answer to a confirm_pairing request.
  decide(id: string, allow: boolean): boolean {
    const p = this.pending.find((x) => x.id === id)
    if (!p || !this.asked.has(id)) return false
    this.asked.delete(id)
    const waiting = [...this.conns].filter((c) => c.phase === 'confirm' && c.pairing?.id === id)
    if (!allow) {
      this.pending.splice(this.pending.indexOf(p), 1)
      for (const c of waiting) {
        c.send({ t: 'denied' })
        this.close(c, 1008)
      }
      this.log('browser pairing denied')
      return true
    }
    p.approved = true
    this.log('browser pairing allowed')
    const [first, ...rest] = waiting
    for (const c of rest) this.close(c, 1008)
    if (first) this.ready(first, first.pairing!)
    return true
  }

  private ready(c: Conn, p: Pairing & { pending: boolean }): void {
    if (p.pending) {
      // The first proven connection makes the pairing real and replaces any earlier one for the same extension.
      const i = this.pending.findIndex((x) => x.id === p.id)
      if (i !== -1) this.pending.splice(i, 1)
      const replaced = this.paired.filter((x) => x.origin === p.origin)
      this.paired = [...this.paired.filter((x) => x.origin !== p.origin), { id: p.id, key: p.key, origin: p.origin, paired_wall_ms: this.now() }]
      this.save()
      for (const o of this.conns) if (o !== c && replaced.some((r) => r.id === o.pairing?.id)) this.close(o, 1008)
      this.log(`browser pairing confirmed replaced=${replaced.length}`)
    }
    if (c.timer) clearTimeout(c.timer)
    c.timer = null
    c.phase = 'ready'
    c.pagesId = this.pages.connect({ send: (msg) => msg.op === 'snapshot' && c.send(msg.epoch === null ? { t: 'snapshot' } : { t: 'snapshot', epoch: msg.epoch }) })
    this.log(`browser connected transport=local count=${this.pages.connectionCount()}`)
    c.send(this.statusOf(this.pause.state()))
    c.send({ t: 'snapshot' })
  }

  private onReady(c: Conn, text: string): void {
    const m = parseExtensionMessage(text)
    if (!m) return this.log('browser line rejected reason=bad_message')
    if (m.t === 'ping') return
    if (m.t === 'status') return c.send(this.statusOf(this.pause.state()))
    const clk = this.clock()
    if (!clk) return this.log('browser line rejected reason=no_helper_clock')
    const wall = this.now()
    const line = {
      v: 1,
      run: c.run,
      seq: c.seq++,
      boot: clk.boot,
      t: { wall_ms: wall, mono_us: clk.mono_us + Math.max(0, wall - clk.wall_ms) * 1000, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, tz_offset_min: -new Date(wall).getTimezoneOffset() },
      platform: platformName(),
      source: 'browser_ext',
      kind: 'tab',
      obs: {
        trigger: m.trigger,
        state: m.state,
        reason: m.state === 'unknown' ? m.reason : null,
        browser: c.browser,
        extension: c.extension,
        window: m.state === 'page' ? m.window : null,
        tab: m.state === 'page' ? m.tab : null,
        url: m.state === 'page' ? m.url : null,
        title: m.state === 'page' ? m.title : null,
        ...(m.epoch === undefined ? {} : { epoch: m.epoch }),
      },
    }
    const r = parseLine(JSON.stringify(line))
    if (!r.ok || r.line.kind !== 'tab') return this.log(`browser line rejected reason=${r.ok ? 'not_tab' : r.reason}`)
    if (this.pause.blocks(wall)) return
    this.pages.onTab(c.pagesId!, r.line as Line & { kind: 'tab' })
  }

  private refuse(c: Conn, why: string): void {
    this.log(`browser local refused reason=${why}`)
    this.close(c, 1008)
  }

  private close(c: Conn, code: number): void {
    if (c.phase === 'closed') return
    if (c.socket.writable) c.socket.write(encodeClose(code))
    c.socket.end()
    this.closed(c)
  }

  private closed(c: Conn): void {
    const wasReady = c.phase === 'ready'
    c.phase = 'closed'
    if (c.timer) clearTimeout(c.timer)
    if (!this.conns.delete(c)) return
    setTimeout(() => c.socket.destroy(), 1000).unref()
    if (wasReady && c.pagesId !== null) {
      this.pages.disconnect(c.pagesId)
      this.log(`browser disconnected transport=local count=${this.pages.connectionCount()}`)
    }
  }
}
