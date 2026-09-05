// DEV-171: search, the agent's data tools, and the MCP path (which delegates
// to the same executors) read the shared corrected facts. The agent's
// day-overview total equals the Timeline payload's total for the same date,
// and a correction changes search and tool results immediately.
import test from 'node:test'
import assert from 'node:assert/strict'
import type Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { executeTool, type DaySummaryResult } from '../src/main/services/aiTools.ts'
import { getTimelineDayPayload, writeTimelineBlockReview } from '../src/main/services/workBlocks.ts'
import {
  computeDeterministicFacts,
  detectDeterministicFactRequests,
} from '../src/main/agent/deterministicFacts.ts'
import { ownedDayBounds } from '../src/main/lib/dayOwnership.ts'
import { searchAll } from '../src/main/db/queries.ts'

interface SearchSessionsToolResult {
  hits: Array<{ windowTitle?: string | null }>
  matchKind: 'strict' | 'broadened' | 'empty'
}

const TEST_DATE = '2026-04-22'

function localMs(hour: number, minute = 0): number {
  return new Date(2026, 3, 22, hour, minute, 0, 0).getTime()
}

function insertFocusEvent(
  db: Database.Database,
  tsMs: number,
  eventType: string,
  bundleId: string,
  appName: string,
  windowTitle: string | null = null,
): void {
  db.prepare(`
    INSERT INTO focus_events (
      ts_ms, mono_ns, event_type, app_bundle_id, app_name, pid,
      window_title, url, page_title, source, confidence, platform, schema_ver
    ) VALUES (?, ?, ?, ?, ?, 4242, ?, NULL, NULL, 'foreground_poll', 'observed', 'darwin', 2)
  `).run(tsMs, tsMs * 1_000_000, eventType, bundleId, appName, windowTitle)
}

// The canonical day also mirrors legacy sessions so FTS-backed search (which
// indexes app_sessions) sees the same activity — the dual-write state real
// capture produces during the migration.
function seedDay(db: Database.Database): void {
  const stretches: Array<[string, string, number, number, string]> = [
    ['com.mitchellh.ghostty', 'Ghostty', localMs(9), localMs(10, 30), 'daylens — evidence.ts'],
    ['com.apple.Safari', 'Safari', localMs(11), localMs(11, 45), 'Quarterly launchplan review'],
  ]
  const insertSession = db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, capture_source, capture_version
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'test', 1)
  `)
  for (const [bundleId, appName, startMs, endMs, title] of stretches) {
    insertFocusEvent(db, startMs, 'app_activated', bundleId, appName, title)
    insertFocusEvent(db, endMs, 'app_deactivated', bundleId, appName, title)
    insertSession.run(
      bundleId, appName, startMs, endMs, Math.round((endMs - startMs) / 1000),
      appName === 'Safari' ? 'browsing' : 'development', title, appName, appName.toLowerCase(),
    )
  }
}

function ignoreSpan(db: Database.Database, startMs: number, endMs: number): void {
  const now = Date.now()
  db.prepare(`
    INSERT INTO timeline_block_reviews (
      id, block_id, date, evidence_key, review_state, original_block_json,
      correction_json, created_at, updated_at
    ) VALUES ('review_shared_consumers', 'shared_consumers_block', ?, 'shared_consumers_block', 'ignored', ?, '{}', ?, ?)
  `).run(TEST_DATE, JSON.stringify({ startTime: startMs, endTime: endMs }), now, now)
}

test('the agent day-overview total equals the Timeline payload total exactly', () => {
  const db = createProductionTestDatabase()
  seedDay(db)
  const payload = getTimelineDayPayload(db, TEST_DATE, null, { materialize: false })
  const summary = executeTool('getDaySummary', { date: TEST_DATE }, db) as DaySummaryResult
  assert.ok(payload.totalSeconds > 0)
  assert.equal(summary.totalTrackedSeconds, Math.round(payload.totalSeconds))
  assert.equal(summary.focusSeconds, Math.round(payload.focusSeconds))
  assert.ok(summary.focusSeconds <= summary.totalTrackedSeconds)
  db.close()
})

// DEV-246: the enforcer rewrites an answer whose headline number disagrees
// with the corrected boundary. If the day-summary tool hands the model app
// totals computed from a DIFFERENT window than the enforcer's, the model is
// fed one number and corrected to another — the agent contradicting itself
// mid-answer. The tool used to read a bare local-midnight window while the
// enforcer read the owned day, so the two only agreed by luck.
test('the agent day-overview app totals are the ones the answer enforcer computes', () => {
  const db = createProductionTestDatabase()
  seedDay(db)
  const summary = executeTool('getDaySummary', { date: TEST_DATE }, db) as DaySummaryResult
  const appNames = summary._evidence.topApps.map((app) => app.appName)
  assert.ok(appNames.length > 0, 'the fixture must produce apps for this comparison to mean anything')

  for (const app of summary._evidence.topApps) {
    const [fact] = computeDeterministicFacts(
      db,
      detectDeterministicFactRequests(`how long was I in ${app.appName}?`, { dates: [TEST_DATE] }, appNames),
    )
    assert.ok(fact, `the enforcer computes no total for ${app.appName}, which the tool reports`)
    assert.equal(fact.kind, 'app_total_time')
    assert.equal(
      fact.value,
      app.totalSeconds,
      `${app.appName}: the day-overview says ${app.totalSeconds}s and the enforcer computes ${fact.value}s. `
      + 'One of them is reading a window the other is not.',
    )
  }
})

// The two windows only differ when the day itself does — a sitting that runs
// past midnight belongs to the day it started in, so the owned day is longer
// than the calendar day. That is where a tool reading plain local midnight
// silently drops the tail of someone's evening and the surfaces beside it do
// not.
const CARRY_DATE = '2026-05-11'

function carryMs(day: number, hour: number, minute = 0): number {
  return new Date(2026, 4, day, hour, minute, 0, 0).getTime()
}

function seedCrossMidnightSitting(db: Database.Database): void {
  const stretches: Array<[number, number]> = [
    [carryMs(11, 22, 0), carryMs(11, 23, 59)],
    [carryMs(12, 0, 1), carryMs(12, 1, 15)],
  ]
  const insertSession = db.prepare(`
    INSERT INTO app_sessions (
      bundle_id, app_name, start_time, end_time, duration_sec,
      category, is_focused, window_title, raw_app_name, canonical_app_id, capture_source, capture_version
    ) VALUES (?, ?, ?, ?, ?, 'development', 1, ?, ?, ?, 'test', 1)
  `)
  for (const [startMs, endMs] of stretches) {
    insertFocusEvent(db, startMs, 'app_activated', 'com.mitchellh.ghostty', 'Ghostty', 'daylens — release cut')
    insertFocusEvent(db, endMs, 'app_deactivated', 'com.mitchellh.ghostty', 'Ghostty', 'daylens — release cut')
    insertSession.run(
      'com.mitchellh.ghostty', 'Ghostty', startMs, endMs, Math.round((endMs - startMs) / 1000),
      'daylens — release cut', 'Ghostty', 'ghostty',
    )
  }
}

test('the agent day-overview keeps a past-midnight sitting on the day that owns it', () => {
  const db = createProductionTestDatabase()
  seedCrossMidnightSitting(db)

  // The fixture really does produce a carry — otherwise the two windows
  // coincide and this test would pass without exercising anything.
  const [, ownedEndMs] = ownedDayBounds(db, CARRY_DATE)
  assert.ok(
    ownedEndMs > carryMs(12, 0, 0),
    'the fixture must produce an owned day that reaches past midnight',
  )

  const summary = executeTool('getDaySummary', { date: CARRY_DATE }, db) as DaySummaryResult
  const ghostty = summary._evidence.topApps.find((app) => /ghostty/i.test(app.appName))
  assert.ok(ghostty, 'the evening stretch must appear in the day overview')

  const beforeMidnightSeconds = Math.round((carryMs(11, 23, 59) - carryMs(11, 22, 0)) / 1000)
  assert.ok(
    ghostty.totalSeconds > beforeMidnightSeconds,
    `the day overview reports ${ghostty.totalSeconds}s, which is only the pre-midnight stretch — `
    + 'the rest of the sitting was dropped at a calendar boundary the rest of the app does not use.',
  )

  const [fact] = computeDeterministicFacts(
    db,
    detectDeterministicFactRequests('how long was I in Ghostty?', { dates: [CARRY_DATE] }, ['Ghostty']),
  )
  assert.ok(fact, 'the enforcer must have a Ghostty total to compare against')
  assert.equal(
    fact.value,
    ghostty.totalSeconds,
    'the tool and the enforcer must read the same day, not two days that share a name',
  )
})

test('a deleted block changes the agent day-overview and Timeline identically', () => {
  const db = createProductionTestDatabase()
  seedDay(db)
  const before = executeTool('getDaySummary', { date: TEST_DATE }, db) as DaySummaryResult
  // Delete the way the product does: the review is written for the real
  // rendered block, so it survives the materialized-day path too.
  const beforePayload = getTimelineDayPayload(db, TEST_DATE, null, { materialize: false })
  const safariBlock = beforePayload.blocks.find((block) =>
    block.sessions.some((session) => session.appName === 'Safari'))
  assert.ok(safariBlock, 'the Safari stretch renders as a block')
  writeTimelineBlockReview(db, TEST_DATE, safariBlock, { state: 'ignored' })

  const payload = getTimelineDayPayload(db, TEST_DATE, null, { materialize: false })
  const after = executeTool('getDaySummary', { date: TEST_DATE }, db) as DaySummaryResult
  assert.equal(after.totalTrackedSeconds, Math.round(payload.totalSeconds))
  assert.ok(after.totalTrackedSeconds < before.totalTrackedSeconds)
  db.close()
})

test('search reflects an ignored-span correction immediately', () => {
  const db = createProductionTestDatabase()
  seedDay(db)
  const hitsBefore = searchAll(db, 'launchplan', { startDate: TEST_DATE, endDate: TEST_DATE })
  assert.ok(hitsBefore.length > 0, 'the Safari session is searchable before the correction')

  ignoreSpan(db, localMs(11), localMs(11, 45))
  const hitsAfter = searchAll(db, 'launchplan', { startDate: TEST_DATE, endDate: TEST_DATE })
  assert.equal(hitsAfter.length, 0, 'the deleted stretch is gone from search with no rebuild')
  db.close()
})

test('the agent searchSessions tool reflects an ignored-span correction immediately', () => {
  const db = createProductionTestDatabase()
  seedDay(db)
  const before = executeTool(
    'searchSessions',
    { query: 'launchplan', startDate: TEST_DATE, endDate: TEST_DATE },
    db,
  ) as SearchSessionsToolResult
  assert.ok(
    before.hits.some((hit) => (hit.windowTitle ?? '').includes('launchplan')),
    `the session is findable before the correction (got ${JSON.stringify(before.hits)})`,
  )

  ignoreSpan(db, localMs(11), localMs(11, 45))
  const after = executeTool(
    'searchSessions',
    { query: 'launchplan', startDate: TEST_DATE, endDate: TEST_DATE },
    db,
  ) as SearchSessionsToolResult
  assert.equal(
    after.hits.filter((hit) => (hit.windowTitle ?? '').includes('launchplan')).length,
    0,
    'the deleted stretch is gone from the tool result',
  )
  db.close()
})
