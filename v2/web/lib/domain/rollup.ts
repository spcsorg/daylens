import type { Block, DailyRollup, Org, Project } from "./model";
import { addDays, atLocalTime, dayStart, datesBetween, isoWeekday, localDate } from "./time";

export type Policy = {
  timeZone: string;
  coreStart: number;
  coreEnd: number;
  workingDays: number[];
};

export type RollupBlock<P> = {
  start: number;
  end: number;
  kind: "work" | "idle" | "away";
  projectId?: P;
  deleted?: boolean;
};

export type RollupRow<P> = {
  projectId?: P;
  seconds: number;
  billableSeconds: number;
  coreSeconds: number;
  idleSeconds: number;
};

function overlap(a: number, b: number, c: number, d: number): number {
  return Math.max(0, Math.min(b, d) - Math.max(a, c));
}

/**
 * One row per project the member worked on that day, plus one row without a project for
 * unattributed work and idle or away time. Blocks are clipped to the org's local day.
 */
export function rollupDay<P extends string>(
  blocks: RollupBlock<P>[],
  date: string,
  policy: Policy,
  billable: (projectId: P) => boolean,
): RollupRow<P>[] {
  const from = dayStart(date, policy.timeZone);
  // The next local midnight, which is 23 or 25 hours away when the clocks change.
  const to = dayStart(addDays(date, 1), policy.timeZone);
  const working = policy.workingDays.includes(isoWeekday(date));
  const coreFrom = atLocalTime(date, policy.coreStart, policy.timeZone);
  const coreTo = atLocalTime(date, policy.coreEnd, policy.timeZone);
  const rows = new Map<P | undefined, RollupRow<P>>();
  for (const b of blocks) {
    if (b.deleted) continue;
    const ms = overlap(b.start, b.end, from, to);
    if (ms === 0) continue;
    const key = b.kind === "work" ? b.projectId : undefined;
    const row = rows.get(key) ?? { projectId: key, seconds: 0, billableSeconds: 0, coreSeconds: 0, idleSeconds: 0 };
    if (b.kind === "work") {
      row.seconds += ms / 1000;
      if (key !== undefined && billable(key)) row.billableSeconds += ms / 1000;
      if (working) row.coreSeconds += overlap(b.start, b.end, coreFrom, coreTo) / 1000;
    } else {
      row.idleSeconds += ms / 1000;
    }
    rows.set(key, row);
  }
  return [...rows.values()];
}

/** Rebuilds a member's rollup rows for one local day from their blocks, as the ingest path will after each upload. */
export function rollupsFor(blocks: Block[], projects: Project[], org: Org, memberId: string, date: string): DailyRollup[] {
  const billable = new Map(projects.map((p) => [p.id, p.billable]));
  return rollupDay(blocks, date, org.policy, (id) => billable.get(id) ?? false).map((row) => ({
    orgId: org.id,
    memberId,
    date,
    ...row,
  }));
}

/**
 * Every rollup row for one member's blocks under the org's policy, and the local dates they span, padded two days each side
 * so rows the other time zone put on a neighbouring day are replaced too: between zones 25 hours apart, a block moves two.
 */
export function rebuildRollups(blocks: Block[], projects: Project[], org: Org, memberId: string): { from: string; to: string; rows: DailyRollup[] } | null {
  const live = blocks.filter((b) => !b.deleted);
  if (!live.length) return null;
  const tz = org.policy.timeZone;
  const byDate = new Map<string, Block[]>();
  for (const b of live) {
    for (const date of datesBetween(localDate(b.start, tz), localDate(Math.max(b.start, b.end - 1), tz))) {
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(b);
    }
  }
  const dates = [...byDate.keys()].sort();
  return {
    from: addDays(dates[0]!, -2),
    to: addDays(dates.at(-1)!, 2),
    rows: dates.flatMap((date) => rollupsFor(byDate.get(date)!, projects, org, memberId, date)),
  };
}

export function coreSecondsPerDay(policy: Policy): number {
  return (policy.coreEnd - policy.coreStart) * 60;
}
