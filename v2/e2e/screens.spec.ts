// Every screen and query in fixtures.json, in one Daylens on the pricing world at the test time. A failed test restarts
// the app for the next one.
import { test as base, expect, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import path from 'node:path'
import { DB_FILE } from '../capture/store.ts'
import { close, launch, openSearch, screen, shows, sized, takeErrors, type Daylens } from './daylens.ts'
import fixtures from './fixtures.json' with { type: 'json' }

const test = base.extend<{ window: Page }, { daylens: Daylens }>({
  daylens: [
    async ({}, use) => {
      const d = await launch()
      await use(d)
      await close(d)
    },
    { scope: 'worker' },
  ],
  // Each test starts and ends at the fixtures' window size with no console error in the window.
  window: async ({ daylens }, use) => {
    await sized(daylens)
    expect(takeErrors(daylens)).toEqual([])
    await use(daylens.window)
    expect(takeErrors(daylens)).toEqual([])
  },
})

test.skip(process.platform === 'win32', 'no Windows test build, and the app spawns its helper without a shell, so the stand-in can’t start on Windows [G-3] [O-18]')

const HOUR_MS = 3_600_000
const main = (window: Page) => window.getByRole('main')

async function step(window: Page, scope: string, back: number): Promise<void> {
  await window.getByRole('button', { name: scope, exact: true }).click()
  for (let i = 0; i < back; i++) await window.getByRole('button', { name: `Previous ${scope.toLowerCase()}` }).click()
}

test('Daylens runs from the build it was given: the packaged test build, or from source', async ({ daylens }) => {
  expect(await daylens.app.evaluate(({ app }) => app.isPackaged)).toBe(process.env.DAYLENS_E2E_APP !== undefined)
})

test('Daylens runs sandboxed', async ({ daylens }) => {
  expect(await daylens.app.evaluate(({ app }) => app.commandLine.hasSwitch('no-sandbox'))).toBe(false)
})

test('an error is caught however much the window logs after it', async ({ daylens, window }) => {
  await window.evaluate(() => {
    console.error('a deliberate error')
    for (let i = 0; i < 250; i++) console.log(`line ${i}`)
  })
  await expect.poll(() => daylens.errors.length).toBe(1)
  expect(takeErrors(daylens)).toEqual([expect.stringMatching(/^console: a deliberate error /)])
})

test('the stand-in helper and the capture service record at the test time', async ({ daylens, window }) => {
  await expect(main(window).locator('[data-current="true"]')).toBeVisible()
  const db = new Database(path.join(daylens.world.data, DB_FILE), { readonly: true, fileMustExist: true })
  try {
    const read = () => db.prepare(`SELECT event_wall_ms, recorded_wall_ms FROM observations WHERE source = 'demo' AND kind = 'focus' ORDER BY id LIMIT 1`).get() as { event_wall_ms: number; recorded_wall_ms: number } | undefined
    await expect.poll(read, { timeout: 30_000 }).toBeTruthy()
    const focus = read()!
    const hour = Math.floor(Date.parse(fixtures.now) / HOUR_MS) * HOUR_MS
    for (const ms of [focus.event_wall_ms, focus.recorded_wall_ms]) expect(Math.floor(ms / HOUR_MS) * HOUR_MS, new Date(ms).toISOString()).toBe(hour)
  } finally {
    db.close()
  }
})

for (const f of fixtures.today)
  test(`Today: ${f.name}`, async ({ window }) => {
    await screen(window, 'Today')
    await step(window, f.scope, f.back)
    await expect(main(window).getByRole('heading', { level: 1 })).toHaveText(f.title)
    await shows(main(window), f.expect)
  })

test('Today: an hour opens to what was in it', async ({ window }) => {
  await screen(window, 'Today')
  await main(window).getByText(fixtures.hour.open, { exact: true }).click()
  const sheet = main(window).locator('.hour-sheet')
  await shows(sheet, fixtures.hour.expect)
})

for (const f of fixtures.search)
  test(`Search: ${f.query}`, async ({ daylens, window }) => {
    await openSearch(daylens)
    const search = window.getByRole('dialog', { name: 'Search' })
    await search.getByRole('textbox').fill(f.query)
    await shows(search, f.expect)
    await window.keyboard.press('Escape')
    await expect(search).toBeHidden()
  })

test('Search: the keyboard picks an hour and opens it in Today', async ({ daylens, window }) => {
  const f = fixtures.searchKeyboard
  await screen(window, 'Settings')
  await openSearch(daylens)
  const search = window.getByRole('dialog', { name: 'Search' })
  await window.keyboard.type(f.query)
  const selected = search.locator('[aria-selected="true"]')
  // Results for an earlier keystroke stay dimmed until the last one's arrive, and only those can be opened.
  await expect(search).toContainText(f.open)
  await expect(search.locator('.search-results')).not.toHaveClass(/stale/)
  for (let i = 0; i < 10 && !(await selected.innerText()).includes(f.open); i++) await window.keyboard.press('ArrowDown')
  await expect(selected).toContainText(f.open)
  await window.keyboard.press('Enter')
  await expect(search).toBeHidden()
  const sheet = main(window).locator('.hour-sheet')
  await shows(sheet, f.expect)
})

for (const f of fixtures.apps)
  test(`Apps: ${f.name}`, async ({ window }) => {
    await screen(window, 'Apps')
    await step(window, f.scope, f.back)
    await expect(main(window).getByRole('heading', { level: 1 })).toHaveText(f.title)
    await shows(main(window), f.expect)
  })

// The examples show only before the first question, so each test starts from a fresh window.
for (const f of fixtures.ask)
  test(`Ask without a key: ${f.question}`, async ({ window }) => {
    await window.reload()
    await screen(window, 'Ask')
    await main(window).getByRole('button', { name: f.question, exact: true }).click()
    const answer = main(window).locator('.ask-exchange').last()
    await shows(answer, [f.question, ...f.expect])
    await shows(main(window), [fixtures.askWithoutKey])
  })

for (const f of fixtures.settings)
  test(`Settings: ${f.tab}`, async ({ window }) => {
    await screen(window, 'Settings')
    await main(window).getByRole('tab', { name: f.tab, exact: true }).click()
    await expect(main(window).getByRole('tab', { name: f.tab, exact: true })).toHaveAttribute('aria-selected', 'true')
    await shows(main(window), f.expect)
  })

test('Settings: Daylens never turns on open at login by itself', async ({ daylens, window }) => {
  await screen(window, 'Settings')
  await main(window).getByRole('tab', { name: 'General', exact: true }).click()
  await expect(main(window).getByRole('switch', { name: 'Open at login' })).toHaveAttribute('aria-checked', 'false')
  expect(await daylens.app.evaluate(({ app }) => app.getLoginItemSettings().openAtLogin)).toBe(false)
})
