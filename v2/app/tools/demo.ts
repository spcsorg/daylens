// Starts Daylens on the invented pricing-memo world in a throwaway folder, for showing the app on camera: nothing on this
// computer is read or recorded, and the printed MCP config lets Claude Code read the same world. macOS and Linux.
// Usage: npm run demo [-- <Electron flags>]
// The folder is reseeded on every run, since the world is dated from today; an AI key saved in Settings stays.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeWorld, source } from './world.ts'

const v2 = path.resolve(import.meta.dirname, '..', '..')
const root = path.join(os.tmpdir(), 'daylens-demo')
const keyFile = path.join(root, 'data', 'anthropic-key')

// Electron's lock names the running demo's pid: reseeding under it would delete the database it has open.
function running(): boolean {
  try {
    process.kill(Number(readlinkSync(path.join(root, 'shell', 'SingletonLock')).split('-').pop()), 0)
    return true
  } catch {
    return false
  }
}
if (running()) {
  process.stderr.write('A Daylens demo is already running. Quit it, then run npm run demo again.\n')
  process.exit(1)
}

const key = existsSync(keyFile) ? readFileSync(keyFile) : null
// On camera the app keeps this computer's own time zone and clock.
const { data, env } = makeWorld({ root, zone: null })
if (key) writeFileSync(keyFile, key, { mode: 0o600 })

const mcp = path.join(root, 'mcp.json')
writeFileSync(mcp, JSON.stringify({ mcpServers: { daylens: { command: process.execPath, args: [path.join(v2, 'mcp', 'main.ts'), '--data-dir', data] } } }, null, 2))
process.stdout.write(`Daylens demo: the invented pricing-memo world in ${data}

Claude Code on this world only, not your own record:
  claude --mcp-config ${mcp} --strict-mcp-config

Any other assistant, in its MCP config:
${readFileSync(mcp, 'utf8')}
`)

const { command, args } = source()
spawn(command, [...args, ...process.argv.slice(2)], { env, stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 1))
