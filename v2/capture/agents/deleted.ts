// Whether an agent record falls in deleted material, judged the same way live and by the first read's merge. A
// subagent's records are judged by what was deleted of every session above it too, through the parent its own log
// names, so one read for the first time after its parent's deletion is still refused.
import type { Agent } from './types.ts'
import type { HostLookup } from './store.ts'

/** An app deletion's tombstone for a session: the app and the range it deleted ('' for spans that name no app). */
export interface DeletedSpan {
  from: number
  to: number
  app: string
}

export interface Tombstones {
  spans: (agent: Agent, session: string) => readonly DeletedSpan[]
  // Deleted for good (agent_deleted_sessions).
  session: (agent: Agent, session: string) => boolean
}

function above(look: HostLookup, agent: Agent, session: string): string[] {
  const chain: string[] = []
  for (let s = look.parent(agent, session); s !== null && s !== session && !chain.includes(s); s = look.parent(agent, s)) chain.push(s)
  return chain
}

/** Whether the session, or a session above it, was deleted for good. */
export function deletedSession(t: Tombstones, look: HostLookup, agent: Agent, session: string): boolean {
  return t.session(agent, session) || above(look, agent, session).some((s) => t.session(agent, s))
}

/**
 * A record of `session` at `at` is deleted when a deleted span of the session, or of any session above it, covers
 * that time, whatever app the record resolves to: the tombstone keeps only the app and the range, not when the session
 * was in the app.
 */
export function deletedAt(t: Tombstones, look: HostLookup, agent: Agent, session: string, at: number | null): boolean {
  if (at === null) return false
  return [session, ...above(look, agent, session)].some((s) => t.spans(agent, s).some((d) => at >= d.from && at < d.to))
}
