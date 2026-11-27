// Ask, in the reader: the record is read here, the question goes to the AI on the person's key, and each checked
// statement is posted to the asking screen as it streams. What was sent is logged on a connection of its own, since
// the reader's is read-only.
import type { MessagePortMain } from 'electron'
import { anthropicApi, ASK_EFFORT, ASK_MODEL } from '../../retrieval/anthropicApi.ts'
import { ask, AskError, type AskResult } from '../../retrieval/ask.ts'
import { AssistantStore } from '../../retrieval/assistantStore.ts'
import type { Reader } from '../../retrieval/reader.ts'
import type { AskQuery } from '../shared/ai.ts'
import { bounded, type Earlier } from '../shared/conversation.ts'

// hours-gold's measured limits for the invented record.
const LIMITS = { maxHours: 12, maxSources: 40, perGroup: 8 }
const TIMEOUT_MS = 60_000

let key: string | null = null
let log: AssistantStore | null = null
// The same question after the same conversation, asked again before anything new is recorded or deleted, gets the answer it got before.
const answered = new Map<string, { state: string; result: AskResult }>()

export function setKey(k: string | null): void {
  key = k
  answered.clear()
}

/** Which question an answer is to: the same words after the same conversation, on the same day. */
export function askedAs(question: string, earlier: readonly Earlier[], nowMs: number): string {
  // "Today" means another day after midnight, though nothing new was recorded.
  return JSON.stringify([new Date(nowMs).toDateString(), question.trim().toLowerCase(), bounded(earlier)])
}

export async function answer(file: string, finder: Reader, port: MessagePortMain, id: number, q: AskQuery): Promise<void> {
  try {
    log ??= AssistantStore.open(file)
    const store = log
    const usage = store.db.prepare(
      'INSERT INTO usage_ledger (at_wall_ms, kind, provider, model, input_tokens, output_tokens, cost_micro_usd, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    // Heartbeats extend an observation in place, so the newest sighting of any of them counts as a change too.
    const state = String(store.db.prepare(`SELECT (SELECT coalesce(max(id), 0) || ':' || coalesce(max(last_seen_wall_ms), 0) FROM observations) || '/' || (SELECT coalesce(max(seq), 0) FROM change_log) || '/' || (SELECT coalesce(max(id), 0) FROM deletions)`).pluck().get())
    const asked = askedAs(q.question, q.earlier, q.asked_at)
    const before = answered.get(asked)
    if (before?.state === state) return void port.postMessage({ id, ok: true, result: before.result })
    const result = await ask(
      q.question,
      {
        reader: finder,
        now: () => q.asked_at,
        model: key ? anthropicApi(ASK_MODEL, { apiKey: key, timeoutMs: TIMEOUT_MS, effort: ASK_EFFORT }) : null,
        log: {
          recordRead: (r, mark) => store.recordRead(r, mark),
          recordUsage: (u) => Number(usage.run(Date.now(), u.kind, u.provider, u.model, u.input_tokens, u.output_tokens, u.cost_micro_usd, u.ref ?? null).lastInsertRowid),
        },
        onStatement: (statement) => port.postMessage({ e: 'ask', ask_id: q.ask_id, statement }),
        onReading: () => port.postMessage({ e: 'ask_reading', ask_id: q.ask_id }),
      },
      LIMITS,
      q.earlier,
    )
    if (result.kind === 'answer' || result.kind === 'no_answer') answered.set(asked, { state, result })
    port.postMessage({ id, ok: true, result })
  } catch (err) {
    if (err instanceof AskError) {
      try {
        const fallback = err.results ?? (await ask(q.question, { reader: finder, model: null, log: { recordRead: () => 0, recordUsage: () => 0 }, now: () => q.asked_at }, LIMITS)).results
        return void port.postMessage({ id, ok: true, result: { kind: 'failed', message: err.message, results: fallback, stamp: finder.stamp() } satisfies AskResult })
      } catch {
        // A failed local read must still settle the question.
      }
    }
    port.postMessage({ id, ok: false, error: err instanceof Error ? err.message : 'failed' })
  }
}
