import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getPeople } from "@/lib/data";
import { connect } from "@/lib/db/client";
import { backupDb, restoreDb } from "@/lib/db/ops";
import { freshDatabase, NOW, seededDatabase } from "./db";

const TABLES = ["orgs", "members", "teams", "team_members", "devices", "clients", "projects", "assignments", "blocks", "daily_rollups", "timesheets", "timesheet_lines", "audit_log"];
const cleanup: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const c of cleanup.reverse()) await c();
});

async function counts(db: ReturnType<typeof connect>["db"]) {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = (await db.execute(sql.raw(`select count(*)::int as n from ${t}`))).rows[0]!.n as number;
  return out;
}

describe("backup and restore", () => {
  it("restores a pg_dump backup into a fresh database with the same rows and rollups", async () => {
    const source = await seededDatabase();
    cleanup.push(source.drop, () => source.pool.end());
    const dir = await mkdtemp(join(tmpdir(), "daylens-backup-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));

    const file = await backupDb(source.url, dir);
    expect(file).toMatch(/daylens-\d{4}-\d{2}-\d{2}T[\d-]+Z\.dump$/);

    const target = await freshDatabase();
    cleanup.push(target.drop);
    await restoreDb(target.url, file);
    const restored = connect(target.url);
    cleanup.push(() => restored.pool.end());

    const before = await counts(source.db);
    expect(before.blocks).toBeGreaterThan(10_000);
    expect(await counts(restored.db)).toEqual(before);

    const grace = source.tables.members.find((m) => m.name === "Grace Mukamana")!.id;
    const rollup = sql`select sum(seconds)::float as s, sum(billable_seconds)::float as b from daily_rollups where member_id = ${grace} and date = '2026-11-26'`;
    expect((await restored.db.execute(rollup)).rows[0]).toEqual((await source.db.execute(rollup)).rows[0]);

    const diane = { memberId: source.tables.members.find((m) => m.name === "Diane Ingabire")!.id };
    expect((await getPeople(diane, { from: "2026-11-16", to: "2026-11-22" }, NOW, restored.db)).length).toBe(26);
  });
});
