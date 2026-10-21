// Grading a written hour against a frozen answer-key checklist, by a fixed grading model.
import type { Packet } from '../../engine/packet.ts'
import type { WrittenHour } from '../../engine/validate.ts'

export type Grade = 'right' | 'partly' | 'wrong' | 'only_you'
export const GRADES: readonly Grade[] = ['right', 'partly', 'wrong', 'only_you']

export interface HourChecklist {
  must: string[]
  should: string[]
  must_not: string[]
  only_you: string[]
  only_user?: boolean
}

export interface Checklists {
  key: string
  rules: Record<string, string>
  hours: Record<string, HourChecklist>
}

export interface Verdict {
  grade: Grade
  reason: string
  must_missed: string[]
  should_missed: string[]
  must_not_said: string[]
  unsupported_claims: string[]
  wrong_attribution: string[]
  only_you_stated: string[]
}

export const GRADER_PROMPT = `You grade one hour that an AI wrote for a person's day, against that person's own account of the hour. Be strict and literal, and judge meaning, not wording.

The input has:
- rules: how to grade.
- checklist: for this hour. must: what a right hour conveys. should: left out, each counts as missed work. must_not: saying any of these makes the hour wrong. only_you: things only the person could know. only_user true means the hour's main point is something only the person could know.
- key: the person's own account of the hour, written after the day. Use it to judge whether the written hour names the right work. It includes things the computer could not record.
- packet: what the computer recorded, which is all the writer saw. A claim is supported only if the packet shows it.
- written: the hour the AI wrote. Ignore its sources list and any IDs.

How to grade:
- grade is right, partly or wrong, following the rules. When only_user is true, grade is only_you if nothing is invented about what only the person could know and no must_not item is said; otherwise wrong.
- An unsupported claim is a statement of fact in the written hour that the packet does not show: a page's content stated as something the person did, something called finished without proof, what an agent worked on stated as fact, attendance at a scheduled event, a reason or a person the packet cannot show. A statement clearly hedged as likely or possible is not a claim of fact, unless the checklist forbids it even hedged.
- wrong_attribution: work done while the person was away, including an agent's work or commit while they were away, credited to the person.
- only_you_stated: checklist only_you items the written hour states as fact. Do not repeat them in unsupported_claims.
- must_missed, should_missed, must_not_said and only_you_stated use the checklist's own wording. unsupported_claims and wrong_attribution quote the written hour briefly, then say why in a few words.

Return only this JSON object and nothing else:
{"grade": "right|partly|wrong|only_you", "reason": "one line", "must_missed": [], "should_missed": [], "must_not_said": [], "unsupported_claims": [], "wrong_attribution": [], "only_you_stated": []}`

export function graderMessage(rules: Record<string, string>, checklist: HourChecklist, key: string, packet: Packet, written: WrittenHour): string {
  const { sources: _sources, ...shown } = written
  return `${GRADER_PROMPT}\n\nInput:\n${JSON.stringify({ rules, checklist, key, packet, written: shown })}`
}

const LISTS = ['must_missed', 'should_missed', 'must_not_said', 'unsupported_claims', 'wrong_attribution', 'only_you_stated'] as const

export function parseVerdict(raw: string, onlyUser: boolean): { verdict: Verdict | null; error: string | null } {
  const text = raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1')
  let o: Record<string, unknown>
  try {
    o = JSON.parse(text) as Record<string, unknown>
  } catch (e) {
    return { verdict: null, error: `not JSON: ${(e as Error).message}` }
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return { verdict: null, error: 'not an object' }
  const allowed: readonly Grade[] = onlyUser ? ['only_you', 'wrong'] : ['right', 'partly', 'wrong']
  if (!allowed.includes(o.grade as Grade)) return { verdict: null, error: `grade ${String(o.grade)} is not one of ${allowed.join(', ')}` }
  if (typeof o.reason !== 'string' || !o.reason.trim()) return { verdict: null, error: 'no reason' }
  for (const k of LISTS) if (!Array.isArray(o[k]) || (o[k] as unknown[]).some((x) => typeof x !== 'string')) return { verdict: null, error: `${k} must be a list of text` }
  return { verdict: o as unknown as Verdict, error: null }
}

// The rules make some findings decide the grade; a verdict that contradicts them is flagged for a hand check.
export function inconsistencies(v: Verdict): string[] {
  const out: string[] = []
  if (v.grade !== 'wrong' && v.must_not_said.length) out.push('a must_not item is said, but the grade is not wrong')
  if (v.grade !== 'wrong' && v.wrong_attribution.length) out.push('work while away is credited, but the grade is not wrong')
  if (v.grade === 'right' && v.must_missed.length) out.push('a must item is missing, but the grade is right')
  return out
}

/** The answer key's own account of each hour, keyed "00".."23", from its "### 8 AM · …" sections. */
export function keySections(markdown: string): Record<string, string> {
  const out: Record<string, string> = {}
  const parts = markdown.split(/^(?=#{2,3} )/m)
  for (const p of parts) {
    const m = /^### (\d{1,2}) (AM|PM)\b/.exec(p)
    if (!m) continue
    let h = Number(m[1]) % 12
    if (m[2] === 'PM') h += 12
    out[String(h).padStart(2, '0')] = p.trim()
  }
  return out
}
