// main.ts's first import, so it runs before anything reads the environment or the time. A release build drops the
// variables that point Daylens at another record, another helper or another time; a test build and a run from source
// keep them, and DAYLENS_TEST_NOW becomes the one offset every process's clock moves by (shared/clock.ts).
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { OFFSET_ENV, shiftClock } from '../shared/clock.ts'

// app:package --test marks the package.json it builds.
export const TEST_BUILD = app.isPackaged && (JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')) as { daylensTestBuild?: unknown }).daylensTestBuild === true

if (app.isPackaged && !TEST_BUILD) for (const k of ['DAYLENS_TEST_NOW', 'DAYLENS_V2_DATA_DIR', 'DAYLENS_SHELL_DIR', 'DAYLENS_HELPER']) delete process.env[k]

const testNow = process.env.DAYLENS_TEST_NOW === undefined ? null : Date.parse(process.env.DAYLENS_TEST_NOW)
if (testNow !== null && !Number.isFinite(testNow)) {
  process.stderr.write('DAYLENS_TEST_NOW is not a time\n')
  process.exit(64)
}
export const testOffsetMs = testNow === null ? 0 : testNow - Date.now()
if (testOffsetMs) process.env[OFFSET_ENV] = String(testOffsetMs)
else delete process.env[OFFSET_ENV]
shiftClock(testOffsetMs)
