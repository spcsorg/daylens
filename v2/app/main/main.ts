// Daylens V2 shell. Owns the window, the menu bar item and launch at login, starts the capture service and the reader
// in their own processes, and routes the interface's actions. It never opens the database.
import { BrowserWindow, Menu, MessageChannelMain, Notification, Tray, app, dialog, ipcMain, nativeImage, nativeTheme, protocol, utilityProcess, type UtilityProcess } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { AssistantRequest } from '../shared/assistants.ts'
import type { Action, ActionResult, DayView, Query, RecordingView, ShellState } from '../shared/types.ts'
import { describeRequest, runsWithoutAsking } from '../../storage/assistantRequests.ts'
import { AssistantRequests } from './assistantRequests.ts'
import { Capture } from './capture.ts'
import { chrome, followTheme } from './chrome.ts'
import { onKeyChange, savedKey } from './ipc/ai.ts'
import { act } from './ipc/index.ts'
import type { Ctx } from './ipc/context.ts'
import { dataDir, paths } from './paths.ts'
import { loadPrefs, writePrefs, type Prefs } from './prefs.ts'
import { createTray } from './tray.ts'
import { installUpdate, startUpdates } from './updates.ts'

// A hand-written assistant config that starts the MCP server without ELECTRON_RUN_AS_NODE lands here; it must never open the window.
if (process.argv.some((a) => a.endsWith('mcp/main.js'))) {
  process.stderr.write('Daylens\u2019s MCP server runs with ELECTRON_RUN_AS_NODE=1\n')
  app.exit(1)
}

const BENCH = process.env.DAYLENS_BENCH === '1'
const log = (line: string) => process.stderr.write(`${line}\n`)

app.setName('Daylens')
app.setPath('userData', process.env.DAYLENS_SHELL_DIR ?? path.join(app.getPath('appData'), BENCH ? 'Daylens V2 Dev Shell Bench' : paths.shellName))

if (!BENCH && !app.requestSingleInstanceLock()) app.exit(0)

protocol.registerSchemesAsPrivileged([{ scheme: 'daylens-icon', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

let prefs = loadPrefs()
function savePrefs(next: Partial<Prefs>): void {
  prefs = { ...prefs, ...next }
  writePrefs(prefs)
}

let win: BrowserWindow | null = null
// Held for the life of the app: a tray nothing references is collected and leaves the menu bar.
let tray: Tray | null = null
let reader: UtilityProcess | null = null
let quitting = false
let updateReady: string | null = null
// Installed over V1 as the same app, the first run keeps V1's pause and exclusions. Runs from source start clean.
const capture = new Capture({ service: paths.service, helper: paths.helper, dataDir: dataDir(), v1AppData: app.isPackaged ? app.getPath('appData') : undefined, log })

// The shell's own channel to the reader, for the menu bar item and app icons.
let mainPort: Electron.MessagePortMain | null = null
let nextQuery = 1
const queries = new Map<number, (r: { ok: boolean; result?: unknown }) => void>()
function query<T>(q: Query): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!mainPort) return reject(new Error('reader_unavailable'))
    const id = nextQuery++
    queries.set(id, (r) => (r.ok ? resolve(r.result as T) : reject(new Error('query_failed'))))
    mainPort.postMessage({ id, query: q })
  })
}

function startReader(): void {
  reader = utilityProcess.fork(paths.reader, [], { serviceName: 'Daylens Reader', stdio: 'inherit' })
  reader.postMessage({ type: 'init', dataDir: dataDir() })
  reader.postMessage({ type: 'ai', key: savedKey() })
  const { port1, port2 } = new MessageChannelMain()
  reader.postMessage({ type: 'port' }, [port1])
  mainPort = port2
  port2.on('message', ({ data }) => {
    if (typeof data?.id === 'number') {
      queries.get(data.id)?.(data)
      queries.delete(data.id)
    } else if (data?.e === 'changed' && (data.kinds as string[]).some((k) => k === 'assistant_request' || k === 'connected' || k === 'reset')) void requests.refresh()
  })
  port2.start()
  reader.on('exit', (code) => {
    if (quitting) return
    log(`reader exited code=${code}`)
    mainPort = null
    setTimeout(() => {
      startReader()
      if (win) connectWindow(win)
    }, 500)
  })
}

function connectWindow(w: BrowserWindow): void {
  if (!reader) return
  const { port1, port2 } = new MessageChannelMain()
  reader.postMessage({ type: 'port' }, [port1])
  w.webContents.postMessage('reader-port', null, [port2])
}

function shellState(): ShellState {
  return {
    platform: process.platform,
    login_item: app.getLoginItemSettings().openAtLogin,
    appearance: prefs.appearance,
    onboarded: prefs.onboarded,
    helper: capture.helper,
    capture: capture.state,
    capture_error: capture.error,
    bench: BENCH,
  }
}

function pushShell(): void {
  win?.webContents.send('shell', shellState())
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: 'Daylens',
    ...chrome(),
    webPreferences: { preload: paths.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  })
  w.once('ready-to-show', () => {
    if (!BENCH || process.env.DAYLENS_BENCH_SHOW === '1') w.show()
  })
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Every load (a reload too) gets a fresh port to the reader.
  w.webContents.on('did-finish-load', () => {
    connectWindow(w)
    pushShell()
  })
  w.on('close', (e) => {
    if (quitting || BENCH) return
    e.preventDefault()
    w.hide()
  })
  const unfollow = followTheme(w)
  w.on('closed', () => {
    unfollow()
    if (win === w) win = null
  })
  void w.loadFile(paths.renderer)
  return w
}

// A window still loading gets the message once it has loaded; the preload holds it until the page listens.
function showAndNavigate(to: 'today' | 'search' | 'search-toggle' | 'settings'): void {
  if (!win) win = createWindow()
  win.show()
  win.focus()
  const w = win
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', () => w.webContents.send('navigate', to))
  else w.webContents.send('navigate', to)
}

function showToday(): void {
  showAndNavigate('today')
}

// 'search-toggle' is Cmd+K pressed in the menu bar; a click on Search… only ever opens it.
function showSearch(to: 'search' | 'search-toggle' = 'search'): void {
  showAndNavigate(to)
}

// Search has no sidebar item, so the menu bar lists it with its shortcut, as Mac apps list their commands. On macOS this
// item owns Cmd+K (the window leaves it alone, see screens/search/shortcut.ts), so one key press does one thing.
function setAppMenu(): void {
  if (process.platform !== 'darwin') return
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        role: 'appMenu',
        submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Settings…', accelerator: 'Command+,', click: () => showAndNavigate('settings') }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }],
      },
      { label: 'File', submenu: [{ role: 'close' }] },
      {
        label: 'Edit',
        submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' }, { label: 'Search…', accelerator: 'Command+K', click: (_item, _win, e) => showSearch(e.triggeredByAccelerator ? 'search-toggle' : 'search') }],
      },
      // Reload and the developer tools are for runs from source only.
      app.isPackaged ? { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] } : { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  )
}

// A browser known only from its history has no recorded path yet; Spotlight finds its bundle by identifier.
function bundlePath(id: string): Promise<string | null> {
  if (process.platform !== 'darwin' || !/^[A-Za-z0-9.-]+$/.test(id)) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('mdfind', [`kMDItemCFBundleIdentifier == '${id}'`], { timeout: 5000 }, (err, out) => resolve(err ? null : (out.split('\n').find((p) => p.endsWith('.app')) ?? null)))
  })
}

const iconCache = new Map<string, Buffer>()
async function appIcon(id: string): Promise<Buffer | null> {
  const hit = iconCache.get(id)
  if (hit) return hit
  const recorded = await query<string | null>({ q: 'app_path', id }).catch(() => null)
  // An app no longer on this Mac gets no icon: getFileIcon would draw a generic document.
  const appPath = recorded && existsSync(recorded) ? recorded : await bundlePath(id)
  if (!appPath) return null
  try {
    // Quick Look draws an app bundle's own icon; getFileIcon gives a generic one for bundles on macOS.
    let img = process.platform === 'darwin' ? await nativeImage.createThumbnailFromPath(appPath, { width: 64, height: 64 }).catch(() => null) : null
    if (!img || img.isEmpty()) img = await app.getFileIcon(appPath, { size: 'normal' })
    const png = img.toPNG()
    iconCache.set(id, png)
    return png
  } catch {
    return null
  }
}

function hourLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric' }).replace(':00', '')
}

function clockLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

const requests = new AssistantRequests({
  pending: () => query<AssistantRequest[]>({ q: 'assistant_requests' }),
  control: (op) => capture.request(op),
  act: (a) => act(ctx, a),
  paused: async () => (await query<RecordingView>({ q: 'recording' })).pause !== null,
  notify: (r) => {
    if (!Notification.isSupported()) return
    const n = new Notification({ title: `${r.assistant} asks Daylens`, body: `${describeRequest(r.change)}. Open Daylens to answer.` })
    n.on('click', showToday)
    n.show()
  },
  log,
})

const ctx: Ctx = {
  capture,
  win: () => win,
  query,
  savePrefs,
  pushShell,
  quit: () => void quit(),
  requests,
}

async function quit(): Promise<void> {
  if (quitting) return
  quitting = true
  await capture.stop()
  reader?.kill()
  app.exit(0)
}

async function restartToUpdate(): Promise<void> {
  if (quitting) return
  quitting = true
  await capture.stop()
  reader?.kill()
  await installUpdate(async (err) => {
    log(`update install failed ${err.message}`)
    await dialog.showMessageBox({ type: 'error', message: 'Daylens couldn’t install the update.', detail: 'Daylens reopens on this version and tries again later.' })
    app.relaunch()
    app.exit(0)
  })
}

app.on('second-instance', () => showToday())
app.on('activate', () => showToday())
app.on('before-quit', (e) => {
  if (quitting) return
  e.preventDefault()
  void quit()
})

app.whenReady().then(() => {
  nativeTheme.themeSource = prefs.appearance
  protocol.handle('daylens-icon', async (req) => {
    const id = decodeURIComponent(new URL(req.url).pathname.slice(1))
    const png = await appIcon(id)
    return png ? new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=86400' } }) : new Response(null, { status: 404 })
  })
  ipcMain.handle('action', (_e, a: Action) => act(ctx, a).catch((err: unknown): ActionResult => ({ ok: false, error: err instanceof Error ? err.message : 'failed' })))
  ipcMain.handle('shell', () => shellState())
  capture.on('state', () => {
    pushShell()
    if (capture.state === 'running') void capture.request({ op: 'ai', key: savedKey() })
  })
  onKeyChange((key) => {
    reader?.postMessage({ type: 'ai', key })
    void capture.request({ op: 'ai', key })
  })
  capture.on('helper', pushShell)
  capture.on('activity', () => reader?.postMessage({ type: 'activity' }))
  capture.start()
  startReader()
  // Requests filed while Daylens was closed: those still in time run or show, the rest expire.
  void requests.refresh()
  // Opened at login, Daylens starts in the menu bar; the window opens from there or from the Dock.
  setAppMenu()
  if (!(app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin)) win = createWindow()
  if (!BENCH) {
    tray = createTray(paths.trayIcon, {
      now: async () => {
        const day = await query<DayView>({ q: 'day', date: new Date().toLocaleDateString('en-CA') })
        const h = day.hours.at(-1)
        const rec = await query<{ pause: { until_ms: number | null } | null }>({ q: 'recording' })
        const names = h ? h.title ?? h.facts.apps.slice(0, 3).map((x) => x.name).join(' · ') : ''
        const title = h ? `${hourLabel(h.start_ms)}${names ? ` · ${names}` : ''}` : 'Daylens'
        const summary = rec.pause ? (rec.pause.until_ms ? `Paused until ${clockLabel(rec.pause.until_ms)}` : 'Paused until you resume') : 'Recording now'
        const asking = (await query<AssistantRequest[]>({ q: 'assistant_requests' }).catch(() => [])).filter((r) => r.state === 'pending' && !runsWithoutAsking(r.change)).length
        return { title, summary, paused: rec.pause, asking }
      },
      pause: async (until) => (await act(ctx, { a: 'pause', until })).ok,
      resume: async () => (await act(ctx, { a: 'resume' })).ok,
      deleteLastTenMinutes: async () => (await act(ctx, { a: 'delete', what: { kind: 'last', ms: 10 * 60_000 } })).ok,
      openToday: showToday,
      openSearch: () => showSearch(),
      update: () => updateReady,
      restartToUpdate: () => void restartToUpdate(),
      quit: () => void quit(),
    })
    startUpdates({
      log,
      onReady: (version) => {
        updateReady = version
      },
    })
  }
})
