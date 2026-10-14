// Lab baselines for the V1 launch plan, against the CLI harness work copy of
// the real profile (never the live database).
//
//   DAYLENS_CLI_ROOT=… npm run bench:v1 -- [--runs 10] [--out file.json]
import fs from 'node:fs'
import type Database from 'better-sqlite3'
import { openHarness } from '../cli/context'

const args = process.argv.slice(2)
const argValue = (name: string): string | null => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] ?? null : null
}
const RUNS = Number(argValue('--runs') ?? 10)
const OUT = argValue('--out')

const nowMs = (): number => Number(process.hrtime.bigint()) / 1e6
const round = (value: number): number => Math.round(value * 10) / 10

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[index]
}

interface Timing { label: string; cold: number; p50: number; p75: number; p95: number; runs: number }
const timings: Timing[] = []

async function measure<T>(label: string, fn: () => T | Promise<T>, runs = RUNS): Promise<T> {
  const t0 = nowMs()
  let result = await fn()
  const cold = nowMs() - t0
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const start = nowMs()
    result = await fn()
    samples.push(nowMs() - start)
  }
  samples.sort((a, b) => a - b)
  const row = { label, cold: round(cold), p50: round(quantile(samples, 0.5)), p75: round(quantile(samples, 0.75)), p95: round(quantile(samples, 0.95)), runs }
  timings.push(row)
  console.log(`  ${label.padEnd(52)} cold ${String(row.cold).padStart(8)}  p50 ${String(row.p50).padStart(8)}  p75 ${String(row.p75).padStart(8)}  p95 ${String(row.p95).padStart(8)} ms`)
  return result
}

interface StatementStat { calls: number; totalMs: number; rows: number }
const statementStats = new Map<string, StatementStat>()

function instrumentStatements(db: Database.Database): void {
  const originalPrepare = db.prepare.bind(db)
  ;(db as unknown as { prepare: typeof db.prepare }).prepare = ((source: string) => {
    const statement = originalPrepare(source)
    const key = source.replace(/\s+/g, ' ').trim().slice(0, 160)
    for (const method of ['all', 'get', 'run', 'iterate'] as const) {
      const original = (statement as unknown as Record<string, (...a: unknown[]) => unknown>)[method]
      if (typeof original !== 'function') continue
      ;(statement as unknown as Record<string, unknown>)[method] = (...params: unknown[]) => {
        const start = nowMs()
        const out = original.apply(statement, params)
        const stat = statementStats.get(key) ?? { calls: 0, totalMs: 0, rows: 0 }
        stat.calls += 1
        stat.totalMs += nowMs() - start
        if (Array.isArray(out)) stat.rows += out.length
        statementStats.set(key, stat)
        return out
      }
    }
    return statement
  }) as typeof db.prepare
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`)
  d.setDate(d.getDate() + days)
  return d.toLocaleDateString('en-CA')
}
const startOfDay = (date: string): number => new Date(`${date}T00:00:00`).getTime()

const NEUTRAL_LABELS = new Set(['Morning', 'Afternoon', 'Evening', 'Night', 'Late night', 'Earlier today'])
const GENERIC_LABELS = new Set(['Uncategorized', 'Browsing', 'Entertainment', 'Communication', 'Development', 'Writing', 'Productivity', 'Social', 'Building & Testing', 'Email', 'Meetings'])

async function main(): Promise<void> {
  const ctx = await openHarness()
  const db = ctx.db
  const { getTimelineDayProjection } = await import('../src/main/core/query/projections')
  const { getAppDetailProjection } = await import('../src/main/core/query/projections')
  const { getAppSummariesForTimelineDay } = await import('../src/main/services/appsFacts')
  const { getCorrectedAppSummariesForRange } = await import('../src/main/services/activityFacts')
  const { buildContextPacket } = await import('../src/main/services/contextPacket')
  const { localDateString } = await import('../src/main/lib/localDate')
  instrumentStatements(db)

  const today = localDateString()
  const heaviest = (db.prepare(`
    SELECT date(start_time/1000,'unixepoch','localtime') AS d, COUNT(*) c
    FROM app_sessions GROUP BY d ORDER BY c DESC LIMIT 2
  `).all() as { d: string; c: number }[]).map((r) => r.d)
  const timelineDays = [...new Set([today, shiftDate(today, -1), '2026-10-05', ...heaviest])]
  const dayPayload = (date: string) => getTimelineDayProjection(db, date, null, { materialize: false, analysis: false })

  console.log(`\nV1 baselines · today ${today} · runs ${RUNS}`)
  console.log('\nTIMELINE (IPC GET_TIMELINE_DAY path)')
  for (const date of timelineDays) await measure(`day payload ${date}`, () => dayPayload(date))
  await measure(`week payloads ending ${today} (7 days)`, () => {
    for (let i = 6; i >= 0; i--) dayPayload(shiftDate(today, -i))
  }, Math.max(3, Math.floor(RUNS / 3)))

  console.log('\nAPPS (inline range path; the app uses the range worker first)')
  const todayEnd = startOfDay(shiftDate(today, 1))
  const ranges: Array<[string, number]> = [['7d', 7], ['30d', 30], ['all', 36500]]
  const rangeTotals: Record<string, { rangeSeconds: number; perDaySeconds: number | null; apps: number; missingApps: Array<{ app: string; perDaySeconds: number; rangeSeconds: number }> }> = {}
  for (const [label, days] of ranges) {
    const from = days >= 36500 ? 0 : startOfDay(shiftDate(today, -(days - 1)))
    const summaries = await measure(`app summaries ${label}`, () => getCorrectedAppSummariesForRange(db, from, todayEnd, null), label === 'all' ? 2 : Math.max(3, Math.floor(RUNS / 2)))
    const rangeSeconds = summaries.reduce((sum, s) => sum + s.totalSeconds, 0)
    let perDaySeconds: number | null = null
    const missingApps: Array<{ app: string; perDaySeconds: number; rangeSeconds: number }> = []
    if (days <= 30) {
      const perApp = new Map<string, number>()
      perDaySeconds = 0
      for (let i = days - 1; i >= 0; i--) {
        for (const s of getAppSummariesForTimelineDay(db, shiftDate(today, -i), null)) {
          perDaySeconds += s.totalSeconds
          perApp.set(s.appName, (perApp.get(s.appName) ?? 0) + s.totalSeconds)
        }
      }
      const rangeByApp = new Map(summaries.map((s) => [s.appName, s.totalSeconds]))
      for (const [app, seconds] of [...perApp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
        missingApps.push({ app, perDaySeconds: seconds, rangeSeconds: rangeByApp.get(app) ?? 0 })
      }
    }
    rangeTotals[label] = { rangeSeconds, perDaySeconds, apps: summaries.length, missingApps }
  }
  const top7 = getCorrectedAppSummariesForRange(db, startOfDay(shiftDate(today, -6)), todayEnd, null)[0]
  const topDay = getAppSummariesForTimelineDay(db, '2026-10-05', null)[0]
  for (const app of [top7, topDay].filter(Boolean)) {
    const id = app.canonicalAppId ?? app.bundleId
    await measure(`app detail ${app.appName} 7d`, () => getAppDetailProjection(db, id, 7, null), Math.max(3, Math.floor(RUNS / 2)))
  }

  console.log('\nAI (context packet assembly before the first model call)')
  for (const question of ['What did I work on yesterday?', 'How much time did I spend on Daylens this week?']) {
    await measure(`context packet: "${question}"`, () => buildContextPacket(db, { purpose: 'answer', question, destination: 'bench:none' }), Math.max(3, Math.floor(RUNS / 2)))
  }

  console.log('\nQUALITY (last 30 days of Timeline as the IPC path renders it)')
  const labelRows: Array<{ date: string; blocks: number; neutral: number; generic: number; toolNamed: number }> = []
  const appNames = new Set((db.prepare('SELECT DISTINCT app_name AS n FROM app_sessions').all() as { n: string }[]).map((r) => r.n))
  let timelineSeconds30 = 0
  for (let i = 29; i >= 0; i--) {
    const date = shiftDate(today, -i)
    const payload = dayPayload(date) as unknown as { blocks: Array<{ label: { current: string } }>; totalSeconds?: number }
    const labels = payload.blocks.map((b) => b.label.current)
    const toolNamed = labels.filter((l) => [...appNames].some((n) => n.length > 2 && new RegExp(`(^|[\\s,])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s,]|$)`).test(l))).length
    labelRows.push({ date, blocks: labels.length, neutral: labels.filter((l) => NEUTRAL_LABELS.has(l)).length, generic: labels.filter((l) => GENERIC_LABELS.has(l)).length, toolNamed })
    timelineSeconds30 += payload.totalSeconds ?? 0
  }
  const totalBlocks = labelRows.reduce((s, r) => s + r.blocks, 0)
  const sum = (key: 'neutral' | 'generic' | 'toolNamed') => labelRows.reduce((s, r) => s + r[key], 0)
  const quality = {
    days: labelRows.length,
    daysWithBlocks: labelRows.filter((r) => r.blocks > 0).length,
    blocks: totalBlocks,
    neutralLabelRate: totalBlocks ? sum('neutral') / totalBlocks : 0,
    genericCategoryLabelRate: totalBlocks ? sum('generic') / totalBlocks : 0,
    toolNamedLabelRate: totalBlocks ? sum('toolNamed') / totalBlocks : 0,
    daysAllNeutral: labelRows.filter((r) => r.blocks > 0 && r.neutral === r.blocks).length,
  }
  console.log(`  blocks ${quality.blocks} over ${quality.daysWithBlocks} days · neutral ${(quality.neutralLabelRate * 100).toFixed(1)}% · generic-category ${(quality.genericCategoryLabelRate * 100).toFixed(1)}% · tool-named ${(quality.toolNamedLabelRate * 100).toFixed(1)}% · all-neutral days ${quality.daysAllNeutral}`)
  for (const [label, t] of Object.entries(rangeTotals)) {
    console.log(`  apps ${label}: range ${Math.round(t.rangeSeconds / 60)}m vs per-day Timeline sum ${t.perDaySeconds == null ? 'n/a' : Math.round(t.perDaySeconds / 60) + 'm'} (${t.apps} apps)`)
  }

  const topStatements = [...statementStats.entries()]
    .map(([sql, s]) => ({ sql, calls: s.calls, totalMs: round(s.totalMs), meanMs: round(s.totalMs / s.calls), rows: s.rows }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 15)
  console.log('\nTOP SQL BY TOTAL TIME (whole run)')
  for (const s of topStatements) console.log(`  ${String(s.totalMs).padStart(9)} ms  ${String(s.calls).padStart(6)} calls  ${s.sql.slice(0, 110)}`)

  const memory = process.memoryUsage()
  const result = {
    takenAt: new Date().toISOString(),
    today,
    runs: RUNS,
    dbPath: ctx.dbPath,
    dbBytes: fs.statSync(ctx.dbPath).size,
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    timings,
    rangeTotals,
    timelineSeconds30,
    quality,
    labelRows,
    topStatements,
    memory: { rssMb: round(memory.rss / 1e6), heapUsedMb: round(memory.heapUsed / 1e6) },
  }
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2))
  console.log(`\nRSS ${result.memory.rssMb} MB · heap ${result.memory.heapUsedMb} MB`)
}

main().then(() => process.exit(0), (error) => {
  console.error(error)
  process.exit(1)
})
