import { sql } from "drizzle-orm";
import { boolean, check, date, index, uniqueIndex, integer, jsonb, pgEnum, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const role = pgEnum("member_role", ["owner", "admin", "employee"]);
export const adminScope = pgEnum("admin_scope", ["org", "teams"]);
export const memberStatus = pgEnum("member_status", ["active", "deactivated"]);
export const blockKind = pgEnum("block_kind", ["work", "idle", "away"]);
export const timesheetStatus = pgEnum("timesheet_status", ["draft", "submitted", "approved", "rejected"]);

const id = () => uuid().primaryKey().defaultRandom();
const orgId = () => uuid().notNull().references(() => orgs.id, { onDelete: "cascade" });
const memberId = () => uuid().notNull().references(() => members.id, { onDelete: "cascade" });
const at = () => timestamp({ withTimezone: true, mode: "date" });

export const orgs = pgTable("orgs", {
  id: id(),
  name: text().notNull(),
  shortName: text().notNull(),
  domains: text().array().notNull(),
  entraTenantId: text().notNull().unique(),
  policy: jsonb().$type<{ timeZone: string; coreStart: number; coreEnd: number; workingDays: number[]; leaveTypes: string[] }>().notNull(),
  retention: jsonb().$type<{ activityMonths: number; timesheetYears: number }>().notNull(),
});

export const members = pgTable(
  "members",
  {
    id: id(),
    orgId: orgId(),
    entraObjectId: text().notNull(),
    email: text().notNull(),
    name: text().notNull(),
    title: text().notNull(),
    role: role().notNull(),
    adminScope: adminScope(),
    status: memberStatus().notNull(),
  },
  (t) => [index().on(t.orgId), uniqueIndex().on(t.orgId, t.entraObjectId)],
);

/** Dev sign-in sessions now; the same shape as Auth.js database sessions, so its adapter can own them later. */
export const sessions = pgTable("sessions", {
  sessionToken: text().primaryKey(),
  memberId: memberId(),
  expires: at().notNull(),
});

export const teams = pgTable("teams", { id: id(), orgId: orgId(), name: text().notNull() }, (t) => [index().on(t.orgId)]);

export const teamMembers = pgTable(
  "team_members",
  {
    orgId: orgId(),
    teamId: uuid().notNull().references(() => teams.id, { onDelete: "cascade" }),
    memberId: memberId(),
    isAdminScope: boolean().notNull(),
  },
  (t) => [index().on(t.teamId), index().on(t.memberId)],
);

export const devices = pgTable(
  "devices",
  {
    id: id(),
    orgId: orgId(),
    memberId: memberId(),
    platform: text().$type<"windows" | "macos" | "linux">().notNull(),
    appVersion: text().notNull(),
    lastSeenAt: at().notNull(),
  },
  (t) => [index().on(t.orgId, t.lastSeenAt)],
);

export const clients = pgTable(
  "clients",
  {
    id: id(),
    orgId: orgId(),
    name: text().notNull(),
    code: text().notNull(),
    aliases: text().array().notNull(),
    domains: text().array().notNull(),
    emailDomains: text().array().notNull().default(sql`'{}'`),
    billable: boolean().notNull(),
    archivedAt: at(),
  },
  (t) => [index().on(t.orgId), uniqueIndex("clients_org_id_code_index").on(t.orgId, sql`lower(${t.code})`)],
);

export const projects = pgTable(
  "projects",
  {
    id: id(),
    orgId: orgId(),
    clientId: uuid().notNull().references(() => clients.id, { onDelete: "cascade" }),
    name: text().notNull(),
    code: text().notNull(),
    keywords: text().array().notNull(),
    billable: boolean().notNull(),
    odooId: integer(),
    archivedAt: at(),
  },
  (t) => [index().on(t.orgId), uniqueIndex("projects_org_id_code_index").on(t.orgId, sql`lower(${t.code})`)],
);

export const assignments = pgTable(
  "assignments",
  {
    id: id(),
    orgId: orgId(),
    projectId: uuid().notNull().references(() => projects.id, { onDelete: "cascade" }),
    memberId: uuid().references(() => members.id, { onDelete: "cascade" }),
    teamId: uuid().references(() => teams.id, { onDelete: "cascade" }),
    startsAt: date({ mode: "string" }),
    endsAt: date({ mode: "string" }),
  },
  (t) => [
    index().on(t.projectId),
    check("assignments_one_assignee", sql`(${t.memberId} is null) <> (${t.teamId} is null)`),
    check("assignments_dates_in_order", sql`${t.endsAt} is null or ${t.startsAt} is null or ${t.endsAt} >= ${t.startsAt}`),
  ],
);

export const blocks = pgTable(
  "blocks",
  {
    id: text().primaryKey(),
    orgId: orgId(),
    memberId: memberId(),
    deviceId: uuid().notNull().references(() => devices.id, { onDelete: "cascade" }),
    revision: integer().notNull(),
    start: at().notNull(),
    end: at().notNull(),
    kind: blockKind().notNull(),
    label: text(),
    summary: text(),
    app: text(),
    title: text(),
    siteDomain: text(),
    clientId: uuid().references(() => clients.id),
    projectId: uuid().references(() => projects.id),
    confidence: real(),
    evidence: text().array(),
    deleted: boolean().notNull().default(false),
  },
  (t) => [index().on(t.orgId, t.memberId, t.start)],
);

export const dailyRollups = pgTable(
  "daily_rollups",
  {
    orgId: orgId(),
    memberId: memberId(),
    date: date({ mode: "string" }).notNull(),
    projectId: uuid().references(() => projects.id),
    seconds: real().notNull(),
    billableSeconds: real().notNull(),
    coreSeconds: real().notNull(),
    idleSeconds: real().notNull(),
  },
  (t) => [index().on(t.orgId, t.date), index().on(t.memberId, t.date)],
);

export const timesheets = pgTable(
  "timesheets",
  {
    id: id(),
    orgId: orgId(),
    memberId: memberId(),
    weekStart: date({ mode: "string" }).notNull(),
    status: timesheetStatus().notNull(),
    submittedAt: at(),
    approvedBy: uuid().references(() => members.id),
    approvedAt: at(),
    /** Bumped by a trigger on every change to the timesheet or its lines, so a review of an older copy is refused. */
    version: integer().notNull().default(1),
    /** Why it was sent back, or why it was reopened. */
    reviewNote: text(),
  },
  (t) => [
    index().on(t.orgId, t.weekStart),
    index().on(t.memberId, t.weekStart),
    check("timesheets_rejected_has_note", sql`${t.status} <> 'rejected' or length(trim(coalesce(${t.reviewNote}, ''))) > 0`),
    check("timesheets_approved_has_approver", sql`${t.status} <> 'approved' or (${t.approvedBy} is not null and ${t.approvedAt} is not null)`),
  ],
);

export const timesheetLines = pgTable(
  "timesheet_lines",
  {
    timesheetId: uuid().notNull().references(() => timesheets.id, { onDelete: "cascade" }),
    date: date({ mode: "string" }).notNull(),
    projectId: uuid().notNull().references(() => projects.id),
    hours: real().notNull(),
    description: text().notNull(),
  },
  (t) => [index().on(t.timesheetId), check("timesheet_lines_quarter_hours", sql`${t.hours} > 0 and ${t.hours} <= 24 and ${t.hours} * 4 = trunc(${t.hours} * 4)`)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    orgId: orgId(),
    actorId: uuid().references(() => members.id),
    action: text().notNull(),
    target: text().notNull(),
    /** The reason given, for actions that need one: a send-back comment or a reopen reason. */
    detail: text(),
    at: at().notNull().default(sql`now()`),
  },
  (t) => [index().on(t.orgId, t.at)],
);
