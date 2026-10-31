// Shortening how long history is kept asks first whenever it deletes something, to the minute storage cuts at.
process.env.TZ = 'Etc/GMT+5'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { retentionCuts } from '../../app/renderer/src/screens/settings/retention.ts'

const NOW = new Date(2026, 9, 31, 16, 0).getTime()

test('a first day whose morning falls before the cutoff is named, though its date is the cutoff date', () => {
  assert.equal(retentionCuts('2026-10-01', 30, NOW), 'everything before 1 October, 4 PM')
})

test('nothing is named when every recorded day is inside the period, or history is kept for good', () => {
  assert.equal(retentionCuts('2026-10-02', 30, NOW), null)
  assert.equal(retentionCuts('2026-09-01', null, NOW), null)
  assert.equal(retentionCuts(null, 30, NOW), null)
})
