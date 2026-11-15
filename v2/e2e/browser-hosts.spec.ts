import { chromium, test, expect, type BrowserContext } from '@playwright/test'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { close, launch, screen, sized, takeErrors } from './daylens.ts'

test.skip(process.platform !== 'darwin' || !process.env.DAYLENS_E2E_APP, 'installed Mac native-host registration needs a packaged test app [F-2]')

const chrome = (home: string) => path.join(home, 'Library', 'Application Support', 'Google', 'Chrome')
const manifest = (home: string) => path.join(chrome(home), 'NativeMessagingHosts', 'app.daylens.browser.json')

test('a fresh browser extension connects through the automatically registered packaged helper', async ({}, info) => {
  const profile = (home: string) => path.join(home, 'Library', 'Application Support', 'Google', 'Chrome for Testing')
  const d = await launch({ world: 'empty' }, w => mkdirSync(profile(w.home), { recursive: true }))
  let browser: BrowserContext | undefined
  const log: string[] = []
  d.app.process().stderr?.on('data', (chunk: Buffer) => log.push(chunk.toString()))
  try {
    await expect.poll(() => existsSync(path.join(profile(d.world.home), 'NativeMessagingHosts', 'app.daylens.browser.json'))).toBe(true)
    await expect.poll(() => existsSync(d.world.env.DAYLENS_V2_BROWSER_SOCKET!)).toBe(true)
    const extension = path.resolve(import.meta.dirname, '../browser/dist/chromium-dev')
    browser = await chromium.launchPersistentContext(profile(d.world.home), {
      executablePath: chromium.executablePath(),
      headless: true,
      chromiumSandbox: true,
      env: d.world.env as Record<string, string>,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--use-mock-keychain', '--password-store=basic'],
    })
    const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker')
    const popup = await browser.newPage()
    await popup.setViewportSize({ width: 280, height: 210 })
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`)
    await expect(popup.locator('#status')).toHaveText('Connected')
    await popup.screenshot({ path: info.outputPath('extension-connected.png') })
    expect(takeErrors(d)).toEqual([])
  } catch (error) {
    await info.attach('app-startup', { body: log.join(''), contentType: 'text/plain' })
    throw error
  } finally {
    await browser?.close()
    await close(d)
  }
})

test('first packaged launch registers the native helper, without a manual registration command', async () => {
  const d = await launch({}, w => mkdirSync(chrome(w.home), { recursive: true }))
  try {
    await expect.poll(() => existsSync(manifest(d.world.home))).toBe(true)
    const host = JSON.parse(readFileSync(manifest(d.world.home), 'utf8')) as { path: string }
    const helper = path.resolve(process.env.DAYLENS_E2E_APP!, '../../Helpers/Daylens.app/Contents/MacOS/daylens-capture-macos')
    expect(host.path).toBe(helper)
    expect(host.path).not.toBe(d.world.env.DAYLENS_HELPER)
    accessSync(host.path, constants.X_OK)
    expect(takeErrors(d)).toEqual([])
  } finally {
    await close(d)
  }
})

test('a failed browser setup says so, and Retry repairs it', async ({}, info) => {
  const d = await launch({}, w => {
    mkdirSync(chrome(w.home), { recursive: true })
    writeFileSync(path.dirname(manifest(w.home)), 'not a directory')
  })
  try {
    await sized(d)
    await screen(d.window, 'Settings')
    await expect(d.window.getByText('Couldn’t set up the extension for Google Chrome. Try again.', { exact: true })).toBeVisible()
    await d.window.screenshot({ path: info.outputPath('browser-setup-error.png'), animations: 'disabled' })
    rmSync(path.dirname(manifest(d.world.home)))
    await d.window.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect.poll(() => existsSync(manifest(d.world.home))).toBe(true)
    await expect(d.window.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)
    expect(takeErrors(d)).toEqual([])
  } finally {
    await close(d)
  }
})

test('a test build without isolated data and shell overrides never replaces browser hosts', async () => {
  const d = await launch({ world: 'empty' }, w => {
    mkdirSync(chrome(w.home), { recursive: true })
    delete w.env.DAYLENS_TEST_NOW
    delete w.env.DAYLENS_V2_DATA_DIR
    delete w.env.DAYLENS_SHELL_DIR
  })
  try {
    await d.window.evaluate(() => (window as unknown as { daylens: { action(a: { a: string }): Promise<unknown> } }).daylens.action({ a: 'browser_hosts_retry' }))
    expect(existsSync(manifest(d.world.home))).toBe(false)
    expect(takeErrors(d)).toEqual([])
  } finally {
    await close(d)
  }
})

test('data and shell overrides alone do not allow a test build to register browser hosts', async () => {
  const d = await launch({ world: 'empty' }, w => {
    mkdirSync(chrome(w.home), { recursive: true })
    delete w.env.DAYLENS_V2_HISTORY_HOME
  })
  try {
    await d.window.evaluate(() => (window as unknown as { daylens: { action(a: { a: string }): Promise<unknown> } }).daylens.action({ a: 'browser_hosts_retry' }))
    expect(existsSync(manifest(d.world.home))).toBe(false)
    expect(takeErrors(d)).toEqual([])
  } finally {
    await close(d)
  }
})
