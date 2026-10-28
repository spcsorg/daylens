// Drives a running Daylens window over the DevTools protocol (the app started with --remote-debugging-port), for
// screenshots and checks on invented data.
// Usage: node app/tools/cdp.ts <port> eval '<js>' | shot <file.png> | wait <ms>  (several commands may follow each other)
import { writeFileSync } from 'node:fs'

const [port, ...cmds] = process.argv.slice(2)
const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[]
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('file:'))
if (!page) throw new Error('no Daylens window')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map<number, (v: { result?: Record<string, unknown>; error?: unknown }) => void>()
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(String(e.data)) as { id?: number; result?: Record<string, unknown>; error?: unknown }
  if (msg.id !== undefined) pending.get(msg.id)?.(msg)
})
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const n = ++id
    pending.set(n, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result ?? {})))
    ws.send(JSON.stringify({ id: n, method, params }))
  })

for (let i = 0; i < cmds.length; i += 2) {
  const [cmd, arg] = [cmds[i], cmds[i + 1]!]
  if (cmd === 'eval') {
    const r = await send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true })
    const v = (r.result as { value?: unknown })?.value
    if (v !== undefined) process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v)}\n`)
  } else if (cmd === 'shot') {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(arg, Buffer.from(String(r.data), 'base64'))
  } else if (cmd === 'scheme') {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: arg }] })
  } else if (cmd === 'wait') {
    await new Promise((r) => setTimeout(r, Number(arg)))
  }
}
ws.close()
