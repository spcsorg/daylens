// Boundary reasons must survive storage (migration v69).
//
// The segmenter has always computed WHY a block started and stopped, then threw
// it away: there was no column, so a rehydrated block could not explain its own
// edges and segmentation was the least diagnosable part of the pipeline.
//
// The load-bearing detail is the NULL. A row written before v69 has no recorded
// reason, which is NOT the same as a block whose reason set is empty. If those
// two collapse into one value, a pre-migration block masquerades as a block
// with no boundary and the diagnosis is silently wrong.

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import {
  loadPersistedAppDetailBlocksForDates,
  parsePersistedBoundary,
} from '../src/main/services/workBlocks.ts'

const T0 = new Date(2026, 6, 1, 9, 0, 0, 0).getTime()
const HOUR = 3_600_000

function seed(
  db: Database.Database,
  id: string,
  startReasonsJson: string | null,
  endReasonsJson: string | null,
): void {
  db.prepare(`
    INSERT INTO timeline_blocks (
      id, date, start_time, end_time, block_kind, dominant_category,
      category_distribution_json, switch_count, label_current, label_source,
      label_confidence, narrative_current, evidence_summary_json, is_live,
      heuristic_version, computed_at, invalidated_at,
      start_reasons_json, end_reasons_json
    ) VALUES (?, '2026-07-01', ?, ?, 'work', 'development',
      '{"development":3600}', 0, 'Seeded', 'rule', 0.5, NULL, '{}', 0,
      'test', ?, NULL, ?, ?)
  `).run(id, T0, T0 + HOUR, T0, startReasonsJson, endReasonsJson)
}

function boundaryOf(db: Database.Database, id: string) {
  const byDate = loadPersistedAppDetailBlocksForDates(db, ['2026-07-01'])
  return byDate.get('2026-07-01')?.find((block) => block.id === id)?.boundary
}

test('migration v69 adds both boundary columns as nullable', () => {
  const db = createProductionTestDatabase()
  const columns = db.prepare(`PRAGMA table_info(timeline_blocks)`).all() as Array<{
    name: string
    notnull: number
  }>
  for (const name of ['start_reasons_json', 'end_reasons_json']) {
    const column = columns.find((candidate) => candidate.name === name)
    assert.ok(column, `${name} missing`)
    assert.equal(column.notnull, 0, `${name} must stay nullable`)
  }
  db.close()
})

test('reasons round-trip through the rehydration reader', () => {
  const db = createProductionTestDatabase()
  seed(db, 'cut', JSON.stringify(['idle-gap']), JSON.stringify(['meeting-start', 'subject-change']))
  assert.deepEqual(boundaryOf(db, 'cut'), {
    startReasons: ['idle-gap'],
    endReasons: ['meeting-start', 'subject-change'],
  })
  db.close()
})

test('a user cut survives the round trip', () => {
  const db = createProductionTestDatabase()
  seed(db, 'user', JSON.stringify(['user-cut']), JSON.stringify(['user-cut']))
  assert.deepEqual(boundaryOf(db, 'user'), {
    startReasons: ['user-cut'],
    endReasons: ['user-cut'],
  })
  db.close()
})

test('"not recorded" and "no reason" stay distinguishable', () => {
  const db = createProductionTestDatabase()
  // Pre-v69 row: nothing was ever recorded.
  seed(db, 'legacy', null, null)
  // Post-v69 row: computed, and no reason applied.
  seed(db, 'empty', '[]', '[]')

  assert.equal(boundaryOf(db, 'legacy'), undefined, 'unrecorded must read as undefined')
  assert.deepEqual(boundaryOf(db, 'empty'), { startReasons: [], endReasons: [] })
  db.close()
})

test('a half-written row reads as not recorded rather than half a boundary', () => {
  const db = createProductionTestDatabase()
  seed(db, 'partial', JSON.stringify(['idle-gap']), null)
  assert.equal(boundaryOf(db, 'partial'), undefined)
  db.close()
})

test('parsePersistedBoundary rejects malformed and unknown values', () => {
  assert.equal(parsePersistedBoundary(null, null), undefined)
  assert.equal(parsePersistedBoundary('not json', '[]'), undefined)
  assert.equal(parsePersistedBoundary('{"a":1}', '[]'), undefined, 'a non-array is not a reason list')
  // An unrecognized reason string is dropped, but the row still counts as
  // recorded — the column was written, one value just is not in the vocabulary.
  assert.deepEqual(
    parsePersistedBoundary(JSON.stringify(['idle-gap', 'invented-reason', 42]), '[]'),
    { startReasons: ['idle-gap'], endReasons: [] },
  )
})
