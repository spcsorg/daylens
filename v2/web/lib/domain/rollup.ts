import { dayStart, DAY_MS, isoWeekday } from "./time";

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
  const to = from + DAY_MS;
  const working = policy.workingDays.includes(isoWeekday(date));
  const coreFrom = from + policy.coreStart * 60_000;
  const coreTo = from + policy.coreEnd * 60_000;
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

export function coreSecondsPerDay(policy: Policy): number {
  return (policy.coreEnd - policy.coreStart) * 60;
}
