// Ask, and the person's own Anthropic key. The key goes from the interface to the shell only to be saved; no read or
// action ever returns it.
import type { AskResult, Statement } from '../../retrieval/ask.ts'

export type { AskResult, Citation, Piece, Statement, Thing, Visual } from '../../retrieval/ask.ts'

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

const OFFLINE = 'You’re offline. Connect to the internet and try again.'
// The engine's reason when the SDK couldn't connect at all.
const NO_CONNECTION = /no connection to Anthropic/

/** What Ask says when it couldn't answer, from the reason the call failed. */
export function askFailure(message: string): string {
  if (/key was refused/.test(message)) return 'Anthropic didn’t accept your key. Check it in Settings › AI.'
  if (/429|rate limit|credit balance|quota/i.test(message)) return 'Your Anthropic account is out of credit or over its limit, so Claude couldn’t answer.'
  if (NO_CONNECTION.test(message)) return OFFLINE
  if (/timed? ?out/i.test(message)) return 'Couldn’t reach Anthropic. Check your connection and try again.'
  if (/being deleted|deletion began/.test(message)) return 'Part of your record is being deleted. Ask again in a moment.'
  return 'Claude couldn’t answer that. Try again.'
}

/** What the key form says when Anthropic didn't accept a key, from checkKey's reason; null when it did. */
export function keyCheckFailure(err: string | null): string | null {
  if (err === null) return null
  if (err === 'the API key was refused') return 'Anthropic didn’t accept this key. Check it and try again.'
  if (NO_CONNECTION.test(err)) return OFFLINE
  return `Couldn’t reach Anthropic to check the key (${err}).`
}
