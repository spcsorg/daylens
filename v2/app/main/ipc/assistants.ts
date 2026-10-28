// Settings › Assistants: connecting the MCP apps on this computer, testing the server, and answering what an
// assistant asked.
import { clipboard } from 'electron'
import path from 'node:path'
import { check, connect, detect, disconnect, serverSpec, snippet, type ServerSpec } from '../../../mcp/clients.ts'
import type { AssistantsAction } from '../../shared/assistants.ts'
import type { ActionHandlers } from './context.ts'

// This app's own binary as Node, so the entry matches what `connect.ts --installed` writes for the same install.
function spec(): ServerSpec {
  const packaged = import.meta.filename.includes(`app.asar${path.sep}`)
  const s = serverSpec(process.execPath, path.join(import.meta.dirname, '..', '..', '..', 'mcp', packaged ? 'main.js' : 'main.ts'), true)
  if (process.env.DAYLENS_V2_DATA_DIR) s.env.DAYLENS_V2_DATA_DIR = process.env.DAYLENS_V2_DATA_DIR
  return s
}

const apps = () => detect(spec()).map(({ id, name, state }) => ({ id, name, state }))

export const assistants: ActionHandlers<AssistantsAction> = {
  assistant_request: (ctx, a) => ctx.requests.decide(a.id, a.allow),
  assistant_apps: async () => ({ ok: true, result: apps() }),
  assistant_connect: async (_ctx, a) => {
    if (a.on) connect(a.id, spec())
    else disconnect(a.id)
    return { ok: true, result: apps() }
  },
  assistant_test: async () => {
    const r = await check(spec())
    return r.ok ? { ok: true, result: r.tools } : { ok: false, error: r.error }
  },
  assistant_copy_setup: async () => {
    clipboard.writeText(snippet(spec()))
    return { ok: true }
  },
}
