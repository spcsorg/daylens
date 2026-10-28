// What an action handler can reach in the shell. Each screen's actions live in their own file under ipc/.
import type { BrowserWindow } from 'electron'
import type { Action, ActionResult, Query } from '../../shared/types.ts'
import type { AssistantRequests } from '../assistantRequests.ts'
import type { Capture } from '../capture.ts'
import type { Prefs } from '../prefs.ts'

export interface Ctx {
  capture: Capture
  win(): BrowserWindow | null
  query<T>(q: Query): Promise<T>
  savePrefs(next: Partial<Prefs>): void
  pushShell(): void
  quit(): void
  requests: AssistantRequests
}

export type ActionHandlers<A extends Action> = { [K in A['a']]: (ctx: Ctx, a: Extract<A, { a: K }>) => Promise<ActionResult> }

/** Sends an operation to the capture service, which owns every write. */
export async function capture(ctx: Ctx, op: Record<string, unknown>, onDeletion?: (state: string) => void): Promise<ActionResult> {
  const r = await ctx.capture.request(op, onDeletion)
  return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error ?? 'failed' }
}
