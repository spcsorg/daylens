import { test, expect } from '@playwright/test'
import { close, launch, openSearch, screen, shows, sized, takeErrors } from './daylens.ts'
import fixtures from './fixtures.json' with { type: 'json' }

test.skip(process.platform === 'win32', 'no Windows test build or stand-in helper launch [G-3] [O-18]')

for (const failure of ['reply', 'throw'] as const) test(`a Save ${failure} failure remains visible after leaving the hour`, async () => {
  const d = await launch()
  try {
    await sized(d)
    await d.app.evaluate(({ ipcMain }, failure) => {
      ipcMain.removeHandler('action')
      ipcMain.handle('action', async (_event, action) => {
        if (action.a !== 'edit_hour') return { ok: true }
        return new Promise((resolve, reject) => {
          (globalThis as { finishSave?: () => void }).finishSave = () => failure === 'reply' ? resolve({ ok: false, error: 'capture_stopped' }) : reject(new Error('save failed'))
        })
      })
    }, failure)
    await d.window.getByText(fixtures.hour.open, { exact: true }).click()
    const sheet = d.window.locator('.hour-sheet')
    await sheet.getByRole('button', { name: 'Edit', exact: true }).click()
    await sheet.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => d.app.evaluate(() => typeof (globalThis as { finishSave?: () => void }).finishSave)).toBe('function')
    await screen(d.window, 'Settings')
    await d.app.evaluate(() => (globalThis as { finishSave?: () => void }).finishSave!())
    await expect(d.window.getByText(failure === 'reply' ? 'Daylens isn’t recording right now, so that couldn’t be saved. Restart recording and try again.' : 'Couldn’t save the hour. Try again.', { exact: true })).toBeVisible()
  } finally {
    await close(d)
  }
})

test('edit an hour, find it everywhere, reopen it and undo the edit', async ({}, info) => {
  const d = await launch()
  try {
    await sized(d)
    await screen(d.window, 'Ask')
    await d.window.getByPlaceholder('Ask about any day').fill('What did I do this afternoon?')
    await d.window.getByRole('main').getByRole('button', { name: 'Ask', exact: true }).click()
    await shows(d.window.locator('.ask-exchange'), [fixtures.hour.open])
    await screen(d.window, 'Today')
    await d.window.getByText(fixtures.hour.open, { exact: true }).click()
    const sheet = d.window.locator('.hour-sheet')
    await sheet.getByRole('button', { name: 'Edit', exact: true }).click()
    await sheet.getByLabel('What were you doing?').fill('Planned the bakery deliveries')
    await sheet.getByLabel('Anything to add?').fill('Agreed the delivery route.')
    await sheet.getByRole('button', { name: 'Save', exact: true }).click()
    await shows(sheet, ['Planned the bakery deliveries', 'Agreed the delivery route.', 'Edited'])
    await d.window.screenshot({ path: info.outputPath('edited-hour.png'), animations: 'disabled' })
    await openSearch(d)
    const search = d.window.getByRole('dialog', { name: 'Search' })
    await search.getByRole('textbox').fill('bakery deliveries')
    await shows(search, ['Planned the bakery deliveries'])
    await d.window.keyboard.press('Escape')
    await screen(d.window, 'Ask')
    await expect(d.window.getByText('Your record changed. Ask again.', { exact: false })).toBeVisible()
    await expect(d.window.locator('.ask-exchange').getByText(fixtures.hour.open, { exact: true })).toHaveCount(0)
    await d.window.getByRole('button', { name: 'Try again', exact: true }).click()
    await shows(d.window.locator('.ask-exchange'), ['Planned the bakery deliveries'])
    await d.window.reload()
    await screen(d.window, 'Today')
    await d.window.getByText('Planned the bakery deliveries', { exact: true }).click()
    await sheet.getByRole('button', { name: 'Undo edit', exact: true }).click()
    await shows(sheet, [fixtures.hour.open])
    await expect(sheet.getByText('Edited', { exact: true })).toHaveCount(0)
    expect(takeErrors(d)).toEqual([])
  } finally {
    await close(d)
  }
})
