// Tests for the pure scheduling decisions used by the daily-summary notifier.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideDailySummary,
  decideYesterdayRecap,
  decideCarryoverNudge,
  decideMorningNudge,
  NOTIFY_MIN_SECONDS,
  CARRYOVER_NUDGE_MIN_SECONDS,
} from '../src/main/lib/dailySummaryScheduler'

const TODAY = '2026-05-12'
const YESTERDAY = '2026-05-11'

function at(hour: number, minute = 0): Date {
  return new Date(2026, 4, 12, hour, minute, 0, 0)
}

// ─── decideDailySummary ─────────────────────────────────────────────────────

test('daily summary does not fire when disabled', () => {
  const decision = decideDailySummary({
    now: at(20),
    state: {},
    todaySecondsTracked: NOTIFY_MIN_SECONDS + 1,
    dailySummaryEnabled: false,
    todayDateString: TODAY,
  })
  assert.deepEqual(decision, { fire: false, reason: 'disabled' })
})

test('daily summary fires at exactly 18:00 with enough activity', () => {
  const decision = decideDailySummary({
    now: at(18, 0),
    state: {},
    todaySecondsTracked: NOTIFY_MIN_SECONDS,
    dailySummaryEnabled: true,
    todayDateString: TODAY,
  })
  assert.deepEqual(decision, { fire: true, targetDate: TODAY })
})

// ─── decideYesterdayRecap ───────────────────────────────────────────────────

const RECAP_BASE = {
  state: {},
  morningNudgeEnabled: true,
  todayDateString: TODAY,
  yesterdayDateString: YESTERDAY,
  yesterdayRecapAlreadyGenerated: false,
}

test('yesterday recap skips when recap already exists', () => {
  const decision = decideYesterdayRecap({
    ...RECAP_BASE,
    now: at(8),
    yesterdaySecondsTracked: NOTIFY_MIN_SECONDS * 4,
    yesterdayRecapAlreadyGenerated: true,
  })
  assert.deepEqual(decision, { fire: false, reason: 'recap-already-exists' })
})

test('yesterday recap fires at 6:00 with enough yesterday activity', () => {
  const decision = decideYesterdayRecap({
    ...RECAP_BASE,
    now: at(6, 0),
    yesterdaySecondsTracked: NOTIFY_MIN_SECONDS,
  })
  assert.deepEqual(decision, { fire: true, targetDate: YESTERDAY })
})

test('yesterday recap fires even when user is already working today', () => {
  const decision = decideYesterdayRecap({
    ...RECAP_BASE,
    now: at(10),
    yesterdaySecondsTracked: NOTIFY_MIN_SECONDS * 2,
  })
  assert.deepEqual(decision, { fire: true, targetDate: YESTERDAY })
})

// ─── decideCarryoverNudge ───────────────────────────────────────────────────

const CARRY_BASE = {
  state: {},
  morningNudgeEnabled: true,
  todayDateString: TODAY,
}

test('carryover nudge requires at least one hour of morning work', () => {
  const decision = decideCarryoverNudge({
    ...CARRY_BASE,
    now: at(10),
    todaySecondsTracked: CARRYOVER_NUDGE_MIN_SECONDS - 1,
    yesterdaySecondsTracked: NOTIFY_MIN_SECONDS * 2,
  })
  assert.deepEqual(decision, { fire: false, reason: 'insufficient-morning-activity' })
})

test('carryover nudge fires after one hour of work today', () => {
  const decision = decideCarryoverNudge({
    ...CARRY_BASE,
    now: at(10),
    todaySecondsTracked: CARRYOVER_NUDGE_MIN_SECONDS,
    yesterdaySecondsTracked: NOTIFY_MIN_SECONDS,
  })
  assert.deepEqual(decision, { fire: true, targetDate: TODAY })
})

test('carryover nudge fires even when yesterday recap existed', () => {
  const decision = decideCarryoverNudge({
    ...CARRY_BASE,
    now: at(11),
    todaySecondsTracked: CARRYOVER_NUDGE_MIN_SECONDS + 600,
    yesterdaySecondsTracked: NOTIFY_MIN_SECONDS * 3,
  })
  assert.deepEqual(decision, { fire: true, targetDate: TODAY })
})

test('decideMorningNudge remains a back-compat alias for yesterday recap', () => {
  const decision = decideMorningNudge({
    now: at(10),
    state: {},
    todaySecondsTracked: 0,
    yesterdaySecondsTracked: NOTIFY_MIN_SECONDS,
    morningNudgeEnabled: true,
    todayDateString: TODAY,
    yesterdayDateString: YESTERDAY,
  })
  assert.deepEqual(decision, { fire: true, targetDate: YESTERDAY })
})
