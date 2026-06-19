import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, Notification, app, nativeImage } from 'electron'
import { getSessionsForRange } from '../db/queries'
import { localDateString, localDayBounds } from '../lib/localDate'
import { hasDayRecapForDate } from '../lib/dayRecap'
import { getDb } from './database'
import { getSettings } from './settings'
import { getWrappedNarrative, canRunWrappedNarrative } from './wrappedNarrative'
import { getCurrentSession } from './tracking'
import { getTimelineDayPayload } from './workBlocks'
import {
  buildEveningWrapRoute,
  openDailySummaryRoute,
  setDailySummaryNavigationWindow,
} from './dailySummaryNavigation'

import {
  decideDailySummary,
  decideYesterdayRecap,
  decideCarryoverNudge,
  type DailyNotifierState,
} from '../lib/dailySummaryScheduler'

const AI_REPORT_TIMEOUT_MS = 12_000

let notifierTimer: ReturnType<typeof setInterval> | null = null
let dailySummaryPreparing = false

const liveNotifications = new Set<Notification>()

function notificationIcon(): Electron.NativeImage | undefined {
  try {
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'build', 'icon.png')
      : path.join(__dirname, '..', '..', 'build', 'icon.png')
    const img = nativeImage.createFromPath(iconPath)
    return img.isEmpty() ? undefined : img
  } catch {
    return undefined
  }
}

function statePath(): string {
  return path.join(app.getPath('userData'), 'daily-summary-state.json')
}

function readState(): DailyNotifierState {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as DailyNotifierState
  } catch {
    return {}
  }
}

function writeState(state: DailyNotifierState): void {
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2))
}

function notifyWithNavigation(title: string, body: string, route: string, options: { actionText?: string } = {}): void {
  if (!Notification.isSupported()) {
    console.warn('[daily-summary] notifications not supported on this platform')
    return
  }

  const icon = notificationIcon()
  const notification = new Notification({
    title,
    body,
    silent: false,
    icon,
    actions: options.actionText && process.platform === 'darwin'
      ? [{ type: 'button', text: options.actionText }]
      : undefined,
  })

  liveNotifications.add(notification)

  const openRoute = () => {
    console.log('[daily-summary] notification clicked, opening route:', route)
    openDailySummaryRoute(route)
  }

  notification.on('click', openRoute)
  notification.on('action', openRoute)
  notification.on('show', () => { console.log('[daily-summary] notification shown:', title) })
  notification.on('failed', (_e, err) => { console.warn('[daily-summary] notification failed:', err) })
  notification.on('close', () => { liveNotifications.delete(notification) })

  notification.show()
  setTimeout(() => { liveNotifications.delete(notification) }, 30 * 60 * 1000)
}

async function tryGetWrappedTeaser(
  dateStr: string,
  surface: 'morning' | 'evening' | 'carryover' = 'evening',
): Promise<string | null> {
  if (!(await canRunWrappedNarrative())) return null
  try {
    const today = localDateString(new Date())
    const liveSession = dateStr === today ? getCurrentSession() : null
    const payload = getTimelineDayPayload(getDb(), dateStr, liveSession)
    const result = await Promise.race([
      getWrappedNarrative(payload),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), AI_REPORT_TIMEOUT_MS)),
    ])
    if (!result || result.status === 'unavailable') return null
    const narrative = result.narrative
    if (!narrative?.lead) return null
    if (surface === 'evening' && narrative.nudge) {
      const combined = `${narrative.lead.trim()} ${narrative.nudge.trim()}`
      if (combined.length <= 160) return combined
    }
    if (surface === 'carryover' && narrative.nudge) return narrative.nudge.trim()
    return narrative.lead
  } catch {
    return null
  }
}

function secondsTrackedOn(date: string): number {
  const [fromMs, toMs] = localDayBounds(date)
  const sessions = getSessionsForRange(getDb(), fromMs, toMs)
  return sessions.reduce((sum, s) => sum + s.durationSeconds, 0)
}

async function checkDailySummary(): Promise<void> {
  if (dailySummaryPreparing) return
  if (!(await canRunWrappedNarrative())) return

  const settings = getSettings()
  const now = new Date()
  const today = localDateString(now)
  const state = readState()

  const decision = decideDailySummary({
    now,
    state,
    todaySecondsTracked: secondsTrackedOn(today),
    dailySummaryEnabled: settings.dailySummaryEnabled ?? true,
    todayDateString: today,
  })
  if (!decision.fire) return

  dailySummaryPreparing = true
  try {
    const teaser = await tryGetWrappedTeaser(today, 'evening')
    if (!teaser) return
    const route = buildEveningWrapRoute(today)
    notifyWithNavigation('Evening Wrap', teaser, route)
    writeState({ ...state, lastDailySummaryDate: today })
  } finally {
    dailySummaryPreparing = false
  }
}

async function checkYesterdayRecap(): Promise<void> {
  if (dailySummaryPreparing) return
  if (!(await canRunWrappedNarrative())) return

  const settings = getSettings()
  const now = new Date()
  const today = localDateString(now)
  const yesterday = localDateString(new Date(now.getTime() - 86_400_000))
  const state = readState()

  const decision = decideYesterdayRecap({
    now,
    state,
    yesterdaySecondsTracked: secondsTrackedOn(yesterday),
    morningNudgeEnabled: settings.morningNudgeEnabled ?? true,
    todayDateString: today,
    yesterdayDateString: yesterday,
    yesterdayRecapAlreadyGenerated: hasDayRecapForDate(yesterday),
  })
  if (!decision.fire) return

  dailySummaryPreparing = true
  try {
    const teaser = await tryGetWrappedTeaser(yesterday, 'morning')
    if (!teaser) return
    const route = `/timeline?date=${yesterday}&source=daily-summary`
    notifyWithNavigation('Yesterday', teaser, route, { actionText: 'Open' })
    writeState({ ...state, lastYesterdayRecapDate: today, lastMorningNudgeDate: today })
  } finally {
    dailySummaryPreparing = false
  }
}

async function checkCarryoverNudge(): Promise<void> {
  if (dailySummaryPreparing) return
  if (!(await canRunWrappedNarrative())) return

  const settings = getSettings()
  const now = new Date()
  const today = localDateString(now)
  const yesterday = localDateString(new Date(now.getTime() - 86_400_000))
  const state = readState()

  const decision = decideCarryoverNudge({
    now,
    state,
    todaySecondsTracked: secondsTrackedOn(today),
    yesterdaySecondsTracked: secondsTrackedOn(yesterday),
    morningNudgeEnabled: settings.morningNudgeEnabled ?? true,
    todayDateString: today,
  })
  if (!decision.fire) return

  dailySummaryPreparing = true
  try {
    const teaser = await tryGetWrappedTeaser(today, 'carryover')
    if (!teaser) return
    const route = buildEveningWrapRoute(today)
    notifyWithNavigation('Good morning', teaser, route, { actionText: 'Open' })
    writeState({ ...state, lastCarryoverNudgeDate: today })
  } finally {
    dailySummaryPreparing = false
  }
}

export async function fireTestDailyNotification(): Promise<{ ok: boolean; reason?: string }> {
  if (!Notification.isSupported()) return { ok: false, reason: 'notifications-unsupported' }
  if (!(await canRunWrappedNarrative())) return { ok: false, reason: 'no-provider' }

  const now = new Date()
  const today = localDateString(now)
  const yesterday = localDateString(new Date(now.getTime() - 86_400_000))
  const isMorning = now.getHours() < 12
  const targetDate = isMorning ? yesterday : today

  try {
    const teaser = await tryGetWrappedTeaser(targetDate, isMorning ? 'morning' : 'evening')
    if (!teaser) return { ok: false, reason: 'no-teaser' }

    if (isMorning) {
      notifyWithNavigation(
        'Yesterday',
        teaser,
        `/timeline?date=${targetDate}&source=daily-summary`,
        { actionText: 'Open' },
      )
    } else {
      notifyWithNavigation(
        'Evening Wrap',
        teaser,
        buildEveningWrapRoute(targetDate),
      )
    }
    return { ok: true }
  } catch (err) {
    console.warn('[daily-summary] manual trigger failed:', err)
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export function setDailySummaryNotificationWindow(window: BrowserWindow | null): void {
  setDailySummaryNavigationWindow(window)
}

export function startDailySummaryNotifier(window?: BrowserWindow | null): void {
  if (window) {
    setDailySummaryNavigationWindow(window)
  }
  if (notifierTimer) return

  const runChecks = () => {
    void (async () => {
      try {
        await checkYesterdayRecap()
        await checkCarryoverNudge()
        await checkDailySummary()
      } catch (err) {
        console.warn('[daily-summary] notifier check failed:', err)
      }
    })()
  }

  runChecks()
  notifierTimer = setInterval(runChecks, 60_000)
}
