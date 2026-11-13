import { test, expect } from '@playwright/test'
import { close, launch, shows } from './daylens.ts'

test.skip(process.platform === 'win32', 'no Windows test build or stand-in helper launch [G-3] [O-18]')

test('hidden hour content cannot satisfy a screen check', async () => {
  const d = await launch({ world: 'empty' })
  try {
    await d.window.evaluate(() => {
      const sheet = document.createElement('section')
      sheet.id = 'hidden-hour'
      sheet.hidden = true
      sheet.textContent = 'Invented hour detail'
      document.body.append(sheet)
    })
    await expect(shows(d.window.locator('#hidden-hour'), ['Invented hour detail'])).rejects.toThrow()
  } finally {
    await close(d)
  }
})
