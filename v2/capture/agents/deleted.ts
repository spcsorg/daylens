// Whether an agent record falls in deleted material, judged the same way live and by the first read's merge. A
// subagent's records are judged by what was deleted of every session above it too, through the parent its own log
// names, so one read for the first time after its parent's deletion is still refused.
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
 * A record of `session` at `at` is deleted when one of the session's deleted spans covers that time: a span is the
 * part of a deleted range the session spent in the deleted app, so outside it the session's records from other apps
 * stay. Inside a span of a session above it, the record goes unless the session (or one between) has an app of its own
 * then that is another app: the deletion removed the spans it would otherwise inherit, so it cannot be judged by them.
 */
export function deletedAt(t: Tombstones, look: HostLookup, agent: Agent, session: string, at: number | null): boolean {
  if (at === null) return false
  if (t.spans(agent, session).some((d) => at >= d.from && at < d.to)) return true
  const below = [session]
  for (const a of above(look, agent, session)) {
    for (const d of t.spans(agent, a)) {
      if (at < d.from || at >= d.to) continue
      const own = ownApp(look, agent, below, at)
      if (d.app === '' || own === null || own === d.app) return true
    }
    below.push(a)
  }
  return false
}

// The app named by the nearest span of these sessions' own at a time; null when none names one.
function ownApp(look: HostLookup, agent: Agent, sessions: readonly string[], at: number): string | null {
  for (const s of sessions) {
    const span = look.span(agent, s, at)
    if (span) return span.basis === 'excluded' ? null : (span.app_id?.toLowerCase() ?? null)
  }
  return null
}
