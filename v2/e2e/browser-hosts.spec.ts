import { test, expect } from '@playwright/test'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { close, launch, screen, sized, takeErrors } from './daylens.ts'

test.skip(process.platform !== 'darwin' || !process.env.DAYLENS_E2E_APP, 'installed Mac native-host registration needs a packaged test app [F-2]')

const chrome = (home: string) => path.join(home, 'Library', 'Application Support', 'Google', 'Chrome')
const manifest = (home: string) => path.join(chrome(home), 'NativeMessagingHosts', 'app.daylens.browser.json')

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
