// Agent session records: what the Claude Code and Codex readers emit and the agent store writes.
// Records carry metadata only. No prompt, reply, tool input or command output ever leaves a parser.

import { createHmac, randomBytes } from 'node:crypto'

export type Agent = 'claude_code' | 'codex'

// interactive: a person drives the session. automated: a script, headless CLI or another agent drives it.
// subagent: spawned by another session's agent.
export type SessionOrigin = 'interactive' | 'automated' | 'subagent'

export type TurnOpener =
  | 'user'
  | 'user_queued'
  | 'user_answer'
  | 'user_retry'
  | 'agent'
  | 'automation'
  | 'notification'
  | 'continuation'
  | 'cross_session'
  | 'scheduled'
  | 'resume'
  | 'retry'
  | 'unknown'

// No end record is 'missing'; the turn's span then stops at its last recorded activity, never later.
export type TurnEndState = 'completed' | 'aborted' | 'failed' | 'missing'

// What the person did, at the time they did it.
export type UserAct = 'prompt' | 'queued' | 'steer' | 'answer' | 'command' | 'shell' | 'suggestion' | 'interrupt' | 'approval'

// marked: the log says a person did it. inferred: an older format without that marker, read from its shape.
export type Basis = 'marked' | 'inferred'

export type WaitReason = 'usage_limit' | 'question' | 'api_error'

export type AgentRecord =
  | {
      t: 'session'
      session: string
      origin: SessionOrigin
      parent: string | null
      client: string | null
      dir: string | null
      branch: string | null
      at: number
    }
  | { t: 'turn'; key: string; session: string; dir: string | null; branch: string | null; opener: TurnOpener; start: number; replayed: boolean }
  | { t: 'turn_dir'; key: string; dir: string }
  | { t: 'turn_opener'; key: string; opener: TurnOpener }
  | { t: 'activity'; key: string; session: string; at: number }
  | { t: 'end'; key: string; state: TurnEndState; at: number | null }
  | { t: 'user'; key: string; session: string; turn: string | null; act: UserAct; basis: Basis; at: number }
  | { t: 'wait'; key: string; session: string; turn: string | null; reason: WaitReason; start: number; end: number | null }

// Counts a parser keeps per batch so the reader can tell a quiet log from one it can no longer understand.
export interface ParseCounts {
  lines: number
  // Complete lines that were not JSON, or recognized records missing a field the reader relies on.
  bad: number
  // Records of a type the reader does not know. Formats add types often; this alone is not degradation.
  unknown: number
  // Records the reader understood.
  recognized: number
  // Turns actually created; a completion alone does not establish a turn.
  turns: number
  // Agent output outside any turn; output since a file's last recognized turn start means turn records went unrecognized.
  orphan: number
}

export function emptyCounts(): ParseCounts {
  return { lines: 0, bad: 0, unknown: 0, recognized: 0, turns: 0, orphan: 0 }
}

export function addCounts(a: ParseCounts, b: ParseCounts): ParseCounts {
  return { lines: a.lines + b.lines, bad: a.bad + b.bad, unknown: a.unknown + b.unknown, recognized: a.recognized + b.recognized, turns: a.turns + b.turns, orphan: a.orphan + b.orphan }
}

export function subCounts(a: ParseCounts, b: ParseCounts): ParseCounts {
  return { lines: a.lines - b.lines, bad: a.bad - b.bad, unknown: a.unknown - b.unknown, recognized: a.recognized - b.recognized, turns: a.turns - b.turns, orphan: a.orphan - b.orphan }
}

export interface LineParser {
  // `text` is the whole line, or a function that decodes it on demand (valid only during the call), or null for a
  // line too long to buffer whole. `head` and `tail` are always set.
  line(text: LineText, head: string, tail: string): AgentRecord[]
  counts: ParseCounts
  state(): string
}

export type LineText = string | null | (() => string | null)

export const lineText = (t: LineText): string | null => (typeof t === 'function' ? t() : t)

export function parseTime(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

// Parsers built without the install's key still never persist an unkeyed fingerprint.
export const processKey = randomBytes(32)

// Short fingerprint for matching copies of a message. Keyed per install, so a short message cannot be recovered from
// the stored fingerprint by hashing guesses.
export function digest(s: string, key: Buffer): string {
  return createHmac('sha256', key).update(s).digest('hex').slice(0, 16)
}
