// Live tests of the extension, its host and the capture service in a real browser with a separate test profile.
// It takes over the screen while it runs. Nothing touches a real browser profile.
//
//   node browser/tools/live.ts canary --browser cft|dia|firefox --app <path to .app> --helper <capture helper> --out <dir>
//   node browser/tools/live.ts soak   --browser cft --app <path> --helper <path> --out <dir> --minutes 60 --procstat <path>
//
// canary: unique pages in a private window next to a normal window showing the same page, then proof that nothing
// from the private window reached the database, logs or diagnostics, while open, after closing and after a restart,
// and that private time is stored as browser time with no page.
// soak: an hour of scripted normal browsing while procstat samples the host, the extension's process and the service.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { cleanAddress } from '../../capture/address.ts'
import { AWAY_IDLE_S, DEFAULT_MARKER, NOT_AWAY_EXIT, endAll, gate, mayTakeScreen, watch, type Signals } from './away.ts'
import { DEV_CHROMIUM_ID, register, unregister } from './register.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const v2 = path.join(here, '..', '..')
const SERVICE = path.join(v2, 'capture', 'service.ts')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    browser: { type: 'string' },
    app: { type: 'string' },
    helper: { type: 'string' },
    out: { type: 'string' },
    minutes: { type: 'string', default: '60' },
    procstat: { type: 'string' },
    activate: { type: 'string' },
    // The local connection instead of native messaging: no host manifest, the listener on, pairing through the popup.
    local: { type: 'boolean', default: false },
    // Firefox only: no screen, for the pairing and permission check (focus steps need a real window).
    headless: { type: 'boolean', default: false },
    // An unpacked extension folder to load instead of the dev build, for manifest experiments.
    'ext-dir': { type: 'string' },
    // The file that says the person is away; a run never starts without it.
    'away-marker': { type: 'string', default: DEFAULT_MARKER },
    'away-idle-s': { type: 'string', default: String(AWAY_IDLE_S) },
    hold: { type: 'string', default: '5000' },
  },
})
const mode = positionals[0]
const kind = values.browser as 'cft' | 'dia' | 'firefox'
const out = path.resolve(values.out!)
const HOLD = Number(values.hold)
const LOCAL = values.local!
const HEADLESS = values.headless!
// Fixed so the runner can open the Firefox popup page; Firefox otherwise picks a random UUID per install.
const FIREFOX_UUID = '6f2b7d1e-5c3a-4a8e-9d10-2b6e7f9a4c31'
const FIREFOX_ID = 'browser@daylens.app'

function log(msg: string): void {
  process.stdout.write(`[live ${new Date().toISOString().slice(11, 23)}] ${msg}\n`)
}

function socketPath(): string {
  const tmp = execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim()
  return path.join(tmp, 'daylens-v2-live', 'browser.sock')
}

// --- canary pages -----------------------------------------------------------------------------------------------

interface Pages {
  base: string
  close(): void
}

function servePages(): Promise<Pages> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    if (u.pathname === '/sample') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(SAMPLE_PAGE)
      return
    }
    const title = u.searchParams.get('title') ?? u.pathname.slice(1)
    const ticking = u.searchParams.get('tick') === '1'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`<!doctype html><title>${title.replace(/</g, '')}</title><body style="font:20px system-ui;padding:40px"><h1>${title.replace(/</g, '')}</h1>
<script>${ticking ? `let n=0;setInterval(()=>{document.title='('+(++n)+') '+${JSON.stringify(title)}},2000)` : ''}</script>`)
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() })
    }),
  )
}

// A neutral page for store screenshots: nothing personal, nothing that looks like a real site.
const SAMPLE_PAGE = `<!doctype html><title>Caring for houseplants</title>
<body style="margin:0;font:18px/1.6 Georgia,serif;color:#222;background:#fbfaf7">
<main style="max-width:680px;margin:0 auto;padding:72px 32px">
<p style="font:600 13px system-ui;letter-spacing:.08em;text-transform:uppercase;color:#7a7368">Guide</p>
<h1 style="font-size:40px;line-height:1.15;margin:8px 0 24px">Caring for houseplants</h1>
<p>Most houseplants want three things: the right light, water when the top of the soil is dry, and a pot that drains.
Start by finding out how much light each spot in your home gets through the day.</p>
<h2 style="font-size:24px;margin:36px 0 8px">Light</h2>
<p>A window that faces the sun gives bright light for a few hours. Plants that like shade do well a little further
back in the room, where the light is soft and even.</p>
<h2 style="font-size:24px;margin:36px 0 8px">Water</h2>
<p>Press a finger into the soil. If the first few centimetres are dry, water slowly until it runs out of the bottom
of the pot, then let it drain.</p>
</main>`

// --- capture service ---------------------------------------------------------------------------------------------

class Service {
  proc: ChildProcess | null = null
  readonly confirmations: { browser: string | null }[] = []
  readonly dataDir: string
  readonly logFile: string
  constructor(dataDir: string, logFile: string) {
    this.dataDir = dataDir
    this.logFile = logFile
  }
  async start(): Promise<void> {
    const logStream = createWriteStream(this.logFile, { flags: 'a' })
    this.proc = spawn(process.execPath, [SERVICE, '--helper', values.helper!, '--data-dir', this.dataDir], {
      env: { ...process.env, DAYLENS_V2_BROWSER_SOCKET: socketPath(), ...(LOCAL ? { DAYLENS_V2_BROWSER_LOCAL: '1' } : {}) },
      stdio: [LOCAL ? 'pipe' : 'ignore', LOCAL ? 'pipe' : 'ignore', 'pipe'],
    })
    if (this.proc.pid) launched.add(this.proc.pid)
    // Plays the app's part: a Firefox pairing asks Allow / Don't allow, and the runner allows it.
    if (LOCAL) {
      let buf = ''
      this.proc.stdout!.setEncoding('utf8').on('data', (c: string) => {
        buf += c
        for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          try {
            const m = JSON.parse(line) as { op?: string; id?: string; browser?: string }
            if (m.op !== 'confirm_pairing' || !m.id) continue
            this.confirmations.push({ browser: m.browser ?? null })
            this.proc!.stdin!.write(JSON.stringify({ op: 'pair_decision', id: m.id, allow: true }) + '\n')
          } catch {}
        }
      })
    }
    this.proc.stderr!.pipe(logStream)
    const start = Date.now()
    while (!existsSync(this.logFile) || !readFileSync(this.logFile, 'utf8').includes('browser socket listening')) {
      if (Date.now() - start > 10_000) throw new Error('service did not start its browser socket')
      await sleep(100)
    }
  }
  // What the Daylens app does with a daylens://pair link the operating system hands it.
  pair(link: string): void {
    this.proc!.stdin!.write(JSON.stringify({ op: 'pair', link }) + '\n')
  }
  async waitLog(text: string, ms: number): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < ms) {
      if (readFileSync(this.logFile, 'utf8').includes(text)) return true
      await sleep(200)
    }
    return false
  }
  async stop(): Promise<void> {
    const p = this.proc
    if (!p || p.exitCode !== null) return
    const done = new Promise((r) => p.once('exit', r))
    p.kill('SIGTERM')
    await done
  }
}

// --- browser drivers ---------------------------------------------------------------------------------------------

interface Driver {
  readonly name: string
  readonly profile: string
  readonly logFile: string
  readonly bundleId: string
  launch(url: string): Promise<void>
  openWindow(url: string): Promise<string>
  openPrivate(url: string): Promise<string>
  activate(handle: string): Promise<void>
  navigate(handle: string, url: string): Promise<void>
  newTab(handle: string, url: string): Promise<string>
  close(handle: string): Promise<void>
  quit(): Promise<void>
  mainPid(): number
  extensionPids(): number[]
  screenshot?(url: string, file: string, dark: boolean): Promise<void>
  evaluate(handle: string, expression: string): Promise<unknown>
  popupUrl(): string
  tabs(): Promise<{ url: string; title?: string }[]>
}

class Rpc {
  private ws: WebSocket
  private id = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data))
      if (typeof m.id !== 'number') return
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.error) p.reject(new Error(typeof m.error === 'string' ? `${m.error}: ${m.message}` : JSON.stringify(m.error)))
      else p.resolve(m.result)
    })
  }
  static connect(url: string): Promise<Rpc> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.addEventListener('open', () => resolve(new Rpc(ws)))
      ws.addEventListener('error', () => reject(new Error('websocket failed')))
    })
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('connection closed'))
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, 15_000)
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      })
    })
  }
  close(): void {
    this.ws.close()
  }
}

function binaryOf(app: string): string {
  const plist = path.join(app, 'Contents', 'Info.plist')
  const exe = execFileSync('/usr/bin/defaults', ['read', plist, 'CFBundleExecutable'], { encoding: 'utf8' }).trim()
  return path.join(app, 'Contents', 'MacOS', exe)
}

function bundleIdOf(app: string): string {
  return execFileSync('/usr/bin/defaults', ['read', path.join(app, 'Contents', 'Info.plist'), 'CFBundleIdentifier'], { encoding: 'utf8' }).trim()
}

function childPids(pid: number): number[] {
  try {
    const kids = execFileSync('/usr/bin/pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)
    return kids.flatMap((k) => [k, ...childPids(k)])
  } catch {
    return []
  }
}

function commandOf(pid: number): string {
  try {
    return execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  } catch {
    return ''
  }
}

class ChromiumDriver implements Driver {
  readonly profile: string
  // Chromium's own user data folder. Dia treats --user-data-dir as its app folder and nests Chromium's under "User Data".
  readonly dataDir: string
  readonly logFile: string
  readonly bundleId: string
  private proc: ChildProcess | null = null
  private cdp!: Rpc
  private readonly binary: string
  private readonly privateHandles = new Set<string>()
  readonly name: string
  readonly app: string
  readonly extensionDir: string
  constructor(name: string, app: string, dir: string, extensionDir: string) {
    this.name = name
    this.app = app
    this.extensionDir = extensionDir
    this.profile = path.join(dir, `${name}-profile`)
    this.dataDir = name === 'dia' ? path.join(this.profile, 'User Data') : this.profile
    this.logFile = path.join(dir, `${name}-browser.log`)
    this.binary = binaryOf(app)
    this.bundleId = bundleIdOf(app)
  }
  private args(): string[] {
    return [
      `--user-data-dir=${this.profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--use-mock-keychain',
      '--password-store=basic',
      '--disable-background-networking',
      '--disable-sync',
      '--enable-logging=stderr',
      `--load-extension=${this.extensionDir}`,
      `--disable-extensions-except=${this.extensionDir}`,
      '--remote-debugging-port=0',
    ]
  }
  // Before Dia is ever given the extension, prove this launch is a new instance on the test profile. A launch that
  // hands off to the user's running Dia would never write the port file into the test profile.
  private async proveIsolated(): Promise<void> {
    mkdirSync(this.profile, { recursive: true })
    rmSync(path.join(this.dataDir, 'DevToolsActivePort'), { force: true })
    const args = this.args().filter((a) => !a.startsWith('--load-extension') && !a.startsWith('--disable-extensions-except'))
    const p = spawn(this.binary, [...args, 'about:blank'], { stdio: 'ignore' })
    if (p.pid) launched.add(p.pid)
    const start = Date.now()
    while (!existsSync(path.join(this.dataDir, 'DevToolsActivePort'))) {
      if (p.exitCode !== null || Date.now() - start > 20_000) {
        p.kill('SIGKILL')
        throw new Error(`${this.name} did not start on the test profile; stopping before the extension is loaded anywhere`)
      }
      await sleep(100)
    }
    const [port, wsPath] = readFileSync(path.join(this.dataDir, 'DevToolsActivePort'), 'utf8').trim().split('\n')
    const cdp = await Rpc.connect(`ws://127.0.0.1:${port}${wsPath}`)
    await cdp.send('Browser.close').catch(() => {})
    cdp.close()
    await Promise.race([new Promise((r) => p.once('exit', r)), sleep(10_000).then(() => p.kill('SIGKILL'))])
    log(`${this.name}: a separate instance on the test profile, confirmed`)
  }
  async launch(url: string): Promise<void> {
    takeScreen(`launching ${this.name}`)
    if (this.name === 'dia') await this.proveIsolated()
    mkdirSync(this.profile, { recursive: true })
    rmSync(path.join(this.dataDir, 'DevToolsActivePort'), { force: true })
    const logStream = createWriteStream(this.logFile, { flags: 'a' })
    this.proc = spawn(this.binary, [...this.args(), url], { env: { ...process.env, DAYLENS_V2_BROWSER_SOCKET: socketPath() }, stdio: ['ignore', 'pipe', 'pipe'] })
    this.proc.stdout!.pipe(logStream)
    this.proc.stderr!.pipe(logStream)
    activatePid = this.proc.pid ?? null
    if (this.proc.pid) launched.add(this.proc.pid)
    const portFile = path.join(this.dataDir, 'DevToolsActivePort')
    const start = Date.now()
    while (!existsSync(portFile)) {
      if (Date.now() - start > 20_000) throw new Error(`${this.name} did not open its debugging port`)
      await sleep(100)
    }
    const [port, wsPath] = readFileSync(portFile, 'utf8').trim().split('\n')
    this.cdp = await Rpc.connect(`ws://127.0.0.1:${port}${wsPath}`)
    await this.waitTarget((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${DEV_CHROMIUM_ID}/`), 15_000, 'extension service worker')
    try {
      await this.waitTarget((t) => t.type === 'page' && t.url.startsWith(url), 8_000, 'first page')
    } catch {
      // Dia opens its own first screen instead of the start URL; open the page in a window of its own.
      await this.openWindow(url)
      await this.waitTarget((t) => t.type === 'page' && t.url.startsWith(url), 8_000, 'first page')
    }
  }
  private async targets(): Promise<{ targetId: string; type: string; url: string; browserContextId?: string }[]> {
    return (await this.cdp.send('Target.getTargets')).targetInfos
  }
  private async waitTarget(pred: (t: { type: string; url: string }) => boolean, ms: number, what: string): Promise<string> {
    const start = Date.now()
    for (;;) {
      const t = (await this.targets()).find(pred)
      if (t) return (t as { targetId: string }).targetId
      if (Date.now() - start > ms) throw new Error(`${this.name}: no ${what}`)
      await sleep(150)
    }
  }
  async firstPage(prefix: string): Promise<string> {
    return this.waitTarget((t) => t.type === 'page' && t.url.startsWith(prefix), 5000, 'page')
  }
  async openWindow(url: string): Promise<string> {
    return (await this.cdp.send('Target.createTarget', { url, newWindow: true })).targetId
  }
  async openPrivate(url: string): Promise<string> {
    // Dia hands a second launch to whichever Dia is already running, which may be the person's own.
    if (this.name === 'dia') throw new Error('dia: a private window cannot be opened from the command line in the test instance')
    // A real incognito window, opened the way a person opens one, not a DevTools browser context.
    execFileSync(this.binary, [`--user-data-dir=${this.profile}`, '--incognito', url], { env: { ...process.env, DAYLENS_V2_BROWSER_SOCKET: socketPath() }, stdio: 'ignore' })
    const id = await this.waitTarget((t) => t.type === 'page' && t.url === url, 10_000, 'private window')
    this.privateHandles.add(id)
    return id
  }
  async activate(handle: string): Promise<void> {
    await this.cdp.send('Target.activateTarget', { targetId: handle })
  }
  async navigate(handle: string, url: string): Promise<void> {
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId: handle, flatten: true })
    await this.cdp.send('Page.navigate', { url }, sessionId)
    await this.cdp.send('Target.detachFromTarget', { sessionId })
  }
  async newTab(handle: string, url: string): Promise<string> {
    // DevTools cannot open a tab in an incognito window it did not create; the command line opens one there.
    if (this.privateHandles.has(handle)) return this.openPrivate(url)
    const info = (await this.targets()).find((t) => t.targetId === handle)
    return (await this.cdp.send('Target.createTarget', { url, ...(info?.browserContextId ? { browserContextId: info.browserContextId } : {}) })).targetId
  }
  async close(handle: string): Promise<void> {
    await this.cdp.send('Target.closeTarget', { targetId: handle })
  }
  async quit(): Promise<void> {
    const p = this.proc
    if (!p || p.exitCode !== null) return
    try {
      await this.cdp.send('Browser.close')
    } catch {}
    this.cdp?.close()
    if (p && p.exitCode === null) await Promise.race([new Promise((r) => p.once('exit', r)), sleep(10_000).then(() => p.kill('SIGKILL'))])
  }
  mainPid(): number {
    return this.proc!.pid!
  }
  extensionPids(): number[] {
    return childPids(this.mainPid()).filter((p) => commandOf(p).includes('--extension-process'))
  }
  async evaluate(handle: string, expression: string): Promise<unknown> {
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId: handle, flatten: true })
    const r = await this.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    await this.cdp.send('Target.detachFromTarget', { sessionId })
    return r.result?.value
  }
  popupUrl(): string {
    return `chrome-extension://${DEV_CHROMIUM_ID}/popup.html`
  }
  // A PNG of the page at a CSS size; height 0 takes the page's own height.
  async shot(handle: string, width: number, height: number, scale: number): Promise<Buffer> {
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId: handle, flatten: true })
    await this.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sessionId)
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: height || 100, deviceScaleFactor: scale, mobile: false }, sessionId)
    if (!height) {
      const r = await this.cdp.send('Runtime.evaluate', { expression: 'Math.ceil(document.body.getBoundingClientRect().bottom)', returnByValue: true }, sessionId)
      await this.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: r.result.value, deviceScaleFactor: scale, mobile: false }, sessionId)
    }
    await sleep(500)
    const shot = await this.cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
    await this.cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId)
    await this.cdp.send('Target.detachFromTarget', { sessionId })
    return Buffer.from(shot.data, 'base64')
  }
  async render(html: string, width: number, height: number): Promise<Buffer> {
    const id = (await this.cdp.send('Target.createTarget', { url: 'about:blank' })).targetId
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId: id, flatten: true })
    const { frameTree } = await this.cdp.send('Page.getFrameTree', {}, sessionId)
    await this.cdp.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, sessionId)
    await this.cdp.send('Target.detachFromTarget', { sessionId })
    const png = await this.shot(id, width, height, 1)
    await this.close(id)
    return png
  }
  async tabs(): Promise<{ url: string; title?: string }[]> {
    return (await this.targets()).filter((t) => t.type === 'page').map((t) => ({ url: t.url, title: (t as { title?: string }).title }))
  }
  async capture(handle: string, file: string, dark: boolean): Promise<void> {
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId: handle, flatten: true })
    await this.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] }, sessionId)
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: 300, height: 240, deviceScaleFactor: 2, mobile: false }, sessionId)
    await sleep(400)
    const shot = await this.cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    await this.cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId)
    await this.cdp.send('Target.detachFromTarget', { sessionId })
  }
  async screenshot(url: string, file: string, dark: boolean): Promise<void> {
    const id = await this.openWindow(url)
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId: id, flatten: true })
    await this.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] }, sessionId)
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: 300, height: 220, deviceScaleFactor: 2, mobile: false }, sessionId)
    await this.cdp.send('Page.reload', {}, sessionId)
    await sleep(1200)
    const shot = await this.cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    await this.cdp.send('Target.detachFromTarget', { sessionId })
    await this.close(id)
  }
}

class FirefoxDriver implements Driver {
  readonly name = 'firefox'
  readonly profile: string
  readonly logFile: string
  readonly bundleId: string
  private proc: ChildProcess | null = null
  private bidi!: Rpc
  private readonly binary: string
  private readonly port = 9300 + Math.floor(Math.random() * 500)
  readonly app: string
  readonly extensionDir: string
  constructor(app: string, dir: string, extensionDir: string) {
    this.app = app
    this.extensionDir = extensionDir
    this.profile = path.join(dir, 'firefox-profile')
    this.logFile = path.join(dir, 'firefox-browser.log')
    this.binary = binaryOf(app)
    this.bundleId = bundleIdOf(app)
  }
  async launch(url: string): Promise<void> {
    takeScreen('launching Firefox')
    mkdirSync(this.profile, { recursive: true })
    writeFileSync(
      path.join(this.profile, 'user.js'),
      [
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("browser.aboutwelcome.enabled", false);',
        'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
        'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
        'user_pref("browser.startup.homepage_override.mstone", "ignore");',
        'user_pref("startup.homepage_welcome_url", "");',
        'user_pref("browser.tabs.warnOnClose", false);',
        'user_pref("app.update.disabledForTesting", true);',
        'user_pref("browser.privatebrowsing.autostart", false);',
        // Extension console output goes to the browser log, where the runner can read why a connection failed.
        'user_pref("devtools.console.stdout.chrome", true);',
        'user_pref("devtools.console.stdout.content", true);',
        `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [FIREFOX_ID]: FIREFOX_UUID }))});`,
      ].join('\n') + '\n',
    )
    const logStream = createWriteStream(this.logFile, { flags: 'a' })
    // System access lets the runner open the extension's own popup page, which BiDi navigation refuses.
    this.proc = spawn(this.binary, ['-profile', this.profile, '--remote-debugging-port', String(this.port), '--remote-allow-system-access', ...(HEADLESS ? ['-headless'] : []), url], {
      env: { ...process.env, DAYLENS_V2_BROWSER_SOCKET: socketPath() },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    activatePid = this.proc.pid ?? null
    if (this.proc.pid) launched.add(this.proc.pid)
    this.proc.stdout!.pipe(logStream)
    this.proc.stderr!.pipe(logStream)
    const start = Date.now()
    for (;;) {
      try {
        this.bidi = await Rpc.connect(`ws://127.0.0.1:${this.port}/session`)
        break
      } catch {
        if (Date.now() - start > 30_000) throw new Error('firefox did not open BiDi')
        await sleep(300)
      }
    }
    await this.bidi.send('session.new', { capabilities: {} })
    await this.bidi.send('webExtension.install', { extensionData: { type: 'path', path: this.extensionDir } })
    await sleep(1500)
  }
  private async tops(): Promise<{ context: string; url: string }[]> {
    return (await this.bidi.send('browsingContext.getTree', { maxDepth: 0 })).contexts
  }
  async firstPage(prefix: string): Promise<string> {
    const start = Date.now()
    for (;;) {
      const c = (await this.tops()).find((x) => x.url.startsWith(prefix))
      if (c) return c.context
      if (Date.now() - start > 10_000) throw new Error('firefox: no first page')
      await sleep(200)
    }
  }
  async openWindow(url: string): Promise<string> {
    if (url.startsWith('moz-extension://')) {
      const chrome = (await this.bidi.send('browsingContext.getTree', { maxDepth: 0, 'moz:scope': 'chrome' })).contexts[0].context
      await this.bidi.send('script.evaluate', {
        expression: `(() => { const t = gBrowser.addTab(${JSON.stringify(url)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); gBrowser.selectedTab = t; return true })()`,
        target: { context: chrome },
        awaitPromise: false,
      })
      const start = Date.now()
      for (;;) {
        const c = (await this.tops()).find((x) => x.url === url)
        if (c) return c.context
        if (Date.now() - start > 10_000) throw new Error('firefox: extension page did not open')
        await sleep(200)
      }
    }
    const { context } = await this.bidi.send('browsingContext.create', { type: 'window' })
    await this.navigate(context, url)
    return context
  }
  async openPrivate(url: string): Promise<string> {
    execFileSync(this.binary, ['-profile', this.profile, '-private-window', url], { stdio: 'ignore', env: { ...process.env, DAYLENS_V2_BROWSER_SOCKET: socketPath() } })
    const start = Date.now()
    for (;;) {
      const c = (await this.tops()).find((x) => x.url === url)
      if (c) return c.context
      if (Date.now() - start > 10_000) throw new Error('firefox: private window not visible to BiDi')
      await sleep(200)
    }
  }
  async activate(handle: string): Promise<void> {
    await this.bidi.send('browsingContext.activate', { context: handle })
  }
  async navigate(handle: string, url: string): Promise<void> {
    await this.bidi.send('browsingContext.navigate', { context: handle, url, wait: 'complete' })
  }
  async newTab(handle: string, url: string): Promise<string> {
    const { context } = await this.bidi.send('browsingContext.create', { type: 'tab', referenceContext: handle })
    await this.navigate(context, url)
    return context
  }
  async close(handle: string): Promise<void> {
    await this.bidi.send('browsingContext.close', { context: handle })
  }
  async quit(): Promise<void> {
    const p = this.proc
    if (!p || p.exitCode !== null) return
    try {
      await this.bidi.send('browser.close')
    } catch {}
    this.bidi?.close()
    if (p && p.exitCode === null) await Promise.race([new Promise((r) => p.once('exit', r)), sleep(10_000).then(() => p.kill('SIGKILL'))])
  }
  mainPid(): number {
    return this.proc!.pid!
  }
  extensionPids(): number[] {
    return childPids(this.mainPid()).filter((p) => /-isForBrowser.*extension|extension/.test(commandOf(p)))
  }
  popupUrl(): string {
    return `moz-extension://${FIREFOX_UUID}/popup.html`
  }
  async tabs(): Promise<{ url: string; title?: string }[]> {
    return (await this.tops()).map((c) => ({ url: c.url }))
  }
  async evaluate(handle: string, expression: string): Promise<unknown> {
    const r = await this.bidi.send('script.evaluate', { expression, target: { context: handle }, awaitPromise: true })
    return r?.result?.value
  }
}

function makeDriver(dir: string): Driver {
  const dist = path.join(v2, 'browser', 'dist')
  if (kind === 'firefox') return new FirefoxDriver(values.app!, dir, values['ext-dir'] ?? path.join(dist, LOCAL ? 'firefox-dev' : 'firefox'))
  return new ChromiumDriver(kind, values.app!, dir, path.join(dist, 'chromium-dev'))
}

function hostDir(d: Driver): string {
  if (kind === 'firefox') return path.join(os.homedir(), 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts')
  return path.join((d as ChromiumDriver).dataDir, 'NativeMessagingHosts')
}

function hostPids(): number[] {
  try {
    return execFileSync('/usr/bin/pgrep', ['-f', `${values.helper!} (chrome-extension://|/.*\\.json browser@)`], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

function frontPid(): number | null {
  try {
    const asn = execFileSync('/usr/bin/lsappinfo', ['front'], { encoding: 'utf8' }).trim()
    const m = /pid = (\d+)/.exec(execFileSync('/usr/bin/lsappinfo', ['info', '-only', 'pid', asn], { encoding: 'utf8' }))
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

// The lock screen is in front while the Mac is locked; nothing can run until someone unlocks it.
function locked(): boolean {
  const f = frontPid()
  return f !== null && commandOf(f).includes('loginwindow')
}

function pidOfApp(name: string): number | null {
  try {
    return Number(execFileSync('/usr/bin/pgrep', ['-nx', name], { encoding: 'utf8' }).trim()) || null
  } catch {
    return null
  }
}

function idleSeconds(): number {
  const out = execFileSync('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { encoding: 'utf8' })
  const m = /"HIDIdleTime" = (\d+)/.exec(out)
  return m ? Number(m[1]) / 1e9 : 0
}
// Intel Macs report it through IODisplayWrangler; Apple silicon has no such node, so it reads as awake.
function displayAsleep(): boolean {
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-n', 'IODisplayWrangler', '-r', '-d', '1'], { encoding: 'utf8' })
    const m = /"CurrentPowerState" = (\d+)/.exec(out)
    return m !== null && Number(m[1]) < 4
  } catch {
    return false
  }
}
const signals: Signals = { marker: () => existsSync(values['away-marker']!), locked, displayAsleep, idleSeconds }

// Everything a run starts, so a stop can end all of it at once.
const launched = new Set<number>()
const openedApps = new Set<string>()
// Set once the away gate passed; nothing visible happens before it. A headless run takes no screen.
let screenHeld = false
function takeScreen(what: string): void {
  if (HEADLESS) return
  if (!mayTakeScreen(screenHeld, signals)) {
    if (screenHeld) void stopRun('the away marker was removed')
    throw new Error(`${what} before the away gate passed`)
  }
}
function openApp(name: string): void {
  takeScreen(`opening ${name}`)
  openedApps.add(name)
  execFileSync('/usr/bin/open', ['-a', name])
}
let stopping = false
// The first input, a lock, or the marker going away ends the whole run: its browsers are quit by pid, nothing is
// brought back to the front, and the runner exits 75 so a queue stops too.
async function stopRun(reason: string): Promise<void> {
  if (stopping) return
  stopping = true
  log(`stopped: ${reason}`)
  await endAll(launched, {
    kill: (pid, sig) => {
      try {
        process.kill(pid, sig)
      } catch {}
    },
    alive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    },
    sleep: async (ms) => {
      await sleep(ms)
    },
  })
  for (const app of openedApps) {
    try {
      execFileSync('/usr/bin/killall', [app], { stdio: 'ignore' })
    } catch {}
  }
  process.exit(NOT_AWAY_EXIT)
}
const realClock = {
  now: () => Date.now(),
  every: (fn: () => void, ms: number) => {
    const t = setInterval(fn, ms)
    t.unref()
    return () => clearInterval(t)
  },
}

// Waits until nobody has touched the Mac for a while, tells them the screen is about to be taken over, and starts
// only if the countdown passes untouched.
async function announce(what: string, seconds: number): Promise<void> {
  if (HEADLESS) return
  const need = Number(values['away-idle-s'])
  for (let said = false; ; ) {
    const g = gate(signals, need)
    if (g === 'no_marker') {
      log(`${what}: not started: no away marker at ${values['away-marker']}`)
      process.exit(NOT_AWAY_EXIT)
    }
    if (g === 'away') break
    if (!said) log(`${what}: waiting for an unlocked Mac with ${need} s without keyboard or mouse input`)
    said = true
    await sleep(10_000)
  }
  // From here on the run holds the screen: the first input, during the countdown or later, ends it.
  screenHeld = true
  watch(signals, realClock, (reason) => void stopRun(reason))
  try {
    execFileSync('/usr/bin/osascript', ['-e', `display notification "${what} starts in ${seconds} seconds and takes over the screen. Touch the keyboard or mouse to stop it." with title "Daylens browser test"`])
  } catch {}
  log(`${what}: starting in ${seconds} s`)
  await sleep(seconds * 1000)
}

// The browser the runner launched is brought forward by pid, never by name: `open -a` does not see a browser started
// with its own profile as that app, so it launches another copy on the default profile.
let activatePid: number | null = null
function activateApp(_app: string): void {
  if (stopping) return
  takeScreen('bringing the browser forward')
  if (activatePid === null) throw new Error('no browser launched to bring forward')
  if (!values.activate) throw new Error('--activate <binary> is required to bring the test browser forward')
  execFileSync(values.activate, [String(activatePid)])
}

// --- evidence ---------------------------------------------------------------------------------------------------

interface Marker {
  t: number
  label: string
  // undefined: the step is not checked (the harness itself is on screen).
  expect: { page: string | null } | undefined
  private: boolean
}

interface PageRow {
  id: number
  event_wall_ms: number
  last_seen_wall_ms: number
  state: string
  url: string | null
  title: string | null
  app_id: string | null
  pid: number | null
  detail: string | null
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
}

function grep(files: string[], needles: string[]): { file: string; needle: string }[] {
  const hits: { file: string; needle: string }[] = []
  for (const f of files) {
    let buf: Buffer
    try {
      if (statSync(f).size > 512 * 1024 * 1024) continue
      buf = readFileSync(f)
    } catch {
      continue
    }
    for (const n of needles) {
      for (const enc of ['utf8', 'utf16le'] as const) if (buf.includes(Buffer.from(n, enc))) hits.push({ file: f, needle: `${n} (${enc})` })
    }
  }
  return hits
}

function pageRows(dataDir: string): PageRow[] {
  const db = new Database(path.join(dataDir, 'daylens-v2.sqlite'), { readonly: true })
  try {
    return db.prepare(`SELECT id, event_wall_ms, last_seen_wall_ms, state, url, title, app_id, pid, detail FROM observations WHERE kind = 'page' ORDER BY event_wall_ms, id`).all() as PageRow[]
  } finally {
    db.close()
  }
}

function focusRows(dataDir: string): { event_wall_ms: number; last_seen_wall_ms: number; app_id: string | null; pid: number | null; title: string | null; title_state: string | null }[] {
  const db = new Database(path.join(dataDir, 'daylens-v2.sqlite'), { readonly: true })
  try {
    return db.prepare(`SELECT event_wall_ms, last_seen_wall_ms, app_id, pid, title, title_state FROM observations WHERE kind = 'focus' ORDER BY event_wall_ms, id`).all() as never
  } finally {
    db.close()
  }
}

function gapsOf(dataDir: string, reason: string): unknown[] {
  const db = new Database(path.join(dataDir, 'daylens-v2.sqlite'), { readonly: true })
  try {
    return db.prepare(`SELECT start_wall_ms, end_wall_ms, detail FROM capture_gaps WHERE reason = ? ORDER BY id`).all(reason)
  } finally {
    db.close()
  }
}

function effectivePage(rows: PageRow[], t: number): PageRow | null {
  let cur: PageRow | null = null
  for (const r of rows) {
    if (r.event_wall_ms > t) break
    cur = r
  }
  return cur && cur.state === 'normal' ? cur : null
}

// --- canary ------------------------------------------------------------------------------------------------------

async function canary(): Promise<void> {
  const dir = path.join(out, `${kind}-canary`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const dataDir = path.join(dir, 'data')
  const svcLog = path.join(dir, 'service.log')
  const id = randomUUID().slice(0, 13)
  const PRIVATE = `PRIVATECANARY${id.replace(/-/g, '')}`
  const PRIVATE_TICK = `PRIVATETICK${id.replace(/-/g, '')}`
  const NORMAL = `NORMALCANARY${id.replace(/-/g, '')}`
  const pages = await servePages()
  const shared = `${pages.base}/shared?title=Daylens+shared+page`
  const normalUrl = `${pages.base}/${NORMAL}?title=${NORMAL}+normal+page`
  const privateUrl = `${pages.base}/${PRIVATE}?q=${PRIVATE}&title=${PRIVATE}+private+page`
  const privateTick = `${pages.base}/${PRIVATE_TICK}?tick=1&title=${PRIVATE_TICK}`
  const svc = new Service(dataDir, svcLog)
  const d = makeDriver(dir)
  const hosts = hostDir(d)
  if (LOCAL) unregister(hosts)
  else register(kind === 'firefox' ? 'firefox' : 'chromium', hosts, values.helper!)
  let pairingSeen: unknown = null
  const markers: Marker[] = []
  const mark = (label: string, page: string | null | undefined, isPrivate: boolean) => {
    // The service stores the address after the address rule, so that is what a step expects.
    markers.push({ t: Date.now(), label, expect: page === undefined ? undefined : { page: page === null ? null : cleanAddress(page) }, private: isPrivate })
    log(label)
  }
  let interruptions = 0
  // Runs one step and holds it; if anything but the expected process came to the front, the step is redone.
  const step = async (label: string, page: string | null, isPrivate: boolean, act: () => Promise<void>, front: 'browser' | 'calculator' = 'browser') => {
    for (let attempt = 1; ; attempt++) {
      await act()
      mark(label, page, isPrivate)
      const want = () => (front === 'browser' ? d.mainPid() : pidOfApp('Calculator'))
      let foreign: number | null = null
      const until = Date.now() + HOLD
      while (Date.now() < until) {
        await sleep(250)
        const f = frontPid()
        if (f !== null && f !== want()) foreign = f
      }
      if (foreign === null) return
      // Input ends the run through the watch; this is something else coming to the front with nobody at the keyboard.
      interruptions++
      markers.at(-1)!.expect = undefined
      markers.at(-1)!.label += ` (interrupted by pid ${foreign}, redone)`
      log(`  interrupted by pid ${foreign}`)
      if (attempt >= 4) throw new Error(`step kept being interrupted: ${label}`)
      if (front === 'browser') activateApp(values.app!)
    }
  }

  try {
    await announce(`The ${kind} canary test`, 30)
    // Keeps the display awake, and so the screen unlocked, only while this run lasts.
    if (!HEADLESS) spawn('/usr/bin/caffeinate', ['-d', '-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref()
    await svc.start()
    await d.launch(shared)
    activateApp(values.app!)
    const normal = await (d as ChromiumDriver | FirefoxDriver).firstPage(pages.base)
    if (LOCAL) pairingSeen = await pairThroughPopup(d, svc, dir)
    if (HEADLESS) {
      log('headless: pairing checked; focus steps need a real window, stopping here')
      return
    }
    await step('normal window: shared page', shared, false, () => d.activate(normal))
    await step('normal window: normal canary', normalUrl, false, () => d.navigate(normal, normalUrl))
    await step('normal window: shared page again', shared, false, () => d.navigate(normal, shared))

    let priv = ''
    await step('private window: private canary', null, true, async () => {
      if (!priv) priv = await d.openPrivate(privateUrl)
      await d.activate(priv)
    })
    await step('private window: same shared page as the normal window', null, true, async () => {
      await d.activate(priv)
      await d.navigate(priv, shared)
    })
    let privTab = ''
    await step('private window: title-changing canary tab', null, true, async () => {
      if (!privTab) privTab = await d.newTab(priv, privateTick)
      await d.activate(privTab)
    })
    await step('another app in front', null, false, async () => {
      openApp('Calculator')
      await sleep(300)
    }, 'calculator')
    await step('back to the browser, straight into the private window', null, true, async () => {
      activateApp(values.app!)
      await d.activate(privTab)
    })
    await step('normal window again', shared, false, () => d.activate(normal))
    await step('private window again', null, true, () => d.activate(privTab))

    const openHits = grep([...filesUnder(dataDir), svcLog, d.logFile], [PRIVATE, PRIVATE_TICK])
    log(`while the private window is open: ${openHits.length} hits`)

    await d.close(privTab)
    await d.close(priv)
    await step('private window closed; normal window', shared, false, () => d.activate(normal))
    let pauseGap: unknown = null
    if (d instanceof ChromiumDriver) {
      // The popup page in a tab: its own buttons pause and resume all of Daylens.
      mark('popup open in a tab (harness on screen, not checked)', undefined, false)
      const popup = await d.openWindow(`chrome-extension://${DEV_CHROMIUM_ID}/popup.html`)
      await sleep(1200)
      await d.capture(popup, path.join(dir, 'popup-connected-light.png'), false)
      await d.capture(popup, path.join(dir, 'popup-connected-dark.png'), true)
      await d.evaluate(popup, `document.getElementById('pause').click()`)
      await d.capture(popup, path.join(dir, 'popup-choices.png'), false)
      await d.evaluate(popup, `document.querySelector('[data-for="until_resumed"]').click(); new Promise(r => setTimeout(r, 800))`)
      const pausedText = await d.evaluate(popup, `document.getElementById('status').textContent`)
      await d.capture(popup, path.join(dir, 'popup-paused.png'), false)
      await step(`paused from the popup (popup said "${pausedText}"); normal window`, null, false, () => d.activate(normal))
      await d.activate(popup)
      await d.evaluate(popup, `document.getElementById('resume').click(); new Promise(r => setTimeout(r, 800))`)
      const resumedText = await d.evaluate(popup, `document.getElementById('status').textContent`)
      await d.close(popup)
      await step(`resumed from the popup (popup said "${resumedText}"); normal window`, shared, false, () => d.activate(normal))
      pauseGap = { paused_text: pausedText, resumed_text: resumedText }
    }
    const hostCount = hostPids().length
    // Marked before quitting: the windows close, and the page ends, as soon as the quit starts.
    mark('browser quit', null, false)
    await d.quit()
    await sleep(2000)
    await svc.stop()
    const closedHits = grep([...filesUnder(dataDir), svcLog, d.logFile], [PRIVATE, PRIVATE_TICK])

    // Restart everything with the same data and profile; the private window is gone, and nothing may come back.
    await svc.start()
    await d.launch(shared)
    activateApp(values.app!)
    const again = await (d as ChromiumDriver | FirefoxDriver).firstPage(pages.base)
    await step('after restart: normal window', shared, false, () => d.activate(again))
    await d.quit()
    await sleep(1500)
    await svc.stop()
    const restartHits = grep([...filesUnder(dataDir), svcLog, d.logFile], [PRIVATE, PRIVATE_TICK])
    const normalHits = grep([path.join(dataDir, 'daylens-v2.sqlite'), path.join(dataDir, 'daylens-v2.sqlite-wal')], [NORMAL])

    const rows = pageRows(dataDir)
    const fr = focusRows(dataDir)
    const paused = gapsOf(dataDir, 'paused') as { start_wall_ms: number; end_wall_ms: number | null }[]
    const pageAt = (t: number) => (paused.some((g) => t >= g.start_wall_ms && (g.end_wall_ms === null || t < g.end_wall_ms)) ? null : (effectivePage(rows, t)?.url ?? null))
    const SETTLE = 1500
    const checks = markers.flatMap((m, i) => {
      if (!m.expect) return []
      const expect = m.expect
      const end = (markers[i + 1]?.t ?? m.t + HOLD) - 50
      const samples: number[] = []
      for (let t = m.t + SETTLE; t < end; t += 250) samples.push(t)
      const wrong = samples.filter((t) => pageAt(t) !== expect.page)
      const browserFront = samples.filter((t) => {
        const f = [...fr].reverse().find((r) => r.event_wall_ms <= t)
        return f && f.app_id?.toLowerCase() === d.bundleId.toLowerCase()
      }).length
      const firstMatch = rows.find((r) => r.event_wall_ms >= m.t - 200 && (expect.page === null ? r.state === 'unknown' : r.url === expect.page))
      return [{
        step: m.label,
        private: m.private,
        expected_page: expect.page,
        samples: samples.length,
        wrong_samples: wrong.length,
        browser_in_front_samples: browserFront,
        latency_ms: firstMatch ? firstMatch.event_wall_ms - m.t : null,
      }]
    })
    const privateBrowserTime = markers
      .filter((m) => m.private)
      .map((m) => fr.filter((r) => r.app_id?.toLowerCase() === d.bundleId.toLowerCase() && r.event_wall_ms <= m.t + SETTLE && r.last_seen_wall_ms >= m.t - 1000).map((r) => ({ title: r.title, title_state: r.title_state })))
    const report = {
      browser: kind,
      app: values.app,
      canaries: { private: [PRIVATE, PRIVATE_TICK], normal: NORMAL },
      host_processes_seen: hostCount,
      transport: LOCAL ? 'local' : 'native',
      pairing: pairingSeen,
      interrupted_steps_redone: interruptions,
      private_hits: { while_open: openHits, after_close: closedHits, after_restart: restartHits },
      normal_canary_stored: normalHits.length > 0,
      popup_pause: pauseGap,
      paused_gaps: gapsOf(dataDir, 'paused'),
      steps: checks,
      browser_focus_rows_during_private_steps: privateBrowserTime,
      page_rows: rows.map((r) => ({ t: r.event_wall_ms, state: r.state, url: r.url, title: r.title, detail: r.detail })),
      service_log: readFileSync(svcLog, 'utf8').split('\n').filter(Boolean),
      host_diagnostics: readFileSync(d.logFile, 'utf8').split('\n').filter((l) => /^browser_host_|^[a-z_]+=[A-Za-z0-9_.:-]*$/.test(l)),
    }
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2))
    const failed =
      openHits.length + closedHits.length + restartHits.length > 0 || !report.normal_canary_stored || checks.some((c) => c.wrong_samples > 0)
    log(`report: ${path.join(dir, 'report.json')} ${failed ? 'FAILED' : 'passed'}`)
    for (const c of checks) log(`  ${c.wrong_samples === 0 ? 'ok  ' : 'FAIL'} ${c.step}: ${c.samples - c.wrong_samples}/${c.samples} samples, latency ${c.latency_ms ?? '-'} ms, browser in front ${c.browser_in_front_samples}/${c.samples}`)
    log(`  private canary hits: open ${openHits.length}, closed ${closedHits.length}, restart ${restartHits.length}; normal canary stored: ${report.normal_canary_stored}`)
    process.exitCode = failed ? 1 : 0
  } finally {
    await d.quit().catch(() => {})
    await svc.stop().catch(() => {})
    pages.close()
    if (kind === 'firefox') unregister(hosts)
    try {
      execFileSync('/usr/bin/killall', ['Calculator'], { stdio: 'ignore' })
    } catch {}
  }
}

// Presses Connect in the popup, reads the daylens://pair link the extension made, and hands it to the service the
// way the app would. Records what the browser did with the daylens:// tab, since nothing on this Mac handles it.
async function pairThroughPopup(d: Driver, svc: Service, dir: string): Promise<unknown> {
  const popup = await d.openWindow(d.popupUrl())
  await sleep(1500)
  const before = await d.evaluate(popup, `document.getElementById('status').textContent`)
  await d.evaluate(popup, `document.getElementById('connect').click()`)
  await sleep(2000)
  const link = (await d.evaluate(
    popup,
    `(async () => { const kv = await import('./kv.js'); const pr = await import('./pairing.js'); const p = await kv.get('pairing'); return p ? pr.pairLink(p) : null })()`,
  )) as string | null
  const tabs = await d.tabs()
  const pairTabs = tabs.filter((t) => t.url.startsWith('daylens:')).map((t) => ({ title: t.title ?? null, scheme_only: t.url.split('?')[0] }))
  if (!link) throw new Error('the extension made no pairing link')
  svc.pair(link)
  const connected = await svc.waitLog('browser connected transport=local', 30_000)
  const after = await d.evaluate(popup, `document.getElementById('status').textContent`)
  const leftover = (await d.tabs()).filter((t) => t.url.startsWith('daylens:')).length
  if (d instanceof ChromiumDriver) await d.capture(popup, path.join(dir, 'popup-local.png'), false)
  await d.close(popup)
  log(`pairing: ${connected ? 'connected' : 'NOT connected'}; popup "${before}" -> "${after}"; daylens:// tabs while pairing ${pairTabs.length}, left after ${leftover}`)
  if (!connected) {
    // Why not: the same WebSocket from the extension's own page (same origin and CSP as its background), and its state.
    const tabsNow = (await d.tabs()).map((t) => t.url.split('?')[0])
    const page = await d.openWindow(d.popupUrl())
    await sleep(1000)
    const probe = await d.evaluate(
      page,
      `new Promise((resolve) => { const out = {}; try { const ws = new WebSocket('ws://127.0.0.1:27481/daylens/browser'); ws.onopen = () => { out.open = true; ws.close(); resolve(out) }; ws.onerror = () => { out.error = true }; ws.onclose = (e) => { out.close = e.code; resolve(out) }; setTimeout(() => resolve(out), 4000) } catch (e) { out.threw = String(e); resolve(out) } })`,
    )
    const status = await d.evaluate(page, `(globalThis.browser ?? globalThis.chrome).runtime.sendMessage({ t: 'status' })`)
    log(`local connection did not come up. tabs ${JSON.stringify(tabsNow)}; websocket from the extension page: ${JSON.stringify(probe)}; extension state: ${JSON.stringify(status)}`)
    throw new Error('the local connection did not come up after pairing')
  }
  return { popup_before: before, popup_after: after, daylens_tabs_during: pairTabs, daylens_tabs_after: leftover, allow_asked: svc.confirmations }
}

// --- soak --------------------------------------------------------------------------------------------------------

async function soak(): Promise<void> {
  const dir = path.join(out, `${kind}-soak`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const dataDir = path.join(dir, 'data')
  const svc = new Service(dataDir, path.join(dir, 'service.log'))
  const pages = await servePages()
  const d = makeDriver(dir)
  const hosts = hostDir(d)
  register(kind === 'firefox' ? 'firefox' : 'chromium', hosts, values.helper!)
  const minutes = Number(values.minutes)
  const stats: ChildProcess[] = []
  const actions: Record<string, number> = {}
  let seed = 7
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!
  const url = () => `${pages.base}/page-${Math.floor(rand() * 200)}?title=${encodeURIComponent(pick(['Inbox', 'Budget plan', 'Search results', 'Docs', 'Video', 'Issue tracker', 'News']))}+${Math.floor(rand() * 1000)}${rand() < 0.15 ? '&tick=1' : ''}`
  try {
    await announce(`An hour of scripted browsing in ${kind}`, 60)
    await svc.start()
    await d.launch(url())
    activateApp(values.app!)
    const winA = await (d as ChromiumDriver | FirefoxDriver).firstPage(pages.base)
    const tabsA = [winA, await d.newTab(winA, url()), await d.newTab(winA, url())]
    const winB = await d.openWindow(url())
    const tabsB = [winB, await d.newTab(winB, url())]
    await d.activate(winA)
    await sleep(3000)
    const hostsNow = hostPids()
    const extPids = d.extensionPids()
    const svcPid = svc.proc!.pid!
    log(`hosts ${hostsNow.join(',')} extension ${extPids.join(',')} service ${svcPid}`)
    for (const [label, pid] of [...hostsNow.map((p) => ['host', p] as const), ...extPids.map((p) => ['extension', p] as const), ['service', svcPid] as const]) {
      const f = createWriteStream(path.join(dir, `procstat-${label}-${pid}.jsonl`))
      const p = spawn(values.procstat!, ['--root', String(pid), '--interval-s', '10'], { stdio: ['ignore', 'pipe', 'ignore'] })
      p.stdout!.pipe(f)
      stats.push(p)
    }
    const end = Date.now() + minutes * 60_000
    while (Date.now() < end) {
      const r = rand()
      const tabs = rand() < 0.7 ? tabsA : tabsB
      try {
        if (r < 0.35) {
          await d.activate(pick(tabs))
          actions.switch_tab = (actions.switch_tab ?? 0) + 1
        } else if (r < 0.6) {
          const t = pick(tabs)
          await d.activate(t)
          await d.navigate(t, url())
          actions.navigate = (actions.navigate ?? 0) + 1
        } else if (r < 0.7) {
          await d.activate(pick(rand() < 0.5 ? tabsA : tabsB))
          actions.switch_window = (actions.switch_window ?? 0) + 1
        } else if (r < 0.8) {
          openApp(pick(['Calculator', 'TextEdit']))
          await sleep(3000 + rand() * 20_000)
          activateApp(values.app!)
          await d.activate(pick(tabs))
          actions.other_app = (actions.other_app ?? 0) + 1
        } else if (r < 0.88 && tabs.length < 6) {
          tabs.push(await d.newTab(tabs[0]!, url()))
          await d.activate(tabs.at(-1)!)
          actions.new_tab = (actions.new_tab ?? 0) + 1
        } else if (tabs.length > 2) {
          const t = tabs.pop()!
          await d.close(t)
          actions.close_tab = (actions.close_tab ?? 0) + 1
        }
      } catch (e) {
        actions.errors = (actions.errors ?? 0) + 1
        log(`action failed: ${(e as Error).message}`)
      }
      await sleep(5000 + rand() * 35_000)
    }
    for (const p of stats) p.kill('SIGTERM')
    await sleep(500)
    const rows = pageRows(dataDir)
    writeFileSync(path.join(dir, 'actions.json'), JSON.stringify({ minutes, actions, page_rows: rows.length, hosts: hostsNow, extension: extPids, service: svcPid }, null, 2))
    log(`done: ${JSON.stringify(actions)} page rows ${rows.length}`)
  } finally {
    for (const p of stats) p.kill('SIGTERM')
    await d.quit().catch(() => {})
    await svc.stop().catch(() => {})
    pages.close()
    if (kind === 'firefox') unregister(hosts)
    for (const app of ['Calculator', 'TextEdit']) {
      try {
        execFileSync('/usr/bin/killall', [app], { stdio: 'ignore' })
      } catch {}
    }
  }
}

// --- store screenshots ---------------------------------------------------------------------------------------------

// The real popup in each state, laid over a neutral page at 1280x800 (a size both the Chrome Web Store and Edge
// Add-ons accept), in a Chrome for Testing test profile talking to a real capture service over native messaging.
async function storeshots(): Promise<void> {
  if (kind !== 'cft' || LOCAL) throw new Error('storeshots runs on Chrome for Testing over native messaging')
  const dir = path.join(out, 'store-screenshots')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const pages = await servePages()
  const svc = new Service(path.join(dir, 'data'), path.join(dir, 'service.log'))
  const d = makeDriver(dir) as ChromiumDriver
  const hosts = hostDir(d)
  register('chromium', hosts, values.helper!)
  try {
    await announce('The store screenshots', 30)
    if (!HEADLESS) spawn('/usr/bin/caffeinate', ['-d', '-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref()
    await svc.start()
    await d.launch(`${pages.base}/sample`)
    activateApp(values.app!)
    const tab = await d.firstPage(pages.base)
    await sleep(1500)
    const background = (await d.shot(tab, 1280, 800, 1)).toString('base64')
    let popup = await d.openWindow(d.popupUrl())
    const status = async () => String(await d.evaluate(popup, `document.getElementById('status')?.textContent ?? ''`))
    const waitStatus = async (want: RegExp, ms: number) => {
      const until = Date.now() + ms
      for (let t = await status(); ; t = await status()) {
        if (want.test(t)) return t
        if (Date.now() > until) throw new Error(`popup said "${t}", wanted ${want}`)
        await sleep(300)
      }
    }
    const grab = async (name: string, want: RegExp, ms = 15_000) => {
      const said = await waitStatus(want, ms)
      const card = (await d.shot(popup, 264, 0, 2)).toString('base64')
      const html = `<!doctype html><body style="margin:0;width:1280px;height:800px;overflow:hidden;position:relative">
<img src="data:image/png;base64,${background}" style="position:absolute;left:0;top:0;width:1280px;height:800px">
<img src="data:image/png;base64,${card}" style="position:absolute;top:12px;right:16px;width:264px;border-radius:10px;box-shadow:0 10px 32px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.08)">`
      const file = path.join(dir, `daylens-popup-${name}-1280x800.png`)
      writeFileSync(file, await d.render(html, 1280, 800))
      log(`${name}: popup said "${said}" -> ${file}`)
    }
    await grab('connected', /^Connected/)
    await d.evaluate(popup, `document.getElementById('pause').click()`)
    await d.evaluate(popup, `document.querySelector('[data-for="until_resumed"]').click()`)
    await grab('paused', /^Paused/)
    await d.evaluate(popup, `document.getElementById('resume').click()`)
    await waitStatus(/^Connected/, 15_000)
    await svc.stop()
    await d.close(popup)
    await sleep(3000)
    popup = await d.openWindow(d.popupUrl())
    await grab('not-running', /isn.t running/, 60_000)
  } finally {
    await d.quit().catch(() => {})
    await svc.stop().catch(() => {})
    pages.close()
  }
}

if (mode === 'canary') await canary()
else if (mode === 'storeshots') await storeshots()
else if (mode === 'soak') await soak()
else {
  process.stderr.write('usage: live.ts canary|soak|storeshots --browser cft|dia|firefox --app <app> --helper <bin> --out <dir>\n')
  process.exit(64)
}
