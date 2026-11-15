// What Ask carries of the conversation before a question, bounded the same way in the interface, over IPC and in the
// reader. No Node or database code, so the interface can use it.

/** Where the record stood when an answer was read: the change log's last entry and the last deletion begun. */
export interface Stamp {
  changes: number
  deletions: number
}

/** A question and answer before this one: never evidence, only what the question may refer to. */
export interface Earlier {
  question: string
  // Null when there is no answer to carry: Ask only searched, or a correction since outdated it.
  answer: string | null
  // When it was asked, so "today" in it keeps meaning that day.
  asked_at: number
  stamp: Stamp
}

// The most of the conversation a question carries: its latest exchanges, each cut to a length.
export const EARLIER_LIMIT = { exchanges: 3, chars: 600 }

export function bounded(earlier: readonly Earlier[]): Earlier[] {
  const cut = (t: string) => t.slice(0, EARLIER_LIMIT.chars)
  return earlier.slice(-EARLIER_LIMIT.exchanges).map((e) => ({ question: cut(e.question), answer: e.answer === null ? null : cut(e.answer), asked_at: e.asked_at, stamp: e.stamp }))
}
