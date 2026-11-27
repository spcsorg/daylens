import { describe, expect, it } from "vitest";
import { rollupDay, type Policy } from "@/lib/domain/rollup";
import { atLocalTime, dayStart } from "@/lib/domain/time";

const policy: Policy = { timeZone: "Africa/Kigali", coreStart: 8 * 60 + 30, coreEnd: 17 * 60 + 30, workingDays: [1, 2, 3, 4, 5] };
const thursday = "2026-11-19";
const at = (date: string, h: number, m = 0) => dayStart(date, policy.timeZone) + (h * 60 + m) * 60_000;
const billable = (p: string) => p !== "internal";

describe("rollupDay", () => {
  it("splits a day into one row per project plus one row for unattributed work and idle time", () => {
    const rows = rollupDay(
      [
        { start: at(thursday, 8), end: at(thursday, 10), kind: "work", projectId: "audit" },
        { start: at(thursday, 10), end: at(thursday, 10, 30), kind: "work" },
        { start: at(thursday, 10, 30), end: at(thursday, 11), kind: "idle" },
        { start: at(thursday, 12), end: at(thursday, 13), kind: "away" },
        { start: at(thursday, 13), end: at(thursday, 14), kind: "work", projectId: "internal" },
        { start: at(thursday, 19), end: at(thursday, 20), kind: "work", projectId: "audit" },
      ],
      thursday,
      policy,
      billable,
    );
    const by = Object.fromEntries(rows.map((r) => [r.projectId ?? "none", r]));
    expect(by.audit).toMatchObject({ seconds: 3 * 3600, billableSeconds: 3 * 3600, coreSeconds: 1.5 * 3600, idleSeconds: 0 });
    expect(by.internal).toMatchObject({ seconds: 3600, billableSeconds: 0, coreSeconds: 3600 });
    expect(by.none).toMatchObject({ seconds: 1800, billableSeconds: 0, coreSeconds: 1800, idleSeconds: 1.5 * 3600 });
  });

  it("uses the org's local day, clipping blocks that cross midnight", () => {
    const rows = rollupDay([{ start: at(thursday, 23), end: at("2026-11-20", 1), kind: "work", projectId: "audit" }], thursday, policy, billable);
    expect(rows).toEqual([{ projectId: "audit", seconds: 3600, billableSeconds: 3600, coreSeconds: 0, idleSeconds: 0 }]);
  });

  it("counts no core hours on a day the org doesn't work", () => {
    const saturday = "2026-11-21";
    const rows = rollupDay([{ start: at(saturday, 9), end: at(saturday, 11), kind: "work", projectId: "audit" }], saturday, policy, billable);
    expect(rows[0]).toMatchObject({ seconds: 7200, coreSeconds: 0 });
  });

  it("counts the whole of a day the clocks change on", () => {
    // Both clock changes fall on a Sunday, so the test works Sundays to reach core hours.
    const newYork: Policy = { ...policy, timeZone: "America/New_York", workingDays: [1, 2, 3, 4, 5, 7] };
    const late = dayStart("2026-11-01", newYork.timeZone) + (23 * 60 + 15) * 60_000;
    const rows = rollupDay([{ start: late, end: late + 30 * 60_000, kind: "work", projectId: "audit" }], "2026-11-01", newYork, billable);
    expect(rows).toEqual([{ projectId: "audit", seconds: 1800, billableSeconds: 1800, coreSeconds: 0, idleSeconds: 0 }]);
    const core = atLocalTime("2026-11-01", 8 * 60 + 30, newYork.timeZone);
    const morning = rollupDay([{ start: core, end: core + 3600_000, kind: "work", projectId: "audit" }], "2026-11-01", newYork, billable);
    expect(morning[0]).toMatchObject({ seconds: 3600, coreSeconds: 3600 });

    const lastHalfHour = dayStart("2026-03-09", newYork.timeZone) - 30 * 60_000;
    const spring = rollupDay([{ start: lastHalfHour, end: lastHalfHour + 30 * 60_000, kind: "work", projectId: "audit" }], "2026-03-08", newYork, billable);
    expect(spring[0]).toMatchObject({ seconds: 1800 });
    const spill = rollupDay([{ start: lastHalfHour, end: lastHalfHour + 30 * 60_000, kind: "work", projectId: "audit" }], "2026-03-09", newYork, billable);
    expect(spill).toEqual([]);
  });

  it("ignores deleted blocks", () => {
    expect(rollupDay([{ start: at(thursday, 9), end: at(thursday, 10), kind: "work", projectId: "audit", deleted: true }], thursday, policy, billable)).toEqual([]);
  });
});
