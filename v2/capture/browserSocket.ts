// The local endpoint the browser host connects to: a Unix socket in the user's private temp folder on macOS and
// Linux, a per-user named pipe on Windows. Lines in are protocol lines of kind `tab`, or control ops; lines out are
// control ops. Logs carry codes and counts only.

import { execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { BrowserPages } from './browser.ts'
import type { PauseControl, PauseState } from './pause.ts'
import { MAX_LINE_BYTES, parseAppIdentity, parseLine } from './protocol.ts'

export const SOCKET_ENV = 'DAYLENS_V2_BROWSER_SOCKET'
const MAX_CONNECTIONS = 32

export function browserSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env[SOCKET_ENV]) return env[SOCKET_ENV]!
  if (process.platform === 'win32') return `\\\\.\\pipe\\daylens-v2-browser-${os.userInfo().username}`
  if (process.platform === 'darwin') {
    // The host reads the same folder with confstr(_CS_DARWIN_USER_TEMP_DIR); TMPDIR can differ in a shell.
    const tmp = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim()
    return path.join(tmp, 'daylens-v2', 'browser.sock')
  }
  return path.join(env.XDG_RUNTIME_DIR ?? os.tmpdir(), 'daylens-v2', 'browser.sock')
}

export type StatusMsg = { op: 'status'; capture: 'running' | 'paused'; until_wall_ms: number | null }

export function statusMsg(s: PauseState): StatusMsg {
  return { op: 'status', capture: s.paused ? 'paused' : 'running', until_wall_ms: s.until_wall_ms }
}

function probe(p: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(p)
    c.once('connect', () => {
      c.destroy()
      resolve(true)
    })
    c.once('error', () => resolve(false))
  })
}

export interface BrowserSocketOptions {
  path?: string
  log?: (msg: string) => void
}

export class BrowserSocket {
  private readonly pages: BrowserPages
  private readonly pause: PauseControl
  private readonly log: (msg: string) => void
  readonly path: string
  private server: net.Server | null = null
  private readonly sockets = new Set<net.Socket>()

  constructor(pages: BrowserPages, pause: PauseControl, opts: BrowserSocketOptions = {}) {
    this.pages = pages
    this.pause = pause
    this.log = opts.log ?? (() => {})
    this.path = opts.path ?? browserSocketPath()
  }

  async start(): Promise<boolean> {
    if (process.platform !== 'win32') {
      const dir = path.dirname(this.path)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const st = lstatSync(dir)
      if (!st.isDirectory() || st.isSymbolicLink() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
        this.log('browser socket refused code=folder_not_ours')
        return false
      }
      chmodSync(dir, 0o700)
      if (await probe(this.path)) {
        this.log('browser socket refused code=in_use')
        return false
      }
      try {
        unlinkSync(this.path)
      } catch {}
    }
    const server = net.createServer((s) => this.onSocket(s))
    server.maxConnections = MAX_CONNECTIONS
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', (err) => {
        this.log(`browser socket failed code=${(err as { code?: string }).code ?? 'unknown'}`)
        resolve(false)
      })
      server.listen(this.path, () => resolve(true))
    })
    if (!ok) return false
    if (process.platform !== 'win32') chmodSync(this.path, 0o600)
    this.server = server
    this.log('browser socket listening')
    return true
  }

  broadcast(msg: object): void {
    const line = JSON.stringify(msg) + '\n'
    for (const s of this.sockets) if (s.writable) s.write(line)
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy()
    this.sockets.clear()
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (process.platform !== 'win32') {
      try {
        unlinkSync(this.path)
      } catch {}
    }
  }

  private onSocket(s: net.Socket): void {
    this.sockets.add(s)
    s.setEncoding('utf8')
    const send = (msg: object) => {
      if (s.writable) s.write(JSON.stringify(msg) + '\n')
    }
    const id = this.pages.connect({ send })
    this.log(`browser connected count=${this.pages.connectionCount()}`)
    send(statusMsg(this.pause.state()))
    let buf = ''
    let discarding = false
    s.on('data', (chunk: string) => {
      buf += chunk
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const raw = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (discarding) discarding = false
        else if (raw.trim()) this.onLine(id, raw, send)
        nl = buf.indexOf('\n')
      }
      if (buf.length > MAX_LINE_BYTES) {
        this.log('browser line rejected reason=too_long')
        discarding = true
        buf = ''
      }
    })
    s.on('error', () => {})
    s.on('close', () => {
      this.sockets.delete(s)
      this.pages.disconnect(id)
      this.log(`browser disconnected count=${this.pages.connectionCount()}`)
    })
  }

  private onLine(id: number, raw: string, send: (msg: object) => void): void {
    if (raw.startsWith('{"op"')) return this.onControl(raw, send)
    const r = parseLine(raw)
    if (!r.ok) {
      this.log(`browser line rejected reason=${r.reason}`)
      return
    }
    if (r.line.kind !== 'tab') {
      this.log('browser line rejected reason=not_tab')
      return
    }
    this.pages.onTab(id, r.line)
  }

  private onControl(raw: string, send: (msg: object) => void): void {
    let msg: { op?: unknown; until_wall_ms?: unknown; browser?: unknown }
    try {
      msg = JSON.parse(raw)
    } catch {
      this.log('browser control rejected reason=not_json')
      return
    }
    if (msg.op === 'status') return send(statusMsg(this.pause.state()))
    const browser = msg.op === 'browser_pause' || msg.op === 'browser_resume' ? parseAppIdentity(msg.browser) : null
    const until = msg.until_wall_ms
    try {
      if (msg.op === 'browser_pause' && browser && (until === null || (typeof until === 'number' && Number.isFinite(until)))) this.pause.pauseBrowser(browser, until as number | null)
      else if (msg.op === 'browser_resume' && browser) this.pause.resumeBrowser(browser)
      else return this.log('browser control rejected reason=unknown_op')
    } catch (err) {
      this.log(`browser control failed op=${String(msg.op)} code=${(err as { code?: string }).code ?? (err as Error).message}`)
      return send({ op: 'error', for: msg.op })
    }
    send(statusMsg(this.pause.state()))
  }
}
