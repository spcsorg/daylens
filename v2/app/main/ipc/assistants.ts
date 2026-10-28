// The person's answer to what an assistant asked.
import type { AssistantsAction } from '../../shared/assistants.ts'
import type { ActionHandlers } from './context.ts'

export const assistants: ActionHandlers<AssistantsAction> = {
  assistant_request: (ctx, a) => ctx.requests.decide(a.id, a.allow),
}
