import { describe, expect, it } from "vitest";
import { AccessError } from "@/lib/data/access";
import { me, overview, people, person } from "@/lib/data/queries";
import { seedTables } from "@/lib/data/seed";

const NOW = Date.parse("2026-11-27T08:40:00Z");
const t = seedTables(NOW);
const byName = (name: string) => t.members.find((m) => m.name === name)!;
const diane = { memberId: byName("Diane Ingabire").id };
const owner = { memberId: byName("Paul Mwangi").id };
const week = { from: "2026-11-16", to: "2026-11-22" };
const advisory = t.teams.find((x) => x.name === "Advisory")!;

describe("admin scope in the data-access module", () => {
  it("stops an admin scoped to Audit and Tax from reading an Advisory member", () => {
    expect(() => person(t, diane, { ...week, memberId: byName("Tomás Herrera").id }, NOW)).toThrow(AccessError);
    expect(person(t, diane, { ...week, memberId: byName("Grace Mukamana").id }, NOW).member.name).toBe("Grace Mukamana");
  });

  it("lists only the admin's teams in the people table and the overview", () => {
    const rows = people(t, diane, week, NOW);
    expect(rows.length).toBe(26);
    expect(rows.every((r) => r.teams.some((x) => x === "Audit" || x === "Tax"))).toBe(true);
    expect(overview(t, diane, week, NOW).people).toBe(26);
    expect(me(t, diane).teams.map((x) => x.name).sort()).toEqual(["Audit", "Tax"]);
  });

  it("refuses a team filter outside the admin's scope", () => {
    expect(() => people(t, diane, { ...week, teamId: advisory.id }, NOW)).toThrow(AccessError);
  });

  it("lets the owner see the whole firm", () => {
    expect(people(t, owner, week, NOW).length).toBe(40);
    expect(person(t, owner, { ...week, memberId: byName("Tomás Herrera").id }, NOW).member.name).toBe("Tomás Herrera");
  });

  it("keeps employees and strangers out", () => {
    expect(() => me(t, { memberId: byName("Grace Mukamana").id })).toThrow("Only admins can open the dashboard");
    expect(() => me(t, { memberId: "00000000-0000-4000-8000-000000000000" })).toThrow(AccessError);
    expect(() => me(t, null)).toThrow("Not signed in");
  });
});

describe("rollup totals", () => {
  it("match the blocks they were built from", () => {
    const grace = byName("Grace Mukamana").id;
    const day = person(t, owner, { from: "2026-11-26", to: "2026-11-26", memberId: grace }, NOW);
    const worked = day.entries.filter((e) => e.kind === "work").reduce((a, e) => a + (e.end - e.start) / 1000, 0);
    expect(day.totals.seconds).toBe(worked);
    expect(day.totals.seconds).toBe(8 * 3600 + 58 * 60);
    expect(day.totals.billableSeconds / day.totals.seconds).toBeCloseTo(0.8, 2);
    expect(day.totals.coverage).toBeCloseTo(0.88, 2);
  });

  it("add up across the firm to the people table", () => {
    const o = overview(t, owner, week, NOW);
    const sum = people(t, owner, week, NOW).reduce((a, r) => a + r.seconds, 0);
    expect(o.totalSeconds).toBeCloseTo(sum, 6);
    expect(o.byClient.reduce((a, c) => a + c.seconds, 0)).toBeCloseTo(o.withProjectSeconds, 6);
  });
});
