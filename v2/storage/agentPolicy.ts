// What storage refuses of agent sessions, as the agent gate asks it. Built over a connection and the rules loaded from
// it, so the capture service and the first read's worker (on a read-only connection) decide the same way.
import type Database from 'better-sqlite3'
import type { ExclusionRule } from '../capture/defaults.ts'
import { Privacy } from '../capture/normalize.ts'
import type { GatePolicy, SessionHost } from '../capture/agents/gate.ts'
import { isKnownAgentHost } from '../capture/agents/host.ts'
import type { Span } from '../capture/agents/withheld.ts'
import { DAY_MS, pauseCovers, pauseEnd, type Rules } from './rules.ts'

export class AgentPolicy implements GatePolicy {
  private readonly db: Database.Database
  private readonly rules: Rules
  private readonly now: () => number

  constructor(db: Database.Database, rules: Rules, now: () => number) {
    this.db = db
    this.rules = rules
    this.now = now
  }

  /** Time nothing may be kept from, whatever the app: pauses, deleted ranges and anything older than retention. */
  withheld = (): Span[] => {
    const spans: Span[] = this.rules.pauses.filter((p) => p.app_id === null).map((p) => [p.since_wall_ms, pauseEnd(p)] as const)
    for (const t of this.rules.tombstones) {
      if (t.kind === 'range') spans.push([t.from_wall_ms ?? Number.NEGATIVE_INFINITY, t.to_wall_ms ?? Number.POSITIVE_INFINITY])
    }
    if (this.rules.retentionDays !== null) spans.push([Number.NEGATIVE_INFINITY, this.now() - this.rules.retentionDays * DAY_MS])
    return spans
  }

  /**
   * Whether what an agent session did at a time is kept, given the app it ran in then: not when storage refuses that
   * app's own rows at that time (excluded, or deleted). With the app not known, not while any app that runs agent
   * sessions is excluded, since the session may have run in it.
   */
  hostAllowed = (host: SessionHost | null, atWallMs: number): boolean => {
    if (host?.app_id) return this.rules.accepts(atWallMs, host.app_id, null) && !this.rules.excludedAt(host.app_id, host.app_path, atWallMs)
    const rules = this.rules.exclusionsAt(atWallMs)
    return !this.unknownExcluded(new Privacy(rules), rules)
  }

  /**
   * The times storage refused an app's own rows: its pauses, deletions and exclusions, past ones included. With the app
   * not known, the times an exclusion was in force that holds back sessions whose app is not known.
   */
  hostRefused = (host: SessionHost | null): Span[] => {
    if (!host?.app_id) return this.rules.exclusionPeriods.filter((p) => this.unknownExcluded(p.privacy, [p.rule])).map((p) => [p.from, p.to] as const)
    const app = host.app_id.toLowerCase()
    const spans: Span[] = this.rules.pauses.filter((p) => p.app_id !== null && pauseCovers(p, app)).map((p) => [p.since_wall_ms, pauseEnd(p)] as const)
    for (const t of this.rules.tombstones) if (t.kind === 'source' && t.app_id === app) spans.push([t.from_wall_ms ?? Number.NEGATIVE_INFINITY, t.to_wall_ms ?? Number.POSITIVE_INFINITY])
    for (const p of this.rules.exclusionPeriods) if (p.privacy.excludes(host.app_id, host.app_path)) spans.push([p.from, p.to])
    return spans
  }

  /** Whether the app an agent session ran in is excluded now. */
  hostExcluded = (host: SessionHost): boolean => host.app_id !== null && this.rules.privacy.excludes(host.app_id, host.app_path)

  /** Whether the app an agent session ran in was excluded at a time. */
  hostExcludedAt = (host: SessionHost, atWallMs: number): boolean => host.app_id !== null && this.rules.excludedAt(host.app_id, host.app_path, atWallMs)

  /** The ranges an app was deleted for. */
  appDeleted = (appId: string): Span[] => {
    const app = appId.toLowerCase()
    return this.rules.tombstones.filter((t) => t.kind === 'source' && t.app_id === app).map((t) => [t.from_wall_ms ?? Number.MIN_SAFE_INTEGER, t.to_wall_ms ?? Number.MAX_SAFE_INTEGER] as const)
  }

  /** The gate's policy alone, to assign onto an agent store. */
  gatePolicy(): GatePolicy {
    return { withheld: this.withheld, hostAllowed: this.hostAllowed, hostRefused: this.hostRefused, hostExcluded: this.hostExcluded, hostExcludedAt: this.hostExcludedAt, appDeleted: this.appDeleted }
  }

  /** Whether these rules exclude an app that may have run a session whose app is not known. */
  unknownExcluded(privacy: Privacy, all: readonly ExclusionRule[]): boolean {
    const rules = all.filter((r) => r.match !== 'site')
    if (rules.length === 0) return false
    if (rules.some((r) => r.match === 'app_id' && isKnownAgentHost(r.value))) return true
    if (this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_hosts'`).get() === undefined) return false
    // A session seen in an excluded app is kept without the app's name, so any such session counts.
    if (this.db.prepare(`SELECT 1 FROM agent_hosts WHERE basis = 'excluded' LIMIT 1`).get() !== undefined) return true
    const seen = this.db.prepare('SELECT DISTINCT app_id, app_path FROM agent_hosts WHERE app_id IS NOT NULL').all() as SessionHost[]
    return seen.some((h) => privacy.excludes(h.app_id, h.app_path))
  }
}
