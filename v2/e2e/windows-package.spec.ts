// Run only against the Windows test package on a disposable CI desktop: this deliberately starts real capture.
import { _electron, test, expect, type ElectronApplication } from '@playwright/test'
import Database from 'better-sqlite3'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { DB_FILE } from '../capture/store.ts'
import type { DayView } from '../app/shared/types.ts'
import { makeWorld } from '../app/tools/world.ts'

test.skip(process.env.DAYLENS_NATIVE_PACKAGE_SMOKE !== '1', 'real packaged capture is reserved for the disposable Windows desktop [A-1]')

test('the Windows package records with its included native helper, reads the store and shuts capture down', async ({}, info) => {
  expect(process.platform).toBe('win32')
  const executable = process.env.DAYLENS_E2E_APP!
  expect(executable).toBeTruthy()
  expect(existsSync(path.join(path.dirname(executable), 'resources', 'daylens-capture-windows.exe'))).toBe(true)
  const world = makeWorld({ world: 'empty' })
  delete world.env.DAYLENS_HELPER
  delete world.env.DAYLENS_HELPER_ARGS
  let app: ElectronApplication | undefined
  let db: Database.Database | undefined
  let log = ''
  try {
    app = await _electron.launch({ executablePath: executable, env: world.env as Record<string, string>, chromiumSandbox: true })
    app.process().stderr?.on('data', chunk => { log += String(chunk) })
    const page = await app.firstWindow()
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!
      win.setTitle('Invented capture window')
      win.show()
      win.focus()
    })
    const file = path.join(world.data, DB_FILE)
    await expect.poll(() => existsSync(file)).toBe(true)
    db = new Database(file, { readonly: true, fileMustExist: true })
    await expect.poll(() => db!.prepare("SELECT helper, platform FROM capture_runs WHERE helper = 'daylens-capture-windows'").get()).toEqual({ helper: 'daylens-capture-windows', platform: 'windows' })
    await expect.poll(() => (db!.prepare("SELECT count(*) AS n FROM observations WHERE platform = 'windows' AND kind = 'focus' AND title = 'Invented capture window'").get() as { n: number }).n).toBeGreaterThan(0)
    const day = await page.evaluate(async () => {
      const d = new Date()
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      return (window as unknown as { daylens: { query(q: { q: 'day'; date: string }): Promise<DayView> } }).daylens.query({ q: 'day', date })
    })
    expect(day.hours.length).toBeGreaterThan(0)
    await page.getByRole('navigation').getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('main').getByText('Window titles', { exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath('windows-native-capture.png'), animations: 'disabled' })
    await app.close()
    app = undefined
    expect(db.prepare("SELECT end_reason FROM capture_runs WHERE helper = 'daylens-capture-windows'").get()).toEqual({ end_reason: 'shutdown' })
    expect(db.prepare("SELECT count(*) AS n FROM capture_runs WHERE helper = 'demo'").get()).toEqual({ n: 0 })
    expect(log).not.toMatch(/line rejected|helper spawn failed/)
  } finally {
    try { await app?.close() }
    finally { db?.close(); rmSync(world.root, { recursive: true, force: true }) }
  }
})
