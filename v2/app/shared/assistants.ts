// What assistants asked Daylens to change, and the person's answer on the card.
import type { AssistantRequest } from '../../storage/assistantRequests.ts'

export type { AssistantRequest } from '../../storage/assistantRequests.ts'

export type AssistantsQuery = { q: 'assistant_requests' }

export interface AssistantsResults {
  assistant_requests: AssistantRequest[]
}

export type AssistantsAction = { a: 'assistant_request'; id: number; allow: boolean }
