import { test, expect } from '@playwright/test'
import { close, launch, openSearch, screen, shows, sized, takeErrors } from './daylens.ts'
import fixtures from './fixtures.json' with { type: 'json' }

test.skip(process.platform === 'win32', 'no Windows test build or stand-in helper launch [G-3] [O-18]')

test('edit an hour, find it everywhere, reopen it and undo the edit', async ({}, info) => {
  const d = await launch()
  try {
    await sized(d)
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
    await d.window.getByPlaceholder('Ask about any day').fill('What did I do this afternoon?')
    await d.window.getByRole('main').getByRole('button', { name: 'Ask', exact: true }).click()
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
