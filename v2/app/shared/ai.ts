// Ask, and the person's own Anthropic key. The key goes from the interface to the shell only to be saved; no read or
// action ever returns it.
import type { AskResult, Statement } from '../../retrieval/ask.ts'

export type { AskResult, Citation, Statement } from '../../retrieval/ask.ts'

export type AskQuery = { q: 'ask'; ask_id: number; question: string }

export interface AskResults {
  ask: AskResult
}

// Each statement as soon as it is complete and has passed the checks, before the whole answer arrives.
export type AskEvent = { e: 'ask'; ask_id: number; statement: Statement }

export type AiAction = { a: 'ai_status' } | { a: 'ai_key_save'; key: string } | { a: 'ai_key_test' } | { a: 'ai_key_clear' }

export interface AiStatus {
  saved: boolean
}
