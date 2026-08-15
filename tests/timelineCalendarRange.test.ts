import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { getTimelineRangeBlocks } from '../src/main/services/timelineCalendarRange.ts'

function seedBlock(
  db: Database.Database,
  options: {
    id: string
    date: string
    startTime: number
    endTime: number
    label?: string
    isLive?: number
    invalidatedAt?: number | null
    distribution?: Record<string, number>
    computedAt?: number
  },
): void {
  db.prepare(`
    INSERT INTO timeline_blocks (
      id, date, start_time, end_time, block_kind, dominant_category,
      category_distribution_json, switch_count, label_current, label_source,
      label_confidence, narrative_current, evidence_summary_json, is_live,
      heuristic_version, computed_at, invalidated_at
    ) VALUES (?, ?, ?, ?, 'work', 'development', ?, 0, ?, 'rule',
      0.5, NULL, '{}', ?, 'test', ?, ?)
  `).run(
    options.id,
    options.date,
    options.startTime,
    options.endTime,
    JSON.stringify(options.distribution ?? { development: 3600 }),
    options.label ?? 'Development',
    options.isLive ?? 0,
    options.computedAt ?? options.startTime,
    options.invalidatedAt ?? null,
  )
}

// A member carries its own span, because `blockActiveSeconds` clamps each
// session to that span before summing. `spanSeconds` defaults to `seconds`, so
// the clamp is a no-op unless a test deliberately writes an over-weighted
// member. `memberId` lets one block hold several.
function seedMemberSeconds(
  db: Database.Database,
  blockId: string,
  seconds: number,
  options: { spanSeconds?: number; startTime?: number; memberId?: string } = {},
): void {
  const start = options.startTime ?? T0
  const span = options.spanSeconds ?? seconds
  db.prepare(`
    INSERT INTO timeline_block_members (block_id, member_type, member_id, start_time, end_time, weight_seconds)
    VALUES (?, 'app_session', ?, ?, ?, ?)
  `).run(blockId, options.memberId ?? `${blockId}:s1`, start, start + span * 1000, seconds)
}

// A real foreground session — the evidence a provisional day's total is read
// from, rather than from the superseded blocks that supply its shapes.
function seedFocusedSession(
  db: Database.Database,
  options: { startTime: number; durationSec: number },
): void {
  db.prepare(`
    INSERT INTO app_sessions (bundle_id, app_name, start_time, end_time, duration_sec, category, is_focused, window_title)
    VALUES ('com.test.editor', 'Editor', ?, ?, ?, 'development', 1, 'work.ts')
  `).run(options.startTime, options.startTime + options.durationSec * 1000, options.durationSec)
}

const T0 = new Date(2026, 6, 1, 9, 0, 0, 0).getTime()
const HOUR = 3_600_000

test('returns blocks grouped by day, ordered, live and invalidated excluded', () => {
  const db = createProductionTestDatabase()
  seedBlock(db, { id: 'b2', date: '2026-07-01', startTime: T0 + 2 * HOUR, endTime: T0 + 3 * HOUR })
  seedBlock(db, { id: 'b1', date: '2026-07-01', startTime: T0, endTime: T0 + HOUR })
  seedBlock(db, { id: 'b3', date: '2026-07-02', startTime: T0 + 24 * HOUR, endTime: T0 + 25 * HOUR })
  seedBlock(db, { id: 'live', date: '2026-07-02', startTime: T0 + 26 * HOUR, endTime: T0 + 27 * HOUR, isLive: 1 })
  seedBlock(db, { id: 'stale', date: '2026-07-02', startTime: T0 + 28 * HOUR, endTime: T0 + 29 * HOUR, invalidatedAt: Date.now() })
  seedBlock(db, { id: 'outside', date: '2026-08-01', startTime: T0, endTime: T0 + HOUR })
  seedMemberSeconds(db, 'b1', 1800)

  const days = getTimelineRangeBlocks(db, '2026-07-01', '2026-07-31')
  assert.equal(days.length, 2)
  const july1 = days.find((day) => day.date === '2026-07-01')
  assert.ok(july1)
  assert.deepEqual(july1.blocks.map((block) => block.id), ['b1', 'b2'])
  const july2 = days.find((day) => day.date === '2026-07-02')
  assert.ok(july2)
  assert.deepEqual(july2.blocks.map((block) => block.id), ['b3'])
  db.close()
})

test('a deleted block is excluded from the month range read', () => {
  const db = createProductionTestDatabase()
  seedBlock(db, { id: 'kept', date: '2026-07-01', startTime: T0, endTime: T0 + HOUR })
  seedBlock(db, { id: 'gone', date: '2026-07-01', startTime: T0 + 2 * HOUR, endTime: T0 + 3 * HOUR })
  db.prepare(`
    INSERT INTO timeline_block_reviews (id, block_id, date, evidence_key, review_state, original_block_json, correction_json, created_at, updated_at)
    VALUES ('r1', 'gone', '2026-07-01', 'k', 'ignored', '{}', '{}', ?, ?)
  `).run(Date.now(), Date.now())

  const [day] = getTimelineRangeBlocks(db, '2026-07-01', '2026-07-01')
  assert.deepEqual(day.blocks.map((block) => block.id), ['kept'])
  db.close()
})

test('a user rename always wins over label_current', () => {
  const db = createProductionTestDatabase()
  seedBlock(db, { id: 'b1', date: '2026-07-01', startTime: T0, endTime: T0 + HOUR, label: 'Stale AI name' })
  db.prepare(`INSERT INTO block_label_overrides (block_id, label, narrative, updated_at) VALUES ('b1', 'Client billing', NULL, ?)`).run(Date.now())

  const [day] = getTimelineRangeBlocks(db, '2026-07-01', '2026-07-01')
  assert.equal(day.blocks[0].label, 'Client billing')
  db.close()
})

test('active seconds match blockActiveSeconds: clamp per member, never to the block span', () => {
  const db = createProductionTestDatabase()
  // 1h span with 30m of tracked sessions → 30m active.
  seedBlock(db, { id: 'sparse', date: '2026-07-01', startTime: T0, endTime: T0 + HOUR })
  seedMemberSeconds(db, 'sparse', 1800)
  // A single member whose weight exceeds its OWN span is clamped to that span —
  // this is the clamp blockActiveSeconds applies, per session.
  seedBlock(db, { id: 'overweight', date: '2026-07-01', startTime: T0 + 2 * HOUR, endTime: T0 + 3 * HOUR })
  seedMemberSeconds(db, 'overweight', 3 * 3600, { spanSeconds: 600, startTime: T0 + 2 * HOUR })
  // No members at all → falls back to the span (same rule as blockActiveSeconds).
  seedBlock(db, { id: 'bare', date: '2026-07-01', startTime: T0 + 4 * HOUR, endTime: T0 + 5 * HOUR })

  const [day] = getTimelineRangeBlocks(db, '2026-07-01', '2026-07-01')
  const byId = new Map(day.blocks.map((block) => [block.id, block]))
  assert.equal(byId.get('sparse')?.activeSeconds, 1800)
  assert.equal(byId.get('overweight')?.activeSeconds, 600, 'a member is clamped to its own span')
  assert.equal(byId.get('bare')?.activeSeconds, 3600)
  db.close()
})

test('a merged block keeps the active seconds of its parts', () => {
  // The reason the total is never clamped to the block span (blockDuration.ts):
  // a merged block spans the gap between its parts, so clamping to the span
  // would make time vanish before the merge and reappear after it. Two 30m
  // members inside a 4h span must still read 60m, not 4h and not a clamped
  // value.
  const db = createProductionTestDatabase()
  seedBlock(db, { id: 'merged', date: '2026-07-01', startTime: T0, endTime: T0 + 4 * HOUR })
  seedMemberSeconds(db, 'merged', 1800, { startTime: T0, memberId: 'merged:a' })
  seedMemberSeconds(db, 'merged', 1800, { startTime: T0 + 3 * HOUR, memberId: 'merged:b' })

  const [day] = getTimelineRangeBlocks(db, '2026-07-01', '2026-07-01')
  assert.equal(day.blocks[0].activeSeconds, 3600)
  assert.equal(day.activeSeconds, 3600)
  db.close()
})

test('a day whose every block is invalidated still appears, marked provisional', () => {
  // A day can hold hours of tracked evidence with every one of its blocks
  // invalidated, and the grid rendered it blank while the day view rebuilt it on
  // open. Invalidation is routine: a correction invalidates a day's blocks.
  const db = createProductionTestDatabase()
  seedBlock(db, { id: 'stale-1', date: '2026-07-01', startTime: T0, endTime: T0 + HOUR, invalidatedAt: Date.now() })
  // Stale member weights claim 3h. Real focused evidence for the day is 30m.
  // The recovered day must report the evidence, not the stale blocks — summing
  // superseded generations double-counts the same underlying sessions.
  seedMemberSeconds(db, 'stale-1', 3 * 3600, { spanSeconds: 3 * 3600 })
  seedFocusedSession(db, { startTime: T0, durationSec: 1800 })
  seedBlock(db, { id: 'current', date: '2026-07-02', startTime: T0 + 24 * HOUR, endTime: T0 + 25 * HOUR })

  const days = getTimelineRangeBlocks(db, '2026-07-01', '2026-07-02')
  assert.deepEqual(days.map((day) => day.date), ['2026-07-01', '2026-07-02'])
  const july1 = days.find((day) => day.date === '2026-07-01')
  assert.equal(july1?.provisional, true, 'a recovered day must say it is one generation stale')
  assert.equal(july1?.blocks.length, 1, 'the stale block still supplies the cell shape')
  assert.equal(july1?.activeSeconds, 1800, 'the day total follows corrected evidence, not stale members')
  assert.equal(days.find((day) => day.date === '2026-07-02')?.provisional, undefined)
  db.close()
})

test('the provisional fallback prefers the newest reconstruction for a contested span', () => {
  // Two generations describe the same hour. The more recently invalidated one
  // wins that span; the older one is not also counted, or the day would read as
  // two hours of work that only ever took one.
  const db = createProductionTestDatabase()
  seedBlock(db, { id: 'gen-old', date: '2026-07-01', startTime: T0, endTime: T0 + HOUR, label: 'Old generation', invalidatedAt: 1_000 })
  seedBlock(db, { id: 'gen-new', date: '2026-07-01', startTime: T0, endTime: T0 + HOUR, label: 'New generation', invalidatedAt: 9_000 })

  const [day] = getTimelineRangeBlocks(db, '2026-07-01', '2026-07-01')
  assert.deepEqual(day.blocks.map((block) => block.id), ['gen-new'])
  db.close()
})

test('the provisional fallback fills spans an older generation alone covers', () => {
  // A rebuild invalidates only the blocks it changed, so cohorts are partial.
  // The newest cohort claims 09:00–10:00; the afternoon exists only in an older
  // one and must still appear, in clock order.
  const db = createProductionTestDatabase()
  seedBlock(db, { id: 'newest', date: '2026-07-01', startTime: T0, endTime: T0 + HOUR, invalidatedAt: 9_000 })
  seedBlock(db, { id: 'older-afternoon', date: '2026-07-01', startTime: T0 + 5 * HOUR, endTime: T0 + 6 * HOUR, invalidatedAt: 1_000 })

  const [day] = getTimelineRangeBlocks(db, '2026-07-01', '2026-07-01')
  assert.deepEqual(day.blocks.map((block) => block.id), ['newest', 'older-afternoon'])
  db.close()
})

test('the provisional fallback never resurrects a deleted block', () => {
  const db = createProductionTestDatabase()
  seedBlock(db, { id: 'stale-kept', date: '2026-07-01', startTime: T0, endTime: T0 + HOUR, invalidatedAt: Date.now() })
  seedBlock(db, { id: 'stale-deleted', date: '2026-07-01', startTime: T0 + 2 * HOUR, endTime: T0 + 3 * HOUR, invalidatedAt: Date.now() })
  db.prepare(`
    INSERT INTO timeline_block_reviews (id, block_id, date, evidence_key, review_state, original_block_json, correction_json, created_at, updated_at)
    VALUES ('r2', 'stale-deleted', '2026-07-01', 'k', 'ignored', '{}', '{}', ?, ?)
  `).run(Date.now(), Date.now())

  const [day] = getTimelineRangeBlocks(db, '2026-07-01', '2026-07-01')
  assert.deepEqual(day.blocks.map((block) => block.id), ['stale-kept'])
  db.close()
})

test('a live-only day is not blank', () => {
  const db = createProductionTestDatabase()
  seedBlock(db, { id: 'today', date: '2026-08-11', startTime: T0, endTime: T0 + HOUR, isLive: 1 })

  const [day] = getTimelineRangeBlocks(db, '2026-08-11', '2026-08-11')
  assert.ok(day, 'today must appear in the range read')
  assert.equal(day.provisional, true)
  db.close()
})

test('the label runs the day view chain, not the raw stored value', () => {
  const db = createProductionTestDatabase()
  // "W2_Reading | Intro to ML | Perusall" is 3+ pipe segments — browser-tab soup
  // that isUsefulLabel rejects, so the day view falls through to a real name.
  // The raw read showed the soup verbatim.
  seedBlock(db, {
    id: 'soup',
    date: '2026-07-01',
    startTime: T0,
    endTime: T0 + HOUR,
    label: 'W2_Reading | Intro to ML | Perusall',
  })

  const [day] = getTimelineRangeBlocks(db, '2026-07-01', '2026-07-01')
  assert.notEqual(day.blocks[0].label, 'W2_Reading | Intro to ML | Perusall')
  assert.ok(day.blocks[0].label.length > 0)
  db.close()
})

test('a user rename survives the label chain verbatim', () => {
  const db = createProductionTestDatabase()
  // An override is intentional and is preserved even when it would fail the
  // usefulness gate that rejects a generated label of the same shape.
  seedBlock(db, { id: 'b1', date: '2026-07-01', startTime: T0, endTime: T0 + HOUR, label: 'Stale AI name' })
  db.prepare(`INSERT INTO block_label_overrides (block_id, label, narrative, updated_at) VALUES ('b1', 'Notes | Draft | Review', NULL, ?)`).run(Date.now())

  const [day] = getTimelineRangeBlocks(db, '2026-07-01', '2026-07-01')
  assert.equal(day.blocks[0].label, 'Notes | Draft | Review')
  db.close()
})
