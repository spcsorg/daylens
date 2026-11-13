// The menu bar item's menu, as its click builds it. Playwright can't open a native menu [O-17], so main is asked for the
// menu the click would pop up, and its items are clicked as the menu would click them.
import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import path from 'node:path'
import { DB_FILE } from '../capture/store.ts'
import { close, launch, sized, takeErrors, type Daylens } from './daylens.ts'
import fixtures from './fixtures.json' with { type: 'json' }

test.skip(process.platform === 'win32', 'no Windows test build, and the app spawns its helper without a shell, so the stand-in can’t start on Windows [G-3] [O-18]')
test.skip(process.platform === 'linux', 'the tray menu never opens on Linux: the app never calls setContextMenu [M-1]')

const HOUR_MS = 3_600_000

// The live Tray, found on the heap: main.ts keeps it in a module variable nothing outside can reach.
async function findTray(d: Daylens): Promise<void> {
  const found = await d.app.evaluate(async ({ Tray }) => {
    const inspector = process.getBuiltinModule('node:inspector') as typeof import('node:inspector')
    const session = new inspector.Session()
    session.connect()
    const post = <T>(method: string, params: object) => new Promise<T>((resolve, reject) => session.post(method, params, (err, r) => (err ? reject(err) : resolve(r as T))))
    const g = globalThis as { e2eTrayProto?: unknown; e2eTrays?: Electron.Tray[] }
    g.e2eTrayProto = Tray.prototype
    const proto = await post<{ result: { objectId: string } }>('Runtime.evaluate', { expression: 'globalThis.e2eTrayProto' })
    const { objects } = await post<{ objects: { objectId: string } }>('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId })
    await post('Runtime.callFunctionOn', { objectId: objects.objectId, functionDeclaration: 'function () { globalThis.e2eTrays = this.filter((t) => t.listenerCount("click") > 0) }' })
    session.disconnect()
    return g.e2eTrays!.length
  })
  expect(found).toBe(1)
}

interface Item {
  label: string
  enabled: boolean
}

// The menu one click on the tray pops up.
async function menu(d: Daylens): Promise<Item[]> {
  return d.app.evaluate(async () => {
    const g = globalThis as { e2eTrays?: Electron.Tray[]; e2eMenu?: Electron.Menu }
    const tray = g.e2eTrays![0]!
    g.e2eMenu = await new Promise<Electron.Menu>((resolve) => {
      tray.popUpContextMenu = (m?: Electron.Menu) => resolve(m!)
      tray.emit('click')
    })
    return g.e2eMenu.items.filter((i) => i.type !== 'separator').map((i) => ({ label: i.label, enabled: i.enabled }))
  })
}

// Clicks an item of the menu last popped up, as the native menu would, and returns main's time just before.
async function click(d: Daylens, label: string): Promise<number> {
  return d.app.evaluate(({ BrowserWindow }, label) => {
    const item = (globalThis as { e2eMenu?: Electron.Menu }).e2eMenu!.items.find((i) => i.label === label)
    if (!item) throw new Error(`no ${label} in the menu`)
    if (!item.enabled) throw new Error(`${label} is disabled`)
    const at = Date.now()
    item.click({ triggeredByAccelerator: false }, BrowserWindow.getFocusedWindow() ?? undefined)
    return at
  }, label)
}

interface Bridge {
  daylens: { query: (q: { q: 'recording' }) => Promise<{ pause: { until_ms: number | null } | null }> }
}

async function pause(d: Daylens): Promise<{ until_ms: number | null } | null> {
  return d.window.evaluate(async () => (await (window as unknown as Bridge).daylens.query({ q: 'recording' })).pause)
}

test('the tray menu: the current hour, the three pauses, deleting the last 10 minutes, Today, Search and Quit', async () => {
  const d = await launch()
  try {
    await sized(d)
    await expect(d.window.locator('[data-current="true"]')).toBeVisible()
    await findTray(d)

    const recording = await menu(d)
    expect(recording[0]!.label.startsWith(`${fixtures.tray.hour} · `), recording[0]!.label).toBe(true)
    expect(recording[1]).toEqual({ label: 'Recording now', enabled: false })
    expect(recording.slice(2)).toEqual(fixtures.tray.recording.map((label) => ({ label, enabled: true })))

    for (const p of fixtures.tray.pauses) {
      const at = await click(d, p.item)
      await expect.poll(() => pause(d)).not.toBeNull()
      const until = (await pause(d))!.until_ms
      if (p.until === '+1h') {
        expect(until! - at).toBeGreaterThanOrEqual(HOUR_MS)
        expect(until! - at).toBeLessThan(HOUR_MS + 60_000)
      } else expect(until).toBe(p.until === null ? null : Date.parse(p.until))
      const paused = await menu(d)
      expect(paused[1]!.label.startsWith(p.summary), paused[1]!.label).toBe(true)
      expect(paused.slice(2)).toEqual(['Resume', ...fixtures.tray.recording.slice(3)].map((label) => ({ label, enabled: true })))
      await click(d, 'Resume')
      await expect.poll(() => pause(d)).toBeNull()
      expect((await menu(d))[1]!.label).toBe('Recording now')
    }

    // Asked first, then gone from disk: no observation is left in the 10 minutes before the click.
    await d.app.evaluate(({ dialog }) => {
      const g = globalThis as { e2eAsked?: string[] }
      g.e2eAsked = []
      dialog.showMessageBox = (async (...args: unknown[]) => {
        g.e2eAsked!.push((args.at(-1) as Electron.MessageBoxOptions).message)
        return { response: 0, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
    })
    const db = new Database(path.join(d.world.data, DB_FILE), { readonly: true, fileMustExist: true })
    try {
      await menu(d)
      const at = await click(d, 'Delete the last 10 minutes')
      expect(await d.app.evaluate(() => (globalThis as { e2eAsked?: string[] }).e2eAsked)).toEqual(['Delete the last 10 minutes?'])
      const range = () => db.prepare(`SELECT from_wall_ms, to_wall_ms FROM deletions WHERE kind = 'range'`).all() as { from_wall_ms: number; to_wall_ms: number }[]
      await expect.poll(() => range().length).toBe(1)
      const [r] = range()
      expect(r!.to_wall_ms - r!.from_wall_ms).toBe(10 * 60_000)
      expect(Math.abs(r!.to_wall_ms - at)).toBeLessThan(5_000)
      await expect.poll(() => (db.prepare(`SELECT count(*) AS n FROM observations WHERE event_wall_ms >= ? AND event_wall_ms < ?`).get(r!.from_wall_ms, r!.to_wall_ms) as { n: number }).n).toBe(0)
    } finally {
      db.close()
    }

    // Open Today brings the window back to today from wherever it was, hidden or not.
    await d.window.getByRole('navigation').getByRole('button', { name: 'Settings', exact: true }).click()
    await d.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide())
    await menu(d)
    await click(d, 'Open Today')
    await expect.poll(() => d.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(true)
    await expect(d.window.getByRole('main').getByRole('heading', { level: 1 })).toHaveText(fixtures.today[0]!.title)

    await menu(d)
    await click(d, 'Search…')
    await expect(d.window.getByRole('dialog', { name: 'Search' })).toBeVisible()

    expect(takeErrors(d)).toEqual([])
    await menu(d)
    const exited = new Promise<number | null>((resolve) => d.app.process().once('exit', (code) => resolve(code)))
    await click(d, 'Quit Daylens')
    expect(await exited).toBe(0)
  } finally {
    await close(d)
  }
})
