// `npm run e2e`: from source after `npm run app:build`, or on a packaged test build with DAYLENS_E2E_APP set to its
// executable. One worker: each launch is a whole app with its own capture service and reader.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  outputDir: '../build/e2e',
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
})
