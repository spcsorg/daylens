import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccessError } from "@/lib/data/access";
import { getPeople, getPerson } from "@/lib/data";
import { rollupsFor } from "@/lib/data/seed";
import { asAdmin } from "@/lib/db/client";
import { NOW, seededDatabase } from "./db";

let env: Awaited<ReturnType<typeof seededDatabase>>;
const id = (name: string) => env.tables.members.find((m) => m.name === name)!.id;
const week = { from: "2026-11-16", to: "2026-11-22" };

beforeAll(async () => {
  env = await seededDatabase();
});

afterAll(async () => {
  await env.pool.end();
  await env.drop();
});

describe("tenant isolation in Postgres", () => {
  it("blocks an Audit and Tax admin from an Advisory member through the data-access module", async () => {
    const diane = { memberId: id("Diane Ingabire") };
    await expect(getPerson(diane, { ...week, memberId: id("Tomás Herrera") }, NOW, env.db)).rejects.toThrow(AccessError);
    expect((await getPerson(diane, { ...week, memberId: id("Grace Mukamana") }, NOW, env.db)).member.name).toBe("Grace Mukamana");
    expect((await getPeople(diane, week, NOW, env.db)).length).toBe(26);
  });

  it("hides the Advisory member's rows from that admin with row-level security, whatever the query", async () => {
    const tomas = id("Tomás Herrera");
    const grace = id("Grace Mukamana");
    const count = (table: string, member: string) =>
      asAdmin(env.db, id("Diane Ingabire"), async (tx) => {
        const column = table === "members" ? "id" : "member_id";
        const r = await tx.execute(sql.raw(`select count(*)::int as n from ${table} where ${column} = '${member}'`));
        return (r.rows[0] as { n: number }).n;
      });
    for (const table of ["members", "team_members", "devices", "blocks", "daily_rollups", "timesheets"]) {
      expect(await count(table, tomas), table).toBe(0);
    }
    expect(await count("blocks", grace)).toBeGreaterThan(0);
    const owner = await asAdmin(env.db, id("Paul Mwangi"), async (tx) => (await tx.execute(sql`select count(*)::int as n from members`)).rows[0]);
    expect(owner).toEqual({ n: 40 });
  });

  it("returns nothing to the app role without a signed-in admin", async () => {
    const rows = await env.db.transaction(async (tx) => {
      await tx.execute(sql`set local role daylens_app`);
      return (await tx.execute(sql`select (select count(*) from members)::int as members, (select count(*) from blocks)::int as blocks`)).rows[0];
    });
    expect(rows).toEqual({ members: 0, blocks: 0 });
  });

  it("returns nothing to an employee", async () => {
    const n = await asAdmin(env.db, id("Grace Mukamana"), async (tx) => (await tx.execute(sql`select count(*)::int as n from blocks`)).rows[0]);
    expect(n).toEqual({ n: 0 });
  });
});

describe("daily rollups in Postgres", () => {
  it("match a rebuild from the stored blocks", async () => {
    const grace = id("Grace Mukamana");
    const org = env.tables.orgs[0]!;
    const blocks = env.tables.blocks.filter((b) => b.memberId === grace);
    const expected = rollupsFor(blocks, env.tables.projects, org, grace, "2026-11-26");
    const stored = await env.db.execute(sql`select project_id, seconds, billable_seconds, core_seconds, idle_seconds from daily_rollups where member_id = ${grace} and date = '2026-11-26'`);
    const key = (r: { projectId?: string | null }) => r.projectId ?? "";
    const rows = (stored.rows as Record<string, number | string | null>[]).map((r) => ({
      projectId: r.project_id as string | null,
      seconds: Number(r.seconds),
      billableSeconds: Number(r.billable_seconds),
      coreSeconds: Number(r.core_seconds),
      idleSeconds: Number(r.idle_seconds),
    }));
    expect(rows.sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
      expected.map((r) => ({ projectId: r.projectId ?? null, seconds: r.seconds, billableSeconds: r.billableSeconds, coreSeconds: r.coreSeconds, idleSeconds: r.idleSeconds })).sort((a, b) => key(a).localeCompare(key(b))),
    );
    expect(rows.reduce((a, r) => a + r.seconds, 0)).toBe(8 * 3600 + 58 * 60);
  });
});
