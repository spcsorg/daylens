// Ask, in the reader: the record is read here, the question goes to the AI on the person's key, and each checked
// statement is posted to the asking screen as it streams. What was sent is logged on a connection of its own, since
// the reader's is read-only.
import type { MessagePortMain } from 'electron'
import { anthropicApi, ASK_EFFORT, ASK_MODEL } from '../../retrieval/anthropicApi.ts'
import { ask, type AskResult } from '../../retrieval/ask.ts'
import { AssistantStore } from '../../retrieval/assistantStore.ts'
import type { Reader } from '../../retrieval/reader.ts'
import type { AskQuery } from '../shared/ai.ts'

// hours-gold's measured limits for the invented record.
const LIMITS = { maxHours: 12, maxSources: 40, perGroup: 8 }
const TIMEOUT_MS = 60_000

let key: string | null = null
let log: AssistantStore | null = null
// The same question, asked again before anything new is recorded or deleted, gets the answer it got before.
const answered = new Map<string, { state: string; result: AskResult }>()

export function setKey(k: string | null): void {
  key = k
  answered.clear()
}

export async function answer(file: string, finder: Reader, port: MessagePortMain, id: number, q: AskQuery): Promise<void> {
  try {
    log ??= AssistantStore.open(file)
    const store = log
    const usage = store.db.prepare(
      'INSERT INTO usage_ledger (at_wall_ms, kind, provider, model, input_tokens, output_tokens, cost_micro_usd, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    // Heartbeats extend an observation in place, so the newest sighting of any of them counts as a change too.
    const state = String(store.db.prepare(`SELECT (SELECT coalesce(max(id), 0) || ':' || coalesce(max(last_seen_wall_ms), 0) FROM observations) || '/' || (SELECT coalesce(max(seq), 0) FROM change_log)`).pluck().get())
    // "Today" means another day after midnight, though nothing new was recorded.
    const asked = `${new Date().toDateString()}\u0000${q.question.trim().toLowerCase()}`
    const before = answered.get(asked)
    if (before?.state === state) return void port.postMessage({ id, ok: true, result: before.result })
    const result = await ask(
      q.question,
      {
        reader: finder,
        model: key ? anthropicApi(ASK_MODEL, { apiKey: key, timeoutMs: TIMEOUT_MS, effort: ASK_EFFORT }) : null,
        log: {
          recordRead: (r, mark) => store.recordRead(r, mark),
          recordUsage: (u) => Number(usage.run(Date.now(), u.kind, u.provider, u.model, u.input_tokens, u.output_tokens, u.cost_micro_usd, u.ref ?? null).lastInsertRowid),
        },
        onStatement: (statement) => port.postMessage({ e: 'ask', ask_id: q.ask_id, statement }),
      },
      LIMITS,
    )
    if (result.kind === 'answer' || result.kind === 'no_answer') answered.set(asked, { state, result })
    port.postMessage({ id, ok: true, result })
  } catch (err) {
    port.postMessage({ id, ok: false, error: err instanceof Error ? err.message : 'failed' })
  }
}
