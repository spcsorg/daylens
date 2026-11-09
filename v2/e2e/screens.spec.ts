// Every screen and query in fixtures.json, in one Daylens on the pricing world at the test time. A failed test restarts
// the app for the next one.
import { test as base, expect, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import path from 'node:path'
import { DB_FILE } from '../capture/store.ts'
import { clearErrors, close, errors, launch, openSearch, screen, sized, type Daylens } from './daylens.ts'
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
    expect(await errors(daylens)).toEqual([])
    await use(daylens.window)
    expect(await errors(daylens)).toEqual([])
    await clearErrors(daylens)
  },
})

test.skip(process.platform === 'win32', 'no Windows test build, and the stand-in helper can’t start on Windows [G-3] [A-1]')

const HOUR_MS = 3_600_000
const main = (window: Page) => window.getByRole('main')

async function step(window: Page, scope: string, back: number): Promise<void> {
  await window.getByRole('button', { name: scope, exact: true }).click()
  for (let i = 0; i < back; i++) await window.getByRole('button', { name: `Previous ${scope.toLowerCase()}` }).click()
}

test('Daylens runs from the build it was given: the packaged test build, or from source', async ({ daylens }) => {
  expect(await daylens.app.evaluate(({ app }) => app.isPackaged)).toBe(process.env.DAYLENS_E2E_APP !== undefined)
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
    for (const text of f.expect) await expect(main(window)).toContainText(text)
  })

test('Today: an hour opens to what was in it', async ({ window }) => {
  await screen(window, 'Today')
  await main(window).getByText(fixtures.hour.open, { exact: true }).click()
  const sheet = main(window).locator('.hour-sheet')
  for (const text of fixtures.hour.expect) await expect(sheet).toContainText(text)
})

for (const f of fixtures.search)
  test(`Search: ${f.query}`, async ({ daylens, window }) => {
    await openSearch(daylens)
    const search = window.getByRole('dialog', { name: 'Search' })
    await search.getByRole('textbox').fill(f.query)
    for (const text of f.expect) await expect(search).toContainText(text)
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
  for (const text of f.expect) await expect(sheet).toContainText(text)
})

for (const f of fixtures.apps)
  test(`Apps: ${f.name}`, async ({ window }) => {
    await screen(window, 'Apps')
    await step(window, f.scope, f.back)
    await expect(main(window).getByRole('heading', { level: 1 })).toHaveText(f.title)
    for (const text of f.expect) await expect(main(window)).toContainText(text)
  })

for (const f of fixtures.ask)
  test(`Ask without a key: ${f.question}`, async ({ window }) => {
    await screen(window, 'Ask')
    // The examples show until the first question; after it, the same question is typed.
    const example = main(window).getByRole('button', { name: f.question, exact: true })
    if (await example.isVisible()) await example.click()
    else {
      await main(window).getByPlaceholder('Ask about any day').fill(f.question)
      await main(window).getByRole('button', { name: 'Ask', exact: true }).click()
    }
    const answer = main(window).locator('.ask-exchange').last()
    await expect(answer).toContainText(f.question)
    for (const text of f.expect) await expect(answer).toContainText(text)
    await expect(main(window)).toContainText(fixtures.askWithoutKey)
  })

for (const f of fixtures.settings)
  test(`Settings: ${f.tab}`, async ({ window }) => {
    await screen(window, 'Settings')
    await main(window).getByRole('tab', { name: f.tab, exact: true }).click()
    await expect(main(window).getByRole('tab', { name: f.tab, exact: true })).toHaveAttribute('aria-selected', 'true')
    for (const text of f.expect) await expect(main(window)).toContainText(text)
  })

test('Settings: Daylens never turns on open at login by itself', async ({ daylens, window }) => {
  await screen(window, 'Settings')
  await main(window).getByRole('tab', { name: 'General', exact: true }).click()
  await expect(main(window).getByRole('switch', { name: 'Open at login' })).toHaveAttribute('aria-checked', 'false')
  expect(await daylens.app.evaluate(({ app }) => app.getLoginItemSettings().openAtLogin)).toBe(false)
})
