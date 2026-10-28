import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { check, connect, detect, disconnect, installedSpec, serverSpec, snippet, type Where } from '../../mcp/clients.ts'
import { tmpDir } from '../storage/support.ts'

const SPEC = serverSpec('/Applications/Daylens.app/Contents/MacOS/Daylens', '/Applications/Daylens.app/Contents/Resources/app.asar/build/app/mcp/main.js', true)

function home(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}): Where {
  return { home: tmpDir(), platform, env }
}
const read = (file: string) => readFileSync(file, 'utf8')
const put = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

test('only apps that have run on the computer are listed, at each platform’s own paths', () => {
  const mac = home('darwin')
  mkdirSync(path.join(mac.home, 'Library', 'Application Support', 'Claude'), { recursive: true })
  mkdirSync(path.join(mac.home, '.cursor'))
  assert.deepEqual(detect(SPEC, mac).map((c) => [c.id, c.state, path.relative(mac.home, c.file)]), [
    ['claude', 'not_connected', path.join('Library', 'Application Support', 'Claude', 'claude_desktop_config.json')],
    ['cursor', 'not_connected', path.join('.cursor', 'mcp.json')],
  ])

  const win = home('win32')
  win.env.APPDATA = path.join(win.home, 'AppData', 'Roaming')
  mkdirSync(path.join(win.env.APPDATA, 'Code', 'User'), { recursive: true })
  mkdirSync(path.join(win.home, '.codex'))
  assert.deepEqual(detect(SPEC, win).map((c) => [c.id, path.relative(win.home, c.file)]), [
    ['codex', path.join('.codex', 'config.toml')],
    ['vscode', path.join('AppData', 'Roaming', 'Code', 'User', 'mcp.json')],
  ])

  const linux = home('linux')
  linux.env.XDG_CONFIG_HOME = path.join(linux.home, 'cfg')
  mkdirSync(path.join(linux.home, 'cfg', 'Claude'), { recursive: true })
  put(path.join(linux.home, '.claude.json'), '{}')
  assert.deepEqual(detect(SPEC, linux).map((c) => [c.id, path.relative(linux.home, c.file)]), [
    ['claude', path.join('cfg', 'Claude', 'claude_desktop_config.json')],
    ['claude-code', '.claude.json'],
  ])
})

test('connecting adds Daylens and keeps everything else in the file; an older Daylens entry is replaced', () => {
  const w = home('darwin')
  const file = path.join(w.home, '.claude.json')
  put(file, JSON.stringify({ numStartups: 4, mcpServers: { other: { type: 'stdio', command: 'other' }, daylens: { type: 'stdio', command: '/old/electron', args: ['/old/v1/server.mjs'] } } }))
  assert.equal(detect(SPEC, w)[0]!.state, 'other_server')
  connect('claude-code', SPEC, w)
  const json = JSON.parse(read(file))
  assert.equal(json.numStartups, 4)
  assert.deepEqual(json.mcpServers.other, { type: 'stdio', command: 'other' })
  assert.deepEqual(json.mcpServers.daylens, { type: 'stdio', command: SPEC.command, args: SPEC.args, env: { ELECTRON_RUN_AS_NODE: '1' } })
  assert.equal(detect(SPEC, w)[0]!.state, 'connected')
  disconnect('claude-code', w)
  assert.deepEqual(JSON.parse(read(file)).mcpServers, { other: { type: 'stdio', command: 'other' } })
})

test('VS Code keeps its servers under "servers"; a new config file is created with its folder', () => {
  const w = home('linux', {})
  mkdirSync(path.join(w.home, '.config', 'Code', 'User'), { recursive: true })
  connect('vscode', SPEC, w)
  assert.deepEqual(JSON.parse(read(path.join(w.home, '.config', 'Code', 'User', 'mcp.json'))), { servers: { daylens: { type: 'stdio', ...SPEC } } })
  connect('windsurf', SPEC, w)
  assert.deepEqual(JSON.parse(read(path.join(w.home, '.codeium', 'windsurf', 'mcp_config.json'))).mcpServers.daylens, SPEC)
})

test('a config that is not plain JSON is reported and never rewritten', () => {
  const w = home('darwin')
  const file = path.join(w.home, '.cursor', 'mcp.json')
  const text = '{\n  // my servers\n  "mcpServers": {}\n}\n'
  put(file, text)
  assert.equal(detect(SPEC, w)[0]!.state, 'unreadable')
  assert.throws(() => connect('cursor', SPEC, w), (e: Error) => e.message === "Cursor's settings file isn't plain JSON, so Daylens won't rewrite it. Add Daylens by hand with Copy setup." && !e.message.includes('my servers'))
  assert.equal(read(file), text)
})

test('Codex’s TOML gains one table for Daylens, replacing an older one and its env, and keeps the rest', () => {
  const w = home('darwin')
  const file = path.join(w.home, '.codex', 'config.toml')
  put(
    file,
    [
      'model = "example"',
      '',
      '[mcp_servers.daylens]',
      'command = "/old/electron"',
      'args = ["/old/v1/server.mjs"]',
      '',
      '[mcp_servers.daylens.env]',
      'ELECTRON_RUN_AS_NODE = "1"',
      '',
      '[mcp_servers.other]',
      'command = "other"',
      '',
    ].join('\n'),
  )
  assert.equal(detect(SPEC, w)[0]!.state, 'other_server')
  connect('codex', SPEC, w)
  assert.equal(
    read(file),
    [
      'model = "example"',
      '',
      '[mcp_servers.other]',
      'command = "other"',
      '',
      '[mcp_servers.daylens]',
      `command = "${SPEC.command}"`,
      `args = ["${SPEC.args[0]}"]`,
      'env = { ELECTRON_RUN_AS_NODE = "1" }',
      '',
    ].join('\n'),
  )
  assert.equal(detect(SPEC, w)[0]!.state, 'connected')
  disconnect('codex', w)
  assert.equal(read(file), 'model = "example"\n\n[mcp_servers.other]\ncommand = "other"\n')
})

test('an installed Daylens is started as Node from its own binary on every platform', () => {
  assert.deepEqual(installedSpec('/Applications/Daylens.app', 'darwin'), SPEC)
  const win = installedSpec('C:\\Users\\a\\AppData\\Local\\Programs\\Daylens', 'win32')
  assert.equal(win.command, 'C:\\Users\\a\\AppData\\Local\\Programs\\Daylens\\Daylens.exe')
  assert.equal(win.args[0], 'C:\\Users\\a\\AppData\\Local\\Programs\\Daylens\\resources\\app.asar\\build\\app\\mcp\\main.js')
  assert.deepEqual(win.env, { ELECTRON_RUN_AS_NODE: '1' })
  assert.deepEqual(JSON.parse(snippet(SPEC)), { mcpServers: { daylens: SPEC } })
})

test('the check starts the server as a client would and lists its tools', async () => {
  const r = await check(serverSpec(process.execPath, path.resolve(import.meta.dirname, '../../mcp/main.ts'), false))
  assert.ok(r.ok && r.tools.includes('get_day'), JSON.stringify(r))
  const bad = await check(serverSpec(process.execPath, path.join(tmpDir(), 'missing.js'), false))
  assert.equal(bad.ok, false)
  // A moved Daylens: the command itself is gone. This must come back as a failure, not throw in the app.
  const gone = await check(serverSpec(path.join(tmpDir(), 'Daylens'), 'main.js', true))
  assert.equal(gone.ok, false)
  const notMcp = await check({ command: process.execPath, args: ['-e', 'console.log("hello"); setTimeout(() => {}, 5000)'], env: {} })
  assert.deepEqual(notMcp, { ok: false, error: 'not an MCP server: hello' })
})

// Windows has no POSIX modes, and symlinks there need a privilege most accounts lack.
test('a config file keeps its permissions, and a symlinked one is written where it points', { skip: process.platform === 'win32' }, () => {
  const w = home('darwin')
  const file = path.join(w.home, '.claude.json')
  put(file, '{}')
  chmodSync(file, 0o600)
  connect('claude-code', SPEC, w)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  const real = path.join(w.home, 'dotfiles', 'config.toml')
  put(real, 'model = "example"\n')
  mkdirSync(path.join(w.home, '.codex'))
  symlinkSync(real, path.join(w.home, '.codex', 'config.toml'))
  connect('codex', SPEC, w)
  assert.ok(lstatSync(path.join(w.home, '.codex', 'config.toml')).isSymbolicLink())
  assert.match(read(real), /^model = "example"\n\n\[mcp_servers\.daylens\]/)
})

test('Codex with Daylens written another way TOML allows is reported and never rewritten', () => {
  for (const form of ['[mcp_servers]\ndaylens = { command = "x" }\n', 'mcp_servers.daylens.command = "x"\n', "[mcp_servers.'daylens']\ncommand = \"x\"\n"]) {
    const w = home('darwin')
    const file = path.join(w.home, '.codex', 'config.toml')
    put(file, form)
    assert.equal(detect(SPEC, w)[0]!.state, 'unreadable')
    assert.throws(() => connect('codex', SPEC, w))
    assert.equal(read(file), form)
  }
})
