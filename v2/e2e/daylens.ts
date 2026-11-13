// Launches Daylens on the pricing world at the fixtures' test time, in its own throwaway folder: the packaged test build
// DAYLENS_E2E_APP names, or from source after `npm run app:build`.
import { _electron, expect, type ConsoleMessage, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { rmSync } from 'node:fs'
import { makeWorld, source, type World, type WorldOptions } from '../app/tools/world.ts'
import fixtures from './fixtures.json' with { type: 'json' }

export interface Daylens {
  app: ElectronApplication
  window: Page
  world: World
  // The window's console errors and uncaught exceptions, from the moment it opened until taken.
  errors: string[]
}

// An app with no icon is answered 404 by design and drawn with the fallback; any other resource that fails to load is an
// error.
const isError = (m: ConsoleMessage) => m.type() === 'error' && !(m.location().url.startsWith('daylens-icon://') && m.text().includes('status of 404'))
const logged = (m: ConsoleMessage) => `console: ${m.text()} (${m.location().url})`
const uncaught = (e: Error) => `uncaught: ${e.message}`

export async function launch(o: Omit<WorldOptions, 'now' | 'zone'> = {}, prepare?: (world: World) => void): Promise<Daylens> {
  const world = makeWorld({ ...o, now: fixtures.now, zone: fixtures.zone })
  const packaged = process.env.DAYLENS_E2E_APP
  let app: ElectronApplication | undefined
  try {
    prepare?.(world)
    // Without chromiumSandbox Playwright adds --no-sandbox on Linux.
    app = await _electron.launch({ ...(packaged ? { executablePath: packaged } : { args: source().args }), env: world.env as Record<string, string>, timezoneId: fixtures.zone, locale: fixtures.locale, chromiumSandbox: true })
    const errors: string[] = []
    // What came before the window was ready is only in its buffer, and until the buffer is read an error can arrive both ways.
    let seen: Set<string> | undefined = new Set()
    const note = (key: string, text: string) => {
      if (seen?.has(key)) return
      seen?.add(key)
      errors.push(text)
    }
    app.context().on('console', (m) => void (isError(m) && note(`${m.timestamp()} ${logged(m)}`, logged(m))))
    app.context().on('weberror', (e) => note(`${e.error().stack}`, uncaught(e.error())))
    const window = await app.firstWindow()
    for (const m of await window.consoleMessages()) if (isError(m)) note(`${m.timestamp()} ${logged(m)}`, logged(m))
    for (const e of await window.pageErrors()) note(`${e.stack}`, uncaught(e))
    seen = undefined
    return { app, window, world, errors }
  } catch (err) {
    await app?.close().catch(() => {})
    rmSync(world.root, { recursive: true, force: true })
    throw err
  }
}

export async function close(d: Daylens): Promise<void> {
  await d.app.close()
  rmSync(d.world.root, { recursive: true, force: true })
}

// The window's content at the fixtures' size, measured from inside the page.
export async function sized(d: Daylens): Promise<void> {
  const { width, height } = fixtures.window
  await d.app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]!.setContentSize(s.width, s.height), { width, height })
  await expect.poll(() => d.window.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([width, height])
}

// The errors since the last take, leaving none behind.
export function takeErrors(d: Daylens): string[] {
  return d.errors.splice(0)
}

// Each text is shown in `where`: innerText leaves out what CSS hides.
export async function shows(where: Locator, texts: string[]): Promise<void> {
  await expect(where).toBeVisible()
  for (const text of texts) await expect(where).toContainText(text, { useInnerText: true })
}

export async function screen(window: Page, name: 'Today' | 'Apps' | 'Ask' | 'Settings'): Promise<void> {
  await window.getByRole('navigation').getByRole('button', { name, exact: true }).click()
}

// On macOS Cmd+K belongs to the Edit menu's Search… item, which only the main process can press; elsewhere the window
// takes Ctrl+K itself.
export async function openSearch(d: Daylens): Promise<void> {
  if (process.platform === 'darwin')
    await d.app.evaluate(({ Menu }) => {
      const search = Menu.getApplicationMenu()?.items.find((i) => i.label === 'Edit')?.submenu?.items.find((i) => i.label === 'Search…')
      if (!search) throw new Error('no Search… item in the Edit menu')
      search.click({ triggeredByAccelerator: false })
    })
  else await d.window.keyboard.press('Control+K')
  await expect(d.window.getByRole('dialog', { name: 'Search' })).toBeVisible()
}
