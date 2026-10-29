// Starts Daylens on the invented pricing-memo world in a throwaway folder, for showing the app on camera: nothing on this
// computer is read or recorded, and the printed MCP config lets Claude Code read the same world. macOS and Linux.
// Usage: npm run demo [-- <Electron flags>]
// The folder is reseeded on every run, since the world is dated from today; an AI key saved in Settings stays.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const v2 = path.resolve(import.meta.dirname, '..', '..')
const root = path.join(os.tmpdir(), 'daylens-demo')
const data = path.join(root, 'data')
const home = path.join(root, 'home')
const shell = path.join(root, 'shell')
const keyFile = path.join(data, 'anthropic-key')

const key = existsSync(keyFile) ? readFileSync(keyFile) : null
rmSync(root, { recursive: true, force: true })
for (const d of [path.join(home, '.claude'), path.join(home, '.codex'), shell]) mkdirSync(d, { recursive: true })
execFileSync(process.execPath, [path.join(v2, 'app', 'tools', 'seed.ts'), '--data-dir', data], { stdio: ['ignore', 'ignore', 'inherit'] })
if (key) writeFileSync(keyFile, key, { mode: 0o600 })
writeFileSync(path.join(shell, 'shell.json'), JSON.stringify({ onboarded: true }))

const mcp = path.join(root, 'mcp.json')
writeFileSync(mcp, JSON.stringify({ mcpServers: { daylens: { command: process.execPath, args: [path.join(v2, 'mcp', 'main.ts'), '--data-dir', data] } } }, null, 2))
process.stdout.write(`Daylens demo: the invented pricing-memo world in ${data}

Claude Code on this world only, not your own record:
  claude --mcp-config ${mcp} --strict-mcp-config

Any other assistant, in its MCP config:
${readFileSync(mcp, 'utf8')}
`)

// HOME and the rest point every reader of this computer's own files (browser history, agent sessions, assistant
// configs) at an empty folder; the stand-in helper reports invented windows instead of the real ones.
const env = {
  ...process.env,
  HOME: home,
  DAYLENS_V2_DATA_DIR: data,
  DAYLENS_SHELL_DIR: shell,
  DAYLENS_V2_HISTORY_HOME: home,
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  CODEX_HOME: path.join(home, '.codex'),
  DAYLENS_V2_BROWSER_SOCKET: path.join(root, 'browser.sock'),
  DAYLENS_HELPER: path.join(v2, 'app', 'tools', 'demo-helper.sh'),
}
const electron = createRequire(import.meta.url)('electron') as string
spawn(electron, [path.join(v2, 'app', 'main', 'main.ts'), ...process.argv.slice(2)], { env, stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 1))
