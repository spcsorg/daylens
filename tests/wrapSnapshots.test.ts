import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  freezeDailyWrapSnapshot,
  getFrozenWrapSnapshotsForDates,
  sumFrozenWrapSnapshots,
} from '../src/main/db/queries.ts'

function openTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE daily_wrap_snapshots (
      date TEXT PRIMARY KEY,
      total_seconds INTEGER NOT NULL,
      work_seconds INTEGER NOT NULL,
      leisure_seconds INTEGER NOT NULL,
      dominant_work_subject TEXT,
      facts_json TEXT NOT NULL,
      frozen_at INTEGER NOT NULL
    );
  `)
  return db
}

test('frozen wrap snapshots sum consistently across a week', () => {
  const db = openTestDb()
  const dates = ['2026-06-16', '2026-06-17', '2026-06-18']
  for (const [index, date] of dates.entries()) {
    freezeDailyWrapSnapshot(db, {
      date,
      totalSeconds: (index + 1) * 3600,
      workSeconds: (index + 1) * 3000,
      leisureSeconds: (index + 1) * 600,
      dominantWorkSubject: `Thread ${index + 1}`,
      factsJson: '{}',
    })
  }

  const snapshots = getFrozenWrapSnapshotsForDates(db, dates)
  assert.equal(snapshots.length, 3)

  const totals = sumFrozenWrapSnapshots(db, dates)
  assert.equal(totals.totalSeconds, 3600 + 7200 + 10800)
  assert.equal(totals.workSeconds, 3000 + 6000 + 9000)
  assert.equal(totals.daysWithActivity, 3)
})
