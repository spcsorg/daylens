// Assistant requests still waiting, for the card and the menu bar.
import { pendingRequests } from '../../storage/assistantRequests.ts'
import type { AssistantsQuery } from '../shared/assistants.ts'
import type { Handlers } from './queries.ts'

export const assistants: Handlers<AssistantsQuery> = {
  assistant_requests: ({ record }) => pendingRequests(record.db, Date.now()),
}
