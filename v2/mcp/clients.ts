// Connecting assistants: finds the MCP apps on this computer and adds Daylens's server to each one's own config file,
// leaving everything else in the file as it was. Used by the main process (Settings › Assistants) and by connect.ts.
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

export const SERVER_NAME = 'daylens'

/** How a client starts the server. */
export interface ServerSpec {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface Where {
  home: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
}

type Format = 'mcpServers' | 'claudeCode' | 'vscode' | 'codex'

interface ClientDef {
  id: string
  name: string
  // The config file, and the folder whose presence means the app has run on this computer.
  file: (w: Where) => string
  sign: (w: Where) => string
  format: Format
}

export type ClientState = 'connected' | 'not_connected' | 'other_server' | 'unreadable'

export interface Client {
  id: string
  name: string
  file: string
  state: ClientState
}

const appSupport = (w: Where, ...p: string[]) =>
  w.platform === 'darwin'
    ? path.join(w.home, 'Library', 'Application Support', ...p)
    : w.platform === 'win32'
      ? path.join(w.env.APPDATA ?? path.join(w.home, 'AppData', 'Roaming'), ...p)
      : path.join(w.env.XDG_CONFIG_HOME ?? path.join(w.home, '.config'), ...p)
const codexHome = (w: Where) => w.env.CODEX_HOME ?? path.join(w.home, '.codex')

// ChatGPT's desktop app connects only to remote servers, so it isn't here; any other app uses the snippet.
const CLIENTS: readonly ClientDef[] = [
  { id: 'claude', name: 'Claude', file: (w) => appSupport(w, 'Claude', 'claude_desktop_config.json'), sign: (w) => appSupport(w, 'Claude'), format: 'mcpServers' },
  { id: 'claude-code', name: 'Claude Code', file: (w) => path.join(w.home, '.claude.json'), sign: (w) => path.join(w.home, '.claude.json'), format: 'claudeCode' },
  { id: 'codex', name: 'Codex', file: (w) => path.join(codexHome(w), 'config.toml'), sign: codexHome, format: 'codex' },
  { id: 'cursor', name: 'Cursor', file: (w) => path.join(w.home, '.cursor', 'mcp.json'), sign: (w) => path.join(w.home, '.cursor'), format: 'mcpServers' },
  { id: 'vscode', name: 'VS Code', file: (w) => appSupport(w, 'Code', 'User', 'mcp.json'), sign: (w) => appSupport(w, 'Code', 'User'), format: 'vscode' },
  { id: 'windsurf', name: 'Windsurf', file: (w) => path.join(w.home, '.codeium', 'windsurf', 'mcp_config.json'), sign: (w) => path.join(w.home, '.codeium', 'windsurf'), format: 'mcpServers' },
  { id: 'gemini', name: 'Gemini CLI', file: (w) => path.join(w.home, '.gemini', 'settings.json'), sign: (w) => path.join(w.home, '.gemini'), format: 'mcpServers' },
]

export const here = (): Where => ({ home: os.homedir(), platform: process.platform, env: process.env })

/** The server as the app running this starts it: its own binary as Node, so nobody needs Node installed. */
export function serverSpec(execPath: string, script: string, asNode: boolean): ServerSpec {
  return { command: execPath, args: [script], env: asNode ? { ELECTRON_RUN_AS_NODE: '1' } : {} }
}

function entry(spec: ServerSpec, format: Format): Record<string, unknown> {
  const base = { command: spec.command, args: spec.args, ...(Object.keys(spec.env).length ? { env: spec.env } : {}) }
  return format === 'mcpServers' || format === 'codex' ? base : { type: 'stdio', ...base }
}

/** What to paste into any other MCP app's config. */
export function snippet(spec: ServerSpec): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: entry(spec, 'mcpServers') } }, null, 2)
}

// --- Codex's TOML: only our own table is read or written, line by line --------------------------------------------

const OUR_TABLE = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*"?${SERVER_NAME}"?\\s*(\\.[^\\]]*)?\\]\\s*(#.*)?$`)

// Daylens written any other way TOML allows (under [mcp_servers], as dotted keys, single-quoted) can't be edited line
// by line, and adding our table beside it would make a duplicate key that breaks the whole file.
const OTHER_FORM = new RegExp(`^\\s*(\\[\\s*mcp_servers\\s*\\.\\s*'${SERVER_NAME}'|(mcp_servers\\s*\\.\\s*)?["']?${SERVER_NAME}["']?\\s*[.=])`)

/** The file's lines split into ours (our table and its subtables) and the rest. */
function splitToml(toml: string): { ours: string[]; rest: string[] } {
  const out = { ours: [] as string[], rest: [] as string[] }
  let inside = false
  for (const line of toml.split('\n')) {
    if (/^\s*\[/.test(line)) inside = OUR_TABLE.test(line)
    ;(inside ? out.ours : out.rest).push(line)
  }
  if (out.rest.some((l) => OTHER_FORM.test(l))) throw new Error('Daylens is already set up in this file in a form it can’t edit')
  return out
}

function codexTable(spec: ServerSpec): string {
  const env = Object.entries(spec.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
  return [`[mcp_servers.${SERVER_NAME}]`, `command = ${JSON.stringify(spec.command)}`, `args = [${spec.args.map((a) => JSON.stringify(a)).join(', ')}]`, ...(env.length ? [`env = { ${env.join(', ')} }`] : [])].join('\n')
}

// --- reading and writing one client's file -------------------------------------------------------------------------

function container(format: Format): string {
  return format === 'vscode' ? 'servers' : 'mcpServers'
}

/** Our entry as the file has it now, undefined when there is none; throws when the file can't be read as its format. */
function current(def: ClientDef, w: Where): unknown {
  const file = def.file(w)
  if (!existsSync(file)) return undefined
  const text = readFileSync(file, 'utf8')
  if (def.format === 'codex') {
    const { ours } = splitToml(text)
    return ours.length ? ours.join('\n') : undefined
  }
  if (text.trim() === '') return undefined
  const json = JSON.parse(text) as Record<string, Record<string, unknown> | undefined>
  return json[container(def.format)]?.[SERVER_NAME]
}

function same(def: ClientDef, found: unknown, spec: ServerSpec): boolean {
  if (def.format === 'codex') return typeof found === 'string' && found.replaceAll('\r', '').trim() === codexTable(spec)
  return JSON.stringify(found) === JSON.stringify(entry(spec, def.format))
}

/** Replaces the file in one step, through a symlink to what it points at, keeping its permissions (often 0600). */
function writeAtomic(file: string, text: string): void {
  const target = existsSync(file) ? realpathSync(file) : file
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600
  mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.daylens-${process.pid}.tmp`
  try {
    writeFileSync(tmp, text, { mode })
    chmodSync(tmp, mode)
    renameSync(tmp, target)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

function update(def: ClientDef, w: Where, spec: ServerSpec | null): void {
  const file = def.file(w)
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (def.format === 'codex') {
    const rest = splitToml(text).rest.join('\n').replace(/\n+$/, '')
    writeAtomic(file, `${[rest, spec ? codexTable(spec) : ''].filter(Boolean).join('\n\n')}\n`)
    return
  }
  // A file that isn't plain JSON (comments, a typo) is never rewritten: what it holds isn't ours to lose.
  let json: Record<string, unknown>
  try {
    json = text.trim() === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
  } catch {
    // JSON.parse's message quotes the file, which can hold keys.
    throw new Error(`${def.name}'s settings file isn't plain JSON, so Daylens won't rewrite it. Add Daylens by hand with Copy setup.`)
  }
  const key = container(def.format)
  const servers = { ...((json[key] as Record<string, unknown> | undefined) ?? {}) }
  if (spec) servers[SERVER_NAME] = entry(spec, def.format)
  else delete servers[SERVER_NAME]
  writeAtomic(file, `${JSON.stringify({ ...json, [key]: servers }, null, 2)}\n`)
}

// --- the API --------------------------------------------------------------------------------------------------------

/** Every supported app that has run on this computer, and whether it starts this server. */
export function detect(spec: ServerSpec, w: Where = here()): Client[] {
  return CLIENTS.filter((c) => existsSync(c.sign(w))).map((c) => {
    let state: ClientState
    try {
      const found = current(c, w)
      state = found === undefined ? 'not_connected' : same(c, found, spec) ? 'connected' : 'other_server'
    } catch {
      state = 'unreadable'
    }
    return { id: c.id, name: c.name, file: c.file(w), state }
  })
}

function def(id: string): ClientDef {
  const c = CLIENTS.find((x) => x.id === id)
  if (!c) throw new Error(`no assistant app ${id}`)
  return c
}

/** Adds this server to the app's config, replacing an older Daylens entry. The app picks it up on its next start. */
export function connect(id: string, spec: ServerSpec, w: Where = here()): void {
  update(def(id), w, spec)
}

export function disconnect(id: string, w: Where = here()): void {
  const c = def(id)
  if (existsSync(c.file(w)) && current(c, w) !== undefined) update(c, w, null)
}

/** Starts the server as a client would and lists its tools: the names on success, else why it failed. */
export function check(spec: ServerSpec, timeoutMs = 10_000): Promise<{ ok: true; tools: string[] } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    let finished = false
    const done = (r: { ok: true; tools: string[] } | { ok: false; error: string }) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      child.stdin.end()
      child.kill()
      resolve(r)
    }
    const timer = setTimeout(() => done({ ok: false, error: `no answer in ${timeoutMs / 1000} s${stderr ? `: ${stderr.trim()}` : ''}` }), timeoutMs)
    child.on('error', (err) => done({ ok: false, error: err.message }))
    child.on('exit', (code) => done({ ok: false, error: `the server exited (${code})${stderr ? `: ${stderr.trim()}` : ''}` }))
    child.stderr.on('data', (d) => (stderr += d))
    // A command that is missing or exits at once breaks the pipe; 'error' or 'exit' already reports why.
    child.stdin.on('error', () => {})
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const m = JSON.parse(line) as { id: number; result?: { tools?: { name: string }[] } }
        if (m.id === 1) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
        if (m.id === 2) done({ ok: true, tools: (m.result?.tools ?? []).map((t) => t.name) })
      } catch {
        done({ ok: false, error: `not an MCP server: ${line.slice(0, 200)}` })
      }
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'daylens-check', version: '1' } } })}\n`)
  })
}

/** The server inside an installed Daylens: the .app on macOS, the install folder on Windows and Linux. */
export function installedSpec(appPath: string, platform: NodeJS.Platform = process.platform): ServerSpec {
  const p = platform === 'win32' ? path.win32 : path.posix
  const resources = platform === 'darwin' ? p.join(appPath, 'Contents', 'Resources') : p.join(appPath, 'resources')
  const binary = platform === 'darwin' ? p.join(appPath, 'Contents', 'MacOS', 'Daylens') : p.join(appPath, platform === 'win32' ? 'Daylens.exe' : 'daylens')
  return serverSpec(binary, p.join(resources, 'app.asar', 'build', 'app', 'mcp', 'main.js'), true)
}
