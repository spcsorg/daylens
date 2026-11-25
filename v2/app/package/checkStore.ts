// Proves an installed Store package, from outside it: Daylens started from Start runs its capture helper from the
// package, and an assistant reaches the record the app writes through the alias Settings › Assistants gives it.
// Usage, after Add-AppxPackage: node app/package/checkStore.ts <Package/Identity/Name>
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { storeSpec } from '../../mcp/clients.ts'

const name = process.argv[2]
if (process.platform !== 'win32' || !name) throw new Error('usage, on Windows: node app/package/checkStore.ts <identity name>')
const ps = (script: string) => execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim()

const family = ps(`(Get-AppxPackage -Name '${name}').PackageFamilyName`)
if (!family) throw new Error(`${name} is not installed`)
ps(`Start-Process 'shell:AppsFolder\\${family}!Daylens'`)

// The helper, by the path it runs from: a copy outside the package would prove nothing.
const helper = () => ps(`(Get-Process daylens-capture-windows -ErrorAction SilentlyContinue | Select-Object -First 1).Path`)
const deadline = Date.now() + 60_000
let running = ''
while (!(running = helper()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000))
if (!running) throw new Error('the capture helper did not start within 60 s')
if (!running.includes('\\WindowsApps\\')) throw new Error(`the capture helper runs from ${running}, not the package`)
process.stdout.write(`capture helper running: ${running}\n`)

// get_status reads the database; a server that can't find the app's record says so instead.
const spec = storeSpec(process.env.LOCALAPPDATA!)
const server = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'inherit'] })
const timer = setTimeout(() => {
  server.kill()
  throw new Error('the MCP server did not answer within 30 s')
}, 30_000)
const send = (id: number, method: string, params: object) => server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
let answered = false
send(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'daylens-check', version: '1' } })
for await (const line of createInterface({ input: server.stdout })) {
  const m = JSON.parse(line) as { id: number; result?: { isError?: boolean; content?: { text: string }[] } }
  if (m.id === 1) send(2, 'tools/call', { name: 'get_status', arguments: {} })
  if (m.id !== 2) continue
  clearTimeout(timer)
  server.kill()
  const text = m.result?.content?.map((c) => c.text).join('\n') ?? line
  if (!m.result || m.result.isError) throw new Error(`get_status through the alias failed: ${text}`)
  process.stdout.write(`get_status through the alias:\n${text}\n`)
  answered = true
  break
}
if (!answered) throw new Error('the MCP server exited without answering')
