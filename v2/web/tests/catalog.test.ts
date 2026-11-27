import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccessError } from "@/lib/data/access";
import { assign, createClient, createProject, getCatalog, getMe, getOverview, setProjectArchived, unassign, updateAssignment, updateClient, updateProject, ValidationError } from "@/lib/data";
import { asAdmin } from "@/lib/db/client";
import { NOW, seededDatabase } from "./db";

let env: Awaited<ReturnType<typeof seededDatabase>>;
const member = (name: string) => env.tables.members.find((m) => m.name === name)!.id;
const team = (name: string) => env.tables.teams.find((t) => t.name === name)!.id;
const project = (code: string) => env.tables.projects.find((p) => p.code === code)!.id;
const client = (code: string) => env.tables.clients.find((c) => c.code === code)!.id;
const as = (name: string) => ({ memberId: member(name) });
const week = { from: "2026-11-16", to: "2026-11-22" };

async function auditRows() {
  return (await env.db.execute(sql`select actor_id, action, target from audit_log where action <> 'org.seeded' order by at, id`)).rows as { actor_id: string; action: string; target: string }[];
}

/** Postgres's own message, from under Drizzle's query wrapper. */
const pgError = (q: Promise<unknown>) => q.then(() => "no error", (e: Error & { cause?: Error }) => e.cause?.message ?? e.message);

async function count(query: ReturnType<typeof sql>) {
  return ((await env.db.execute(query)).rows[0] as { n: number }).n;
}

beforeAll(async () => {
  env = await seededDatabase();
});

afterAll(async () => {
  await env.pool.end();
  await env.drop();
});

describe("assignment scope on writes", () => {
  it("stops an Audit and Tax admin assigning an Advisory person or team through the data module", async () => {
    const before = await count(sql`select count(*)::int as n from assignments`);
    await expect(assign(as("Diane Ingabire"), { projectId: project("LKB-AUD-26"), memberId: member("Tomás Herrera") }, env.db)).rejects.toThrow(AccessError);
    await expect(assign(as("Diane Ingabire"), { projectId: project("LKB-AUD-26"), teamId: team("Advisory") }, env.db)).rejects.toThrow(AccessError);
    const tomas = (await env.db.execute(sql`select id from assignments where member_id = ${member("Tomás Herrera")}`)).rows[0] as { id: string };
    await expect(unassign(as("Diane Ingabire"), tomas.id, env.db)).rejects.toThrow(AccessError);
    await expect(updateAssignment(as("Diane Ingabire"), tomas.id, { endsAt: "2026-12-31" }, env.db)).rejects.toThrow(AccessError);
    expect(await count(sql`select count(*)::int as n from assignments`)).toBe(before);

    const id = await assign(as("Diane Ingabire"), { projectId: project("LKB-AUD-26"), memberId: member("Grace Mukamana"), startsAt: "2026-11-23", endsAt: "2026-12-18" }, env.db);
    expect(await count(sql`select count(*)::int as n from assignments where id = ${id} and starts_at = '2026-11-23'`)).toBe(1);
  });

  it("stops the same admin with row-level security when the SQL skips the module", async () => {
    const [org, lkb] = [env.tables.orgs[0]!.id, project("LKB-AUD-26")];
    const raw = (q: ReturnType<typeof sql>) => asAdmin(env.db, member("Diane Ingabire"), (tx) => tx.execute(q));
    expect(await pgError(raw(sql`insert into assignments (org_id, project_id, member_id) values (${org}, ${lkb}, ${member("Tomás Herrera")})`))).toMatch(/row-level security/);
    expect(await pgError(raw(sql`insert into assignments (org_id, project_id, team_id) values (${org}, ${lkb}, ${team("Advisory")})`))).toMatch(/row-level security/);
    const advisory = sql`select count(*)::int as n from assignments where team_id = ${team("Advisory")} or member_id = ${member("Tomás Herrera")}`;
    const before = await count(advisory);
    expect(before).toBeGreaterThan(0);
    await raw(sql`delete from assignments where team_id = ${team("Advisory")} or member_id = ${member("Tomás Herrera")}`);
    await raw(sql`update assignments set ends_at = '2026-12-31' where team_id = ${team("Advisory")}`);
    expect(await count(advisory)).toBe(before);
    expect(await count(sql`select count(*)::int as n from assignments where team_id = ${team("Advisory")} and ends_at is not null`)).toBe(0);
    expect(await pgError(raw(sql`insert into audit_log (org_id, actor_id, action, target) values (${org}, ${member("Paul Mwangi")}, 'x', 'y')`))).toMatch(/row-level security/);

    await raw(sql`insert into assignments (org_id, project_id, team_id) values (${org}, ${lkb}, ${team("Tax")})`);
    const owner = await asAdmin(env.db, member("Paul Mwangi"), (tx) => tx.execute(sql`insert into assignments (org_id, project_id, team_id) values (${org}, ${lkb}, ${team("Advisory")}) returning id`));
    expect(owner.rows).toHaveLength(1);
  });

  it("keeps employees from writing, in the module and in Postgres", async () => {
    await expect(createClient(as("Grace Mukamana"), { name: "Mara Coffee", code: "MCE", billable: true, aliases: [], domains: [], emailDomains: [] }, env.db)).rejects.toThrow("Only admins");
    const raw = asAdmin(env.db, member("Grace Mukamana"), (tx) =>
      tx.execute(sql`insert into clients (org_id, name, code, aliases, domains, billable) values (${env.tables.orgs[0]!.id}, 'Mara Coffee', 'MCE', '{}', '{}', true)`),
    );
    expect(await pgError(raw)).toMatch(/row-level security/);
  });
});

describe("client and project codes", () => {
  it("are unique per org whatever the case, as a form error from the module and a constraint in Postgres", async () => {
    const input = { clientId: client("LKB"), name: "Another audit", code: "lkb-aud-26", billable: true, keywords: [] };
    const err = await createProject(as("Paul Mwangi"), input, env.db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fields).toEqual({ code: "Another project already uses LKB-AUD-26." });
    await expect(updateClient(as("Paul Mwangi"), client("NYT"), { code: "lkb" }, env.db)).rejects.toThrow("Another client already uses LKB.");
    const copy = env.db.execute(sql`insert into projects (org_id, client_id, name, code, keywords, billable) values (${env.tables.orgs[0]!.id}, ${client("LKB")}, 'Copy', 'Lkb-Aud-26', '{}', true)`);
    expect(await pgError(copy)).toMatch(/projects_org_id_code_index/);

    const other = (await env.db.execute(sql`insert into orgs (name, short_name, domains, entra_tenant_id, policy, retention) values ('Other firm', 'Other', '{}', 'other-tenant', '{}', '{}') returning id`)).rows[0] as { id: string };
    await env.db.execute(sql`insert into clients (org_id, name, code, aliases, domains, billable) values (${other.id}, 'Lakeside elsewhere', 'LKB', '{}', '{}', true)`);
    await env.db.execute(sql`delete from orgs where id = ${other.id}`);
  });

  it("reject a date that isn't one, as a field error rather than a crash", async () => {
    const err = (await assign(as("Paul Mwangi"), { projectId: project("LKB-AUD-26"), teamId: team("Audit"), endsAt: "2026-02-31" }, env.db).catch((e: unknown) => e)) as ValidationError;
    expect(err.fields).toEqual({ endsAt: "Pick an end date." });
    const impossible = (await assign(as("Paul Mwangi"), { projectId: project("LKB-AUD-26"), teamId: team("Audit"), startsAt: "2026-13-01" }, env.db).catch((e: unknown) => e)) as ValidationError;
    expect(impossible.fields).toEqual({ startsAt: "Pick a start date." });
  });

  it("show what's missing or malformed beside each field", async () => {
    const err = (await createClient(as("Paul Mwangi"), { name: " ", code: "", billable: true, aliases: [], domains: ["not a domain"], emailDomains: ["@mara.example"] }, env.db).catch((e: unknown) => e)) as ValidationError;
    expect(Object.keys(err.fields).sort()).toEqual(["code", "domains", "name"]);
  });
});

describe("editing one field", () => {
  it("leaves the other fields as they stand, including someone else's change", async () => {
    const owner = as("Paul Mwangi");
    const projectId = await createProject(owner, { clientId: client("LKB"), name: "Reworked audit", code: "LKB-AUD-27", billable: true, keywords: ["year-end"] }, env.db);
    await env.db.execute(sql`update projects set keywords = '{year-end, stock count}' where id = ${projectId}`);
    await updateProject(owner, projectId, { billable: false }, env.db);
    const row = (await env.db.execute(sql`select billable, keywords from projects where id = ${projectId}`)).rows[0];
    expect(row).toEqual({ billable: false, keywords: ["year-end", "stock count"] });
    await setProjectArchived(owner, projectId, true, env.db);
    await env.db.execute(sql`update projects set archived_at = null where id = ${projectId}`);
  });
});

describe("audit log", () => {
  it("gets one row per write, with the actor, action and target, in the same transaction", async () => {
    await env.db.execute(sql`delete from audit_log where action <> 'org.seeded'`);
    const paul = as("Paul Mwangi");
    const clientId = await createClient(paul, { name: "Mara Coffee Exporters", code: "mce", billable: true, aliases: ["Mara"], domains: ["https://www.maracoffee.example/about"], emailDomains: ["@maracoffee.example"] }, env.db);
    await updateClient(paul, clientId, { aliases: ["Mara", "MCE"] }, env.db);
    const projectId = await createProject(paul, { clientId, name: "Export audit", code: "MCE-AUD-27", billable: true, keywords: ["export"] }, env.db);
    await updateProject(paul, projectId, { billable: false }, env.db);
    const assignmentId = await assign(paul, { projectId, teamId: team("Audit") }, env.db);
    await updateAssignment(paul, assignmentId, { startsAt: "2027-01-04" }, env.db);
    await unassign(paul, assignmentId, env.db);
    await setProjectArchived(paul, projectId, true, env.db);
    await setProjectArchived(paul, projectId, false, env.db);

    const audit = team("Audit");
    expect(await auditRows()).toEqual(
      [
        ["client.created", `client:${clientId}`],
        ["client.updated", `client:${clientId}`],
        ["project.created", `project:${projectId}`],
        ["project.updated", `project:${projectId}`],
        ["assignment.created", `project:${projectId}/team:${audit}`],
        ["assignment.updated", `project:${projectId}/team:${audit}`],
        ["assignment.removed", `project:${projectId}/team:${audit}`],
        ["project.archived", `project:${projectId}`],
        ["project.restored", `project:${projectId}`],
      ].map(([action, target]) => ({ actor_id: paul.memberId, action, target })),
    );
    const stored = (await env.db.execute(sql`select code, domains, email_domains from clients where id = ${clientId}`)).rows[0];
    expect(stored).toEqual({ code: "MCE", domains: ["maracoffee.example"], email_domains: ["maracoffee.example"] });
  });

  it("gets no row when the write fails", async () => {
    const before = (await auditRows()).length;
    await expect(assign(as("Diane Ingabire"), { projectId: project("LKB-AUD-26"), teamId: team("Advisory") }, env.db)).rejects.toThrow();
    await expect(
      asAdmin(env.db, member("Paul Mwangi"), async (tx) => {
        await tx.execute(sql`insert into audit_log (org_id, actor_id, action, target) values (${env.tables.orgs[0]!.id}, ${member("Paul Mwangi")}, 'project.updated', 'x')`);
        await tx.execute(sql`update projects set code = 'LKB-TAX-HC' where id = ${project("LKB-AUD-26")}`);
      }),
    ).rejects.toThrow();
    expect((await auditRows()).length).toBe(before);
  });
});

describe("archiving a project", () => {
  it("hides it from pickers and new assignments while its hours and history stay", async () => {
    const owner = as("Paul Mwangi");
    const tp = project("KVS-TP-26");
    const hours = (await getOverview(owner, week, NOW, env.db)).byProject.find((p) => p.id === tp)!;
    expect(hours.seconds).toBeGreaterThan(0);
    expect((await getMe(owner, env.db)).projects.map((p) => p.id)).toContain(tp);

    await setProjectArchived(owner, tp, true, env.db);
    expect((await getMe(owner, env.db)).projects.map((p) => p.id)).not.toContain(tp);
    expect((await getOverview(owner, week, NOW, env.db)).byProject.find((p) => p.id === tp)).toEqual(hours);
    const listed = (await getCatalog(owner, week, env.db)).clients.flatMap((c) => c.projects).find((p) => p.id === tp)!;
    expect(listed).toMatchObject({ archived: true, seconds: hours.seconds });
    expect(await count(sql`select count(*)::int as n from blocks where project_id = ${tp}`)).toBeGreaterThan(0);
    await expect(assign(owner, { projectId: tp, teamId: team("Tax") }, env.db)).rejects.toThrow("is archived");
    const org = env.tables.orgs[0]!.id;
    const raced = asAdmin(env.db, owner.memberId, (tx) => tx.execute(sql`insert into assignments (org_id, project_id, team_id) values (${org}, ${tp}, ${team("Tax")}) returning id`));
    expect(await pgError(raced)).toMatch(/row-level security/);
    await setProjectArchived(owner, tp, false, env.db);
  });
});

describe("the clients and projects list", () => {
  it("shows hours from rollups and only the admin's people as assignable", async () => {
    const all = await getCatalog(as("Paul Mwangi"), week, env.db);
    const scoped = await getCatalog(as("Diane Ingabire"), week, env.db);
    const sum = (c: typeof all) => c.clients.reduce((a, x) => a + x.seconds, 0);
    expect(sum(all)).toBeCloseTo((await getOverview(as("Paul Mwangi"), week, NOW, env.db)).withProjectSeconds, 3);
    expect(scoped.assignable.members).toHaveLength(26);
    expect(scoped.assignable.teams.map((t) => t.name)).toEqual(["Audit", "Tax"]);
    const erp = scoped.clients.flatMap((c) => c.projects).find((p) => p.code === "TWG-ADV-ERP")!;
    expect(erp.assignments.find((a) => !a.team)).toMatchObject({ name: "Someone outside your teams", editable: false });
  });
});
