import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type { Block, Tables, Timesheet } from "../domain/model";
import type { Db, Tx } from "./client";
import * as s from "./schema";

const BATCH = 1000;
const opt = <T>(v: T | null) => v ?? undefined;
const ms = (d: Date | null) => (d ? d.getTime() : undefined);
const date = (x: number | undefined) => (x === undefined ? null : new Date(x));

export function emptyTables(): Tables {
  return { orgs: [], members: [], teams: [], teamMembers: [], devices: [], clients: [], projects: [], assignments: [], blocks: [], dailyRollups: [], timesheets: [], timesheetLines: [], auditLog: [] };
}

async function insertAll<T>(rows: T[], insert: (batch: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += BATCH) await insert(rows.slice(i, i + BATCH));
}

/** Replaces every org's data with these tables. Used by the dev seed and the tests, never by the app. */
export async function replaceAll(db: Db, t: Tables) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`truncate orgs cascade`);
    await insertAll(t.orgs, (b) => tx.insert(s.orgs).values(b));
    await insertAll(t.members, (b) => tx.insert(s.members).values(b));
    await insertAll(t.teams, (b) => tx.insert(s.teams).values(b));
    await insertAll(t.teamMembers, (b) => tx.insert(s.teamMembers).values(b));
    await insertAll(t.devices, (b) => tx.insert(s.devices).values(b.map((d) => ({ ...d, lastSeenAt: new Date(d.lastSeenAt) }))));
    await insertAll(t.clients, (b) => tx.insert(s.clients).values(b.map((x) => ({ ...x, archivedAt: date(x.archivedAt) }))));
    await insertAll(t.projects, (b) => tx.insert(s.projects).values(b.map((x) => ({ ...x, archivedAt: date(x.archivedAt) }))));
    await insertAll(t.assignments, (b) => tx.insert(s.assignments).values(b));
    await insertAll(t.blocks, (b) => tx.insert(s.blocks).values(b.map((x) => ({ ...x, start: new Date(x.start), end: new Date(x.end) }))));
    await insertAll(t.dailyRollups, (b) => tx.insert(s.dailyRollups).values(b));
    // Lines can't go into an approved timesheet, so approved ones arrive as submitted and are approved once their lines are in.
    await insertAll(t.timesheets, (b) =>
      tx.insert(s.timesheets).values(
        b.map((x) => ({
          ...x,
          status: x.status === "approved" ? ("submitted" as const) : x.status,
          submittedAt: x.submittedAt ? new Date(x.submittedAt) : null,
          approvedAt: x.approvedAt ? new Date(x.approvedAt) : null,
        })),
      ),
    );
    await insertAll(t.timesheetLines, (b) => tx.insert(s.timesheetLines).values(b));
    const approved = t.timesheets.filter((x) => x.status === "approved").map((x) => x.id);
    await insertAll(approved, (b) => tx.update(s.timesheets).set({ status: "approved" }).where(inArray(s.timesheets.id, b)));
    await insertAll(t.auditLog, (b) => tx.insert(s.auditLog).values(b.map((x) => ({ ...x, at: new Date(x.at) }))));
  });
}

/** The admin's org with its people, teams, clients and projects, as row-level security lets the admin see them. */
export async function loadOrg(tx: Tx, adminId: string): Promise<Tables> {
  const t = emptyTables();
  const [admin] = await tx.select({ orgId: s.members.orgId }).from(s.members).where(eq(s.members.id, adminId));
  if (!admin) return t;
  const org = admin.orgId;
  t.orgs = await tx.select().from(s.orgs).where(eq(s.orgs.id, org));
  const members = await tx.select().from(s.members).where(eq(s.members.orgId, org));
  const teams = await tx.select().from(s.teams).where(eq(s.teams.orgId, org));
  const links = await tx.select().from(s.teamMembers).where(eq(s.teamMembers.orgId, org));
  const clients = await tx.select().from(s.clients).where(eq(s.clients.orgId, org));
  const projects = await tx.select().from(s.projects).where(eq(s.projects.orgId, org));
  t.members = members.map((m) => ({ ...m, adminScope: opt(m.adminScope) }));
  t.teams = teams;
  t.teamMembers = links;
  t.clients = clients.map((c) => ({ ...c, archivedAt: ms(c.archivedAt) }));
  t.projects = projects.map((p) => ({ ...p, odooId: opt(p.odooId), archivedAt: ms(p.archivedAt) }));
  return t;
}

export async function loadAssignments(tx: Tx, t: Tables, orgId: string) {
  const rows = await tx.select().from(s.assignments).where(eq(s.assignments.orgId, orgId));
  t.assignments = rows.map((a) => ({ ...a, memberId: opt(a.memberId), teamId: opt(a.teamId), startsAt: opt(a.startsAt), endsAt: opt(a.endsAt) }));
}

export async function loadRollups(tx: Tx, t: Tables, orgId: string, from: string, to: string, memberIds: string[]) {
  if (!memberIds.length) return;
  const rows = await tx
    .select()
    .from(s.dailyRollups)
    .where(and(eq(s.dailyRollups.orgId, orgId), gte(s.dailyRollups.date, from), lte(s.dailyRollups.date, to), inArray(s.dailyRollups.memberId, memberIds)));
  t.dailyRollups.push(...rows.map((r) => ({ ...r, projectId: opt(r.projectId) })));
}

export async function loadDevices(tx: Tx, t: Tables, orgId: string, seenSince: number, memberIds: string[]) {
  if (!memberIds.length) return;
  const rows = await tx
    .select()
    .from(s.devices)
    .where(and(eq(s.devices.orgId, orgId), gte(s.devices.lastSeenAt, new Date(seenSince)), inArray(s.devices.memberId, memberIds)));
  t.devices = rows.map((d) => ({ ...d, lastSeenAt: d.lastSeenAt.getTime() }));
}

export async function loadBlocks(tx: Tx, t: Tables, orgId: string, from: number, to: number, memberIds: string[]) {
  if (!memberIds.length) return;
  const rows = await tx
    .select()
    .from(s.blocks)
    .where(
      and(
        eq(s.blocks.orgId, orgId),
        inArray(s.blocks.memberId, memberIds),
        gte(s.blocks.start, new Date(from)),
        lt(s.blocks.start, new Date(to)),
        eq(s.blocks.deleted, false),
      ),
    )
    .orderBy(s.blocks.start);
  t.blocks = rows.map(
    (b): Block => ({
      ...b,
      start: b.start.getTime(),
      end: b.end.getTime(),
      label: opt(b.label),
      summary: opt(b.summary),
      app: opt(b.app),
      title: opt(b.title),
      siteDomain: opt(b.siteDomain),
      clientId: opt(b.clientId),
      projectId: opt(b.projectId),
      confidence: opt(b.confidence),
      evidence: opt(b.evidence),
    }),
  );
}

const sheet = (x: typeof s.timesheets.$inferSelect): Timesheet => ({
  ...x,
  submittedAt: ms(x.submittedAt),
  approvedAt: ms(x.approvedAt),
  approvedBy: opt(x.approvedBy),
  reviewNote: opt(x.reviewNote),
});

export async function loadTimesheets(tx: Tx, t: Tables, orgId: string, weekStart: string, memberIds: string[], withLines: boolean) {
  if (!memberIds.length) return;
  const rows = await tx
    .select()
    .from(s.timesheets)
    .where(and(eq(s.timesheets.orgId, orgId), eq(s.timesheets.weekStart, weekStart), inArray(s.timesheets.memberId, memberIds)));
  t.timesheets = rows.map(sheet);
  if (withLines && rows.length) {
    t.timesheetLines = await tx.select().from(s.timesheetLines).where(inArray(s.timesheetLines.timesheetId, rows.map((x) => x.id)));
  }
}

export async function loadTimesheet(tx: Tx, t: Tables, orgId: string, id: string) {
  const rows = await tx.select().from(s.timesheets).where(and(eq(s.timesheets.orgId, orgId), eq(s.timesheets.id, id)));
  t.timesheets = rows.map(sheet);
  if (rows.length) t.timesheetLines = await tx.select().from(s.timesheetLines).where(eq(s.timesheetLines.timesheetId, id));
}

/** Submitted timesheets per week, for the people given: what's waiting for the admin. */
export async function loadWaiting(tx: Tx, orgId: string, memberIds: string[]) {
  if (!memberIds.length) return [];
  return tx
    .select({ weekStart: s.timesheets.weekStart, count: sql<number>`count(*)::int` })
    .from(s.timesheets)
    .where(and(eq(s.timesheets.orgId, orgId), eq(s.timesheets.status, "submitted"), inArray(s.timesheets.memberId, memberIds)))
    .groupBy(s.timesheets.weekStart)
    .orderBy(s.timesheets.weekStart);
}

/** The newest send-back or reopen of a timesheet, for who did it and when. */
export async function loadLastReview(tx: Tx, orgId: string, timesheetId: string) {
  const [row] = await tx
    .select({ action: s.auditLog.action, actorId: s.auditLog.actorId, at: s.auditLog.at })
    .from(s.auditLog)
    .where(and(eq(s.auditLog.orgId, orgId), eq(s.auditLog.target, `timesheet:${timesheetId}`), inArray(s.auditLog.action, ["timesheet.rejected", "timesheet.reopened"])))
    .orderBy(desc(s.auditLog.at))
    .limit(1);
  return row ? { action: row.action, actorId: row.actorId, at: row.at.getTime() } : null;
}
