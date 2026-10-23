// Whether an agent record falls in deleted material, judged the same way live and by the first read's merge.
import type { Agent } from './types.ts'
import type { HostLookup } from './store.ts'

/** Part of a deleted range a session spent in the deleted app, and that app; '' for a span that names none. */
export interface DeletedSpan {
  from: number
  to: number
  app: string
}

export interface Tombstones {
  spans: (agent: Agent, session: string) => readonly DeletedSpan[]
}

/**
 * A record of `session` at `at` is deleted when one of the session's deleted spans covers that time: a span is the
 * part of a deleted range the session spent in the deleted app, so outside it the session's records from other apps
 * stay.
 */
export function deletedAt(t: Tombstones, _look: HostLookup, agent: Agent, session: string, at: number | null): boolean {
  if (at === null) return false
  return t.spans(agent, session).some((d) => at >= d.from && at < d.to)
}
