// Codex session logs: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, moved to ~/.codex/archived_sessions/ when archived.
// Every line starts with its timestamp and type, so bulk records are classified from that prefix and never parsed.

import { stringAfter } from './edges.ts'
import { digest, emptyCounts, parseTime, type AgentRecord, type Basis, type LineParser, type SessionOrigin, type TurnOpener, type UserAct } from './types.ts'

interface OpenTurn {
  key: string
  // A live turn was written as it happened. A replayed one was copied in later (an import, a fork or a resumed
  // history), so its line timestamps are the copy time and only the times inside its payloads are true.
  live: boolean
  start: number
  last: number
  opener: TurnOpener
  users: number
}

interface CodexState {
  session: string | null
  origin: SessionOrigin
  dir: string | null
  branch: string | null
  turn: OpenTurn | null
}

const PREFIX = /^\{"timestamp":"([^"]+)",(?:"ordinal":\d+,)?"type":"([a-z_]+)"(?:,"payload":\{"type":"([A-Za-z_]+)")?/
const ITEM_KIND = /"item":\{"type":"([A-Za-z]+)"/
const COMPLETED_MS = /"completed_at_ms":(\d+)/
// Record kinds whose payload never holds anything the reader needs beyond the line's own time.
const BULK = new Set(['reasoning', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'agent_message', 'token_count', 'web_search_call', 'local_shell_call', 'agent_reasoning', 'exec_command_end', 'exec_command_begin', 'mcp_tool_call_end', 'patch_apply_end'])
const BULK_TYPES = new Set(['token_usage_record', 'world_state', 'compacted', 'inter_agent_communication_metadata', 'realtime_item'])

const TRIGGER_OPENER: Record<string, TurnOpener> = {
  composer: 'user',
  queue: 'user_queued',
  send_user_message_async_question: 'user_answer',
  capacity_retry_manual: 'user_retry',
  capacity_retry_automatic: 'retry',
  resume_interrupted_task: 'resume',
  exec: 'automation',
}

const ANSWER = '<send_user_message_question_reply>'
// User-role text that people type: an attachment header followed by their own words, or an image they pasted.
const USER_WRAPPERS = ['# Files mentioned by the user', '# Files pasted by the user', '# Browser comments', '# Response annotations', '<image ', '<pasted_content']

function userText(content: unknown): string | null {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : null
  const parts: string[] = []
  for (const c of content as { type?: unknown; text?: unknown }[]) {
    if (typeof c?.text === 'string') parts.push(c.text)
    else if (c?.type === 'input_image' || c?.type === 'image') parts.push('<image>')
  }
  return parts.length ? parts.join('\n') : null
}

// Without content kinds, anything that opens with a tag or an instructions header is context Codex or another agent added.
function looksInjected(text: string): boolean {
  const t = text.replace(/^\s+/, '')
  if (t.startsWith(ANSWER) || USER_WRAPPERS.some((w) => t.startsWith(w))) return false
  return t.startsWith('<') || t.startsWith('# AGENTS.md') || t.startsWith('# Codex') || t.startsWith('[')
}

// A line too long to decode (a message with pasted images): the fields the reader needs are at its edges.
function fromEdges(head: string, tail: string, type: string, sub: string | undefined): Record<string, unknown> {
  const words = stringAfter(head, '"text":"') ?? ''
  if (type === 'response_item' && sub === 'message') {
    const created = /"create_time":([0-9.]+)/.exec(tail)?.[1]
    const kinds = /"content_item_kinds":(\[[^\]]*\])/.exec(tail)?.[1]
    return {
      payload: {
        type: 'message',
        role: /^[^]{0,200}"role":"([a-z]+)"/.exec(head.slice(head.indexOf('"payload"')))?.[1] ?? null,
        content: [{ type: 'input_text', text: words }],
        internal_chat_message_metadata_passthrough: { create_time: created ? Number(created) : undefined, content_item_kinds: kinds ? (JSON.parse(kinds) as unknown) : undefined },
      },
    }
  }
  if (type === 'event_msg' && sub === 'user_message') return { payload: { type: 'user_message', message: stringAfter(head, '"message":"') ?? '' } }
  if (sub === 'UserMessage') return { payload: { item: { content: [{ type: 'text', text: words }], client_id: /"client_id":"([^"]+)"/.exec(head)?.[1] } } }
  return { payload: { type: sub } }
}

export class CodexParser implements LineParser {
  counts = emptyCounts()
  private s: CodexState
  private readonly fileSession: string
  // Copies of one message (the response item, its completed item, the legacy event) count once per turn.
  private seen = new Set<string>()
  // The Codex app writes each sent message twice in a row: as a response item, then as a completed UserMessage item.
  private lastMessageLine = -10

  constructor(fileSession: string, saved: string | null) {
    this.fileSession = fileSession
    this.s = saved ? (JSON.parse(saved) as CodexState) : { session: null, origin: 'interactive', dir: null, branch: null, turn: null }
  }

  state(): string {
    return JSON.stringify(this.s)
  }

  private get session(): string {
    return this.s.session ?? this.fileSession
  }

  line(text: string | null, head: string, tail: string): AgentRecord[] {
    this.counts.lines++
    let m = PREFIX.exec(head)
    let parsed: Record<string, unknown> | null = null
    if (!m) {
      // A line that does not start the usual way is parsed in full; the format may have moved.
      if (text === null) {
        this.counts.bad++
        return []
      }
      try {
        parsed = JSON.parse(text) as Record<string, unknown>
      } catch {
        this.counts.bad++
        return []
      }
      const p = parsed.payload as { type?: unknown } | undefined
      if (typeof parsed.timestamp !== 'string' || typeof parsed.type !== 'string') {
        this.counts.bad++
        return []
      }
      m = ['', parsed.timestamp, parsed.type, typeof p?.type === 'string' ? p.type : undefined] as unknown as RegExpExecArray
    }
    const at = parseTime(m[1])
    if (at === null) {
      this.counts.bad++
      return []
    }
    const type = m[2]!
    const sub = m[3]
    const t = this.s.turn

    if (BULK_TYPES.has(type) || (sub !== undefined && BULK.has(sub))) {
      this.counts.recognized++
      return t?.live ? this.activity(at) : []
    }
    if (type === 'event_msg' && sub === 'item_completed') {
      this.counts.recognized++
      const kind = ITEM_KIND.exec(head)?.[1]
      const done = COMPLETED_MS.exec(tail)?.[1]
      const out = done !== undefined ? this.activity(Number(done)) : t?.live ? this.activity(at) : []
      if (kind !== 'UserMessage') return out
      if (this.counts.lines - this.lastMessageLine <= 2) return out
      const o = this.parse(text, parsed, head, tail, type, 'UserMessage')
      if (!o) return out
      const item = (o.payload as { item?: { content?: unknown; client_id?: unknown } }).item
      const words = userText(item?.content)
      if (words === null) return out
      // A client id means the Codex app's composer sent it.
      return out.concat(this.message(words, typeof item?.client_id === 'string' ? 'marked' : null, t?.live ? at : null))
    }

    const o = this.parse(text, parsed, head, tail, type, sub)
    if (!o) return []
    const p = (o.payload ?? {}) as Record<string, unknown>
    switch (type) {
      case 'session_meta':
        return this.meta(p, at)
      case 'turn_context':
        this.counts.recognized++
        if (typeof p.cwd === 'string') {
          this.s.dir = p.cwd
          if (t) return [{ t: 'turn_dir', key: t.key, dir: p.cwd }]
        }
        return []
      case 'event_msg':
        return this.event(sub, p, at)
      case 'response_item':
        this.counts.recognized++
        if (sub === 'message' && p.role === 'user') {
          const words = userText(p.content)
          if (words === null) return t?.live ? this.activity(at) : []
          const meta = p.internal_chat_message_metadata_passthrough as { create_time?: unknown; content_item_kinds?: unknown } | undefined
          const created = typeof meta?.create_time === 'number' ? Math.round(meta.create_time * 1000) : null
          const kinds = Array.isArray(meta?.content_item_kinds) ? (meta.content_item_kinds as unknown[]) : null
          const out = t?.live ? this.activity(at) : []
          this.lastMessageLine = this.counts.lines
          if (kinds !== null) {
            const typed = kinds.length > 0 && kinds.every((k) => typeof k === 'string' && k.startsWith('user.'))
            return typed ? out.concat(this.message(words, 'marked', created ?? (t?.live ? at : null))) : out
          }
          return out.concat(this.message(words, null, created ?? (t?.live ? at : null)))
        }
        return t?.live ? this.activity(at) : []
      default:
        this.counts.unknown++
        return []
    }
  }

  private parse(text: string | null, parsed: Record<string, unknown> | null, head: string, tail: string, type: string, sub: string | undefined): Record<string, unknown> | null {
    if (parsed) return parsed
    if (text === null) return fromEdges(head, tail, type, sub)
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      this.counts.bad++
      return null
    }
  }

  private meta(p: Record<string, unknown>, at: number): AgentRecord[] {
    // A fork or subagent file repeats its parent's metadata after its own; only the first is this session's.
    if (this.s.session !== null) {
      this.counts.recognized++
      return []
    }
    if (typeof p.id !== 'string') {
      this.counts.bad++
      return []
    }
    this.counts.recognized++
    this.s.session = p.id
    const source = p.source as unknown
    const spawn = source && typeof source === 'object' ? (source as { subagent?: { thread_spawn?: { parent_thread_id?: unknown } } }).subagent?.thread_spawn : undefined
    const originator = typeof p.originator === 'string' ? p.originator : null
    let parent: string | null = null
    if (spawn || p.thread_source === 'subagent') {
      this.s.origin = 'subagent'
      parent = typeof spawn?.parent_thread_id === 'string' ? spawn.parent_thread_id : typeof p.parent_thread_id === 'string' ? p.parent_thread_id : null
    } else if (source === 'exec' || originator === 'codex_exec' || originator === 'Claude Code') this.s.origin = 'automated'
    if (typeof p.cwd === 'string') this.s.dir = p.cwd
    const git = p.git as { branch?: unknown } | undefined
    if (typeof git?.branch === 'string') this.s.branch = git.branch
    const started = parseTime(p.timestamp) ?? at
    return [{ t: 'session', session: p.id, origin: this.s.origin, parent, client: originator, dir: this.s.dir, branch: this.s.branch, at: started }]
  }

  private event(sub: string | undefined, p: Record<string, unknown>, at: number): AgentRecord[] {
    const t = this.s.turn
    switch (sub) {
      case 'task_started': {
        if (typeof p.turn_id !== 'string') {
          this.counts.bad++
          return []
        }
        this.counts.recognized++
        const out = this.close('missing', null)
        const startedS = typeof p.started_at === 'number' ? p.started_at : null
        // Written as it happened, the line carries the turn's own start second (to clock rounding).
        const live = startedS === null || Math.abs(Math.floor(at / 1000) - startedS) <= 1
        const start = startedS !== null ? startedS * 1000 : at
        const attribution = p.turn_attribution as { turn_trigger?: unknown } | undefined
        const trigger = typeof attribution?.turn_trigger === 'string' ? attribution.turn_trigger : null
        let opener: TurnOpener = trigger !== null ? (TRIGGER_OPENER[trigger] ?? 'unknown') : 'unknown'
        if (this.s.origin === 'automated') opener = 'automation'
        else if (this.s.origin === 'subagent') opener = 'agent'
        this.s.turn = { key: p.turn_id, live, start, last: start, opener, users: 0 }
        this.seen.clear()
        out.push({ t: 'turn', key: p.turn_id, session: this.session, dir: this.s.dir, branch: this.s.branch, opener, start, replayed: !live })
        if (opener === 'user_queued' || opener === 'user_retry') out.push(this.act(`${p.turn_id}:${opener}`, opener === 'user_retry' ? 'prompt' : 'queued', 'marked', start))
        return out
      }
      case 'task_complete':
      case 'turn_aborted': {
        this.counts.recognized++
        if (!t || (typeof p.turn_id === 'string' && p.turn_id !== t.key)) return []
        const completed = typeof p.completed_at === 'number' ? p.completed_at * 1000 : null
        const fromDuration = typeof p.duration_ms === 'number' ? t.start + p.duration_ms : null
        const end = completed ?? fromDuration ?? (t.live ? at : null)
        const out: AgentRecord[] = []
        if (sub === 'turn_aborted') {
          // Stopping a turn from the app or the terminal; an app that quits mid-turn reads the same.
          if (p.reason === 'interrupted' && this.s.origin === 'interactive' && end !== null) out.push(this.act(`${t.key}:interrupt`, 'interrupt', 'inferred', end))
          out.push(...this.close('aborted', end))
        } else out.push(...this.close(p.error ? 'failed' : 'completed', end))
        return out
      }
      case 'user_message': {
        this.counts.recognized++
        const words = typeof p.message === 'string' ? p.message : null
        if (words === null) return []
        return (t?.live ? this.activity(at) : []).concat(this.message(words, null, t?.live ? at : null))
      }
      default:
        this.counts.recognized++
        return t?.live ? this.activity(at) : []
    }
  }

  // `basis` is 'marked' when the record itself says a person sent it; null means only the text's shape can tell.
  private message(text: string, basis: Basis | null, at: number | null): AgentRecord[] {
    const t = this.s.turn
    if (!t || this.s.origin !== 'interactive') return []
    const d = digest(text)
    if (this.seen.has(d)) return []
    if (basis === null && looksInjected(text)) return []
    this.seen.add(d)
    const answer = text.trimStart().startsWith(ANSWER)
    const first = t.users === 0
    t.users++
    let act: UserAct = answer ? 'answer' : first ? 'prompt' : 'steer'
    if (first && t.opener === 'user_queued') {
      // The queued prompt was counted when the turn started; the person typed it earlier, at a time not logged.
      return []
    }
    if (first && t.opener === 'user_retry') return []
    const out: AgentRecord[] = []
    if (first && t.opener === 'unknown') {
      t.opener = answer ? 'user_answer' : 'user'
      out.push({ t: 'turn_opener', key: t.key, opener: t.opener })
    }
    // The opening message of a turn is sent when the turn starts.
    const when = first ? t.start : at
    if (when === null) return out
    if (first && t.opener === 'user_answer') act = 'answer'
    out.push(this.act(`${t.key}:u${t.users}`, act, basis ?? 'inferred', when))
    return out
  }

  private close(state: 'completed' | 'aborted' | 'failed' | 'missing', at: number | null): AgentRecord[] {
    const t = this.s.turn
    if (!t) return []
    this.s.turn = null
    return [{ t: 'end', key: t.key, state, at: state === 'missing' ? null : at }]
  }

  private activity(at: number): AgentRecord[] {
    const t = this.s.turn
    if (!t || at < t.start) return []
    if (at > t.last) t.last = at
    return [{ t: 'activity', key: t.key, session: this.session, at }]
  }

  private act(key: string, act: UserAct, basis: Basis, at: number): AgentRecord {
    return { t: 'user', key, session: this.session, turn: this.s.turn?.key ?? null, act, basis, at }
  }
}
