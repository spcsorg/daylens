// Every action the interface can send, each answered by the file of the screen that owns it.
import type { Action, ActionResult } from '../../shared/types.ts'
import { ai } from './ai.ts'
import { assistants } from './assistants.ts'
import type { ActionHandlers, Ctx } from './context.ts'
import { core } from './core.ts'
import { onboarding } from './onboarding.ts'
import { settings } from './settings.ts'

const handlers: ActionHandlers<Action> = { ...core, ...settings, ...onboarding, ...ai, ...assistants }

export function act(ctx: Ctx, a: Action): Promise<ActionResult> {
  const run = handlers[a.a] as (ctx: Ctx, a: Action) => Promise<ActionResult>
  return run(ctx, a)
}
