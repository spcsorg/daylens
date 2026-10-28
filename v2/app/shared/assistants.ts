// Settings › Assistants and the request card: the MCP apps on this computer, what assistants read and asked to
// change, and the person's answers.
import type { AssistantRequest } from '../../storage/assistantRequests.ts'

export type { AssistantRequest } from '../../storage/assistantRequests.ts'

export type AssistantAppState = 'connected' | 'not_connected' | 'other_server' | 'unreadable'

export interface AssistantApp {
  id: string
  name: string
  state: AssistantAppState
}

export interface ReadEntry {
  id: number
  assistant: string
  at_wall_ms: number
  tool: string
  from_wall_ms: number
  to_wall_ms: number
  query: string | null
}

export interface AssistantLog {
  reads: ReadEntry[]
  requests: AssistantRequest[]
}

export type AssistantsQuery = { q: 'assistant_requests' } | { q: 'assistant_log' }

export interface AssistantsResults {
  assistant_requests: AssistantRequest[]
  assistant_log: AssistantLog
}

export type AssistantsAction =
  | { a: 'assistant_request'; id: number; allow: boolean }
  // Results: AssistantApp[] for the list, connect and disconnect; the tool names for the test.
  | { a: 'assistant_apps' }
  | { a: 'assistant_connect'; id: string; on: boolean }
  | { a: 'assistant_test' }
  | { a: 'assistant_copy_setup' }
