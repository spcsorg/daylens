// Every written hour is checked in code before it is stored. Anything invalid is rejected and the hour stays as facts.
import type { Packet, Ref } from './packet.ts'

export interface WrittenHour {
  title: string
  summary: string
  apps: string[]
  detail: string
  outcome: string | null
  sources: string[]
  suggestion: string | null
}

export type ValidationCode =
  | 'not_json'
  | 'fenced'
  | 'wrong_keys'
  | 'wrong_type'
  | 'invented_id'
  | 'no_sources'
  | 'ids_in_text'
  | 'unknown_app'
  | 'outcome_without_proof'
  | 'finished_without_proof'
  | 'time_outside_hour'
  | 'away_work_credited'

export interface Validation {
  ok: boolean
  errors: { code: ValidationCode; detail: string }[]
  // `fenced` is only a warning: the JSON inside the fence is still checked.
  warnings: { code: ValidationCode; detail: string }[]
  hour: WrittenHour | null
  cited: Ref[]
}

const KEYS = ['title', 'summary', 'apps', 'detail', 'outcome', 'sources', 'suggestion'] as const
const TEXT_FIELDS = ['title', 'summary', 'detail', 'outcome', 'suggestion'] as const
const FINISHED = /\b(finish(ed|es)?|complet(ed|es)|shipp(ed|ing)|ships|publish(ed|es)|releas(ed|es)|merg(ed|es)|deploy(ed|s)|submitt(ed|s)|launch(ed|es)|deliver(ed|s)|fix(ed|es)|resolv(ed|es)|wrapped up)\b/i
// A sentence that says the record cannot show completion ("not whether you published it") claims none.
const UNPROVEN = /\b(not|no|never|nothing|whether|unclear|unknown|cannot)\b|n't\b/i
const ID_TOKEN = /\b[a-z]\d{1,4}\b/g
const CLOCK = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g

export function validateHour(raw: string, packet: Packet, refs: Record<string, Ref>): Validation {
  const v: Validation = { ok: false, errors: [], warnings: [], hour: null, cited: [] }
  const err = (code: ValidationCode, detail: string) => v.errors.push({ code, detail })
  let text = raw.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text)
  if (fence) {
    v.warnings.push({ code: 'fenced', detail: 'wrapped in a code fence' })
    text = fence[1]!
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    err('not_json', (e as Error).message)
    return v
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    err('not_json', 'not an object')
    return v
  }
  const o = parsed as Record<string, unknown>
  const keys = Object.keys(o).sort()
  if (keys.join() !== [...KEYS].sort().join()) err('wrong_keys', keys.join(','))
  for (const k of ['title', 'summary', 'detail'] as const) if (typeof o[k] !== 'string' || !(o[k] as string).trim()) err('wrong_type', `${k} must be text`)
  for (const k of ['outcome', 'suggestion'] as const) if (o[k] !== null && typeof o[k] !== 'string') err('wrong_type', `${k} must be text or null`)
  for (const k of ['apps', 'sources'] as const) if (!Array.isArray(o[k]) || (o[k] as unknown[]).some((x) => typeof x !== 'string')) err('wrong_type', `${k} must be a list of text`)
  if (v.errors.length) return v
  const h = o as unknown as WrittenHour
  // Writers sometimes spell "none" as an empty string or the word null.
  for (const k of ['outcome', 'suggestion'] as const) if (h[k] !== null && /^\s*(null)?\s*$/i.test(h[k]!)) h[k] = null

  const sources = [...new Set(h.sources)]
  for (const id of sources) {
    const ref = refs[id]
    if (ref) v.cited.push(ref)
    else err('invented_id', id)
  }
  const evidence = packet.windows.length + packet.pages.length + packet.agents.length + packet.commits.length > 0
  if (evidence && sources.length === 0) err('no_sources', 'the packet has evidence but nothing is cited')

  for (const f of TEXT_FIELDS) {
    for (const m of (h[f] ?? '').matchAll(ID_TOKEN)) if (refs[m[0]]) err('ids_in_text', `${f}: ${m[0]}`)
  }

  const known = new Set([...packet.windows, ...packet.pages].map((i) => i.app).filter((a): a is string => !!a).concat(packet.agents.map((a) => a.agent)))
  for (const a of h.apps) if (!known.has(a)) err('unknown_app', a)

  // Only evidence of the action itself proves something was finished: a commit. A page or window shows what was open.
  const proven = sources.some((id) => refs[id]?.kind === 'commit')
  if (h.outcome !== null && !proven) err('outcome_without_proof', h.outcome)
  if (!proven) {
    for (const f of ['title', 'summary'] as const) {
      for (const sentence of h[f].split(/(?<=[.!?;])\s+|\n+/)) {
        if (FINISHED.test(sentence) && !UNPROVEN.test(sentence)) err('finished_without_proof', `${f}: ${sentence}`)
      }
    }
  }

  // Times this hour's own facts state (a calendar entry that started earlier, the time a title last changed) are
  // evidence, not invention. Captured text (titles, addresses) and earlier hours' text (previous_hour, corrections) are not.
  const stated = [
    ...packet.away.flatMap((a) => [a.from, a.to]),
    ...packet.unknown.flatMap((g) => [g.from, g.to]),
    ...[...packet.windows, ...packet.pages].flatMap((i) => [i.from, i.to, i.stale ?? '']),
    ...packet.agents.flatMap((a) => a.messages.map((m) => m.slice(0, 5))),
    ...packet.commits.map((c) => c.at),
    ...packet.scheduled_events.flatMap((e) => [e.from, e.to]),
  ]
  const packetTimes = new Set(stated.flatMap((x) => [...x.matchAll(CLOCK)].map((m) => toMinute(m))))
  const [from, to] = packet.hour.slice(11).split('-').map((t) => toMinute(/(\d+):(\d+)/.exec(t)!))
  const end = to! === 0 ? 24 * 60 : to!
  for (const f of TEXT_FIELDS) {
    for (const m of (h[f] ?? '').matchAll(CLOCK)) {
      const t = toMinute(m)
      if ((t < from! || t > end) && !packetTimes.has(t)) err('time_outside_hour', `${f}: ${m[0]}`)
    }
  }

  // What the packet marks as done while the person was away: any time inside an away span, a commit made then, and an
  // agent, project or window that only worked or stayed in front then. A sentence that speaks to the person ("you")
  // may not name any of it, whatever else it says.
  const span = (a: { from: string; to: string }) => [toMinute(/(\d+):(\d+)/.exec(a.from)!), toMinute(/(\d+):(\d+)/.exec(a.to)!)] as const
  const awaySpans = packet.away.map(span)
  const awayCommits = packet.commits.filter((c) => c.while_away)
  const onlyAway = <T>(items: T[], name: (t: T) => string | null | undefined, away: (t: T) => boolean) => {
    const byName = new Map<string, boolean>()
    for (const t of items) {
      const n = name(t)?.trim().toLowerCase()
      if (n && n.length >= 3) byName.set(n, (byName.get(n) ?? true) && away(t))
    }
    return [...byName].filter(([, all]) => all).map(([n]) => n)
  }
  const agentAway = (a: Packet['agents'][number]) => a.with_you_min === 0 && a.while_away_min > 0
  const itemAway = (i: Packet['windows'][number]) => i.min === 0 && (i.away_min ?? 0) > 0
  const awayNames = [
    ...onlyAway(packet.agents, (a) => a.agent, agentAway),
    ...onlyAway(packet.agents, (a) => a.project, agentAway),
    ...onlyAway([...packet.windows, ...packet.pages], (i) => i.title, itemAway),
  ]
  const awaySubjects = awayCommits.map((c) => c.subject.toLowerCase().slice(0, 24))
  const mentions = (sentence: string, name: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(sentence)
  for (const f of TEXT_FIELDS) {
    for (const sentence of (h[f] ?? '').split(/(?<=[.!?;])\s+|\n+/)) {
      if (!/\byou\b/i.test(sentence)) continue
      const times = [...sentence.matchAll(CLOCK)].map((m) => toMinute(m))
      const insideAway = times.some((t) => awaySpans.some(([s, e]) => t > s && t < e))
      const awayCommit = awayCommits.some((c) => times.includes(toMinute(/(\d+):(\d+)/.exec(c.at)!))) || awaySubjects.some((x) => sentence.toLowerCase().includes(x))
      const named = awayNames.find((n) => mentions(sentence, n))
      if (insideAway || awayCommit || named) err('away_work_credited', `${f}: ${sentence}`)
    }
  }

  v.hour = h
  v.ok = v.errors.length === 0
  return v
}

function toMinute(m: RegExpMatchArray | RegExpExecArray): number {
  return Number(m[1]) * 60 + Number(m[2])
}
