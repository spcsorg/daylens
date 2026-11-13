import type { TodayAction } from '../../shared/today.ts'
import { capture, type ActionHandlers } from './context.ts'

export const today: ActionHandlers<TodayAction> = {
  edit_hour: (ctx, a) => capture(ctx, { op: 'edit_hour', start_ms: a.start_ms, title: a.title, summary: a.summary }),
  undo_hour_edit: (ctx, a) => capture(ctx, { op: 'undo_hour_edit', start_ms: a.start_ms, edit_id: a.edit_id }),
}
