// A first run on an empty record: onboarding from the window-title permission to Today, remembered on disk.
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { close, launch, shows, sized, takeErrors } from './daylens.ts'
import fixtures from './fixtures.json' with { type: 'json' }

test.skip(process.platform === 'win32', 'no Windows test build, and the app spawns its helper without a shell, so the stand-in can’t start on Windows [G-3] [O-18]')

test('onboarding: the permission, the day so far, then Today', async () => {
  const d = await launch({ world: 'empty', onboarded: false })
  try {
    await sized(d)
    const main = d.window.getByRole('main')
    const f = fixtures.onboarding
    await shows(main, f.permission)
    await main.getByRole('button', { name: 'Continue', exact: true }).click()
    await shows(main, f.morning)
    await main.getByRole('button', { name: 'Open Today', exact: true }).click()
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(fixtures.today[0]!.title)
    expect((JSON.parse(readFileSync(path.join(d.world.shell, 'shell.json'), 'utf8')) as { onboarded: boolean }).onboarded).toBe(true)
    expect(takeErrors(d)).toEqual([])
  } finally {
    await close(d)
  }
})

// Where Daylens has no capture helper (Linux), stood in for here by the shell state the app sends then, kept in every
// later send: the stand-in helper still runs.
test('onboarding: where Daylens can’t record, it says so and opens Today without asking for a permission', async () => {
  const d = await launch({ world: 'empty', onboarded: false })
  try {
    const main = d.window.getByRole('main')
    const f = fixtures.onboarding
    await shows(main, f.permission)
    await d.app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0]!.webContents
      const send = wc.send.bind(wc)
      const none = { platform: 'linux', helper: { running: false, accessibility: null, titles: null }, capture: 'failed', capture_error: 'no_helper' }
      wc.send = (channel: string, ...args: unknown[]) => send(channel, ...(channel === 'shell' ? [{ ...(args[0] as object), ...none }] : args))
      wc.send('shell', { login_item: false, appearance: 'system', onboarded: false, bench: false })
    })
    await shows(main, f.no_helper)
    for (const text of ['Let Daylens see your windows', 'is noting', 'Starting', 'Open System Settings']) await expect(main).not.toContainText(text)
    await main.getByRole('button', { name: 'Open Today', exact: true }).click()
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(fixtures.today[0]!.title)
    await expect(main.getByText('Not recording.', { exact: true })).toBeVisible()
    await expect(main.getByText('Recording now.', { exact: true })).toHaveCount(0)
    await shows(main, ['Daylens can’t record on Linux yet.'])
    expect((JSON.parse(readFileSync(path.join(d.world.shell, 'shell.json'), 'utf8')) as { onboarded: boolean }).onboarded).toBe(true)
    expect(takeErrors(d)).toEqual([])
  } finally {
    await close(d)
  }
})
