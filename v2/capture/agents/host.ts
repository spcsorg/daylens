// The app an agent session runs in: Claude Code inside Terminal, iTerm, VS Code or Cursor; Codex in its own app or
// a terminal. Some logs say so (the Claude and Codex apps write their name as the client); otherwise a running
// session is traced to its process and the capture helper names the app that process runs in.
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Agent } from './types.ts'

export interface HostApp {
  app_id: string | null
  name: string | null
  path: string | null
}

export type HostBasis = 'log' | 'responsible' | 'parent'

export interface HostFinding {
  // null: the session was traced and runs in no app (a detached terminal multiplexer, a remote shell).
  app: HostApp | null
  basis: HostBasis | 'none'
}

// Clients that name the app a session runs in, by platform. Every other client (a CLI, an editor extension that
// both VS Code and Cursor load) leaves the app to be traced from the running process.
const CLIENT_APPS: Partial<Record<NodeJS.Platform, Record<Agent, Record<string, HostApp>>>> = {
  darwin: {
    claude_code: { 'claude-desktop': { app_id: 'com.anthropic.claudefordesktop', name: null, path: null } },
    codex: {
      'Codex Desktop': { app_id: 'com.openai.codex', name: null, path: null },
      codex_work_desktop: { app_id: 'com.openai.codex', name: null, path: null },
    },
  },
}

/** The app a client name stands for on this platform, or null when the client does not say. */
export function clientApp(agent: Agent, client: string | null, platform: NodeJS.Platform = process.platform): HostApp | null {
  return client === null ? null : (CLIENT_APPS[platform]?.[agent]?.[client] ?? null)
}

// Apps that run agent sessions: terminals, editors and the agents' own apps (macOS bundle ids; a trailing dot is a
// prefix). Apps seen hosting a session on this machine count too.
export const KNOWN_AGENT_HOSTS: readonly string[] = [
  'com.apple.terminal', 'com.googlecode.iterm2', 'com.mitchellh.ghostty', 'dev.warp.warp-stable', 'com.github.wez.wezterm', 'org.alacritty',
  'net.kovidgoyal.kitty', 'co.zeit.hyper', 'com.microsoft.vscode', 'com.microsoft.vscodeinsiders', 'com.todesktop.230313mzl4w4u92',
  'com.exafunction.windsurf', 'dev.zed.zed', 'com.jetbrains.', 'com.google.android.studio', 'com.anthropic.claudefordesktop', 'com.openai.codex',
]

export function isKnownAgentHost(appId: string): boolean {
  const id = appId.toLowerCase()
  return KNOWN_AGENT_HOSTS.some((h) => (h.endsWith('.') ? id.startsWith(h) : id === h))
}

const HELPER_LIMIT_MS = 5_000

/** Asks the capture helper which app each process runs in. */
export function readHostOf(helper: string, args: readonly string[], pids: readonly number[], extra: readonly string[] = []): Promise<Map<number, HostFinding>> {
  return new Promise((resolve) => {
    const out = new Map<number, HostFinding>()
    if (pids.length === 0) return resolve(out)
    execFile(helper, [...args, '--host-of', ...pids.map(String), ...extra], { encoding: 'utf8', windowsHide: true, timeout: HELPER_LIMIT_MS, killSignal: 'SIGKILL' }, (error, stdout) => {
      if (error) return resolve(out)
      for (const line of stdout.split('\n')) {
        try {
          const o = JSON.parse(line) as { pid?: unknown; basis?: unknown; app?: unknown }
          if (!Number.isSafeInteger(o.pid) || !['responsible', 'parent', 'none'].includes(o.basis as string)) continue
          const a = o.app as Partial<HostApp> | null
          const app = a && typeof a === 'object' && typeof a.app_id === 'string' ? { app_id: a.app_id, name: typeof a.name === 'string' ? a.name : null, path: typeof a.path === 'string' ? a.path : null } : null
          out.set(o.pid as number, { app, basis: app === null ? 'none' : (o.basis as HostBasis) })
        } catch {
          // A line that is not one of the helper's answers is ignored.
        }
      }
      resolve(out)
    })
  })
}

function run(cmd: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: HELPER_LIMIT_MS, killSignal: 'SIGKILL' }, (error, stdout) => resolve(error && !stdout ? null : stdout))
  })
}

// ps prints elapsed time as [[dd-]hh:]mm:ss.
function elapsedMs(etime: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime.trim())
  if (!m) return null
  return (((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000
}

/** The processes Claude Code's sessions folder says run a session (`<pid>.json` files), the latest started first. */
export function claudeSessionFiles(claudeDir: string, session: string): { pid: number; startedAt: number }[] {
  const dir = path.join(claudeDir, 'sessions')
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n))
  } catch {
    return []
  }
  const out: { pid: number; startedAt: number }[] = []
  for (const n of names) {
    let o: { pid?: unknown; sessionId?: unknown; startedAt?: unknown }
    try {
      o = JSON.parse(readFileSync(path.join(dir, n), 'utf8'))
    } catch {
      continue
    }
    if (o.sessionId === session && Number.isSafeInteger(o.pid) && typeof o.startedAt === 'number') out.push({ pid: o.pid as number, startedAt: o.startedAt })
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * Claude Code writes `<pid>.json` in its sessions folder while a session runs. A pid is used only if that process
 * started when the file says, so a reused pid is never taken for the session; of several, the latest started.
 */
export async function claudeSessionProcess(claudeDir: string, session: string, now: () => number = Date.now): Promise<{ pid: number; startedAt: number } | null> {
  for (const f of claudeSessionFiles(claudeDir, session)) {
    const etime = await run('ps', ['-o', 'etime=', '-p', String(f.pid)])
    const ms = etime === null ? null : elapsedMs(etime)
    // ps reports whole seconds.
    if (ms !== null && Math.abs(now() - ms - f.startedAt) < 5_000) return f
  }
  return null
}

export async function claudeSessionPid(claudeDir: string, session: string, now: () => number = Date.now): Promise<number | null> {
  return (await claudeSessionProcess(claudeDir, session, now))?.pid ?? null
}

/** Codex keeps its session log open while the session runs. */
export async function codexSessionPids(file: string): Promise<number[]> {
  const out = await run('lsof', ['-t', '--', file])
  return out === null ? [] : out.split('\n').filter((l) => /^\d+$/.test(l)).map(Number)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM'
  }
}

export interface HostResolverOptions {
  claudeDir: string
  helper: string
  helperArgs?: readonly string[]
  now?: () => number
  // How long a Codex session's process is taken to still hold its log without asking again (lsof is too slow to ask on
  // every read); the capture service passes its reconcile interval.
  revalidateMs: number
}

interface Traced {
  pid: number
  finding: HostFinding
  // Claude Code: when the process started, as its sessions file says.
  startedAt: number | null
  checkedAt: number
}

/** Traces running sessions to the app they run in; one lookup per session process. */
export class HostResolver {
  private readonly opts: HostResolverOptions
  private readonly cache = new Map<string, Traced>()

  constructor(opts: HostResolverOptions) {
    this.opts = opts
  }

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  // A pid that is still alive may have been reused: a Claude Code session is still in that process while it is the
  // latest its sessions folder names; a Codex session while that process holds the log open, asked again after
  // revalidateMs.
  private async stillTraced(agent: Agent, session: string, file: string, t: Traced): Promise<boolean> {
    if (!alive(t.pid)) return false
    if (agent === 'claude_code') {
      const latest = claudeSessionFiles(this.opts.claudeDir, session)[0]
      return latest !== undefined && latest.pid === t.pid && latest.startedAt === t.startedAt
    }
    if (this.now() - t.checkedAt < this.opts.revalidateMs) return true
    if (!(await codexSessionPids(file)).includes(t.pid)) return false
    t.checkedAt = this.now()
    return true
  }

  async resolve(agent: Agent, session: string, file: string): Promise<HostFinding | null> {
    const key = `${agent}:${session}`
    const cached = this.cache.get(key)
    if (cached && (await this.stillTraced(agent, session, file, cached))) return cached.finding
    this.cache.delete(key)
    const claude = agent === 'claude_code' ? await claudeSessionProcess(this.opts.claudeDir, session, this.opts.now) : null
    const pids = agent === 'claude_code' ? (claude ? [claude.pid] : []) : await codexSessionPids(file)
    if (pids.length === 0) return null
    const found = await readHostOf(this.opts.helper, this.opts.helperArgs ?? [], pids)
    for (const pid of pids) {
      const finding = found.get(pid)
      if (!finding) continue
      this.cache.set(key, { pid, finding, startedAt: claude?.startedAt ?? null, checkedAt: this.now() })
      return finding
    }
    return null
  }
}
