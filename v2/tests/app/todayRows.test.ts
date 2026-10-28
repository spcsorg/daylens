// Today's rows: a run of empty hours with one reason reads as one range; an hour from browser history is named by its pages.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dayRows, historyLines, kindOf } from '../../app/renderer/src/screens/today/rows.ts'
import type { GapReason, HourRow } from '../../app/shared/types.ts'

const H = 3_600_000
const T = Date.UTC(2026, 2, 5)

function hour(i: number, gap: GapReason | null, extra: Partial<HourRow> = {}): HourRow {
  return { start_ms: T + i * H, end_ms: T + (i + 1) * H, current: false, title: null, summary: null, edited: false, facts: { apps: [], titles: [] }, gap, recorded_until_ms: null, from_history: false, ...extra }
}

test('consecutive empty hours with the same reason become one range; a different reason or a recorded hour starts a new row', () => {
  const rows = dayRows([hour(1, 'not_running'), hour(2, 'not_running'), hour(3, 'not_running'), hour(4, 'asleep'), hour(5, null), hour(6, 'idle'), hour(7, 'idle')])
  assert.deepEqual(
    rows.map((r) => (r.kind === 'gap' ? [r.reason, (r.start_ms - T) / H, (r.end_ms - T) / H] : ['hour', (r.h.start_ms - T) / H])),
    [
      ['not_running', 1, 4],
      ['asleep', 4, 5],
      ['hour', 5],
      ['idle', 6, 8],
    ],
  )
})

test('the same reason either side of a recorded hour stays two rows', () => {
  const rows = dayRows([hour(1, 'locked'), hour(2, null), hour(3, 'locked')])
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['gap', 'hour', 'gap'],
  )
})

test('a range that runs into the current hour is marked current, so it ends now rather than at the hour’s end', () => {
  const rows = dayRows([hour(7, 'paused'), hour(8, 'paused', { current: true })])
  assert.deepEqual(
    rows.map((r) => (r.kind === 'gap' ? [(r.start_ms - T) / H, r.current] : null)),
    [[7, true]],
  )
  const past = dayRows([hour(6, 'paused'), hour(7, 'paused'), hour(8, null, { current: true })])[0]!
  assert.equal(past.kind === 'gap' && past.current, false)
})

test('an hour known only from browser history keeps that design when it is the current hour', () => {
  assert.equal(kindOf(hour(9, null, { from_history: true, current: true })), 'filled')
  assert.equal(kindOf(hour(9, null, { current: true })), 'current')
  assert.equal(kindOf(hour(9, null, { title: 'Wrote the menu' })), 'written')
})

test('an hour from browser history is titled by its pages and says once where they came from', () => {
  const chrome = { id: 'com.example.browser', name: 'Browser', ms: 0 }
  const other = { id: 'com.example.other', name: 'Other', ms: 0 }
  assert.deepEqual(historyLines(hour(6, null, { from_history: true, facts: { apps: [chrome], titles: ['Garden plan'] } })), { title: 'Garden plan', summary: null, where: 'Opened in Browser · from browser history' })
  assert.deepEqual(historyLines(hour(6, null, { from_history: true, facts: { apps: [chrome, other], titles: ['Garden plan', 'Soup', 'Beds', 'Seeds'] } })), {
    title: 'Garden plan',
    summary: 'Soup, Beds, Seeds',
    where: 'Opened in Browser and Other · from browser history',
  })
})
