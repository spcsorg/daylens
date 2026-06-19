import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { AIWrappedNarrative, AppCategory, DayTimelinePayload, WebsiteSummary, WrappedPeriodFacts, WrappedPeriodNarrative, WrappedNarrativeResult } from '@shared/types'
import { blockActiveSeconds } from '@shared/blockDuration'
import { dateStringFromMs, dayBounds, formatTime, todayString } from '../lib/format'
import { ipc } from '../lib/ipc'
import type { BrowserContext, FocusByPeriod, IdentityConfidence, WrappedQuality } from '../lib/wrappedFacts'
import {
  buildBrowserContext,
  categoryBreakdownFromSources,
  computeFocusByPeriod,
  computeIdentityConfidence,
  computeQuality,
  selectPeakBlock,
} from '../lib/wrappedFacts'

// ─── Themes ─────────────────────────────────────────────────────────────────

interface SlideTheme { bg: string; accent: string; glow: string; hue: string }

const MORNING_VIDEO_URLS = [
  new URL('../assets/videos/morning-coffee-sunrise.mp4', import.meta.url).href,
  new URL('../assets/videos/morning-forest.mp4', import.meta.url).href,
  new URL('../assets/videos/morning-coffee-bokeh.mp4', import.meta.url).href,
  new URL('../assets/videos/morning-horizon.mp4', import.meta.url).href,
  new URL('../assets/videos/morning-hills.mp4', import.meta.url).href,
  new URL('../assets/videos/morning-hearth.mp4', import.meta.url).href,
]

const MORNING_THEMES: SlideTheme[] = [
  { bg: 'linear-gradient(158deg,#1d180f 0%,#66350d 48%,#ef9a3a 100%)', accent: '#ffd38a', glow: 'rgba(255,179,84,0.42)', hue: 'amber' },
  { bg: 'linear-gradient(144deg,#0b1820 0%,#315a56 48%,#e0a96d 100%)', accent: '#bff0dc', glow: 'rgba(191,240,220,0.28)', hue: 'sage' },
  { bg: 'linear-gradient(166deg,#251126 0%,#74393f 52%,#f2b270 100%)', accent: '#ffc7a0', glow: 'rgba(255,172,116,0.36)', hue: 'rose' },
  { bg: 'linear-gradient(136deg,#101a2a 0%,#234f74 46%,#f5c778 100%)', accent: '#b9ddff', glow: 'rgba(185,221,255,0.3)', hue: 'dawn-blue' },
]

const CAT_THEME: Partial<Record<AppCategory, SlideTheme>> = {
  development:   { bg: 'linear-gradient(150deg,#060d22 0%,#0d1c52 55%,#1a2e7a 100%)', accent: '#b4c5ff', glow: 'rgba(77,142,255,0.38)',   hue: 'blue'    },
  design:        { bg: 'linear-gradient(150deg,#150818 0%,#3d0a48 55%,#6b1280 100%)', accent: '#f472b6', glow: 'rgba(244,114,182,0.38)',  hue: 'pink'    },
  communication: { bg: 'linear-gradient(150deg,#030f0e 0%,#083830 55%,#0d5c50 100%)', accent: '#4fdbc8', glow: 'rgba(79,219,200,0.38)',   hue: 'teal'    },
  research:      { bg: 'linear-gradient(150deg,#0c0718 0%,#260865 55%,#3d0e9c 100%)', accent: '#c084fc', glow: 'rgba(192,132,252,0.38)',  hue: 'violet'  },
  writing:       { bg: 'linear-gradient(150deg,#040b1a 0%,#082060 55%,#0d3690 100%)', accent: '#93c5fd', glow: 'rgba(147,197,253,0.38)',  hue: 'blue'    },
  aiTools:       { bg: 'linear-gradient(150deg,#130618 0%,#480865 55%,#780898 100%)', accent: '#e879f9', glow: 'rgba(232,121,249,0.38)',  hue: 'magenta' },
  productivity:  { bg: 'linear-gradient(150deg,#031208 0%,#083820 55%,#0d5c32 100%)', accent: '#6ee7b7', glow: 'rgba(110,231,183,0.38)',  hue: 'green'   },
  meetings:      { bg: 'linear-gradient(150deg,#130e04 0%,#3d2206 55%,#6b3a06 100%)', accent: '#ffb95f', glow: 'rgba(255,185,95,0.38)',   hue: 'gold'    },
  email:         { bg: 'linear-gradient(150deg,#031214 0%,#084048 55%,#0d6470 100%)', accent: '#67e8f9', glow: 'rgba(103,232,249,0.38)',  hue: 'cyan'    },
  browsing:      { bg: 'linear-gradient(150deg,#140804 0%,#481806 55%,#7a2a06 100%)', accent: '#fb923c', glow: 'rgba(251,146,60,0.38)',   hue: 'orange'  },
  social:        { bg: 'linear-gradient(150deg,#0e0820 0%,#2c1870 55%,#4a2ab0 100%)', accent: '#a78bfa', glow: 'rgba(167,139,250,0.38)',  hue: 'indigo'  },
  entertainment: { bg: 'linear-gradient(150deg,#180808 0%,#5a0c0c 55%,#8c1a1a 100%)', accent: '#f87171', glow: 'rgba(248,113,113,0.38)',  hue: 'red'     },
  system:        { bg: 'linear-gradient(150deg,#080808 0%,#1a1a1a 55%,#2a2a2a 100%)', accent: '#94a3b8', glow: 'rgba(148,163,184,0.3)',   hue: 'gray'    },
  uncategorized: { bg: 'linear-gradient(150deg,#080808 0%,#1a1a1a 55%,#2a2a2a 100%)', accent: '#94a3b8', glow: 'rgba(148,163,184,0.3)',   hue: 'gray'    },
}

const DEFAULT_THEME: SlideTheme = {
  bg: 'linear-gradient(150deg,#060d1a 0%,#0d1c3a 55%,#1a2d5c 100%)',
  accent: '#adc6ff', glow: 'rgba(173,198,255,0.32)', hue: 'blue',
}

const STEADY_THEME: SlideTheme = {
  bg: 'linear-gradient(150deg,#031212 0%,#094040 55%,#0f6060 100%)',
  accent: '#4fdbc8', glow: 'rgba(79,219,200,0.38)', hue: 'teal',
}

const FALLBACK_POOL: SlideTheme[] = [
  CAT_THEME.meetings!,
  CAT_THEME.productivity!,
  CAT_THEME.design!,
  CAT_THEME.browsing!,
  CAT_THEME.email!,
  CAT_THEME.social!,
  CAT_THEME.entertainment!,
  CAT_THEME.communication!,
]

function catTheme(cat: AppCategory | string | undefined): SlideTheme {
  return (cat ? CAT_THEME[cat as AppCategory] : undefined) ?? DEFAULT_THEME
}

function dedupeAdjacentThemes(themes: SlideTheme[]): SlideTheme[] {
  const result: SlideTheme[] = []
  for (let i = 0; i < themes.length; i++) {
    let t = themes[i]
    if (i > 0 && result[i - 1].hue === t.hue) {
      const prev = result[i - 1].hue
      const next = i + 1 < themes.length ? themes[i + 1].hue : ''
      const fb = FALLBACK_POOL.find(f => f.hue !== prev && f.hue !== next && f.hue !== t.hue)
      if (fb) t = fb
    }
    result.push(t)
  }
  return result
}

// ─── Derived data ─────────────────────────────────────────────────────────────

interface WrappedBlock {
  durationSeconds: number
  startTime: number
  endTime: number
  category: AppCategory
}

interface WrappedData {
  totalSeconds: number
  focusSeconds: number
  focusPct: number
  appCount: number
  blockCount: number
  peakBlock: { label: string; durationSeconds: number; startTime: number; endTime: number; category: AppCategory } | null
  topApp: { appName: string; durationSeconds: number; category: AppCategory; isBrowser: boolean } | null
  totalSwitches: number
  dominantCategory: AppCategory
  dominantCategoryPct: number
  blocks: WrappedBlock[]
  firstActivityTime: number | null
  lastActivityTime: number | null
  dayStartMs: number
  // Stage 1 additions
  quality: WrappedQuality
  switchesPerHour: number
  topDomains: WebsiteSummary[]
  identityConfidence: IdentityConfidence
  browserContext: BrowserContext | null
  // Stage 3 additions
  categoryBreakdown: { category: AppCategory; seconds: number; pct: number }[]
  focusByPeriod: FocusByPeriod
}

function deriveData(data: DayTimelinePayload): WrappedData {
  const [dayFrom] = dayBounds(data.date)

  const sortedBlocks = [...data.blocks].sort((a, b) => a.startTime - b.startTime)

  const peakBlock = selectPeakBlock(data.blocks)

  // Build isBrowser flag from block topApps (more reliable than app name matching)
  const browserFlags = new Map<string, boolean>()
  for (const b of data.blocks) {
    for (const a of b.topApps) {
      browserFlags.set(a.appName, a.isBrowser)
    }
  }

  const appMap = new Map<string, { appName: string; durationSeconds: number; category: AppCategory; isBrowser: boolean }>()
  for (const s of data.sessions) {
    const isBrowser = browserFlags.get(s.appName) ?? (s.category === 'browsing')
    const entry = appMap.get(s.appName)
    if (entry) entry.durationSeconds += s.durationSeconds
    else appMap.set(s.appName, { appName: s.appName, durationSeconds: s.durationSeconds, category: s.category, isBrowser })
  }
  const topApp = appMap.size > 0
    ? [...appMap.values()].reduce((a, b) => a.durationSeconds > b.durationSeconds ? a : b)
    : null

  const totalSwitches = data.blocks.reduce((sum, b) => sum + b.switchCount, 0)

  const categoryStats = categoryBreakdownFromSources(data.sessions, data.blocks)
  const dominantCategory = categoryStats.dominantCategory
  const dominantCategoryPct = categoryStats.dominantCategoryPct
  const categoryBreakdown = categoryStats.breakdown

  const blocks: WrappedBlock[] = sortedBlocks.map(b => ({
    durationSeconds: blockActiveSeconds(b),
    startTime: b.startTime,
    endTime: b.endTime,
    category: b.dominantCategory,
  }))

  // Stage 3: focus by period (morning / afternoon / evening)
  const focusByPeriod = computeFocusByPeriod(blocks)

  // Stage 1 fields
  const quality = computeQuality(data.totalSeconds)
  const hoursTracked = data.totalSeconds / 3600
  const switchesPerHour = hoursTracked > 0 ? Math.round(totalSwitches / hoursTracked) : 0
  const topDomains = [...data.websites].sort((a, b) => b.totalSeconds - a.totalSeconds).slice(0, 5)
  const browserContext = topApp?.isBrowser ? buildBrowserContext(topDomains) : (data.websites.length > 0 ? buildBrowserContext(topDomains) : null)
  const identityConfidence = computeIdentityConfidence(quality, data.totalSeconds, dominantCategory, dominantCategoryPct, browserContext)

  return {
    totalSeconds: data.totalSeconds,
    focusSeconds: data.focusSeconds,
    focusPct: data.focusPct,
    appCount: data.appCount,
    blockCount: data.blocks.length,
    peakBlock, topApp, totalSwitches,
    dominantCategory, dominantCategoryPct,
    blocks,
    firstActivityTime: sortedBlocks.length > 0
      ? sortedBlocks[0].startTime
      : data.sessions.length > 0 ? Math.min(...data.sessions.map(s => s.startTime)) : null,
    lastActivityTime: sortedBlocks.length > 0
      ? sortedBlocks[sortedBlocks.length - 1].endTime
      : data.sessions.length > 0 ? Math.max(...data.sessions.map(s => s.startTime + s.durationSeconds * 1000)) : null,
    dayStartMs: dayFrom,
    quality,
    switchesPerHour,
    topDomains,
    identityConfidence,
    browserContext,
    categoryBreakdown,
    focusByPeriod,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dateMs(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

function isPastLocalDate(dateStr: string): boolean {
  return dateMs(dateStr) < dateMs(todayString())
}

function dateVariant(dateStr: string, modulo: number): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  const current = new Date(y, m - 1, d)
  const yearStart = new Date(y, 0, 1)
  const dayOfYear = Math.floor((current.getTime() - yearStart.getTime()) / 86_400_000)
  return Math.abs((y * 37 + dayOfYear) % modulo)
}

function rotateGradientForDate(theme: SlideTheme, dateStr: string): SlideTheme {
  const angle = 142 + dateVariant(dateStr, 9) * 4
  return {
    ...theme,
    bg: theme.bg.replace(/linear-gradient\(\d+deg/, `linear-gradient(${angle}deg`),
  }
}

function formatDurationShort(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0 && m > 0) return `${h}h ${m}m`
  if (h > 0) return `${h}h`
  return `${Math.max(1, m)}m`
}

// ─── Layout ───────────────────────────────────────────────────────────────────

function SlideLeft({ children }: { children: ReactNode }) {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column', justifyContent: 'center',
      alignItems: 'flex-start', padding: '88px 64px 60px',
      pointerEvents: 'none',
    }}>
      {children}
    </div>
  )
}

function SlideCenter({ children }: { children: ReactNode }) {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column', justifyContent: 'center',
      alignItems: 'center', textAlign: 'center', padding: '88px 48px 60px',
      pointerEvents: 'none',
    }}>
      {children}
    </div>
  )
}

interface WrapSlidePlan {
  id: string
  body: string
  theme: SlideTheme
}

function isLikelyLeisureDay(d: WrappedData): boolean {
  const leisureCats: AppCategory[] = ['entertainment', 'social', 'browsing']
  const leisureSec = d.categoryBreakdown
    .filter((entry) => leisureCats.includes(entry.category))
    .reduce((sum, entry) => sum + entry.seconds, 0)
  const workSec = Math.max(0, d.totalSeconds - leisureSec)
  return d.quality === 'full' && leisureSec > workSec && workSec < 15 * 60
}

function buildWrapSlidePlan(narrative: AIWrappedNarrative, d: WrappedData): WrapSlidePlan[] {
  const leisureDay = isLikelyLeisureDay(d)
  const slides: WrapSlidePlan[] = [
    { id: 'shape', body: narrative.lead, theme: DEFAULT_THEME },
  ]
  if (leisureDay) {
    slides.push({
      id: 'close',
      body: narrative.slides.closing ?? "That's the day.",
      theme: DEFAULT_THEME,
    })
    return slides
  }
  if (narrative.slides.topApp) {
    slides.push({
      id: 'work',
      body: narrative.slides.topApp,
      theme: catTheme(d.peakBlock?.category ?? d.dominantCategory),
    })
  }
  if (narrative.slides.scale) {
    slides.push({ id: 'time', body: narrative.slides.scale, theme: DEFAULT_THEME })
  }
  if (narrative.nudge) {
    slides.push({ id: 'thread', body: narrative.nudge, theme: STEADY_THEME })
  }
  slides.push({
    id: 'close',
    body: narrative.slides.closing ?? "That's the day.",
    theme: DEFAULT_THEME,
  })
  return slides.slice(0, 5)
}

function SlideNarrativeCard({ body }: { body: string; theme: SlideTheme }) {
  return (
    <SlideLeft>
      <p style={{
        fontSize: 42,
        fontWeight: 700,
        lineHeight: 1.18,
        letterSpacing: '-0.02em',
        color: '#fff',
        margin: 0,
        maxWidth: '28ch',
      }}>
        {body}
      </p>
    </SlideLeft>
  )
}

function SlideProviderRequired({ onClose }: { onClose: () => void }) {
  return (
    <SlideCenter>
      <h1 style={{ fontSize: 34, fontWeight: 700, color: '#fff', margin: '0 0 12px' }}>
        Connect a provider to open wraps
      </h1>
      <p style={{ fontSize: 17, color: 'rgba(255,255,255,0.55)', margin: '0 0 28px', maxWidth: '36ch', lineHeight: 1.5 }}>
        Briefs and wraps are written fresh through your AI provider. Add an API key in Settings to continue.
      </p>
      <button
        onClick={(e) => { e.stopPropagation(); onClose() }}
        style={{
          pointerEvents: 'auto',
          padding: '10px 18px',
          borderRadius: 999,
          border: '1px solid rgba(255,255,255,0.2)',
          background: 'rgba(255,255,255,0.1)',
          color: '#fff',
          cursor: 'pointer',
          fontSize: 14,
        }}
      >
        Close
      </button>
    </SlideCenter>
  )
}

// ─── Empty and partial state slides ──────────────────────────────────────────

function SlideEmpty({ onClose }: { onClose: () => void }) {
  return (
    <SlideLeft>
      <h1 style={{ fontSize: 72, fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.025em', color: '#fff', margin: 0 }}>
        Nothing tracked yet.
      </h1>
      <p style={{ fontSize: 18, color: 'rgba(255,255,255,0.45)', marginTop: 20, maxWidth: '36ch', lineHeight: 1.6 }}>
        Daylens needs some activity before it can tell the story of your day.
      </p>
      <button
        onClick={(e) => { e.stopPropagation(); onClose() }}
        style={{
          marginTop: 40, padding: '13px 28px', borderRadius: 10,
          background: 'rgba(255,255,255,0.08)',
          color: 'rgba(255,255,255,0.65)',
          fontSize: 15, fontWeight: 500,
          border: '1px solid rgba(255,255,255,0.14)',
          cursor: 'pointer', pointerEvents: 'all',
        }}
      >
        Dismiss
      </button>
    </SlideLeft>
  )
}

function SlideTooEarly({ d, theme, onClose }: { d: WrappedData; theme: SlideTheme; onClose: () => void }) {
  const dur = formatDurationShort(d.totalSeconds)
  return (
    <SlideLeft>
      <h1 style={{ fontSize: 72, fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.025em', color: '#fff', margin: 0 }}>
        Too early to tell.
      </h1>
      <p style={{ fontSize: 18, color: 'rgba(255,255,255,0.45)', marginTop: 20, maxWidth: '36ch', lineHeight: 1.6 }}>
        Daylens has only tracked{' '}
        <span style={{ color: theme.accent, fontWeight: 600 }}>{dur}</span>{' '}
        so far. Check back after a real session.
      </p>
      <button
        onClick={(e) => { e.stopPropagation(); onClose() }}
        style={{
          marginTop: 40, padding: '13px 28px', borderRadius: 10,
          background: 'rgba(255,255,255,0.08)',
          color: 'rgba(255,255,255,0.65)',
          fontSize: 15, fontWeight: 500,
          border: '1px solid rgba(255,255,255,0.14)',
          cursor: 'pointer', pointerEvents: 'all',
        }}
      >
        Dismiss
      </button>
    </SlideLeft>
  )
}

function morningLead(d: WrappedData, aiTeaser: string | null): string {
  if (aiTeaser) return aiTeaser
  if (d.quality === 'empty' || d.quality === 'tooEarly') return 'Not much was tracked yesterday, so the signal is thin. Start fresh today.'
  if (d.focusPct >= 65) return `Yesterday, ${d.focusPct}% of your tracked time stayed focused. That is a clean signal to protect today.`
  if (d.peakBlock && d.peakBlock.durationSeconds >= 45 * 60) {
    return `Your clearest stretch ran ${formatTime(d.peakBlock.startTime)} to ${formatTime(d.peakBlock.endTime)}. That window is worth defending.`
  }
  if (d.browserContext && !d.browserContext.isWorkRelevant) {
    return `Yesterday leaned heavy on the browser. ${d.browserContext.interpretation} Start today with a clear thread.`
  }
  if (d.totalSeconds >= 5 * 3600) return `You tracked ${formatDurationShort(d.totalSeconds)} yesterday across ${d.blockCount} work session${d.blockCount !== 1 ? 's' : ''}.`
  if (d.topApp) return `${d.topApp.appName} carried the strongest signal yesterday. The full recap has the shape of the day.`
  return 'Yesterday left enough signal for a useful read on what to carry into today.'
}

function SlideMorningGreeting({
  d,
  userName,
  aiTeaser,
}: {
  d: WrappedData
  userName: string | null
  aiTeaser: string | null
}) {
  const name = userName?.trim()
  return (
    <SlideLeft>
      <h1 style={{
        fontSize: name ? 72 : 68,
        fontWeight: 860,
        lineHeight: 1.02,
        letterSpacing: '-0.03em',
        color: '#fffaf0',
        margin: 0,
        textShadow: '0 14px 48px rgba(0,0,0,0.42)',
      }}>
        {name ? `Good morning, ${name}.` : 'Good morning.'}
      </h1>
      <p style={{
        fontSize: 22,
        fontWeight: 430,
        lineHeight: 1.55,
        color: 'rgba(255,250,240,0.72)',
        margin: '24px 0 0',
        maxWidth: '42ch',
        textShadow: '0 10px 32px rgba(0,0,0,0.5)',
      }}>
        {morningLead(d, aiTeaser)}
      </p>
    </SlideLeft>
  )
}

// ─── Distraction Cost ─────────────────────────────────────────────────────────

// ─── Week-wrap slides ─────────────────────────────────────────────────────────

interface WeekDay {
  dateStr: string
  dayLabel: string
  totalSeconds: number
  dominantCategory: AppCategory
  longestBlockSec: number
}

interface WeekSummary {
  thisWeek: WeekDay[]
  lastWeek: WeekDay[]
}

function useWeekData(enabled: boolean, anchorDate: string): WeekSummary | null {
  const [summary, setSummary] = useState<WeekSummary | null>(null)

  useEffect(() => {
    if (!enabled) return
    const [y, m, d] = anchorDate.split('-').map(Number)
    const anchorMs = new Date(y, m - 1, d).getTime()
    const dates = Array.from({ length: 14 }, (_, i) =>
      dateStringFromMs(anchorMs - (13 - i) * 86_400_000)
    )

    Promise.all(dates.map(date => ipc.db.getTimelineDay(date).catch(() => null)))
      .then(payloads => {
        const process = (p: DayTimelinePayload | null, dateStr: string): WeekDay => {
          const [py, pm, pd] = dateStr.split('-').map(Number)
          const dayLabel = new Date(py, pm - 1, pd).toLocaleDateString('en-US', { weekday: 'short' })
          if (!p || p.totalSeconds === 0) {
            return { dateStr, dayLabel, totalSeconds: 0, dominantCategory: 'development', longestBlockSec: 0 }
          }
          const longestBlockSec = p.blocks.reduce(
            (mx, b) => Math.max(mx, blockActiveSeconds(b)), 0
          )
          return {
            dateStr, dayLabel,
            totalSeconds: p.totalSeconds,
            dominantCategory: deriveData(p).dominantCategory,
            longestBlockSec,
          }
        }
        const all = payloads.map((p, i) => process(p, dates[i]))
        setSummary({ thisWeek: all.slice(7), lastWeek: all.slice(0, 7) })
      })
      .catch(() => {})
  }, [enabled, anchorDate])

  return summary
}

function SlideWeekChart({ week, theme, aiLine = null }: { week: WeekDay[]; theme: SlideTheme; aiLine?: string | null }) {
  const maxSec = Math.max(...week.map(d => d.totalSeconds), 1)

  return (
    <SlideLeft>
      <h1 style={{ fontSize: 56, fontWeight: 800, lineHeight: 1.1, letterSpacing: '-0.025em', color: '#fff', margin: '0 0 8px' }}>
        Your week<br />at a glance.
      </h1>
      {aiLine && (
        <p style={{ fontSize: 17, fontWeight: 400, color: 'rgba(255,255,255,0.5)', margin: '4px 0 0', lineHeight: 1.45, maxWidth: '36ch' }}>
          {aiLine}
        </p>
      )}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, marginTop: 36, height: 120 }}>
        {week.map((day, i) => {
          const rel   = day.totalSeconds / maxSec
          const barH  = Math.max(4, Math.round(rel * 104))
          const color = CAT_THEME[day.dominantCategory]?.accent ?? DEFAULT_THEME.accent
          const isToday = i === week.length - 1
          return (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, flex: 1 }}>
              <div style={{
                width: '100%', height: barH, borderRadius: 4,
                background: color,
                opacity: isToday ? 1 : 0.45,
                boxShadow: isToday ? `0 0 14px ${CAT_THEME[day.dominantCategory]?.glow ?? theme.glow}` : 'none',
                transition: `height 0.9s ${i * 0.06}s cubic-bezier(0.16,1,0.3,1)`,
              }} />
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.04em', fontWeight: isToday ? 700 : 400 }}>
                {day.dayLabel}
              </span>
            </div>
          )
        })}
      </div>
    </SlideLeft>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function DayWrapped({
  data,
  onClose,
  userName = null,
}: {
  data: DayTimelinePayload
  threadId: number | null
  artifactId: number | null
  onClose: () => void
  onOpenReport: () => void
  userName?: string | null
}) {
  const d = useMemo(() => deriveData(data), [data])
  const isMorning = useMemo(() => isPastLocalDate(data.date), [data.date])
  const morningVideoUrl = useMemo(() => MORNING_VIDEO_URLS[dateVariant(data.date, MORNING_VIDEO_URLS.length)], [data.date])
  const [narrativeState, setNarrativeState] = useState<
    | { status: 'loading' }
    | { status: 'unavailable' }
    | { status: 'ready'; narrative: AIWrappedNarrative }
    | { status: 'non_ai'; narrative: AIWrappedNarrative }
  >({ status: 'loading' })
  const narrative = narrativeState.status === 'ready' || narrativeState.status === 'non_ai'
    ? narrativeState.narrative
    : null
  const aiTeaser = narrative?.lead ?? null
  const aiNudge = narrative?.nudge ?? null

  useEffect(() => {
    let cancelled = false
    setNarrativeState({ status: 'loading' })

    void ipc.ai.getWrappedNarrative(data.date)
      .then((result: WrappedNarrativeResult) => {
        if (cancelled || !result) {
          if (!cancelled) setNarrativeState({ status: 'unavailable' })
          return
        }
        if (result.status === 'unavailable') {
          setNarrativeState({ status: 'unavailable' })
          return
        }
        setNarrativeState({ status: result.status, narrative: result.narrative })
      })
      .catch(() => {
        if (!cancelled) setNarrativeState({ status: 'unavailable' })
      })

    return () => { cancelled = true }
  }, [data.date])

  const isExtended = useMemo(() => {
    if (isMorning) return false
    const [y, m, day] = data.date.split('-').map(Number)
    const dataDate    = new Date(y, m - 1, day)
    const isFriday    = dataDate.getDay() === 5
    const lastOfMonth = new Date(y, m, 0).getDate() === day
    return isFriday || lastOfMonth
  }, [data.date, isMorning])

  const weekSummary = useWeekData(!isMorning && isExtended, data.date)

  // Fetch AI period narrative for the week slides when week data is available
  const [periodNarrative, setPeriodNarrative] = useState<WrappedPeriodNarrative | null>(null)
  useEffect(() => {
    if (!weekSummary) { setPeriodNarrative(null); return }
    let cancelled = false

    const thisWeek = weekSummary.thisWeek
    const lastWeek = weekSummary.lastWeek
    const totalSeconds = thisWeek.reduce((s, d) => s + d.totalSeconds, 0)
    const previousPeriodSeconds = lastWeek.reduce((s, d) => s + d.totalSeconds, 0)
    const daysWithActivity = thisWeek.filter(d => d.totalSeconds > 0).length

    // Derive dominant category from the week
    const catTotals = new Map<AppCategory | 'unknown', number>()
    for (const day of thisWeek) {
      if (day.totalSeconds > 0) {
        catTotals.set(day.dominantCategory, (catTotals.get(day.dominantCategory) ?? 0) + day.totalSeconds)
      }
    }
    let dominantCategory: AppCategory | 'unknown' = 'unknown'
    let dominantSeconds = 0
    for (const [cat, sec] of catTotals) {
      if (sec > dominantSeconds) { dominantCategory = cat; dominantSeconds = sec }
    }
    const dominantCategoryPct = totalSeconds > 0 ? Math.round((dominantSeconds / totalSeconds) * 100) : 0

    // Busiest day
    const busiestDay = thisWeek.reduce<typeof thisWeek[0] | null>((best, d) =>
      d.totalSeconds > (best?.totalSeconds ?? 0) ? d : best, null)

    // Longest block
    const longestBlockDay = thisWeek.reduce<typeof thisWeek[0] | null>((best, d) =>
      d.longestBlockSec > (best?.longestBlockSec ?? 0) ? d : best, null)

    const facts: WrappedPeriodFacts = {
      period: 'week',
      anchorDate: data.date,
      totalSeconds,
      previousPeriodSeconds,
      daysWithActivity,
      dominantCategory,
      dominantCategoryPct,
      busiestDay: busiestDay && busiestDay.totalSeconds > 0 ? {
        dateStr: busiestDay.dateStr,
        dayLabel: busiestDay.dayLabel,
        totalSeconds: busiestDay.totalSeconds,
        dominantCategory: busiestDay.dominantCategory,
      } : null,
      longestBlock: longestBlockDay && longestBlockDay.longestBlockSec > 0 ? {
        dateStr: longestBlockDay.dateStr,
        dayLabel: longestBlockDay.dayLabel,
        durationSeconds: longestBlockDay.longestBlockSec,
        dominantCategory: longestBlockDay.dominantCategory,
      } : null,
      buckets: thisWeek.map(d => ({ label: d.dayLabel, totalSeconds: d.totalSeconds, dominantCategory: d.dominantCategory })),
    }

    void ipc.ai.getWrappedPeriodNarrative(facts)
      .then((result) => { if (!cancelled) setPeriodNarrative(result ?? null) })
      .catch(() => { if (!cancelled) setPeriodNarrative(null) })

    return () => { cancelled = true }
  }, [weekSummary, data.date])

  const weekSlides = !isMorning && isExtended && weekSummary && narrative ? 1 : 0

  const wrapSlides = useMemo(() => {
    if (!narrative || isMorning) return [] as WrapSlidePlan[]
    return buildWrapSlidePlan(narrative, d)
  }, [d, isMorning, narrative])

  const SLIDE_COUNT = isMorning
    ? (narrative ? (aiNudge ? 2 : 1) : 1)
    : narrativeState.status === 'unavailable'
      ? 1
      : d.quality === 'empty' || d.quality === 'tooEarly'
        ? 1
        : narrativeState.status === 'loading'
          ? 1
          : wrapSlides.length + weekSlides

  const [slideIndex, setSlideIndex] = useState(0)
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')

  const advance = useCallback(() => {
    setDirection('forward')
    setSlideIndex(i => Math.min(i + 1, SLIDE_COUNT - 1))
  }, [SLIDE_COUNT])

  const goBack = useCallback(() => {
    setDirection('back')
    setSlideIndex(i => Math.max(i - 1, 0))
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape')     onClose()
      if (e.key === 'ArrowRight') advance()
      if (e.key === 'ArrowLeft')  goBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [advance, goBack, onClose])

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest('button')) return
    const rect = e.currentTarget.getBoundingClientRect()
    if (e.clientX - rect.left < rect.width / 2) goBack()
    else advance()
  }

  const baseThemes = useMemo<SlideTheme[]>(() => {
    if (isMorning) {
      return narrative
        ? [MORNING_THEMES[0], MORNING_THEMES[2]]
        : [MORNING_THEMES[0]]
    }
    if (narrativeState.status === 'unavailable') return [DEFAULT_THEME]
    if (d.quality === 'empty' || d.quality === 'tooEarly') return [DEFAULT_THEME]
    if (narrativeState.status === 'loading') return [DEFAULT_THEME]
    const eveningThemes = wrapSlides.map((slide) => slide.theme)
    const weekTheme = weekSummary ? [CAT_THEME.productivity ?? DEFAULT_THEME] : []
    return [...eveningThemes, ...weekTheme]
  }, [d.quality, isMorning, narrative, narrativeState.status, weekSummary, wrapSlides])

  const slideThemes = useMemo(
    () => dedupeAdjacentThemes(baseThemes).map((entry) => rotateGradientForDate(entry, data.date)),
    [baseThemes, data.date],
  )

  const theme    = slideThemes[Math.min(slideIndex, slideThemes.length - 1)]
  const animName = direction === 'forward' ? 'wrappedEnterFromRight' : 'wrappedEnterFromLeft'

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: '#000', cursor: 'default',
        animation: 'wrappedOverlayIn 280ms ease forwards',
      }}
      onClick={handleClick}
    >
      <div
        key={slideIndex}
        style={{
          position: 'absolute', inset: 0,
          background: theme.bg,
          animation: `${animName} 380ms cubic-bezier(0.34,1.56,0.64,1) forwards`,
          overflow: 'hidden',
        }}
      >
        {isMorning && slideIndex === 0 && (
          <>
            <video
              key={morningVideoUrl}
              src={morningVideoUrl}
              autoPlay
              muted
              loop
              playsInline
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                filter: 'saturate(1.06) contrast(1.08)',
                opacity: 0.9,
              }}
            />
            <div style={{
              position: 'absolute',
              inset: 0,
              background: 'linear-gradient(90deg, rgba(5,8,14,0.78) 0%, rgba(8,12,18,0.5) 42%, rgba(8,12,18,0.22) 100%)',
            }} />
            <div style={{
              position: 'absolute',
              inset: 0,
              background: 'radial-gradient(circle at 28% 64%, rgba(255,177,89,0.18), transparent 42%)',
              mixBlendMode: 'screen',
            }} />
          </>
        )}
        {isMorning && slideIndex > 0 && (
          <>
            <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 74% 18%, rgba(255,246,218,0.16), transparent 36%)' }} />
            <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 18% 82%, rgba(90,36,8,0.24), transparent 42%)' }} />
            <div style={{
              position: 'absolute',
              inset: 0,
              backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.7' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.11'/%3E%3C/svg%3E")`,
              opacity: 0.1,
              mixBlendMode: 'overlay',
            }} />
          </>
        )}

        {isMorning ? (
          <>
            {slideIndex === 0 && (
              narrative
                ? <SlideNarrativeCard body={narrative.lead} theme={theme} />
                : <SlideMorningGreeting d={d} userName={userName} aiTeaser={aiTeaser} />
            )}
            {aiNudge && slideIndex === 1 && (
              <SlideNarrativeCard body={aiNudge} theme={theme} />
            )}
          </>
        ) : narrativeState.status === 'unavailable' ? (
          <SlideProviderRequired onClose={onClose} />
        ) : d.quality === 'empty' ? (
          <SlideEmpty onClose={onClose} />
        ) : d.quality === 'tooEarly' ? (
          <SlideTooEarly d={d} theme={theme} onClose={onClose} />
        ) : narrativeState.status === 'loading' ? (
          <SlideCenter>
            <p style={{ fontSize: 22, color: 'rgba(255,255,255,0.6)', margin: 0 }}>Writing your wrap…</p>
          </SlideCenter>
        ) : (
          <>
            {wrapSlides[slideIndex] && (
              <SlideNarrativeCard body={wrapSlides[slideIndex].body} theme={theme} />
            )}
            {weekSummary && slideIndex === wrapSlides.length && (
              <SlideWeekChart week={weekSummary.thisWeek} theme={theme} aiLine={periodNarrative?.slides.chart ?? null} />
            )}
          </>
        )}
      </div>

      {/* Progress bar — clears macOS traffic lights */}
      <div style={{
        position: 'absolute', top: 46, left: 16, right: 56,
        display: 'flex', gap: 4, zIndex: 10, pointerEvents: 'none',
      }}>
        {Array.from({ length: SLIDE_COUNT }).map((_, i) => (
          <div key={i} style={{
            flex: 1, height: 3, borderRadius: 2,
            background: i <= slideIndex ? theme.accent : 'rgba(255,255,255,0.16)',
            transition: 'background 300ms ease',
          }} />
        ))}
      </div>

      {/* Close button */}
      <button
        onClick={(e) => { e.stopPropagation(); onClose() }}
        style={{
          position: 'absolute', top: 38, right: 16, zIndex: 10,
          width: 36, height: 36, borderRadius: '50%',
          background: 'rgba(255,255,255,0.12)',
          border: '1px solid rgba(255,255,255,0.16)',
          color: 'rgba(255,255,255,0.7)',
          fontSize: 18, lineHeight: 1,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer',
        }}
      >
        ×
      </button>
    </div>
  )
}
