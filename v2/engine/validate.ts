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
const ID_TOKEN = /\b[a-z]\d{1,4}\b/g
const CLOCK = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g
const MADE = /\b(commit|commits|committed|pushed|shipped|merged|landed|fixed)\b/i
const AGENT_WORDS = /\b(codex|claude|agent|agents)\b/i
const AWAY_WORDS = /\b(away|locked|lock|idle|asleep|sleep|stepped)\b/i

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

  if (h.outcome !== null && !sources.some((id) => refs[id]?.kind === 'commit' || (refs[id]?.kind === 'observations' && packet.pages.some((p) => p.id === id)))) {
    err('outcome_without_proof', h.outcome)
  }

  // Times the packet itself states (a calendar entry that started earlier, say) are evidence, not invention.
  const packetTimes = new Set([...JSON.stringify(packet).matchAll(CLOCK)].map((m) => toMinute(m)))
  const [from, to] = packet.hour.slice(11).split('-').map((t) => toMinute(/(\d+):(\d+)/.exec(t)!))
  const end = to! === 0 ? 24 * 60 : to!
  for (const f of TEXT_FIELDS) {
    for (const m of (h[f] ?? '').matchAll(CLOCK)) {
      const t = toMinute(m)
      if ((t < from! || t > end) && !packetTimes.has(t)) err('time_outside_hour', `${f}: ${m[0]}`)
    }
  }

  const awayCommits = packet.commits.filter((c) => c.while_away)
  const presentCommits = packet.commits.length - awayCommits.length
  const awaySpans = packet.away.map((a) => [toMinute(/(\d+):(\d+)/.exec(a.from)!), toMinute(/(\d+):(\d+)/.exec(a.to)!)] as const)
  for (const f of TEXT_FIELDS) {
    for (const sentence of (h[f] ?? '').split(/(?<=[.!?;])\s+/)) {
      if (!/\byou\b/i.test(sentence) || AWAY_WORDS.test(sentence)) continue
      const times = [...sentence.matchAll(CLOCK)].map((m) => toMinute(m))
      const namesAwayCommit = awayCommits.some((c) => times.includes(toMinute(/(\d+):(\d+)/.exec(c.at)!)) || sentence.toLowerCase().includes(c.subject.toLowerCase().slice(0, 24)))
      const creditsCommit = MADE.test(sentence) && !AGENT_WORDS.test(sentence) && (namesAwayCommit || (awayCommits.length > 0 && presentCommits === 0))
      const insideAway = times.some((t) => awaySpans.some(([s, e]) => t > s && t < e))
      if (creditsCommit || insideAway) err('away_work_credited', `${f}: ${sentence}`)
    }
  }

  v.hour = h
  v.ok = v.errors.length === 0
  return v
}

function toMinute(m: RegExpMatchArray | RegExpExecArray): number {
  return Number(m[1]) * 60 + Number(m[2])
}
