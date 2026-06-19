// Pure scheduling decisions for the daily-summary notifier. Lives in /lib
// instead of /services so it has no transitive dependency on settings, the
// database, or providers — which means tests can drive the gate logic with
// synthetic state alone.
//
// The notifier (`src/main/services/dailySummaryNotifier.ts`) is the only
// production caller; it gathers settings + state + tracked seconds and asks
// these functions whether to fire.

export interface DailyNotifierState {
  lastDailySummaryDate?: string
  /** @deprecated use lastYesterdayRecapDate */
  lastMorningNudgeDate?: string
  lastYesterdayRecapDate?: string
  lastCarryoverNudgeDate?: string
}

// Minimum tracked seconds before Wrapped has enough signal to be worth notifying.
export const NOTIFY_MIN_SECONDS = 45 * 60

/** Carryover nudge fires after this many seconds of morning work. */
export const CARRYOVER_NUDGE_MIN_SECONDS = 60 * 60

/** Carryover nudge stops firing after this local hour. */
export const CARRYOVER_NUDGE_MAX_HOUR = 14

export type SchedulerDecision =
  | { fire: true; targetDate: string }
  | { fire: false; reason: string }

function hasReachedLocalTime(now: Date, hour: number, minute = 0): boolean {
  return now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute)
}

export interface DailySummaryDecisionInput {
  now: Date
  state: DailyNotifierState
  todaySecondsTracked: number
  dailySummaryEnabled: boolean
  todayDateString: string
}

export function decideDailySummary(input: DailySummaryDecisionInput): SchedulerDecision {
  if (!input.dailySummaryEnabled) return { fire: false, reason: 'disabled' }
  if (input.state.lastDailySummaryDate === input.todayDateString) {
    return { fire: false, reason: 'already-fired-today' }
  }
  if (!hasReachedLocalTime(input.now, 18)) return { fire: false, reason: 'before-18' }
  if (input.todaySecondsTracked < NOTIFY_MIN_SECONDS) {
    return { fire: false, reason: 'insufficient-activity' }
  }
  return { fire: true, targetDate: input.todayDateString }
}

export interface MorningNudgeDecisionInput {
  now: Date
  state: DailyNotifierState
  todaySecondsTracked: number
  yesterdaySecondsTracked: number
  morningNudgeEnabled: boolean
  todayDateString: string
  yesterdayDateString: string
}

export function decideMorningNudge(input: MorningNudgeDecisionInput): SchedulerDecision {
  // Back-compat alias — maps to yesterday recap decision.
  return decideYesterdayRecap({
    now: input.now,
    state: input.state,
    yesterdaySecondsTracked: input.yesterdaySecondsTracked,
    morningNudgeEnabled: input.morningNudgeEnabled,
    todayDateString: input.todayDateString,
    yesterdayDateString: input.yesterdayDateString,
    yesterdayRecapAlreadyGenerated: false,
  })
}

export interface YesterdayRecapDecisionInput {
  now: Date
  state: DailyNotifierState
  yesterdaySecondsTracked: number
  morningNudgeEnabled: boolean
  todayDateString: string
  yesterdayDateString: string
  /** When true, user already generated a recap yesterday — skip this notification. */
  yesterdayRecapAlreadyGenerated: boolean
}

/** Yesterday's recap — fires early morning only if no recap was generated yesterday. */
export function decideYesterdayRecap(input: YesterdayRecapDecisionInput): SchedulerDecision {
  if (!input.morningNudgeEnabled) return { fire: false, reason: 'disabled' }
  const lastRecap = input.state.lastYesterdayRecapDate ?? input.state.lastMorningNudgeDate
  if (lastRecap === input.todayDateString) {
    return { fire: false, reason: 'already-fired-today' }
  }
  if (!hasReachedLocalTime(input.now, 6)) return { fire: false, reason: 'before-6' }
  if (input.now.getHours() >= 12) return { fire: false, reason: 'after-noon' }
  if (input.yesterdayRecapAlreadyGenerated) {
    return { fire: false, reason: 'recap-already-exists' }
  }
  if (input.yesterdaySecondsTracked < NOTIFY_MIN_SECONDS) {
    return { fire: false, reason: 'insufficient-yesterday-activity' }
  }
  return { fire: true, targetDate: input.yesterdayDateString }
}

export interface CarryoverNudgeDecisionInput {
  now: Date
  state: DailyNotifierState
  todaySecondsTracked: number
  yesterdaySecondsTracked: number
  morningNudgeEnabled: boolean
  todayDateString: string
}

/** Carryover nudge — fires after 1+ hours of morning work, always (independent of recap). */
export function decideCarryoverNudge(input: CarryoverNudgeDecisionInput): SchedulerDecision {
  if (!input.morningNudgeEnabled) return { fire: false, reason: 'disabled' }
  if (input.state.lastCarryoverNudgeDate === input.todayDateString) {
    return { fire: false, reason: 'already-fired-today' }
  }
  if (input.now.getHours() >= CARRYOVER_NUDGE_MAX_HOUR) {
    return { fire: false, reason: 'after-carryover-window' }
  }
  if (input.todaySecondsTracked < CARRYOVER_NUDGE_MIN_SECONDS) {
    return { fire: false, reason: 'insufficient-morning-activity' }
  }
  if (input.yesterdaySecondsTracked < NOTIFY_MIN_SECONDS) {
    return { fire: false, reason: 'insufficient-yesterday-activity' }
  }
  return { fire: true, targetDate: input.todayDateString }
}
