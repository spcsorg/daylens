// Launches Daylens on the pricing world at the fixtures' test time, in its own throwaway folder: the packaged test build
// DAYLENS_E2E_APP names, or from source after `npm run app:build`.
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { rmSync } from 'node:fs'
import { makeWorld, source, type World, type WorldOptions } from '../app/tools/world.ts'
import fixtures from './fixtures.json' with { type: 'json' }

export interface Daylens {
  app: ElectronApplication
  window: Page
  world: World
}

export async function launch(o: Omit<WorldOptions, 'now' | 'zone'> = {}): Promise<Daylens> {
  const world = makeWorld({ ...o, now: fixtures.now, zone: fixtures.zone })
  const packaged = process.env.DAYLENS_E2E_APP
  try {
    const app = await _electron.launch({ ...(packaged ? { executablePath: packaged } : { args: source().args }), env: world.env as Record<string, string>, timezoneId: fixtures.zone, locale: fixtures.locale })
    return { app, window: await app.firstWindow(), world }
  } catch (err) {
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

// The window's console errors and uncaught exceptions since it opened or since the last clearErrors. An app with no
// icon is answered 404 by design and drawn with the fallback; any other resource that fails to load is an error.
export async function errors(d: Daylens): Promise<string[]> {
  const logged = (await d.window.consoleMessages())
    .filter((m) => m.type() === 'error' && !(m.location().url.startsWith('daylens-icon://') && m.text().includes('status of 404')))
    .map((m) => `console: ${m.text()} (${m.location().url})`)
  return [...logged, ...(await d.window.pageErrors()).map((e) => `uncaught: ${e.message}`)]
}

export async function clearErrors(d: Daylens): Promise<void> {
  await d.window.clearConsoleMessages()
  await d.window.clearPageErrors()
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
