// Ask's thread, as data: what a question carries of the conversation before it, and what a correction leaves of it.
import type { AskResult, Statement } from '../../../../shared/ai.ts'
import { bounded, EARLIER_LIMIT, type Earlier } from '../../../../shared/conversation.ts'

export interface Turn {
  id: number
  question: string
  asked_at: number
  // The conversation it was asked after, kept so asking it again asks it the same way.
  earlier: Earlier[]
  streamed: Statement[]
  result: AskResult | null
  error: string | null
  stale: boolean
  // Since a correction: the exchange as it was answered, carried on without its answer.
  outdated: Earlier | null
}

/** The exchange a turn adds to the conversation: one the person saw answered, or searched for with no AI. */
function exchange(t: Turn): Earlier | null {
  if (t.outdated) return t.outdated
  const r = t.result
  if (t.stale || !r || (r.kind !== 'answer' && r.kind !== 'search_only')) return null
  let answer: string | null = null
  if (r.kind === 'answer') {
    answer = ''
    for (const s of r.statements) {
      if (answer.length >= EARLIER_LIMIT.chars) break
      answer = (answer + (answer ? ' ' : '') + s.text.slice(0, EARLIER_LIMIT.chars)).slice(0, EARLIER_LIMIT.chars)
    }
  }
  return { question: t.question.slice(0, EARLIER_LIMIT.chars), answer, asked_at: t.asked_at, stamp: r.stamp }
}

/** The latest exchanges a new question is asked after. */
export function earlierOf(turns: readonly Turn[]): Earlier[] {
  const earlier: Earlier[] = []
  for (let i = turns.length - 1; i >= 0 && earlier.length < EARLIER_LIMIT.exchanges; i--) {
    const e = exchange(turns[i]!)
    if (e) earlier.unshift(e)
  }
  return earlier
}

/** After a correction every answer may be wrong, so none is shown or carried; the questions stay. */
export function corrected(turns: readonly Turn[]): Turn[] {
  return turns.map((t) => {
    const e = exchange(t)
    return { ...t, outdated: e && { ...e, answer: null }, earlier: t.earlier.map((x) => ({ ...x, answer: null })), result: null, streamed: [], error: null, stale: true }
  })
}

export function questionOf(t: Pick<Turn, 'question' | 'asked_at' | 'earlier'>) {
  return { question: t.question, asked_at: t.asked_at, earlier: bounded(t.earlier) }
}
