// Window-title capture health. Browser windows never keep a title — the
// capture gate strips page content — so a browser sample counts as seen when
// browser history recorded a visit for that browser in the same window. A
// stale Accessibility grant shows only in apps whose titles are kept, so the
// grant verdict is judged on those apps alone.
import type Database from 'better-sqlite3'
import { resolveCanonicalApp, resolveCanonicalBrowser } from '../lib/appIdentity'
import {
  countWebsiteVisitsByBrowserSince,
  listNativeCaptureTitleStatsByApp,
  type CaptureTitleSampleStatsByApp,
} from '../db/focusEventRepository'
import { isBrowserFocusApp } from './captureEventGate'

// Same bar as the permission watcher: most samples must carry context.
const HEALTHY_CONTEXT_RATIO = 0.5
const MIN_SAMPLES_FOR_TITLE_VERDICT = 5

export interface CaptureContextStats {
  recentSamples: number
  recentSamplesWithTitle: number
  /** Samples from apps whose titles are kept (not browsers). */
  titleEligibleSamples: number
  titleEligibleWithTitle: number
  browserSamples: number
  browserSamplesWithHistory: number
  /** Titled samples plus browser samples backed by a history visit. */
  samplesWithContext: number
  lastCapturedAtMs: number | null
}

function sampleBrowserKey(appBundleId: string | null, appName: string | null): string | null {
  const identity = resolveCanonicalApp(appBundleId ?? '', appName ?? '')
  return identity.canonicalAppId ?? appBundleId?.trim().toLowerCase() ?? null
}

export function summarizeCaptureContext(
  apps: CaptureTitleSampleStatsByApp[],
  visitsByBrowser: Array<{ browserBundleId: string; visits: number }>,
  isBrowser: (appBundleId: string | null, appName: string | null) => boolean,
): CaptureContextStats {
  const browsersWithHistory = new Set(
    visitsByBrowser
      .filter((row) => row.visits > 0)
      .map((row) => resolveCanonicalBrowser(row.browserBundleId).canonicalBrowserId)
      .filter((id): id is string => Boolean(id)),
  )

  const stats: CaptureContextStats = {
    recentSamples: 0,
    recentSamplesWithTitle: 0,
    titleEligibleSamples: 0,
    titleEligibleWithTitle: 0,
    browserSamples: 0,
    browserSamplesWithHistory: 0,
    samplesWithContext: 0,
    lastCapturedAtMs: null,
  }

  for (const app of apps) {
    stats.recentSamples += app.samples
    stats.recentSamplesWithTitle += app.withTitle
    if (app.lastCapturedAtMs !== null) {
      stats.lastCapturedAtMs = Math.max(stats.lastCapturedAtMs ?? 0, app.lastCapturedAtMs)
    }

    if (!isBrowser(app.appBundleId, app.appName)) {
      stats.titleEligibleSamples += app.samples
      stats.titleEligibleWithTitle += app.withTitle
      stats.samplesWithContext += app.withTitle
      continue
    }

    stats.browserSamples += app.samples
    const key = sampleBrowserKey(app.appBundleId, app.appName)
    const covered = key !== null && browsersWithHistory.has(key)
    if (covered) stats.browserSamplesWithHistory += app.samples
    stats.samplesWithContext += covered ? app.samples : app.withTitle
  }

  return stats
}

export function getCaptureContextStats(db: Database.Database, sinceMs: number): CaptureContextStats {
  return summarizeCaptureContext(
    listNativeCaptureTitleStatsByApp(db, sinceMs),
    countWebsiteVisitsByBrowserSince(db, sinceMs),
    isBrowserFocusApp,
  )
}

export type WindowTitleHealthStatus = 'healthy' | 'degraded' | 'waiting' | 'missing'
export type WindowTitleBlindCause = 'window_titles' | 'browser_history'

export function deriveWindowTitleHealth(input: {
  recentSamples: number
  samplesWithContext: number
  titleEligibleSamples: number
  titleEligibleWithTitle: number
  browserSamples: number
  browserSamplesWithHistory: number
}): { status: WindowTitleHealthStatus; blindCause: WindowTitleBlindCause | null } {
  // Browser history can cover for a dead grant in the overall ratio, so weak
  // titles in apps that keep them degrade health on their own.
  const titlesWeak = input.titleEligibleSamples >= MIN_SAMPLES_FOR_TITLE_VERDICT
    && input.titleEligibleWithTitle / input.titleEligibleSamples < HEALTHY_CONTEXT_RATIO
  const status: WindowTitleHealthStatus = input.recentSamples === 0
    ? 'waiting'
    : input.samplesWithContext === 0
      ? 'missing'
      : titlesWeak || input.samplesWithContext / input.recentSamples < HEALTHY_CONTEXT_RATIO
        ? 'degraded'
        : 'healthy'
  if (status === 'healthy' || status === 'waiting') return { status, blindCause: null }

  const browserGap = input.browserSamples > input.browserSamplesWithHistory
  return { status, blindCause: titlesWeak || !browserGap ? 'window_titles' : 'browser_history' }
}
