// Assistant requests still waiting, for the card and the menu bar; and the log Settings › Assistants shows.
import { pendingRequests, recentRequests } from '../../storage/assistantRequests.ts'
import type { AssistantsQuery, ReadEntry } from '../shared/assistants.ts'
import type { Handlers } from './queries.ts'

const LOG_ROWS = 50

export const assistants: Handlers<AssistantsQuery> = {
  assistant_requests: ({ record }) => pendingRequests(record.db, record.now()),
  assistant_log: ({ record }) => ({
    reads: record.db.prepare('SELECT id, assistant, at_wall_ms, tool, from_wall_ms, to_wall_ms, query FROM assistant_reads ORDER BY id DESC LIMIT ?').all(LOG_ROWS) as ReadEntry[],
    requests: recentRequests(record.db, record.now()),
  }),
}
