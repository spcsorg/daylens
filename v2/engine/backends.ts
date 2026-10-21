// The ways an hour can be written, behind one interface: Claude Code (`claude -p`), Codex (`codex exec`), or no AI.
// The CLIs run on the person's own subscription, in an empty folder, with tools switched off as far as each allows.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Packet } from './packet.ts'
import { writerMessage } from './prompt.ts'
import type { WrittenHour } from './validate.ts'

export interface Usage {
  // All input tokens, including any read from or written to a cache.
  input: number
  cached_input: number
  cache_write: number
  output: number
  reasoning: number | null
}

export interface CallResult {
  text: string | null
  error: string | null
  // The call stopped on a usage or quota limit; retrying will not help until it resets.
  quota: boolean
  latency_ms: number
  usage: Usage | null
  // What the CLI itself reports, when it reports a cost (claude -p does, at API rates).
  reported_cost_usd: number | null
  // The exact model the provider says answered.
  model: string | null
  // Tool calls the run made. A writer must make none.
  tool_calls: string[]
  raw: unknown
}

export interface TextBackend {
  readonly name: string
  call(message: string): Promise<CallResult>
}

export interface HourWriter {
  readonly name: string
  write(packet: Packet): Promise<CallResult>
}

export interface RunResult {
  stdout: string
  stderr: string
  code: number | null
  ms: number
}

export type Runner = (cmd: string, args: string[], input: string, opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<RunResult>

export const runProcess: Runner = (cmd, args, input, opts) =>
  new Promise((resolve, reject) => {
    const t0 = performance.now()
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code, ms: performance.now() - t0 })
    })
    child.stdin.end(input)
  })

// Only what a CLI needs to find its own login. API keys and the parent session's settings (effort, base URL) are
// left out, so a run uses the subscription and the model's own defaults.
const ENV_KEEP = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM']

export function cleanEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const k of ENV_KEEP) if (from[k] !== undefined) env[k] = from[k]
  return env
}

const QUOTA = /usage limit|rate limit|quota|limit reached|resets? (at|in)|hit your .*limit/i

interface CliOptions {
  // Must be an empty folder: the CLI reads nothing from it.
  cwd: string
  run?: Runner
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export function claudeCli(model: string, opts: CliOptions): TextBackend {
  const run = opts.run ?? runProcess
  const args = [
    '-p', '--model', model, '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '', '--no-session-persistence', '--system-prompt', '', '--exclude-dynamic-system-prompt-sections',
  ]
  return {
    name: `claude:${model}`,
    async call(message) {
      const r = await run('claude', args, message, { cwd: opts.cwd, env: opts.env ?? cleanEnv(), timeoutMs: opts.timeoutMs ?? 900_000 })
      return parseClaude(r)
    },
  }
}

export function parseClaude(r: RunResult): CallResult {
  const out: CallResult = { text: null, error: null, quota: false, latency_ms: Math.round(r.ms), usage: null, reported_cost_usd: null, model: null, tool_calls: [], raw: null }
  let d: Record<string, unknown>
  try {
    d = JSON.parse(r.stdout) as Record<string, unknown>
  } catch {
    out.error = `unreadable output (exit ${r.code}): ${(r.stderr || r.stdout).slice(-400)}`
    out.quota = QUOTA.test(r.stderr + r.stdout)
    return out
  }
  out.raw = d
  const u = (d.usage ?? {}) as Record<string, number>
  const cacheWrite = u.cache_creation_input_tokens ?? 0
  const cacheRead = u.cache_read_input_tokens ?? 0
  out.usage = { input: (u.input_tokens ?? 0) + cacheWrite + cacheRead, cached_input: cacheRead, cache_write: cacheWrite, output: u.output_tokens ?? 0, reasoning: null }
  out.reported_cost_usd = typeof d.total_cost_usd === 'number' ? d.total_cost_usd : null
  const models = Object.keys((d.modelUsage ?? {}) as object)
  out.model = models.length === 1 ? models[0]! : models.length ? models.join(',') : null
  if (typeof d.num_turns === 'number' && d.num_turns > 1) out.tool_calls.push(`${d.num_turns} turns`)
  if (d.is_error || r.code !== 0) {
    out.error = String(d.result ?? d.subtype ?? `exit ${r.code}`)
    out.quota = QUOTA.test(out.error)
  } else {
    out.text = typeof d.result === 'string' ? d.result : null
    if (out.text === null) out.error = 'no result text'
  }
  return out
}

// What codex exec 0.162 can switch off. It still offers some tools (see the evaluation report), so it is only used
// on frozen packets in a read-only sandbox in an empty folder.
const CODEX_DISABLE = [
  'shell_tool', 'unified_exec', 'image_generation', 'multi_agent', 'plugins', 'apps', 'view_image', 'sleep_tool', 'tool_suggest',
  'skill_search', 'browser_use', 'browser_use_external', 'computer_use', 'goals', 'in_app_browser', 'remote_plugin', 'shell_snapshot',
  'skill_mcp_dependency_install',
]

export function codexCli(model: string, effort: string | null, opts: CliOptions & { instructionsFile: string }): TextBackend {
  const run = opts.run ?? runProcess
  const args = [
    'exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-s', 'read-only', '--json', '-C', opts.cwd,
    '-c', `model_instructions_file=${opts.instructionsFile}`, '-c', 'project_doc_max_bytes=0', '-c', 'web_search=disabled',
    '-c', 'include_permissions_instructions=false', '-c', 'include_apps_instructions=false', '-c', 'include_environment_context=false',
    '-c', 'include_collaboration_mode_instructions=false',
    ...CODEX_DISABLE.flatMap((f) => ['--disable', f]),
    '-m', model, ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), '-',
  ]
  return {
    name: `codex:${model}${effort ? `:${effort}` : ''}`,
    async call(message) {
      const r = await run('codex', args, message, { cwd: opts.cwd, env: opts.env ?? cleanEnv(), timeoutMs: opts.timeoutMs ?? 900_000 })
      return parseCodex(r, model)
    },
  }
}

export function parseCodex(r: RunResult, model: string): CallResult {
  const out: CallResult = { text: null, error: null, quota: false, latency_ms: Math.round(r.ms), usage: null, reported_cost_usd: null, model, tool_calls: [], raw: null }
  const texts: string[] = []
  const errors: string[] = []
  const events: unknown[] = []
  for (const line of r.stdout.split('\n')) {
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    events.push(ev)
    const item = (ev.item ?? {}) as Record<string, unknown>
    if (ev.type === 'item.completed' && item.type === 'agent_message') texts.push(String(item.text ?? ''))
    else if (ev.type === 'item.completed' && !['agent_message', 'reasoning', 'error'].includes(String(item.type))) out.tool_calls.push(String(item.type))
    else if (ev.type === 'turn.completed') {
      // OpenAI counts cached tokens inside input_tokens and reasoning tokens inside output_tokens.
      const u = (ev.usage ?? {}) as Record<string, number>
      out.usage = { input: u.input_tokens ?? 0, cached_input: u.cached_input_tokens ?? 0, cache_write: 0, output: u.output_tokens ?? 0, reasoning: u.reasoning_output_tokens ?? null }
    } else if (ev.type === 'error' || ev.type === 'turn.failed') {
      errors.push(String(ev.message ?? (ev.error as { message?: string } | undefined)?.message ?? ev.type))
    }
  }
  out.raw = events
  if (errors.length || !out.usage || r.code !== 0) {
    out.error = errors.join('; ') || (out.usage ? `exit ${r.code}` : `no turn.completed (exit ${r.code}): ${r.stderr.slice(-400)}`)
    out.quota = QUOTA.test(out.error + r.stderr)
  } else {
    out.text = texts.at(-1) ?? null
    if (out.text === null) out.error = 'no agent message'
  }
  return out
}

export function cliWriter(backend: TextBackend): HourWriter {
  return { name: backend.name, write: (packet) => backend.call(writerMessage(packet)) }
}

// A folder for a CLI to run in, with nothing in it, and a file of base instructions beside it.
export function cliScratch(baseInstructions: string): { cwd: string; instructionsFile: string; dispose: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'daylens-writer-'))
  const cwd = path.join(root, 'empty')
  const instructionsFile = path.join(root, 'instructions.txt')
  mkdirSync(cwd)
  writeFileSync(instructionsFile, baseInstructions)
  return { cwd, instructionsFile, dispose: () => rmSync(root, { recursive: true, force: true }) }
}

// With no AI, the hour is its facts: apps by time, what was open, agent work, commits, and when the person was away.
// It never says the person made anything, since the facts cannot tell who did.
export const noAi: HourWriter = {
  name: 'no-ai',
  async write(packet) {
    const t0 = performance.now()
    const hour = factsHour(packet)
    return { text: JSON.stringify(hour), error: null, quota: false, latency_ms: Math.round(performance.now() - t0), usage: null, reported_cost_usd: 0, model: null, tool_calls: [], raw: null }
  },
}

export function factsHour(packet: Packet): WrittenHour {
  const byApp = new Map<string, { min: number; ids: string[] }>()
  for (const i of [...packet.windows, ...packet.pages]) {
    if (!i.app) continue
    const e = byApp.get(i.app) ?? { min: 0, ids: [] }
    e.min += i.min
    e.ids.push(i.id)
    byApp.set(i.app, e)
  }
  const apps = [...byApp.entries()].filter(([, e]) => Math.round(e.min) > 0).sort((a, b) => b[1].min - a[1].min)
  const sources: string[] = []
  const lines: string[] = []
  const said = (ids: string[]) => sources.push(...ids)

  const titled = [...packet.windows, ...packet.pages].filter((i) => i.title && !i.stale && Math.round(i.min) > 0).sort((a, b) => b.min - a.min)
  for (const i of titled) {
    lines.push(`${i.app ?? 'Unknown app'}: ${i.title} (${Math.round(i.min)} min, ${i.from}–${i.to})`)
    said([i.id])
  }
  for (const a of packet.agents) {
    lines.push(`${a.agent} in ${a.project ?? 'an unknown folder'}: ${Math.round(a.with_you_min)} min working with you there, ${Math.round(a.while_away_min)} min while you were away`)
    said([a.id])
  }
  for (const c of packet.commits) {
    lines.push(`Commit at ${c.at} in ${c.repos.join(', ')}: ${c.subject}${c.while_away ? ` (made while away: ${c.while_away})` : ''}`)
    said([c.id])
  }
  for (const w of packet.away) if (w.from !== w.to) lines.push(`Away ${w.from}–${w.to} (${w.why})`)
  for (const g of packet.unknown) if (g.from !== g.to) lines.push(`Not recorded ${g.from}–${g.to} (${g.why})`)
  for (const k of packet.scheduled_events) lines.push(`On the calendar: ${k.title}, ${k.from}–${k.to} (scheduled)`)

  for (const [, e] of apps) said(e.ids)
  const top = apps[0]
  const title = top ? `Mostly ${top[0]}` : packet.away.length ? 'Away' : 'Nothing recorded'
  const summary = apps.length ? apps.map(([app, e]) => `${app} ${Math.round(e.min)} min`).join(', ') + '.' : 'No app time recorded.'
  return {
    title,
    summary,
    apps: apps.map(([app]) => app).concat(packet.agents.map((a) => a.agent).filter((a, i, all) => all.indexOf(a) === i && !byApp.has(a))),
    detail: lines.join('\n') || 'Nothing was recorded in this hour.',
    outcome: packet.commits.length ? packet.commits.map((c) => `Commit at ${c.at}: ${c.subject}`).join('; ') : null,
    sources: [...new Set(sources)],
    suggestion: null,
  }
}
