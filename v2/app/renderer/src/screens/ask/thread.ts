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
}

/** The latest exchanges a new question is asked after: those the person saw answered, or searched for with no AI. */
export function earlierOf(turns: readonly Turn[]): Earlier[] {
  const earlier: Earlier[] = []
  for (let i = turns.length - 1; i >= 0 && earlier.length < EARLIER_LIMIT.exchanges; i--) {
    const t = turns[i]!
    const r = t.result
    if (t.stale || !r || (r.kind !== 'answer' && r.kind !== 'search_only')) continue
    let answer: string | null = null
    if (r.kind === 'answer') {
      answer = ''
      for (const s of r.statements) {
        if (answer.length >= EARLIER_LIMIT.chars) break
        answer = (answer + (answer ? ' ' : '') + s.text.slice(0, EARLIER_LIMIT.chars)).slice(0, EARLIER_LIMIT.chars)
      }
    }
    earlier.unshift({ question: t.question.slice(0, EARLIER_LIMIT.chars), answer, asked_at: t.asked_at, stamp: r.stamp })
  }
  return earlier
}

/** After a correction every answer may be wrong, so none is shown or carried; the questions stay. */
export function corrected(turns: readonly Turn[]): Turn[] {
  return turns.map((t) => ({ ...t, earlier: t.earlier.map((e) => ({ ...e, answer: null })), result: null, streamed: [], error: null, stale: true }))
}

export function questionOf(t: Pick<Turn, 'question' | 'asked_at' | 'earlier'>) {
  return { question: t.question, asked_at: t.asked_at, earlier: bounded(t.earlier) }
}
