// A local stand-in for the Anthropic Messages API: it records each request and streams a reply as server-sent events.
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Seen {
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

export type Reply =
  | { kind: 'text'; chunks: readonly string[]; gapMs?: number; stop?: 'end_turn' | 'max_tokens' | 'refusal'; model?: string }
  | { kind: 'error'; status: number; type: string; message: string }

export async function fakeAnthropic(reply: (body: Record<string, unknown>) => Reply): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8').on('data', (c: string) => (raw += c)).on('end', async () => {
      // The key check lists models: it accepts any key but sk-refused.
      if (req.method === 'GET') {
        seen.push({ headers: req.headers, body: {} })
        if (req.headers['x-api-key'] === 'sk-refused') res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
        else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }))
        return
      }
      const body = JSON.parse(raw) as Record<string, unknown>
      seen.push({ headers: req.headers, body })
      const r = reply(body)
      if (r.kind === 'error') {
        res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: r.type, message: r.message } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      send('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: r.model ?? body.model, content: [], stop_reason: null, usage: { input_tokens: 1200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      for (const c of r.chunks) {
        if (r.gapMs) await new Promise((ok) => setTimeout(ok, r.gapMs))
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: c } })
      }
      send('content_block_stop', { index: 0 })
      send('message_delta', { delta: { stop_reason: r.stop ?? 'end_turn', stop_sequence: null, ...(r.stop === 'refusal' ? { stop_details: { type: 'refusal', category: 'cyber', explanation: null } } : {}) }, usage: { output_tokens: 300 } })
      send('message_stop', {})
      res.end()
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((ok) => server.close(() => ok())) }
}
