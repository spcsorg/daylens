// Daylens's MCP server, started by an assistant and spoken to over stdin and stdout, one JSON-RPC message per line. It
// lives exactly as long as its client: it exits when stdin ends or when the process that started it is gone.
// From source: node mcp/main.ts [--data-dir <dir>]. Packaged: ELECTRON_RUN_AS_NODE=1 <Daylens> <app.asar>/build/app/mcp/main.js
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { McpServer } from './server.ts'

// stdout is the transport: anything else printed there breaks the client's connection.
console.log = console.info = console.debug = console.error

// How often the server checks that the process that started it is still there, for a client that dies without closing
// stdin (a stdin a grandchild still holds, or a Windows parent, whose death changes no ppid).
const PARENT_CHECK_MS = 2000

/** Where Daylens keeps its record: the packaged app's folder when this runs from inside it, else the one runs from source use. */
export function dataDir(packaged: boolean): string {
  if (process.env.DAYLENS_V2_DATA_DIR) return process.env.DAYLENS_V2_DATA_DIR
  const name = packaged ? 'Daylens V2' : 'Daylens V2 Dev'
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name)
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), name)
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), name.toLowerCase().replaceAll(' ', '-'))
}

// The version of the app this ships in: the first package.json above this file, v2's from source and the app's packaged.
function version(): string {
  for (let dir = import.meta.dirname; ; dir = path.dirname(dir)) {
    const file = path.join(dir, 'package.json')
    if (existsSync(file)) return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version
    if (path.dirname(dir) === dir) return '0.0.0'
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' } } })
const server = new McpServer({
  dataDir: values['data-dir'] ?? dataDir(import.meta.filename.includes(`app.asar${path.sep}`)),
  version: version(),
  // Search results per group, and the longest span in days one call may read: a month.
  limits: { perGroup: 10, maxDays: 31 },
  // A change that needs no yes is done in well under a second when Daylens runs; a person gets most of a minute to
  // answer before the call returns, under the minute clients give a tool call by default.
  waitMs: { run: 5000, answer: 45_000 },
  log: (line) => process.stderr.write(`${line}\n`),
})

let exiting = false
function exit(): void {
  if (exiting) return
  exiting = true
  server.close()
  process.exit(0)
}

const parent = process.ppid
// A parent that died while this started has already handed it to init (pid 1) on macOS and Linux.
if (process.platform !== 'win32' && parent === 1) exit()
setInterval(() => {
  if (process.ppid !== parent || !alive(parent)) exit()
}, PARENT_CHECK_MS).unref()

process.stdout.on('error', exit)
process.stdin.on('error', exit)
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  if (line.trim() === '') return
  void server.handle(line).then((reply) => {
    if (reply && !exiting) process.stdout.write(`${JSON.stringify(reply)}\n`)
  })
})
lines.on('close', exit)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, exit)
