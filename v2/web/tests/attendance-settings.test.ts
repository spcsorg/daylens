import { sql } from "drizzle-orm";
import { readSheet } from "read-excel-file/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccessError } from "@/lib/data/access";
import {
  getAttendance,
  getPeople,
  getSettings,
  recordLeave,
  removeLeave,
  setMemberActive,
  updateLeave,
  updateMember,
  updatePolicy,
  ValidationError,
} from "@/lib/data";
import { asAdmin } from "@/lib/db/client";
import * as s from "@/lib/db/schema";
import { toCsv, toXlsx } from "@/lib/export";
import { attendanceTable, peopleTable, type Table } from "@/lib/tables";
import { seededDatabase } from "./db";

let env: Awaited<ReturnType<typeof seededDatabase>>;
const id = (name: string) => env.tables.members.find((m) => m.name === name)!.id;
const as = (name: string) => ({ memberId: id(name) });
const MONTH = { from: "2026-11-01", to: "2026-11-30" };
const WEEK = { from: "2026-11-23", to: "2026-11-29" };
const NOW = Date.parse("2026-11-27T08:40:00Z");
const pgError = (q: Promise<unknown>) => q.then(() => "no error", (e: Error & { cause?: Error }) => e.cause?.message ?? e.message);

async function audits(target: string) {
  return (await env.db.execute(sql`select action, detail from audit_log where target = ${target} order by at, id`)).rows as { action: string; detail: string | null }[];
}

async function leaveRows() {
  return (await env.db.execute(sql`select member_id, type, starts_on::text, ends_on::text from leave order by starts_on`)).rows as {
    member_id: string;
    type: string;
    starts_on: string;
    ends_on: string;
  }[];
}

const cell = (data: Awaited<ReturnType<typeof getAttendance>>, name: string, date: string) =>
  data.people.find((p) => p.name === name)!.cells.find((c) => c.date === date)!;

beforeAll(async () => {
  env = await seededDatabase();
}, 600_000);

afterAll(async () => {
  await env.pool.end();
  await env.drop();
});

describe("attendance for a month", () => {
  it("counts working days with no activity, leaves weekends alone, and flags both kinds of day that don't add up", async () => {
    const data = await getAttendance(as("Paul Mwangi"), MONTH, NOW, env.db);
    expect(data.people.length).toBe(40);
    expect(data.days.length).toBe(30);

    const quiet = cell(data, "Aline Uwera", "2026-11-09");
    expect(quiet.kind).toBe("none");
    expect(quiet.flag).toBe(true);
    expect(quiet.seconds).toBe(0);

    const weekend = cell(data, "Aline Uwera", "2026-11-07");
    expect(weekend.kind).toBe("off");
    expect(weekend.flag).toBe(false);

    const onLeave = cell(data, "Olivier Habimana", "2026-11-12");
    expect(onLeave.kind).toBe("leave");
    expect(onLeave.leaveType).toBe("Annual leave");
    expect(onLeave.flag).toBe(true);
    expect(onLeave.seconds).toBe(126 * 60);

    const plainLeave = cell(data, "Moses Tumusiime", "2026-11-17");
    expect(plainLeave.kind).toBe("leave");
    expect(plainLeave.flag).toBe(false);

    const worked = cell(data, "Grace Mukamana", "2026-11-26");
    expect(worked.kind).toBe("worked");
    expect(worked.flag).toBe(false);

    expect(data.flags.map((f) => `${f.name} ${f.date}`)).toEqual(expect.arrayContaining(["Olivier Habimana 2026-11-12", "Aline Uwera 2026-11-09"]));
    const leaveFlag = data.flags.find((f) => f.name === "Olivier Habimana")!;
    expect(leaveFlag.leaveType).toBe("Annual leave");
    expect(leaveFlag.mostly?.name).toBeTruthy();
    expect(data.flags.find((f) => f.name === "Aline Uwera")!.leaveType).toBeNull();

    const moses = data.people.find((p) => p.name === "Moses Tumusiime")!;
    expect(moses.leaveDays).toBe(3);
    expect(data.leave.find((l) => l.name === "Moses Tumusiime")!.days).toBe(3);
  });

  it("shows an admin only their own teams", async () => {
    const data = await getAttendance(as("Diane Ingabire"), MONTH, NOW, env.db);
    expect(data.people.map((p) => p.name)).not.toContain("Tomás Herrera");
    expect(data.flags.every((f) => f.name !== "Tomás Herrera")).toBe(true);
    expect(data.people.length).toBe(26);
    const advisory = env.tables.teams.find((t) => t.name === "Advisory")!.id;
    await expect(getAttendance(as("Diane Ingabire"), { ...MONTH, teamId: advisory }, NOW, env.db)).rejects.toThrow(AccessError);
  });
});

describe("recording leave", () => {
  it("records, changes and removes leave for someone in scope, with an audit row each time", async () => {
    const grace = id("Grace Mukamana");
    const leaveId = await recordLeave(as("Diane Ingabire"), { memberId: grace, type: "Study leave", startsOn: "2026-11-19", endsOn: "2026-11-20" }, env.db);
    expect((await audits(`member:${grace}/leave:${leaveId}`)).map((a) => a.action)).toEqual(["leave.recorded"]);

    await updateLeave(as("Diane Ingabire"), leaveId, { type: "Sick leave", startsOn: "2026-11-19", endsOn: "2026-11-19" }, env.db);
    const changed = (await leaveRows()).find((l) => l.member_id === grace)!;
    expect(changed).toMatchObject({ type: "Sick leave", starts_on: "2026-11-19", ends_on: "2026-11-19" });
    expect((await audits(`member:${grace}/leave:${leaveId}`)).map((a) => a.action)).toEqual(["leave.recorded", "leave.updated"]);

    const data = await getAttendance(as("Diane Ingabire"), MONTH, NOW, env.db);
    expect(cell(data, "Grace Mukamana", "2026-11-19").kind).toBe("leave");

    await removeLeave(as("Diane Ingabire"), leaveId, env.db);
    expect((await leaveRows()).some((l) => l.member_id === grace)).toBe(false);
    expect((await getAttendance(as("Diane Ingabire"), MONTH, NOW, env.db)).people.find((p) => p.name === "Grace Mukamana")!.leaveDays).toBe(0);
    expect((await audits(`member:${grace}/leave:${leaveId}`)).map((a) => a.action)).toEqual(["leave.recorded", "leave.updated", "leave.removed"]);
  });

  it("refuses someone outside the admin's scope, through the module and through row-level security", async () => {
    const tomas = id("Tomás Herrera");
    await expect(recordLeave(as("Diane Ingabire"), { memberId: tomas, type: "Annual leave", startsOn: "2026-11-19", endsOn: "2026-11-20" }, env.db)).rejects.toThrow(AccessError);
    const refused = pgError(
      asAdmin(env.db, id("Diane Ingabire"), (tx) => tx.insert(s.leave).values({ orgId: env.tables.orgs[0]!.id, memberId: tomas, type: "Annual leave", startsOn: "2026-11-19", endsOn: "2026-11-20" })),
    );
    expect(await refused).toMatch(/row-level security/);
    const seen = await asAdmin(env.db, id("Diane Ingabire"), (tx) => tx.select().from(s.leave).where(sql`member_id = ${tomas}`));
    expect(seen).toEqual([]);
    expect((await leaveRows()).some((l) => l.member_id === tomas)).toBe(false);
  });

  it("refuses dates that overlap leave already recorded, and dates with only days off in them", async () => {
    const moses = id("Moses Tumusiime");
    await expect(recordLeave(as("Paul Mwangi"), { memberId: moses, type: "Annual leave", startsOn: "2026-11-18", endsOn: "2026-11-19" }, env.db)).rejects.toThrow(ValidationError);
    await expect(recordLeave(as("Paul Mwangi"), { memberId: moses, type: "Annual leave", startsOn: "2026-11-21", endsOn: "2026-11-22" }, env.db)).rejects.toThrow(/non-working days/);
    await expect(recordLeave(as("Paul Mwangi"), { memberId: moses, type: "Unpaid sabbatical", startsOn: "2026-12-01", endsOn: "2026-12-02" }, env.db)).rejects.toThrow(ValidationError);
    await expect(recordLeave(as("Paul Mwangi"), { memberId: moses, type: "Annual leave", startsOn: "2026-12-03", endsOn: "2026-12-01" }, env.db)).rejects.toThrow(ValidationError);
  });
});

describe("settings", () => {
  it("opens for an admin to read and says only an owner may change it", async () => {
    const owner = await getSettings(as("Paul Mwangi"), env.db);
    const admin = await getSettings(as("Diane Ingabire"), env.db);
    expect(owner.canEdit).toBe(true);
    expect(admin.canEdit).toBe(false);
    expect(admin.policy.coreStart).toBe(8 * 60 + 30);
    expect(owner.members.length).toBe(40);
    expect(admin.members.length).toBe(26);
    expect(admin.members.map((m) => m.name)).not.toContain("Tomás Herrera");
    expect(admin.members.find((m) => m.name === "Diane Ingabire")).toMatchObject({ role: "admin", adminScope: "teams", adminTeamIds: expect.arrayContaining([env.tables.teams.find((t) => t.name === "Audit")!.id]) });

    const policy = { ...admin.policy, coreEnd: 16 * 60 };
    await expect(updatePolicy(as("Diane Ingabire"), policy, env.db)).rejects.toThrow(AccessError);
    const changed = await asAdmin(env.db, id("Diane Ingabire"), (tx) => tx.update(s.orgs).set({ policy }).where(sql`true`).returning({ id: s.orgs.id }));
    expect(changed).toEqual([]);
    const [org] = (await env.db.execute(sql`select policy from orgs`)).rows as { policy: { coreEnd: number } }[];
    expect(org!.policy.coreEnd).toBe(17 * 60 + 30);
  });

  it("changes someone's role, admin scope and teams, and deactivates and reactivates them", async () => {
    const eric = id("Eric Nkurunziza");
    const audit = env.tables.teams.find((t) => t.name === "Audit")!.id;
    await updateMember(as("Paul Mwangi"), eric, { role: "admin", adminScope: "teams", teamIds: [audit], adminTeamIds: [audit] }, env.db);
    const afterRole = await getSettings(as("Paul Mwangi"), env.db);
    expect(afterRole.members.find((m) => m.id === eric)).toMatchObject({ role: "admin", adminScope: "teams", adminTeamIds: [audit] });
    expect((await audits(`member:${eric}`)).map((a) => a.action)).toEqual(expect.arrayContaining(["member.role_changed", "member.teams_changed"]));
    expect((await getPeople(as("Eric Nkurunziza"), WEEK, NOW, env.db)).every((r) => r.teams.includes("Audit"))).toBe(true);

    await updateMember(as("Paul Mwangi"), eric, { role: "employee", adminScope: null, teamIds: [audit], adminTeamIds: [] }, env.db);
    const afterRevert = await getSettings(as("Paul Mwangi"), env.db).then((d) => d.members.find((m) => m.id === eric)!);
    expect(afterRevert).toMatchObject({ role: "employee", adminScope: null, adminTeamIds: [] });
    await expect(getPeople(as("Eric Nkurunziza"), WEEK, NOW, env.db)).rejects.toThrow("Only admins can open the dashboard");

    await setMemberActive(as("Paul Mwangi"), eric, false, env.db);
    expect((await getPeople(as("Paul Mwangi"), WEEK, NOW, env.db)).map((r) => r.memberId)).not.toContain(eric);
    expect((await getSettings(as("Paul Mwangi"), env.db)).members.find((m) => m.id === eric)!.active).toBe(false);
    expect((await audits(`member:${eric}`)).map((a) => a.action)).toContain("member.deactivated");

    await setMemberActive(as("Paul Mwangi"), eric, true, env.db);
    expect((await getPeople(as("Paul Mwangi"), WEEK, NOW, env.db)).map((r) => r.memberId)).toContain(eric);
  });

  it("keeps the last active owner, in the module and in Postgres", async () => {
    const paul = id("Paul Mwangi");
    const audit = env.tables.teams.find((t) => t.name === "Audit")!.id;
    await expect(setMemberActive(as("Paul Mwangi"), paul, false, env.db)).rejects.toThrow(ValidationError);
    await expect(updateMember(as("Paul Mwangi"), paul, { role: "admin", adminScope: "org", teamIds: [audit], adminTeamIds: [] }, env.db)).rejects.toThrow(/only owner/);

    const demoted = pgError(asAdmin(env.db, paul, (tx) => tx.update(s.members).set({ role: "employee" }).where(sql`id = ${paul}`)));
    expect(await demoted).toMatch(/at least one active owner/);
    const deactivated = pgError(asAdmin(env.db, paul, (tx) => tx.update(s.members).set({ status: "deactivated" }).where(sql`id = ${paul}`)));
    expect(await deactivated).toMatch(/at least one active owner/);
    const [row] = (await env.db.execute(sql`select role, status from members where id = ${paul}`)).rows as { role: string; status: string }[];
    expect(row).toEqual({ role: "owner", status: "active" });

    const diane = id("Diane Ingabire");
    await expect(setMemberActive(as("Diane Ingabire"), diane, false, env.db)).rejects.toThrow(AccessError);
  });

  it("lets a second owner take over, and then the first can step down", async () => {
    const paul = id("Paul Mwangi");
    const diane = id("Diane Ingabire");
    const audit = env.tables.teams.find((t) => t.name === "Audit")!.id;
    await updateMember(as("Paul Mwangi"), diane, { role: "owner", adminScope: null, teamIds: [audit], adminTeamIds: [] }, env.db);
    await expect(setMemberActive(as("Paul Mwangi"), paul, false, env.db)).rejects.toThrow(/yourself/);
    await setMemberActive(as("Diane Ingabire"), paul, false, env.db);
    const [row] = (await env.db.execute(sql`select status from members where id = ${paul}`)).rows as { status: string }[];
    expect(row!.status).toBe("deactivated");
    await setMemberActive(as("Diane Ingabire"), paul, true, env.db);
    await updateMember(as("Paul Mwangi"), diane, { role: "admin", adminScope: "teams", teamIds: [audit], adminTeamIds: [audit] }, env.db);
    const diane2 = await getSettings(as("Paul Mwangi"), env.db).then((d) => d.members.find((m) => m.id === diane)!);
    expect(diane2).toMatchObject({ role: "admin", adminScope: "teams" });
  });
});

describe("exports", () => {
  const lines = (csv: string) => csv.replace(/^\uFEFF/, "").trimEnd().split("\r\n");

  it("carries only the rows on screen, and opens as a valid xlsx", async () => {
    const rows = await getPeople(as("Diane Ingabire"), WEEK, NOW, env.db);
    const table = peopleTable(rows, "23–29 November");
    const csv = toCsv(table);
    const body = lines(csv);
    expect(body[0]).toBe(table.columns.join(","));
    expect(body.length).toBe(rows.length + 1);
    expect(csv).not.toContain("Tomás Herrera");

    const sheet = await readSheet(await toXlsx(table));
    expect(sheet[0]).toEqual(table.columns);
    expect(sheet.length).toBe(rows.length + 1);
    const names = sheet.slice(1).map((r) => r[0]);
    expect(names).toEqual(rows.map((r) => r.name));
    expect(names).not.toContain("Tomás Herrera");
  });

  it("exports the attendance grid and the timesheets list with the same scope", async () => {
    const data = await getAttendance(as("Diane Ingabire"), MONTH, NOW, env.db);
    const table = attendanceTable(data, "November");
    const sheet = await readSheet(await toXlsx(table));
    expect(sheet[0]!.slice(0, 3)).toEqual(["Person", "Title", "Sun 1"]);
    expect(sheet.length).toBe(data.people.length + 1);
    expect(sheet.flat().some((v) => v === "Annual leave")).toBe(true);

    const scoped = lines(toCsv(table));
    expect(scoped.length).toBe(data.people.length + 1);
    expect(scoped.some((l) => l.startsWith("Tomás Herrera"))).toBe(false);
  });

  it("quotes text a spreadsheet would run as a formula", () => {
    const table: Table = { name: "Test", columns: ["Note"], rows: [["=1+1"], ["plain"]] };
    expect(lines(toCsv(table))[1]).toBe("'=1+1");
    expect(lines(toCsv(table))[2]).toBe("plain");
  });
});

describe("changing the policy", () => {
  it("recounts core-hours coverage when the working days change", async () => {
    const grace = id("Grace Mukamana");
    const before = (await getPeople(as("Paul Mwangi"), WEEK, NOW, env.db)).find((r) => r.memberId === grace)!.coverage!;
    const core = async (date: string) =>
      (await env.db.execute(sql`select coalesce(sum(core_seconds), 0)::float as s from daily_rollups where member_id = ${grace} and date = ${date}`)).rows[0] as { s: number };
    const saturdayBefore = await core("2026-11-28");

    const policy = (await getSettings(as("Paul Mwangi"), env.db)).policy;
    await updatePolicy(as("Paul Mwangi"), { ...policy, workingDays: [1, 2, 3, 4, 5, 6], coreEnd: 16 * 60 }, env.db);

    const after = (await getPeople(as("Paul Mwangi"), WEEK, NOW, env.db)).find((r) => r.memberId === grace)!.coverage!;
    expect(after).toBeLessThan(before);
    expect((await core("2026-11-26")).s).toBeLessThan(9 * 3600);
    expect(saturdayBefore.s).toBe(0);
    const [entry] = (await audits(`org:${env.tables.orgs[0]!.id}`)).filter((a) => a.action === "org.policy_changed");
    expect(entry!.detail).toBe("core hours 08:30–17:30 to 08:30–16:00; working days Mon, Tue, Wed, Thu, Fri to Mon, Tue, Wed, Thu, Fri, Sat");

    await updatePolicy(as("Paul Mwangi"), policy, env.db);
    expect((await getPeople(as("Paul Mwangi"), WEEK, NOW, env.db)).find((r) => r.memberId === grace)!.coverage).toBeCloseTo(before, 6);
  });

  it("refuses a policy that can't be saved", async () => {
    const policy = (await getSettings(as("Paul Mwangi"), env.db)).policy;
    await expect(updatePolicy(as("Paul Mwangi"), { ...policy, timeZone: "Mars/Olympus" }, env.db)).rejects.toThrow(ValidationError);
    await expect(updatePolicy(as("Paul Mwangi"), { ...policy, coreStart: 17 * 60, coreEnd: 9 * 60 }, env.db)).rejects.toThrow(/Core hours end/);
    await expect(updatePolicy(as("Paul Mwangi"), { ...policy, workingDays: [] }, env.db)).rejects.toThrow(/working day/);
    await expect(updatePolicy(as("Paul Mwangi"), { ...policy, leaveTypes: [] }, env.db)).rejects.toThrow(ValidationError);
  });
});
