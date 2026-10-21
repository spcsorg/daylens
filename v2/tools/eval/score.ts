// Turning per-hour results into per-model numbers, ranked correctness first, then cost, then speed.
import type { CallResult, Usage } from '../../engine/backends.ts'
import type { Validation } from '../../engine/validate.ts'
import { GRADES, type Grade, type Verdict } from './grade.ts'

export interface Rate {
  // US dollars per million tokens.
  input: number
  output: number
}

/** List price for one call, no caching discount or premium: every input token at the input rate. */
export function listPrice(u: Usage, rate: Rate): number {
  return (u.input * rate.input + u.output * rate.output) / 1e6
}

export interface HourResult {
  hour: string
  call: Pick<CallResult, 'error' | 'quota' | 'latency_ms' | 'usage' | 'reported_cost_usd' | 'model' | 'tool_calls'>
  attempts: number
  validation: Pick<Validation, 'ok' | 'errors' | 'warnings'> | null
  verdict: Verdict | null
  // A hand check that disagrees replaces the grader's grade.
  hand: { grade: Grade; note: string } | null
}

export interface ModelScore {
  model: string
  hours: number
  grades: Record<Grade, number>
  failed_calls: number
  rejected: number
  unsupported_claims: number
  invented_ids: number
  wrong_attribution: number
  must_missed: number
  should_missed: number
  tool_calls: number
  cost_usd: number | null
  cost_per_call_usd: number | null
  reported_cost_usd: number | null
  latency_mean_ms: number | null
  latency_max_ms: number | null
}

export function finalGrade(r: HourResult): Grade | null {
  return r.hand?.grade ?? r.verdict?.grade ?? null
}

export function scoreModel(model: string, results: HourResult[], rate: Rate | null): ModelScore {
  const grades = Object.fromEntries(GRADES.map((g) => [g, 0])) as Record<Grade, number>
  let unsupported = 0, invented = 0, attribution = 0, mustMissed = 0, shouldMissed = 0, rejected = 0, failed = 0, tools = 0
  let cost = 0, reported = 0, priced = 0, reportedN = 0
  const lat: number[] = []
  for (const r of results) {
    const g = finalGrade(r)
    if (g) grades[g]++
    if (r.call.error) failed++
    if (r.validation && !r.validation.ok) rejected++
    invented += r.validation?.errors.filter((e) => e.code === 'invented_id').length ?? 0
    if (r.verdict) {
      unsupported += r.verdict.unsupported_claims.length + r.verdict.only_you_stated.length
      attribution += r.verdict.wrong_attribution.length
      mustMissed += r.verdict.must_missed.length
      shouldMissed += r.verdict.should_missed.length
    }
    tools += r.call.tool_calls.length
    if (!r.call.error) lat.push(r.call.latency_ms)
    if (r.call.usage && rate) {
      cost += listPrice(r.call.usage, rate)
      priced++
    }
    if (r.call.reported_cost_usd !== null) {
      reported += r.call.reported_cost_usd
      reportedN++
    }
  }
  const noCost = rate === null && results.every((r) => r.call.usage === null && r.call.reported_cost_usd === 0)
  return {
    model,
    hours: results.length,
    grades,
    failed_calls: failed,
    rejected,
    unsupported_claims: unsupported,
    invented_ids: invented,
    wrong_attribution: attribution,
    must_missed: mustMissed,
    should_missed: shouldMissed,
    tool_calls: tools,
    cost_usd: noCost ? 0 : priced ? cost : null,
    cost_per_call_usd: noCost ? 0 : priced ? cost / priced : null,
    reported_cost_usd: reportedN ? reported : null,
    latency_mean_ms: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
    latency_max_ms: lat.length ? Math.max(...lat) : null,
  }
}

// An only-you hour graded only_you is correct: the writer left unknown what only the person could know.
const correct = (s: ModelScore) => s.grades.right + s.grades.only_you
const claims = (s: ModelScore) => s.unsupported_claims + s.invented_ids + s.wrong_attribution

/**
 * Correctness first: correct hours minus wrong hours, then fewer wrong hours, then fewer unsupported claims (invented
 * IDs and wrong attribution included). Then cost per call, then mean latency. A failed call is already graded wrong.
 */
export function rank(scores: ModelScore[]): ModelScore[] {
  return [...scores].sort(
    (a, b) =>
      correct(b) - b.grades.wrong - (correct(a) - a.grades.wrong) ||
      a.grades.wrong - b.grades.wrong ||
      claims(a) - claims(b) ||
      (a.cost_per_call_usd ?? Infinity) - (b.cost_per_call_usd ?? Infinity) ||
      (a.latency_mean_ms ?? Infinity) - (b.latency_mean_ms ?? Infinity),
  )
}

export interface Standings {
  // What the facts alone score; candidates are measured against it and it is never ranked among them.
  baseline: ModelScore | null
  ranked: (ModelScore & { vs_baseline: { correct: number; wrong: number } | null })[]
}

export function standings(scores: ModelScore[], baseline: string): Standings {
  const base = scores.find((s) => s.model === baseline) ?? null
  return {
    baseline: base,
    ranked: rank(scores.filter((s) => s.model !== baseline)).map((s) => ({
      ...s,
      vs_baseline: base ? { correct: correct(s) - correct(base), wrong: s.grades.wrong - base.grades.wrong } : null,
    })),
  }
}

/** Hours where two graders gave different grades for the same written hour. */
export function disagreements(a: Record<string, Verdict | null>, b: Record<string, Verdict | null>): { hour: string; a: Grade | null; b: Grade | null }[] {
  const out: { hour: string; a: Grade | null; b: Grade | null }[] = []
  for (const hour of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const ga = a[hour]?.grade ?? null
    const gb = b[hour]?.grade ?? null
    if (ga !== gb) out.push({ hour, a: ga, b: gb })
  }
  return out
}

/** Which hours to check by hand: every wrong one, and a fixed quarter (rounded up) of the right ones. */
export function handCheckSample(model: string, verdicts: Record<string, Verdict | null>, hash: (s: string) => string): string[] {
  const hours = Object.keys(verdicts).sort()
  const wrong = hours.filter((h) => verdicts[h]?.grade === 'wrong')
  const right = hours.filter((h) => verdicts[h]?.grade === 'right').sort((x, y) => hash(`${model}:${x}`).localeCompare(hash(`${model}:${y}`)))
  return [...wrong, ...right.slice(0, Math.ceil(right.length / 4))].sort()
}
