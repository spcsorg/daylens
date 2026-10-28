// Settings › Assistants: connecting the MCP apps on this computer, testing the server, and answering what an
// assistant asked.
import { clipboard } from 'electron'
import { check, connect, detect, disconnect, serverSpec, snippet, type ServerSpec } from '../../../mcp/clients.ts'
import type { ActionResult } from '../../shared/types.ts'
import type { AssistantsAction } from '../../shared/assistants.ts'
import { paths } from '../paths.ts'
import type { ActionHandlers } from './context.ts'

// This app's own binary as Node, so the entry matches what `connect.ts --installed` writes for the same install.
function spec(): ServerSpec {
  const s = serverSpec(process.execPath, paths.mcpServer, true)
  if (process.env.DAYLENS_V2_DATA_DIR) s.env.DAYLENS_V2_DATA_DIR = process.env.DAYLENS_V2_DATA_DIR
  return s
}

// Opened from the disk image, or from Downloads before it was moved, macOS runs a temporary copy whose path goes away.
const MOVE_FIRST: ActionResult | null = /\/AppTranslocation\/|^\/Volumes\//.test(process.execPath) ? { ok: false, error: 'Move Daylens to Applications, open it from there, then connect.' } : null

const apps = () => detect(spec()).map(({ id, name, state }) => ({ id, name, state }))

export const assistants: ActionHandlers<AssistantsAction> = {
  assistant_request: (ctx, a) => ctx.requests.decide(a.id, a.allow),
  assistant_apps: async () => ({ ok: true, result: apps() }),
  assistant_connect: async (_ctx, a) => {
    if (a.on && MOVE_FIRST) return MOVE_FIRST
    if (a.on) connect(a.id, spec())
    else disconnect(a.id)
    return { ok: true, result: apps() }
  },
  assistant_test: async () => {
    const r = await check(spec())
    return r.ok ? { ok: true, result: r.tools } : { ok: false, error: r.error }
  },
  assistant_copy_setup: async () => {
    if (MOVE_FIRST) return MOVE_FIRST
    clipboard.writeText(snippet(spec()))
    return { ok: true }
  },
}
