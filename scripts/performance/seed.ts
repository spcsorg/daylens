import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadDayFixture, isCaptureEventsDayFixture } from '../../tests/support/dayFixture.ts'
import { createProductionTestDatabase } from '../../tests/support/testDatabase.ts'
import { setTestDb, clearTestDb } from '../../tests/support/database-stub.mjs'
import { driveCaptureDay } from '../../tests/support/captureDay.ts'
import { projectDay } from '../../src/main/core/projections/chunk2.ts'
import { materializeTimelineDayProjection } from '../../src/main/core/query/projections.ts'
import { localDateString, shiftLocalDateString } from '../../src/main/lib/localDate.ts'

const destination = process.argv[2]
assert.ok(destination && path.isAbsolute(destination), 'Pass a new absolute fixture directory')
fs.mkdirSync(destination) // Refuse an existing directory, including a real profile.
const db = createProductionTestDatabase(path.join(destination, 'daylens.sqlite'))
setTestDb(db)
try {
  const today = localDateString()
  for (let offset = 0; offset < 32; offset += 1) {
    const fixture = loadDayFixture(path.resolve('tests/timeline-eval/fixtures/reference-workday.json'))
    assert.ok(isCaptureEventsDayFixture(fixture))
    fixture.date = shiftLocalDateString(today, -offset)
    await driveCaptureDay(db, fixture)
    projectDay(db, fixture.date, { finalize: true, now: new Date(`${today}T23:59:59`) })
    const payload = materializeTimelineDayProjection(db, fixture.date, null)
    assert.ok(payload.blocks.length > 0, `Empty fixture day ${fixture.date}`)
  }
  fs.writeFileSync(path.join(destination, 'config.json'), JSON.stringify({
    onboardingComplete: true,
    onboardingState: { stage: 'complete' },
    trackingEnabled: false,
    mcpServerEnabled: false,
    analyticsOptIn: false,
  }))
  fs.writeFileSync(path.join(destination, 'fixture.json'), JSON.stringify({
    today, days: 32, source: 'tests/timeline-eval/fixtures/reference-workday.json',
    focusEvents: db.prepare('SELECT COUNT(*) AS count FROM focus_events').get(),
  }))
} finally {
  clearTestDb()
  db.close()
}
