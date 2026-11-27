import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccessError } from "@/lib/data/access";
import { approveTimesheets, getMe, getTimesheetReview, getTimesheets, rejectTimesheet, reopenTimesheet, ValidationError } from "@/lib/data";
import { asAdmin } from "@/lib/db/client";
import { seededDatabase } from "./db";

let env: Awaited<ReturnType<typeof seededDatabase>>;
const member = (name: string) => env.tables.members.find((m) => m.name === name)!.id;
const as = (name: string) => ({ memberId: member(name) });
const WEEK = "2026-11-23";

type Sheet = { id: string; version: number; status: string; name: string };

/** This week's timesheets in a team and status, straight from the table. */
async function sheets(team: string, status: string): Promise<Sheet[]> {
  const rows = await env.db.execute(sql`
    select t.id, t.version, t.status, m.name from timesheets t
    join members m on m.id = t.member_id
    join team_members tm on tm.member_id = m.id
    join teams x on x.id = tm.team_id
    where t.week_start = ${WEEK} and t.status = ${status} and x.name = ${team} and m.role = 'employee'
    group by t.id, m.name order by m.name`);
  return rows.rows as Sheet[];
}

async function row(id: string) {
  return (await env.db.execute(sql`select status, version, review_note, approved_by from timesheets where id = ${id}`)).rows[0] as { status: string; version: number; review_note: string | null; approved_by: string | null };
}

async function audits(id: string) {
  return (await env.db.execute(sql`select actor_id, action, detail from audit_log where target = ${"timesheet:" + id} order by at, id`)).rows as { actor_id: string; action: string; detail: string | null }[];
}

const pgError = (q: Promise<unknown>) => q.then(() => "no error", (e: Error & { cause?: Error }) => e.cause?.message ?? e.message);
const seen = (s: Sheet) => ({ id: s.id, version: s.version });

beforeAll(async () => {
  env = await seededDatabase();
});

afterAll(async () => {
  await env.pool.end();
  await env.drop();
});

describe("the timesheet queue", () => {
  it("shows the admin's people for the week, every state, claimed hours beside tracked time, and the count waiting", async () => {
    const owner = await getTimesheets(as("Paul Mwangi"), { weekStart: WEEK }, env.db);
    const statuses = new Set(owner.people.map((p) => p.status));
    expect([...statuses].sort()).toEqual(["approved", "draft", "missing", "rejected", "submitted"]);
    const someone = owner.people.find((p) => p.status === "submitted")!;
    expect(someone.hours).toBeGreaterThan(0);
    expect(someone.hours * 4).toBe(Math.round(someone.hours * 4));
    expect(someone.trackedSeconds).toBeGreaterThan(0);

    const scoped = await getTimesheets(as("Diane Ingabire"), { weekStart: WEEK }, env.db);
    expect(scoped.people.length).toBeLessThan(owner.people.length);
    expect(scoped.people.map((p) => p.name)).not.toContain("Tomás Herrera");
    const advisory = env.tables.teams.find((t) => t.name === "Advisory")!.id;
    await expect(getTimesheets(as("Diane Ingabire"), { weekStart: WEEK, teamId: advisory }, env.db)).rejects.toThrow(AccessError);

    const me = await getMe(as("Diane Ingabire"), env.db);
    expect(me.waitingTimesheets).toBe(scoped.people.filter((p) => p.status === "submitted").length);
  });

  it("opens a review with rows by project and day and the tracked hours, only inside the admin's scope", async () => {
    const [s] = await sheets("Audit", "submitted");
    const review = await getTimesheetReview(as("Diane Ingabire"), s!.id, env.db);
    expect(review.rows.length).toBeGreaterThan(0);
    expect(review.claimed.reduce((a, x) => a + x, 0)).toBeCloseTo(review.rows.reduce((a, r) => a + r.total, 0));
    expect(review.tracked.some((h) => h > 0)).toBe(true);
    const [tomas] = await sheets("Advisory", "submitted");
    await expect(getTimesheetReview(as("Diane Ingabire"), tomas!.id, env.db)).rejects.toThrow(AccessError);
  });
});

describe("review scope", () => {
  it("stops an Audit and Tax admin approving, sending back or reopening an Advisory timesheet through the module", async () => {
    const [submitted] = await sheets("Advisory", "submitted");
    const [approved] = await sheets("Advisory", "approved");
    const diane = as("Diane Ingabire");
    await expect(approveTimesheets(diane, [seen(submitted!)], env.db)).rejects.toThrow(AccessError);
    await expect(rejectTimesheet(diane, seen(submitted!), "Split Tuesday", env.db)).rejects.toThrow(AccessError);
    await expect(reopenTimesheet(diane, seen(approved!), "Wrong project", env.db)).rejects.toThrow(AccessError);
    expect((await row(submitted!.id)).status).toBe("submitted");
    expect((await row(approved!.id)).status).toBe("approved");
    expect(await audits(submitted!.id)).toEqual([]);
  });

  it("stops the same admin with row-level security when the SQL skips the module", async () => {
    const [submitted] = await sheets("Advisory", "submitted");
    const [approved] = await sheets("Advisory", "approved");
    const diane = member("Diane Ingabire");
    const raw = (q: ReturnType<typeof sql>) => asAdmin(env.db, diane, (tx) => tx.execute(q));
    const hit = await raw(sql`update timesheets set status = 'approved', approved_by = ${diane}, approved_at = now() where id = ${submitted!.id} returning id`);
    expect(hit.rows).toEqual([]);
    expect((await raw(sql`update timesheets set status = 'rejected', review_note = 'x' where id = ${submitted!.id} returning id`)).rows).toEqual([]);
    expect((await raw(sql`update timesheets set status = 'submitted', review_note = 'x' where id = ${approved!.id} returning id`)).rows).toEqual([]);
    expect((await row(submitted!.id)).status).toBe("submitted");
    expect((await row(approved!.id)).status).toBe("approved");

    const [own] = await sheets("Audit", "submitted");
    expect(await pgError(raw(sql`update timesheets set status = 'approved', approved_by = ${member("Paul Mwangi")}, approved_at = now() where id = ${own!.id}`))).toMatch(/row-level security/);
    expect(await pgError(raw(sql`update timesheets set member_id = ${member("Tomás Herrera")} where id = ${own!.id}`))).toMatch(/permission denied/);
    expect(await pgError(raw(sql`update timesheet_lines set hours = 1 where timesheet_id = ${own!.id}`))).toMatch(/permission denied/);
  });

  it("keeps employees from reviewing, in the module and in Postgres", async () => {
    const [s] = await sheets("Audit", "submitted");
    await expect(approveTimesheets(as("Grace Mukamana"), [seen(s!)], env.db)).rejects.toThrow("Only admins");
    const grace = member("Grace Mukamana");
    const raw = await asAdmin(env.db, grace, (tx) => tx.execute(sql`update timesheets set status = 'approved', approved_by = ${grace}, approved_at = now() where id = ${s!.id} returning id`));
    expect(raw.rows).toEqual([]);
    expect((await row(s!.id)).status).toBe("submitted");
  });
});

describe("sending back", () => {
  it("needs a comment, in the module and in Postgres, and keeps it on the timesheet and in the audit log", async () => {
    const [s] = await sheets("Tax", "submitted");
    const diane = as("Diane Ingabire");
    const err = (await rejectTimesheet(diane, seen(s!), "   ", env.db).catch((e: unknown) => e)) as ValidationError;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.fields).toEqual({ comment: "Say what should change, so they know what to fix." });
    expect(await pgError(env.db.execute(sql`update timesheets set status = 'rejected', review_note = null where id = ${s!.id}`))).toMatch(/timesheets_rejected_has_note/);
    expect((await row(s!.id)).status).toBe("submitted");

    const fresh = await row(s!.id);
    await rejectTimesheet(diane, { id: s!.id, version: fresh.version }, "Move Tuesday's 3 h to the tax health check", env.db);
    expect(await row(s!.id)).toMatchObject({ status: "rejected", review_note: "Move Tuesday's 3 h to the tax health check" });
    expect(await audits(s!.id)).toEqual([{ actor_id: diane.memberId, action: "timesheet.rejected", detail: "Move Tuesday's 3 h to the tax health check" }]);
  });
});

describe("an approved timesheet", () => {
  it("is locked against edits and a second approval until an admin reopens it with a reason", async () => {
    const [s] = await sheets("Audit", "submitted");
    const diane = as("Diane Ingabire");
    await approveTimesheets(diane, [seen(s!)], env.db);
    const approved = await row(s!.id);
    expect(approved).toMatchObject({ status: "approved", approved_by: diane.memberId, review_note: null });

    await expect(approveTimesheets(diane, [{ id: s!.id, version: approved.version }], env.db)).rejects.toThrow("isn’t waiting for approval");
    await expect(rejectTimesheet(diane, { id: s!.id, version: approved.version }, "Too late", env.db)).rejects.toThrow("isn’t waiting for approval");
    expect(await pgError(env.db.execute(sql`update timesheet_lines set hours = hours + 0.25 where timesheet_id = ${s!.id}`))).toMatch(/approved and locked/);
    expect(await pgError(env.db.execute(sql`delete from timesheet_lines where timesheet_id = ${s!.id}`))).toMatch(/approved and locked/);
    expect(await pgError(env.db.execute(sql`update timesheets set status = 'rejected', review_note = 'x' where id = ${s!.id}`))).toMatch(/approved and locked/);
    expect(await pgError(env.db.execute(sql`update timesheets set status = 'submitted', review_note = null where id = ${s!.id}`))).toMatch(/needs a reason/);
    await expect(reopenTimesheet(diane, { id: s!.id, version: approved.version }, " ", env.db)).rejects.toThrow("Say why it needs reopening");
    expect((await row(s!.id)).version).toBe(approved.version);

    await reopenTimesheet(diane, { id: s!.id, version: approved.version }, "Wednesday's hours went to the wrong project", env.db);
    const reopened = await row(s!.id);
    expect(reopened).toMatchObject({ status: "submitted", approved_by: null, review_note: "Wednesday's hours went to the wrong project" });
    await env.db.execute(sql`update timesheet_lines set hours = hours + 0.25 where timesheet_id = ${s!.id}`);
    const edited = await row(s!.id);
    expect(edited.version).toBeGreaterThan(reopened.version);
    await approveTimesheets(diane, [{ id: s!.id, version: edited.version }], env.db);
    expect((await row(s!.id)).status).toBe("approved");
    expect((await audits(s!.id)).map((a) => a.action)).toEqual(["timesheet.approved", "timesheet.reopened", "timesheet.approved"]);

    const review = await getTimesheetReview(diane, s!.id, env.db);
    expect(review.approved?.by).toBe("you");
  });
});

describe("a stale review", () => {
  it("is refused when the timesheet changed since the admin read it", async () => {
    const [s] = await sheets("Tax", "submitted");
    const shown = (await getTimesheets(as("Diane Ingabire"), { weekStart: WEEK }, env.db)).people.find((p) => p.sheet?.id === s!.id)!;
    await rejectTimesheet(as("Paul Mwangi"), { id: s!.id, version: shown.sheet!.version }, "Add the client meeting on Thursday", env.db);
    const err = await approveTimesheets(as("Diane Ingabire"), [{ id: s!.id, version: shown.sheet!.version }], env.db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/changed since you opened it, so nothing was approved/);
    expect((await row(s!.id)).status).toBe("rejected");

    const [line] = await sheets("Audit", "submitted");
    await env.db.execute(sql`update timesheet_lines set description = 'Stock count follow-up' where timesheet_id = ${line!.id}`);
    await expect(approveTimesheets(as("Diane Ingabire"), [seen(line!)], env.db)).rejects.toThrow("changed since you opened it");
  });
});

describe("bulk approve", () => {
  it("approves every selected timesheet with one audit row each, or none when one changed", async () => {
    const paul = as("Paul Mwangi");
    const chosen = [...(await sheets("Advisory", "submitted")), ...(await sheets("Operations", "submitted"))].slice(0, 3);
    expect(chosen).toHaveLength(3);
    await env.db.execute(sql`update timesheets set review_note = 'touched' where id = ${chosen[2]!.id}`);
    await expect(approveTimesheets(paul, chosen.map(seen), env.db)).rejects.toThrow(`${chosen[2]!.name}’s timesheet changed`);
    for (const s of chosen) expect((await row(s.id)).status).toBe("submitted");
    for (const s of chosen) expect(await audits(s.id)).toEqual([]);

    const now = await Promise.all(chosen.map(async (s) => ({ id: s.id, version: (await row(s.id)).version })));
    expect(await approveTimesheets(paul, now, env.db)).toBe(3);
    for (const s of chosen) {
      expect((await row(s.id)).status).toBe("approved");
      expect(await audits(s.id)).toEqual([{ actor_id: paul.memberId, action: "timesheet.approved", detail: null }]);
    }
  });
});
