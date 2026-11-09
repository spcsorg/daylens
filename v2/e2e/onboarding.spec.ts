// A first run on an empty record: onboarding from the window-title permission to Today, remembered on disk.
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { close, errors, launch, sized } from './daylens.ts'
import fixtures from './fixtures.json' with { type: 'json' }

test.skip(process.platform === 'win32', 'no Windows test build, and the stand-in helper can’t start on Windows [G-3] [A-1]')

test('onboarding: the permission, the day so far, then Today', async () => {
  const d = await launch({ world: 'empty', onboarded: false })
  try {
    await sized(d)
    const main = d.window.getByRole('main')
    const f = fixtures.onboarding
    for (const text of f.permission) await expect(main).toContainText(text)
    await main.getByRole('button', { name: 'Continue', exact: true }).click()
    for (const text of f.morning) await expect(main).toContainText(text)
    await main.getByRole('button', { name: 'Open Today', exact: true }).click()
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(fixtures.today[0]!.title)
    expect((JSON.parse(readFileSync(path.join(d.world.shell, 'shell.json'), 'utf8')) as { onboarded: boolean }).onboarded).toBe(true)
    expect(await errors(d)).toEqual([])
  } finally {
    await close(d)
  }
})
