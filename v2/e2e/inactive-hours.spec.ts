import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import path from 'node:path'
import { DB_FILE } from '../capture/store.ts'
import { close, launch, sized, takeErrors } from './daylens.ts'
import fixtures from './fixtures.json' with { type: 'json' }

test.skip(process.platform === 'win32', 'no Windows test build or stand-in helper launch [G-3] [O-18]')

test('saved empty hours appear as one quiet overnight range', async ({}, info) => {
  const d = await launch({}, (world) => {
    const db = new Database(path.join(world.data, DB_FILE))
    try {
      const midnight = Date.parse(fixtures.now) - 17.5 * 3_600_000
      const insert = db.prepare(`INSERT INTO hours (start_wall_ms, end_wall_ms, tz, status, title, summary, updated_wall_ms)
        VALUES (?, ?, ?, 'written', 'Hour not recorded', 'Nothing was recorded.', ?)`)
      for (let h = 0; h < 7; h++) {
        const start = midnight + h * 3_600_000
        insert.run(start, start + 3_600_000, fixtures.zone, start)
      }
    } finally {
      db.close()
    }
  })
  try {
    await sized(d)
    const list = d.window.locator('.today-day')
    await expect(list.locator('.hour')).not.toHaveCount(0)
    await list.evaluate((el) => { el.scrollTop = 0 })
    await d.window.screenshot({ path: info.outputPath('overnight.png'), animations: 'disabled' })
    const overnight = list.locator('.hour').first()
    await expect(overnight).toHaveClass('hour gap')
    await expect(overnight).toContainText('12–7 AM')
    await expect(overnight).toContainText('Daylens wasn’t running')
    await expect(overnight).not.toHaveAttribute('role', 'button')
    await expect(list.getByText('Hour not recorded', { exact: true })).toHaveCount(0)
    await expect(list.getByText('Hacker News and Stripe’s pricing docs', { exact: true })).toBeVisible()
    expect(takeErrors(d)).toEqual([])
  } finally {
    await close(d)
  }
})
