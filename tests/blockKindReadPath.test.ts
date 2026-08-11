// The month grid must resolve kind, not read it (ADR-002).
//
// `timeline_blocks.block_kind` holds a BlockCategoryBucket
// ('work' | 'communication' | 'meeting' | 'mixed'), not a WorkKind. The range
// reader used to cast that column straight into WorkKind, coercing every
// unrecognized bucket to 'work' — and since the bucket vocabulary has no
// 'leisure', every block in the grid read as work no matter what it was.
//
// These tests pin the corrected behavior: the stored column does not decide the
// product kind, and a leisure block reads as leisure.

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createProductionTestDatabase } from './support/testDatabase.ts'
import { getTimelineRangeBlocks } from '../src/main/services/timelineCalendarRange.ts'
import { blockKindForCategory } from '../src/main/services/workBlocks.ts'

const T0 = new Date(2026, 6, 1, 9, 0, 0, 0).getTime()
const HOUR = 3_600_000

function seed(
  db: Database.Database,
  options: {
    id: string
    storedBlockKind: string
    dominantCategory: string
    distribution: Record<string, number>
    evidence?: unknown
  },
): void {
  db.prepare(`
    INSERT INTO timeline_blocks (
      id, date, start_time, end_time, block_kind, dominant_category,
      category_distribution_json, switch_count, label_current, label_source,
      label_confidence, narrative_current, evidence_summary_json, is_live,
      heuristic_version, computed_at, invalidated_at
    ) VALUES (?, '2026-07-01', ?, ?, ?, ?, ?, 0, 'Seeded', 'rule',
      0.5, NULL, ?, 0, 'test', ?, NULL)
  `).run(
    options.id,
    T0,
    T0 + HOUR,
    options.storedBlockKind,
    options.dominantCategory,
    JSON.stringify(options.distribution),
    JSON.stringify(options.evidence ?? {}),
    T0,
  )
}

function kindOf(db: Database.Database, id: string): string | undefined {
  const days = getTimelineRangeBlocks(db, '2026-07-01', '2026-07-01')
  return days[0]?.blocks.find((block) => block.id === id)?.kind
}

test('a leisure block reads as leisure even though block_kind can never say so', () => {
  const db = createProductionTestDatabase()
  // What the builder would actually persist for an entertainment block: the
  // bucket vocabulary has no 'leisure', so it writes 'work'.
  assert.equal(blockKindForCategory('entertainment'), 'work')
  seed(db, {
    id: 'leisure-block',
    storedBlockKind: 'work',
    dominantCategory: 'entertainment',
    distribution: { entertainment: 3600 },
    evidence: {
      apps: [{ bundleId: 'com.netflix', appName: 'Netflix', category: 'entertainment', totalSeconds: 3600, sessionCount: 1, isBrowser: false }],
      pages: [{ artifactType: 'page', domain: 'netflix.com', totalSeconds: 3600, displayTitle: 'Netflix' }],
    },
  })
  assert.equal(kindOf(db, 'leisure-block'), 'leisure')
  db.close()
})

test('non-WorkKind buckets in the stored column do not decide the kind', () => {
  const db = createProductionTestDatabase()
  // These three values exist in real databases and are not WorkKinds at all.
  for (const bucket of ['communication', 'meeting', 'mixed'] as const) {
    seed(db, {
      id: `bucket-${bucket}`,
      storedBlockKind: bucket,
      dominantCategory: 'development',
      distribution: { development: 3600 },
    })
  }
  // Development is a focused category, so all three resolve to work — by the
  // resolver's rule, not by the old coerce-anything-unknown-to-work fallback.
  for (const bucket of ['communication', 'meeting', 'mixed'] as const) {
    assert.equal(kindOf(db, `bucket-${bucket}`), 'work')
  }
  db.close()
})

test('a garbage block_kind value cannot fabricate a kind', () => {
  const db = createProductionTestDatabase()
  seed(db, {
    id: 'garbage',
    storedBlockKind: 'not-a-kind-at-all',
    dominantCategory: 'entertainment',
    distribution: { entertainment: 3600 },
    evidence: {
      apps: [{ bundleId: 'com.netflix', appName: 'Netflix', category: 'entertainment', totalSeconds: 3600, sessionCount: 1, isBrowser: false }],
      pages: [{ artifactType: 'page', domain: 'netflix.com', totalSeconds: 3600, displayTitle: 'Netflix' }],
    },
  })
  // Previously coerced to 'work'; now the evidence decides.
  assert.equal(kindOf(db, 'garbage'), 'leisure')
  db.close()
})

test('blockKindForCategory emits only the four bucket values', () => {
  const buckets = new Set(
    (['development', 'design', 'writing', 'meetings', 'communication', 'email', 'uncategorized', 'entertainment', 'social', 'browsing'] as const)
      .map((category) => blockKindForCategory(category)),
  )
  for (const bucket of buckets) {
    assert.ok(['work', 'communication', 'meeting', 'mixed'].includes(bucket), `unexpected bucket ${bucket}`)
  }
  // The point of the type split: leisure/personal/idle are unreachable here.
  assert.ok(!buckets.has('leisure' as never))
  assert.ok(!buckets.has('personal' as never))
})
