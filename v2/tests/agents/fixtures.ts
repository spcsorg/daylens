// Synthetic Claude Code and Codex log lines. Field order follows the real formats, because the readers classify
// bulk records from the start of a line. No real log content is used anywhere in these tests.
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentRecord, LineParser } from '../../capture/agents/types.ts'

export const T0 = Date.parse('2026-10-14T18:00:00.000Z')
export const iso = (ms: number) => new Date(ms).toISOString()
export const sec = (s: number) => T0 + s * 1000

export function tmp(prefix = 'daylens-v2-agents-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function run(parser: LineParser, lines: string[]): AgentRecord[] {
  const out: AgentRecord[] = []
  for (const l of lines) out.push(...parser.line(l, l.slice(0, 8192), l.slice(-8192)))
  return out
}

export const of = <K extends AgentRecord['t']>(recs: AgentRecord[], t: K) => recs.filter((r): r is Extract<AgentRecord, { t: K }> => r.t === t)

// --- Claude Code ------------------------------------------------------------

export interface ClaudeCtx {
  session: string
  cwd: string
  entrypoint: string
  agentId?: string
}

export function claudeCtx(over: Partial<ClaudeCtx> = {}): ClaudeCtx {
  return { session: randomUUID(), cwd: '/home/me/code/project-alpha', entrypoint: 'cli', ...over }
}

function tailFields(c: ClaudeCtx): Record<string, unknown> {
  return { userType: 'external', entrypoint: c.entrypoint, cwd: c.cwd, sessionId: c.session, version: '9.9.9', gitBranch: 'main' }
}

export const claude = {
  // A prompt as the CLI writes it today. `origin` is omitted for the older format.
  prompt(c: ClaudeCtx, at: number, content: unknown, opts: { uuid?: string; origin?: Record<string, unknown> | null; promptSource?: string; isMeta?: boolean; sidechain?: boolean; compact?: boolean } = {}): string {
    const uuid = opts.uuid ?? randomUUID()
    const o: Record<string, unknown> = {
      parentUuid: null,
      isSidechain: opts.sidechain ?? false,
      promptId: randomUUID(),
      ...(c.agentId ? { agentId: c.agentId } : {}),
      type: 'user',
      message: { role: 'user', content },
      ...(opts.isMeta ? { isMeta: true } : {}),
      ...(opts.compact ? { isCompactSummary: true } : {}),
      uuid,
      timestamp: iso(at),
    }
    if (opts.origin !== null) {
      o.permissionMode = 'default'
      o.origin = opts.origin ?? { kind: 'human' }
      o.promptSource = opts.promptSource ?? 'typed'
    }
    return JSON.stringify({ ...o, ...tailFields(c) })
  },
  assistant(c: ClaudeCtx, at: number, stop: string | null, opts: { tools?: { id: string; name: string }[]; text?: string; sidechain?: boolean; apiError?: boolean; msg?: string; parent?: string } = {}): string {
    const content = [...(opts.text ? [{ type: 'text', text: opts.text }] : []), ...(opts.tools ?? []).map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: {} }))]
    return JSON.stringify({
      parentUuid: opts.parent ?? null,
      isSidechain: opts.sidechain ?? false,
      ...(c.agentId ? { agentId: c.agentId } : {}),
      message: { id: opts.msg ?? `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'm', content, stop_reason: stop, stop_sequence: null, usage: {} },
      requestId: 'req_x',
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: iso(at),
      ...(opts.apiError ? { isApiErrorMessage: true } : {}),
      ...tailFields(c),
    })
  },
  toolResult(c: ClaudeCtx, at: number, toolUseId: string, output: string, opts: { approvedByUser?: boolean; error?: boolean; answers?: boolean } = {}): string {
    return JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      promptId: randomUUID(),
      ...(c.agentId ? { agentId: c.agentId } : {}),
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: output, ...(opts.error ? { is_error: true } : {}) }] },
      uuid: randomUUID(),
      timestamp: iso(at),
      toolUseResult: opts.error ? `Error: ${output}` : opts.answers ? { questions: [], answers: {} } : { stdout: output, stderr: '' },
      sourceToolAssistantUUID: randomUUID(),
      ...(opts.approvedByUser ? { permissionDecision: { decision: 'accept', source: 'user_temporary' } } : { permissionDecision: { decision: 'accept', source: 'config', reasonType: 'mode' } }),
      ...tailFields(c),
    })
  },
  system(c: ClaudeCtx, at: number, subtype: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ parentUuid: null, isSidechain: false, type: 'system', subtype, ...extra, timestamp: iso(at), uuid: randomUUID(), ...tailFields(c) })
  },
  queue(c: ClaudeCtx, at: number, operation: 'enqueue' | 'dequeue' | 'remove', content?: string): string {
    return JSON.stringify({ type: 'queue-operation', operation, timestamp: iso(at), sessionId: c.session, ...(content !== undefined ? { content } : {}) })
  },
  queuedCommand(c: ClaudeCtx, at: number, prompt: string, origin: Record<string, unknown> = { kind: 'human' }): string {
    return JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      attachment: { type: 'queued_command', prompt, source_uuid: randomUUID(), commandMode: 'prompt', origin, timestamp: iso(at) },
      type: 'attachment',
      uuid: randomUUID(),
      timestamp: iso(at),
      ...tailFields(c),
    })
  },
  meta(c: ClaudeCtx, type: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ type, ...extra, sessionId: c.session })
  },
}

// --- Codex ------------------------------------------------------------------

export interface CodexCtx {
  id: string
  cwd: string
}

export function codexCtx(over: Partial<CodexCtx> = {}): CodexCtx {
  return { id: randomUUID(), cwd: '/home/me/code/project-beta', ...over }
}

let ordinal = 0
function line(at: number, type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ timestamp: iso(at), ordinal: ordinal++, type, payload, ...extra })
}

export const codex = {
  meta(c: CodexCtx, at: number, opts: { source?: unknown; originator?: string; threadSource?: string; forkedFrom?: string; id?: string } = {}): string {
    return line(at, 'session_meta', {
      session_id: opts.id ?? c.id,
      id: opts.id ?? c.id,
      timestamp: iso(at),
      cwd: c.cwd,
      originator: opts.originator ?? 'Codex Desktop',
      cli_version: '9.9.9',
      source: opts.source ?? 'vscode',
      ...(opts.threadSource ? { thread_source: opts.threadSource } : {}),
      ...(opts.forkedFrom ? { forked_from_id: opts.forkedFrom } : {}),
      model_provider: 'openai',
      base_instructions: { text: 'synthetic base instructions' },
      history_mode: 'paginated',
      git: { branch: 'main' },
    })
  },
  // `startedS` defaults to the line time: a live turn. A replayed turn carries its original start.
  started(at: number, turn: string, trigger: string | null | undefined, startedAtMs = at): string {
    return line(at, 'event_msg', {
      type: 'task_started',
      ...(trigger !== undefined ? { turn_attribution: { turn_id: turn, turn_trigger: trigger, parent_turn_id: null, initiating_agent_path: null, root_turn_id: turn } } : {}),
      turn_id: turn,
      started_at: Math.floor(startedAtMs / 1000),
      model_context_window: 1,
      collaboration_mode_kind: 'default',
    })
  },
  complete(at: number, turn: string, startedAtMs: number, completedAtMs: number | null = at, error?: unknown): string {
    return line(at, 'event_msg', {
      type: 'task_complete',
      turn_id: turn,
      started_at: Math.floor(startedAtMs / 1000),
      ...(completedAtMs !== null ? { completed_at: Math.floor(completedAtMs / 1000) } : {}),
      last_agent_message: 'synthetic reply',
      ...(error ? { error } : {}),
    })
  },
  aborted(at: number, turn: string, startedAtMs: number, reason = 'interrupted'): string {
    return line(at, 'event_msg', { type: 'turn_aborted', turn_id: turn, started_at: Math.floor(startedAtMs / 1000), completed_at: Math.floor(at / 1000), reason })
  },
  context(at: number, turn: string, cwd: string): string {
    return line(at, 'turn_context', { turn_id: turn, cwd, model: 'm' })
  },
  userItem(at: number, text: string, kinds: string[] | null, createdMs: number | null = at): string {
    return line(at, 'response_item', {
      type: 'message',
      id: `msg_${randomUUID()}`,
      role: 'user',
      content: [{ type: 'input_text', text }],
      ...(kinds !== null || createdMs !== null
        ? { internal_chat_message_metadata_passthrough: { ...(createdMs !== null ? { create_time: createdMs / 1000 } : {}), ...(kinds !== null ? { content_item_kinds: kinds } : {}) } }
        : {}),
    })
  },
  userCompleted(at: number, turn: string, text: string, clientId: string | null): string {
    return line(at, 'event_msg', { type: 'item_completed', thread_id: 't', turn_id: turn, item: { type: 'UserMessage', id: randomUUID(), ...(clientId ? { client_id: clientId } : {}), content: [{ type: 'text', text }] } })
  },
  userEvent(at: number, text: string): string {
    return line(at, 'event_msg', { type: 'user_message', message: text, images: [], local_images: [], text_elements: [] })
  },
  assistant(at: number, text = 'synthetic reply'): string {
    return line(at, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
  },
  toolCall(at: number, output: string): string {
    return line(at, 'response_item', { type: 'function_call_output', call_id: 'c', output })
  },
  itemDone(at: number, turn: string, startedMs: number, completedMs: number): string {
    return line(at, 'event_msg', { type: 'item_completed', thread_id: 't', turn_id: turn, item: { type: 'CommandExecution', id: 'x' }, started_at_ms: startedMs, completed_at_ms: completedMs })
  },
  tokens(at: number): string {
    return line(at, 'event_msg', { type: 'token_count', info: null, rate_limits: {} })
  },
}
