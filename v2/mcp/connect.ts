// Connects assistants from the command line, as Settings › Assistants does.
// node mcp/connect.ts                    lists the assistant apps found and whether each starts Daylens
// node mcp/connect.ts --all | --app <id>  connects them (repeat --app); --remove <id> disconnects one
// node mcp/connect.ts --snippet           prints the config to paste into any other MCP app
// node mcp/connect.ts --check             starts the server once and lists its tools
// --installed <path>  uses the server inside an installed Daylens (the .app, or the install folder) instead of this checkout's
import path from 'node:path'
import { parseArgs } from 'node:util'
import { check, connect, detect, disconnect, installedSpec, serverSpec, snippet } from './clients.ts'

const { values } = parseArgs({
  options: {
    all: { type: 'boolean' },
    app: { type: 'string', multiple: true },
    remove: { type: 'string', multiple: true },
    snippet: { type: 'boolean' },
    check: { type: 'boolean' },
    installed: { type: 'string' },
  },
})
const spec = values.installed ? installedSpec(path.resolve(values.installed)) : serverSpec(process.execPath, path.join(import.meta.dirname, 'main.ts'), false)
const out = (line: string) => process.stdout.write(`${line}\n`)
const STATES = { connected: 'connected', not_connected: 'not connected', other_server: 'starts another Daylens server', unreadable: "config can't be read" }

if (values.snippet) {
  out(snippet(spec))
} else if (values.check) {
  const r = await check(spec)
  out(r.ok ? `ok: ${r.tools.join(', ')}` : `failed: ${r.error}`)
  process.exitCode = r.ok ? 0 : 1
} else {
  const found = detect(spec)
  const ids = values.all ? found.map((c) => c.id) : (values.app ?? [])
  for (const id of ids) {
    try {
      connect(id, spec)
      out(`connected ${id}: restart it to use Daylens`)
    } catch (err) {
      out(`couldn't connect ${id}: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    }
  }
  for (const id of values.remove ?? []) {
    disconnect(id)
    out(`disconnected ${id}`)
  }
  for (const c of detect(spec)) out(`${c.id.padEnd(12)} ${c.name.padEnd(12)} ${STATES[c.state].padEnd(30)} ${c.file}`)
  if (found.length === 0) out('No assistant apps found. Use --snippet to set one up by hand.')
}
