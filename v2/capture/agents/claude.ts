// Claude Code session logs: ~/.claude/projects/<encoded cwd>/<session>.jsonl, subagents under <session>/subagents/.
// Tool results are recognized from the start of the line and never parsed, so command output is never read.

import { fieldsFromTail, stringAfter } from './edges.ts'
import { digest, emptyCounts, parseTime, type AgentRecord, type LineParser, type TurnOpener, type UserAct } from './types.ts'

interface OpenTurn {
  key: string
  last: number
  stop: string | null
  // The reply that set `stop`; one reply is written as several records that share its id.
  msg?: string | null
  replied?: boolean
}

// A reply that ends the turn: the agent stopped, or the request failed and the CLI wrote the error as its reply.
const finished = (t: OpenTurn) => t.stop === 'end_turn' || t.stop === 'stop_sequence' || t.stop === 'error'

interface ClaudeState {
  session: string | null
  announced: boolean
  dir: string | null
  branch: string | null
  automated: boolean
  turn: OpenTurn | null
  // An instruction not from the person (a command, a notice, another session) waiting for the agent's reply.
  // `last` is the latest such record; a reply that points at it answers the instruction, not the turn before.
  pending: { opener: TurnOpener; at: number; key: string; last?: string } | null
  // Typed messages waiting for delivery: when they were typed, and whether the agent was busy then.
  queued: Record<string, [number, boolean]>
  questions: Record<string, number>
  limitSince: number | null
  retrySince?: number | null
}

const TOOL_RESULT_HEAD = /"type":"user","message":\{"role":"user","content":\[\{"(?:tool_use_id|type":"tool_result)"/
const SKIPPED_HEAD = /^\{"type":"(?:api-request-blob|api-request|api-request-shape|file-history-snapshot|file-history-delta|atis-latch|mode|permission-mode|last-prompt|custom-title|ai-title|agent-name|pr-link|frame-link|bridge-session|cost-state|worktree-state|isolation-latch|artifact-[a-z-]+)"/
const TOP_TIME = /"uuid":"([^"]+)","timestamp":"([^"]+)"/
const USER_APPROVAL_TAIL = /"permissionDecision":\{"decision":"accept","source":"user/
const TOOL_USE_ID = /"tool_use_id":"([^"]+)"/
const FAILED_RESULT = /"is_error":true/
const STRING_RESULT = /"toolUseResult":"/

// Text the CLI writes into a user-role message on the person's behalf, or that a person never typed.
const INJECTED_PREFIXES = [
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<system-reminder>',
  '<task-notification>',
  '<user-prompt-submit-hook>',
  '<command-message>',
  '<scheduled-task',
  'Caveat: The messages below were generated',
  'This session is being continued from a previous conversation',
  '[Cross-session',
  '[Usage limit',
  '[Earlier usage-limit',
  '[Image: original',
]

const INTERRUPT = '[Request interrupted by user'
// Queued messages that were never delivered are forgotten oldest first, so the saved state stays small.
const MAX_QUEUED = 64

function firstText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  for (const c of content) {
    if (c && typeof c === 'object' && (c as { type?: unknown }).type === 'text') {
      const t = (c as { text?: unknown }).text
      if (typeof t === 'string') return t
    }
  }
  // An image-only message is still a message the person sent.
  return content.some((c) => c && typeof c === 'object' && (c as { type?: unknown }).type === 'image') ? '' : null
}

const TAIL_KEYS = ['requestId', 'isMeta', 'isCompactSummary', 'uuid', 'type']
// The record type when it comes before any nested object, as it does for user and system records.
const LEADING_TYPE = /^\{(?:"[^"]+":(?:"[^"]*"|true|false|null|-?\d+),)*?"type":"([a-z_-]+)"/
const ASK_IDS = /"type":"tool_use","id":"([^"]+)","name":"AskUserQuestion"/g

// A line too long to decode: the record type and the first words of a prompt are in its head, the rest of the
// envelope (uuid, timestamp, origin, session) follows the message and is in its tail.
function fromEdges(head: string, tail: string): Record<string, unknown> | null {
  const env = fieldsFromTail(tail, TAIL_KEYS)
  if (!env) return null
  const lead = LEADING_TYPE.exec(head)
  const type = lead?.[1] ?? env.type
  if (typeof type !== 'string') return null
  const user = type === 'user'
  const o: Record<string, unknown> = { ...env, type }
  const sub = lead ? /^\{(?:"[^"]+":(?:"[^"]*"|true|false|null|-?\d+),)*?"subtype":"([a-z_]+)"/.exec(head)?.[1] : undefined
  if (sub) o.subtype = sub
  if (user) {
    const image = /"message":\{"role":"user","content":\[\{"type":"image"/.test(head)
    const text = stringAfter(head, '"message":{"role":"user","content":"') ?? stringAfter(head, '"content":[{"type":"text","text":"')
    o.message = { content: text ?? (image ? [{ type: 'image' }] : null) }
    for (const k of ['isSidechain', 'isMeta', 'isCompactSummary']) if (head.includes(`"${k}":true`)) o[k] = true
  } else if (type === 'assistant') {
    const stop = /"stop_reason":"([a-z_]+)"/.exec(tail)?.[1]
    const content = [...head.matchAll(ASK_IDS)].map((m) => ({ type: 'tool_use', name: 'AskUserQuestion', id: m[1] }))
    o.message = { id: /"message":\{[^{]*?"id":"([^"]+)"/.exec(head)?.[1] ?? null, stop_reason: stop ?? null, content }
    o.parentUuid = /^\{"parentUuid":"([^"]+)"/.exec(head)?.[1] ?? null
    if (head.includes('"isSidechain":true')) o.isSidechain = true
  }
  return o
}

function isInjected(text: string): boolean {
  const t = text.trimStart()
  return INJECTED_PREFIXES.some((p) => t.startsWith(p))
}

const ORIGIN_OPENER: Record<string, TurnOpener> = {
  'task-notification': 'notification',
  'auto-continuation': 'continuation',
  peer: 'cross_session',
  coordinator: 'agent',
  scheduled: 'scheduled',
}

export class ClaudeParser implements LineParser {
  counts = emptyCounts()
  private s: ClaudeState
  private readonly subagentFile: boolean
  private readonly fileSession: string

  // `fileSession` is the file's stem; for a subagent file, `parentSession` is the session folder it sits in.
  constructor(fileSession: string, parentSession: string | null, saved: string | null) {
    this.subagentFile = parentSession !== null
    this.fileSession = fileSession
    this.parent = parentSession
    this.s = saved
      ? (JSON.parse(saved) as ClaudeState)
      : { session: null, announced: false, dir: null, branch: null, automated: false, turn: null, pending: null, queued: {}, questions: {}, limitSince: null }
  }

  private readonly parent: string | null

  state(): string {
    return JSON.stringify(this.s)
  }

  line(text: string | null, head: string, tail: string): AgentRecord[] {
    this.counts.lines++
    if (SKIPPED_HEAD.test(head)) {
      this.counts.recognized++
      return []
    }
    if (TOOL_RESULT_HEAD.test(head)) return this.toolResult(text, head, tail)
    let o: Record<string, unknown> | null
    if (text === null) o = fromEdges(head, tail)
    else {
      try {
        o = JSON.parse(text) as Record<string, unknown>
      } catch {
        o = null
      }
    }
    if (!o || typeof o !== 'object' || typeof o.type !== 'string') {
      this.counts.bad++
      return []
    }
    switch (o.type) {
      case 'user':
        return this.user(o)
      case 'assistant':
        return this.assistant(o)
      case 'system':
        return this.system(o)
      case 'attachment':
        return this.attachment(o)
      case 'queue-operation':
        return this.queue(o)
      case 'relocated':
        if (typeof o.relocatedCwd === 'string') this.s.dir = o.relocatedCwd
        this.counts.recognized++
        return []
      case 'summary':
      case 'continued-in':
      case 'fork-context-ref':
      case 'started':
        this.counts.recognized++
        return []
      default:
        this.counts.unknown++
        return []
    }
  }

  // --- records -------------------------------------------------------------

  private envelope(o: Record<string, unknown>): { at: number; uuid: string } | null {
    const at = parseTime(o.timestamp)
    if (at === null || typeof o.uuid !== 'string' || typeof o.sessionId !== 'string') {
      this.counts.bad++
      return null
    }
    this.counts.recognized++
    return { at, uuid: o.uuid }
  }

  private meta(o: Record<string, unknown>, at: number): AgentRecord[] {
    if (typeof o.cwd === 'string') this.s.dir = o.cwd
    if (typeof o.gitBranch === 'string' && o.gitBranch !== '') this.s.branch = o.gitBranch
    if (this.s.announced) return []
    this.s.announced = true
    this.s.automated = o.entrypoint === 'sdk-cli'
    const session = this.subagentFile ? (typeof o.agentId === 'string' ? o.agentId : this.fileSession) : (o.sessionId as string)
    this.s.session = session
    return [
      {
        t: 'session',
        session,
        origin: this.subagentFile ? 'subagent' : this.s.automated ? 'automated' : 'interactive',
        parent: this.subagentFile ? this.parent : null,
        client: typeof o.entrypoint === 'string' ? o.entrypoint : null,
        dir: this.s.dir,
        branch: this.s.branch,
        at,
      },
    ]
  }

  private get session(): string {
    return this.s.session ?? this.fileSession
  }

  private user(o: Record<string, unknown>): AgentRecord[] {
    const env = this.envelope(o)
    if (!env) return []
    const out = this.meta(o, env.at)
    const msg = o.message as { content?: unknown } | undefined
    const text = firstText(msg?.content)
    // A sidechain is a subagent inside this file; its prompts come from the agent, and its work is the open turn's.
    if (o.isSidechain === true) return out.concat(this.activity(env.at))
    // Text the CLI adds (a compaction summary, skill bodies, reminders, notices) is not the agent working.
    if (o.isCompactSummary === true || text === null) return out

    if (text.trimStart().startsWith(INTERRUPT)) {
      out.push(...this.act(env.uuid, 'interrupt', 'marked', env.at, this.s.turn?.key ?? null))
      return out.concat(this.close('aborted', env.at))
    }

    const origin = o.origin as { kind?: unknown } | undefined
    const kind = typeof origin?.kind === 'string' ? origin.kind : null
    const source = typeof o.promptSource === 'string' ? o.promptSource : null
    const humanCapable = !this.subagentFile && !this.s.automated

    if (kind !== null) {
      if (kind === 'human' && humanCapable) {
        const act: UserAct = source === 'queued' ? 'queued' : source === 'suggestion_accepted' ? 'suggestion' : 'prompt'
        return out.concat(this.open(env.uuid, act === 'queued' ? 'user_queued' : 'user', env.at, act, 'marked', text))
      }
      const opener = this.subagentFile ? 'agent' : this.s.automated ? 'automation' : (ORIGIN_OPENER[kind] ?? 'unknown')
      if (o.isMeta === true) {
        this.instruct(opener, env.at, env.uuid, text, false)
        return out
      }
      return out.concat(this.open(env.uuid, opener, env.at, null, 'marked', text))
    }

    // Older logs carry no origin: the shape of the message is all there is to go on.
    if (o.isMeta === true || isInjected(text)) {
      this.instruct(this.subagentFile ? 'agent' : 'unknown', env.at, env.uuid, text, true)
      return out
    }
    if (!humanCapable) return out.concat(this.open(env.uuid, this.subagentFile ? 'agent' : 'automation', env.at, null, 'inferred', text))
    const t = text.trimStart()
    if (t.startsWith('<command-name>')) {
      this.s.pending = { opener: 'user', at: env.at, key: env.uuid, last: env.uuid }
      return out.concat(this.act(env.uuid, 'command', 'inferred', env.at, this.s.turn?.key ?? null))
    }
    if (t.startsWith('<bash-input>')) {
      return out.concat(this.act(env.uuid, 'shell', 'inferred', env.at, this.s.turn?.key ?? null))
    }
    return out.concat(this.open(env.uuid, 'user', env.at, 'prompt', 'inferred', text))
  }

  private toolResult(text: string | null, head: string, tail: string): AgentRecord[] {
    this.counts.recognized++
    const id = TOOL_USE_ID.exec(head)?.[1]
    const asked = id !== undefined ? this.s.questions[id] : undefined
    const approved = USER_APPROVAL_TAIL.test(tail)
    if (asked === undefined && !approved) return []
    // Only the envelope is read: the uuid and timestamp sit between the message and the tool output.
    const m = TOP_TIME.exec(text ?? head + tail)
    const at = m ? parseTime(m[2]) : null
    if (!m || at === null) {
      this.counts.bad++
      return []
    }
    const out: AgentRecord[] = []
    const turn = this.s.turn?.key ?? null
    // Only a person-driven session has a person to answer or approve; a script or a parent agent does it otherwise.
    const humanCapable = !this.subagentFile && !this.s.automated
    if (asked !== undefined && id !== undefined) {
      delete this.s.questions[id]
      out.push({ t: 'wait', key: `${this.session}:q:${id}`, session: this.session, turn, reason: 'question', start: asked, end: at })
      // A failed or rejected question carries an error flag and a plain-text result; an answer carries the answers.
      const failed = FAILED_RESULT.test(text ?? head) || FAILED_RESULT.test(tail) || STRING_RESULT.test(text ?? tail)
      if (humanCapable && !failed) out.push(...this.act(m[1]!, 'answer', 'marked', at, turn))
    } else if (approved && humanCapable) out.push(...this.act(m[1]!, 'approval', 'marked', at, turn))
    return out.concat(this.activity(at))
  }

  private assistant(o: Record<string, unknown>): AgentRecord[] {
    const env = this.envelope(o)
    if (!env) return []
    const out = this.meta(o, env.at)
    if (o.isSidechain === true && !this.subagentFile) return out.concat(this.activity(env.at))
    const message = o.message as { id?: unknown; stop_reason?: unknown; content?: unknown } | undefined
    const msg = typeof message?.id === 'string' ? message.id : null
    // A finished turn stays finished: only more of the reply that finished it belongs to it; any other reply is a new turn.
    const t0 = this.s.turn
    const parent = typeof o.parentUuid === 'string' ? o.parentUuid : null
    const answersInstruction = t0 !== null && t0.replied === true && this.s.pending?.last !== undefined && parent === this.s.pending.last
    if (t0 !== null && ((finished(t0) && (this.s.pending !== null || msg === null || msg !== t0.msg)) || answersInstruction)) out.push(...this.close('missing', null))
    if (!this.s.turn) {
      const p = this.s.pending
      out.push(...this.open(p?.key ?? env.uuid, p?.opener ?? (this.subagentFile ? 'agent' : 'unknown'), p?.at ?? env.at, null, 'marked', null))
    }
    if (this.s.retrySince != null) {
      out.push({ t: 'wait', key: `${this.session}:retry:${this.s.retrySince}`, session: this.session, turn: this.s.turn?.key ?? null, reason: 'api_error', start: this.s.retrySince, end: env.at })
      this.s.retrySince = null
    }
    const t = this.s.turn
    if (t) {
      t.msg = msg
      t.replied = true
      out.push(...this.activity(env.at, true))
      t.stop = o.isApiErrorMessage === true ? 'error' : typeof message?.stop_reason === 'string' ? message.stop_reason : t.stop
    }
    if (Array.isArray(message?.content)) {
      for (const c of message.content as { type?: unknown; name?: unknown; id?: unknown }[]) {
        if (c?.type === 'tool_use' && c.name === 'AskUserQuestion' && typeof c.id === 'string') this.s.questions[c.id] = env.at
      }
    }
    return out
  }

  private system(o: Record<string, unknown>): AgentRecord[] {
    const env = this.envelope(o)
    if (!env) return []
    const out = this.meta(o, env.at)
    const sub = o.subtype
    if (sub === 'turn_duration' || sub === 'stop_hook_summary') {
      if (this.s.turn) out.push(...this.close(this.s.turn.stop === 'error' ? 'failed' : 'completed', env.at))
      return out
    }
    // A failed request is retried after a pause; until the next reply arrives the agent is waiting, not working.
    if (sub === 'api_error') {
      if (this.s.turn) this.s.retrySince ??= env.at
      return out
    }
    if (sub === 'informational' && typeof o.content === 'string') {
      if (o.content.startsWith('Usage limit reached')) this.s.limitSince ??= env.at
      else if (o.content.startsWith('Usage limit reset') && this.s.limitSince !== null) {
        out.push({ t: 'wait', key: `${this.session}:limit:${this.s.limitSince}`, session: this.session, turn: this.s.turn?.key ?? null, reason: 'usage_limit', start: this.s.limitSince, end: env.at })
        this.s.limitSince = null
      }
      return out
    }
    if (sub === 'local_command' || sub === 'away_summary' || sub === 'bridge_status' || sub === 'scheduled_task_fire') return out
    return out.concat(this.activity(env.at))
  }

  private attachment(o: Record<string, unknown>): AgentRecord[] {
    const env = this.envelope(o)
    if (!env) return []
    const out = this.meta(o, env.at)
    const a = o.attachment as { type?: unknown; prompt?: unknown; origin?: { kind?: unknown }; isMeta?: unknown } | undefined
    if (a?.type !== 'queued_command' || this.subagentFile || this.s.automated || a.isMeta === true) return out
    const kind = a.origin?.kind
    if (kind !== undefined && kind !== 'human') return out
    const prompt = typeof a.prompt === 'string' ? a.prompt : null
    if (prompt === null || isInjected(prompt)) return out
    // Typed while the agent worked and delivered into the running turn; it counts once, at the time it was typed.
    const typed = this.takeQueued(prompt)
    out.push(...this.act(env.uuid, 'steer', kind === 'human' ? 'marked' : 'inferred', typed?.[0] ?? env.at, this.s.turn?.key ?? null))
    return out
  }

  private queue(o: Record<string, unknown>): AgentRecord[] {
    const at = parseTime(o.timestamp)
    if (at === null || typeof o.operation !== 'string') {
      this.counts.bad++
      return []
    }
    this.counts.recognized++
    if (this.subagentFile || this.s.automated) return []
    const content = typeof o.content === 'string' ? o.content : null
    // The time a message was typed into the queue; it is counted when it is delivered, as part of the turn it starts.
    if (o.operation === 'enqueue' && content !== null && !isInjected(content)) {
      const t = this.s.turn
      this.s.queued[digest(content)] = [at, t !== null && t.stop !== 'end_turn' && t.stop !== 'stop_sequence']
      const keys = Object.keys(this.s.queued)
      if (keys.length > MAX_QUEUED) delete this.s.queued[keys[0]!]
    }
    return []
  }

  // --- turns ---------------------------------------------------------------

  // Text a CLI adds before the first reply belongs to the prompt it follows; an image placeholder belongs to the tool
  // output it follows. Anything else is an instruction that can start a turn of its own.
  private instruct(opener: TurnOpener, at: number, uuid: string, text: string | null, keepFirst: boolean): void {
    const t = this.s.turn
    if (t !== null && !t.replied) return
    if (text === null || text === '' || text.trimStart().startsWith('[Image')) return
    if (keepFirst && this.s.pending) this.s.pending.last = uuid
    else this.s.pending = { opener, at, key: uuid, last: uuid }
  }

  private takeQueued(text: string): [number, boolean] | null {
    const d = digest(text)
    const q = this.s.queued[d]
    if (q === undefined) return null
    delete this.s.queued[d]
    return q
  }

  private open(key: string, opener: TurnOpener, at: number, act: UserAct | null, basis: 'marked' | 'inferred', text: string | null): AgentRecord[] {
    const out = this.close('missing', null)
    this.s.pending = null
    // Message uuids survive a resumed or forked copy, so a turn and its acts are keyed on them alone.
    const turn = key
    this.s.turn = { key: turn, last: at, stop: null }
    out.push({ t: 'turn', key: turn, session: this.session, dir: this.s.dir, branch: this.s.branch, opener, start: at, replayed: false })
    if (act !== null) {
      // Every prompt passes through the queue; one typed while the agent was busy waited there, and was sent when typed.
      const typed = text !== null ? this.takeQueued(text) : null
      out.push(...this.act(key, typed?.[1] ? 'queued' : act, basis, typed?.[0] ?? at, turn))
    }
    return out
  }

  // A turn without an end record keeps the time of its last activity; nothing is added after it.
  private close(state: 'completed' | 'aborted' | 'failed' | 'missing', at: number | null): AgentRecord[] {
    const t = this.s.turn
    if (!t) return []
    this.s.turn = null
    this.s.questions = {}
    this.s.retrySince = null
    if (state === 'missing' && finished(t)) return [{ t: 'end', key: t.key, state: t.stop === 'error' ? 'failed' : 'completed', at: t.last }]
    return [{ t: 'end', key: t.key, state, at: state === 'missing' ? null : at }]
  }

  // `sameReply`: a further block of the reply that finished the turn, the only thing a finished turn still takes.
  private activity(at: number, sameReply = false): AgentRecord[] {
    const t = this.s.turn
    if (!t || (finished(t) && !sameReply)) return []
    if (at > t.last) t.last = at
    return [{ t: 'activity', key: t.key, session: this.session, at }]
  }

  private act(key: string, act: UserAct, basis: 'marked' | 'inferred', at: number, turn: string | null): AgentRecord[] {
    return [{ t: 'user', key, session: this.session, turn, act, basis, at }]
  }
}
