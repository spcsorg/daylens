// Ask's thread without a key, on the pricing world: each question is searched on its own, so one about now after a
// question about yesterday shows today.
import { test, expect } from '@playwright/test'
import { close, launch, screen, shows, sized, takeErrors } from './daylens.ts'
import type { AskQuery, AskResult } from '../app/shared/ai.ts'
import fixtures from './fixtures.json' with { type: 'json' }

test.skip(process.platform === 'win32', 'no Windows test build or stand-in helper launch [G-3] [O-18]')

const [today, yesterday] = fixtures.ask as [(typeof fixtures.ask)[number], (typeof fixtures.ask)[number]]

test('"What did I just do?" after a question about yesterday shows today', async ({}, info) => {
  const d = await launch()
  try {
    await sized(d)
    await screen(d.window, 'Ask')
    const exchanges = d.window.locator('.ask-exchange')
    await d.window.getByRole('main').getByRole('button', { name: yesterday.question, exact: true }).click()
    await shows(exchanges.nth(0), [yesterday.expect[0]!])
    await d.window.getByPlaceholder('Ask about any day').fill('What did I just do?')
    await d.window.getByRole('main').getByRole('button', { name: 'Ask', exact: true }).click()
    await shows(exchanges.nth(1), ['What did I just do?', today.expect[3]!])
    await expect(exchanges.nth(1).getByText(yesterday.expect[0]!, { exact: true })).toHaveCount(0)
    await d.window.screenshot({ path: info.outputPath('just-now.png'), animations: 'disabled' })
    expect(takeErrors(d)).toEqual([])
  } finally {
    await close(d)
  }
})


test('a provider credit failure leaves matching search results and a useful error', async ({}, info) => {
  const d = await launch()
  try {
    await sized(d)
    await screen(d.window, 'Ask')
    const found = await d.window.evaluate(() => (window as unknown as { daylens: { query(q: AskQuery): Promise<AskResult> } }).daylens.query({ q: 'ask', ask_id: 0, question: 'pricing memo', asked_at: Date.now(), earlier: [] }))
    // Inject the provider error at the reader boundary, keeping the real local search results.
    await d.app.evaluate(({ MessageChannelMain, BrowserWindow }, found) => {
      const { port1, port2 } = new MessageChannelMain()
      port1.on('message', ({ data }) => {
        if (data.query.q === 'ask') port1.postMessage({ id: data.id, ok: true, result: { ...found, kind: 'failed', message: 'Claude did not answer: credit balance is too low' } })
      })
      port1.start()
      BrowserWindow.getAllWindows()[0]!.webContents.postMessage('reader-port', null, [port2])
    }, found)
    await d.window.getByPlaceholder('Ask about any day').fill('pricing memo')
    await d.window.getByRole('main').getByRole('button', { name: 'Ask', exact: true }).click()
    await expect(d.window.getByRole('alert')).toContainText('out of credit')
    await expect(d.window.locator('.ask-exchange .ask-found')).toBeVisible()
    await expect(d.window.locator('.ask-exchange')).toContainText('Spring pricing memo')
    await d.window.screenshot({ path: info.outputPath('provider-failure.png'), animations: 'disabled' })
    expect(takeErrors(d)).toEqual([])
  } finally {
    await close(d)
  }
})
