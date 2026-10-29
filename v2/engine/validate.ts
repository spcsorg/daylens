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
  | 'share_overstated'

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
const FINISHED = /\b(finish(ed|es)?|complet(ed|es)|shipp(ed|ing)|ships|publish(ed|es)|releas(ed|es)|merg(ed|es)|deploy(ed|s)|submitt(ed|s)|launch(ed|es)|deliver(ed|s)|fix(ed|es)|resolv(ed|es)|wrapped up)\b/gi
// A completion word after one of these in its clause is denied or in doubt ("not whether you published it"): it claims nothing.
const UNPROVEN = /\b(not|no|never|nothing|whether|unclear|unknown|cannot)\b|n['’]t\b/i
// Where a denial stops reaching: "You finished the export, but not the cleanup" still claims the export.
const CLAUSE = /[,;:()–—]|\b(?:but|yet|though|although|whereas|while)\b|\b(?:and|or)(?=\s+(?:then\s+)?you\b)/i
const QUOTES = [['"', '"'], ['“', '”'], ["'", "'"], ['‘', '’'], ['«', '»']] as const
// Finishing a stretch of time ("you finished the hour on the email") is not finishing any work.
const SPAN_OF_TIME = /^\s+(?:the|your|this)\s+(?:hour|day|morning|afternoon|evening|week)\b/i
function claimsFinished(sentence: string): boolean {
  return sentence.split(CLAUSE).some((clause) => [...clause.matchAll(FINISHED)].some((m) => !UNPROVEN.test(clause.slice(0, m.index)) && !SPAN_OF_TIME.test(clause.slice(m.index + m[0].length))))
}
const ID_TOKEN = /\b[a-z]\d{1,4}\b/g
// A clock time as the writer gives it, "9:20 AM" or "2 PM", or as the packet gives it, "14:05".
const CLOCK = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])\.?m\b\.?|\b([01]?\d|2[0-3]):([0-5]\d)\b/gi
// A claim about how much of the hour something took.
const SHARE = /\b(?:most|much|the bulk) of the (?:hour|time)\b|\b(the rest of the hour)\b/i

export function validateHour(raw: string, packet: Packet, refs: Record<string, Ref>): Validation {
  // Only the packet's own IDs: "constructor" or "__proto__" would otherwise be found on every object.
  const refOf = (id: string): Ref | undefined => (Object.hasOwn(refs, id) ? refs[id] : undefined)
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
    const ref = refOf(id)
    if (ref) v.cited.push(ref)
    else err('invented_id', id)
  }
  const evidence = packet.windows.length + packet.pages.length + packet.agents.length + packet.commits.length > 0
  if (evidence && sources.length === 0) err('no_sources', 'the packet has evidence but nothing is cited')

  for (const f of TEXT_FIELDS) {
    for (const m of (h[f] ?? '').matchAll(ID_TOKEN)) if (refOf(m[0])) err('ids_in_text', `${f}: ${m[0]}`)
  }

  const known = new Set([...packet.windows, ...packet.pages].map((i) => i.app).filter((a): a is string => !!a).concat(packet.agents.map((a) => a.agent)))
  for (const a of h.apps) if (!known.has(a)) err('unknown_app', a)

  // Only evidence of the action itself proves something was finished: a commit. A page or window shows what was open.
  const proven = sources.some((id) => refOf(id)?.kind === 'commit')
  if (h.outcome !== null && !proven) err('outcome_without_proof', h.outcome)
  if (!proven) {
    // Quoting what the packet names, in quotation marks ("“Fixed the login bug” was open"), claims nothing was done.
    const named = [...packet.windows, ...packet.pages].map((i) => i.title).concat(packet.commits.map((c) => c.subject), packet.scheduled_events.map((e) => e.title))
    const quoted = [...new Set(named.filter((t): t is string => !!t && t.trim().length >= 3).map((t) => t.toLowerCase()))].sort((a, b) => b.length - a.length)
    const unquoted = (text: string) => quoted.reduce((x, t) => QUOTES.reduce((y, [o, c]) => y.split(o + t + c).join(' '), x), text.toLowerCase())
    for (const f of ['title', 'summary', 'detail'] as const) {
      for (const sentence of unquoted(h[f]).split(/(?<=[.!?;])\s+|\n+/)) {
        if (claimsFinished(sentence)) err('finished_without_proof', `${f}: ${sentence}`)
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
  // A span that ends at midnight ends at minute 1440, not 0.
  const span = (a: { from: string; to: string }) => {
    const s = toMinute(/(\d+):(\d+)/.exec(a.from)!)
    const e = toMinute(/(\d+):(\d+)/.exec(a.to)!)
    return [s, e < s ? e + 24 * 60 : e] as const
  }
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

  // "Most of the hour" holds only when what the sentence names was in front for more than half of it; "the rest of the
  // hour" from a time, for more than half of what was left.
  const items = [...packet.windows, ...packet.pages]
  for (const f of TEXT_FIELDS) {
    for (const sentence of (h[f] ?? '').split(/(?<=[.!?;])\s+|\n+/)) {
      const share = SHARE.exec(sentence)
      if (!share) continue
      const named = items.filter((i) => [i.title, i.app].some((n) => n && n.trim().length >= 3 && mentions(sentence, n.trim().toLowerCase())))
      const agents = packet.agents.filter((a) => [a.agent, a.project].some((n) => n && n.trim().length >= 3 && mentions(sentence, n.trim().toLowerCase())))
      if (named.length + agents.length === 0) continue
      const minutes = named.reduce((n, i) => n + i.min, 0) + agents.reduce((n, a) => n + a.with_you_min, 0)
      const since = share[1] ? [...sentence.matchAll(CLOCK)].map((m) => toMinute(m)).find((t) => t >= from! && t < end) : undefined
      if (minutes * 2 <= (since === undefined ? 60 : end - since)) err('share_overstated', `${f}: ${sentence}`)
    }
  }

  v.hour = h
  v.ok = v.errors.length === 0
  return v
}

/** Minutes after midnight of a CLOCK match: 12-hour with AM or PM, else 24-hour. */
function toMinute(m: RegExpMatchArray | RegExpExecArray): number {
  if (m[3]) return ((Number(m[1]) % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0)) * 60 + Number(m[2] ?? 0)
  return Number(m[4] ?? m[1]) * 60 + Number(m[5] ?? m[2])
}
