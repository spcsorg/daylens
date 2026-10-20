// Time Daylens must not keep agent records for: pauses, deleted ranges and anything older than retention.
export type Span = readonly [from: number, to: number]

export function admitsAt(spans: readonly Span[], at: number | null): boolean {
  if (at === null) return true
  return !spans.some(([from, to]) => at >= from && at < to)
}

/** Whether nothing withheld lies between two moments, so a turn may stretch from one to the other. */
export function admitsSpan(spans: readonly Span[], a: number, b: number): boolean {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  return !spans.some(([from, to]) => from < hi && to > lo)
}

/** The first withheld moment after `at`, where a turn that began at `at` has to stop. */
export function nextWithheld(spans: readonly Span[], at: number): number | null {
  let next: number | null = null
  for (const [from, to] of spans) if (to > at && from > at && (next === null || from < next)) next = from
  return next
}
