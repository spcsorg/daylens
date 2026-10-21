// Ask through Claude Code on the person's own subscription: `claude -p` with no tools, no MCP servers, no settings,
// hooks, plugins or CLAUDE.md of the machine, structured output, and no session kept on disk. It runs in an empty
// folder that is removed afterwards. The record goes in on stdin, never on the command line.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AskModel, AskReply, AskRequest } from './ask.ts'

export interface ClaudeCliOptions {
  // How long one answer may take before it is abandoned. A product decision with no default.
  timeoutMs: number
  command?: string
  model?: string
}

export function claudeArgs(req: AskRequest, model?: string): string[] {
  return [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(req.schema),
    '--tools', '',
    '--strict-mcp-config',
    '--safe-mode',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt', req.system,
    ...(model ? ['--model', model] : []),
  ]
}

interface CliResult {
  is_error?: boolean
  subtype?: string
  structured_output?: unknown
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
  modelUsage?: Record<string, unknown>
  permission_denials?: unknown[]
}

export function parseCliResult(stdout: string): AskReply {
  let r: CliResult
  try {
    r = JSON.parse(stdout) as CliResult
  } catch {
    throw new Error('Claude Code returned something other than its JSON result')
  }
  if (r.is_error || r.subtype !== 'success') throw new Error(`Claude Code reported ${r.subtype ?? 'an error'}`)
  if (r.permission_denials && r.permission_denials.length > 0) throw new Error('Claude Code tried to use a tool')
  if (r.structured_output === undefined) throw new Error('Claude Code returned no structured answer')
  const u = r.usage ?? {}
  return {
    output: r.structured_output,
    model: Object.keys(r.modelUsage ?? {})[0] ?? 'unknown',
    input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    output_tokens: u.output_tokens ?? 0,
    // Billed to the person's own subscription, not to Daylens.
    cost_micro_usd: 0,
  }
}

export function claudeCli(opts: ClaudeCliOptions): AskModel {
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 1) throw new RangeError('timeoutMs must be a positive whole number')
  return {
    name: 'Claude Code',
    provider: 'claude-cli',
    run: (req) =>
      new Promise<AskReply>((resolve, reject) => {
        const cwd = mkdtempSync(path.join(os.tmpdir(), 'daylens-ask-'))
        const done = (fn: () => void) => {
          clearTimeout(timer)
          rmSync(cwd, { recursive: true, force: true })
          fn()
        }
        const child = spawn(opts.command ?? 'claude', claudeArgs(req, opts.model), { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
        const timer = setTimeout(() => {
          child.kill('SIGTERM')
          done(() => reject(new Error(`no answer within ${opts.timeoutMs} ms`)))
        }, opts.timeoutMs)
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c))
        child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c))
        child.on('error', (err) => done(() => reject(err)))
        child.on('close', (code) => {
          if (child.killed) return
          if (code !== 0) return done(() => reject(new Error(`Claude Code exited with ${code}: ${stderr.trim().slice(0, 300) || stdout.trim().slice(0, 300)}`)))
          let reply: AskReply
          try {
            reply = parseCliResult(stdout)
          } catch (err) {
            return done(() => reject(err))
          }
          done(() => resolve(reply))
        })
        child.stdin.end(req.prompt)
      }),
  }
}
