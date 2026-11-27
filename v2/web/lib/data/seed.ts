import { randomUUID } from "node:crypto";
import { CLIENTS, graceDateFor, MEMBERS, ORG, PROJECTS, rng, seedDay, TEAMS } from "../domain/firm";
import type { Block, DailyRollup, Org, Project, Tables, Timesheet, TimesheetLine } from "../domain/model";
import { rollupDay } from "../domain/rollup";
import { addDays, dayStart, datesBetween, localDate, mondayOf } from "../domain/time";

const CURRENT_WEEK_STATUS = ["submitted", "submitted", "approved", "submitted", "draft", "submitted", "missing", "rejected", "submitted", "approved"] as const;

/** Rebuilds a member's rollup rows for one local day from their blocks, as the ingest path will after each upload. */
export function rollupsFor(blocks: Block[], projects: Project[], org: Org, memberId: string, date: string): DailyRollup[] {
  const billable = new Map(projects.map((p) => [p.id, p.billable]));
  return rollupDay(blocks, date, org.policy, (id) => billable.get(id) ?? false).map((row) => ({
    orgId: org.id,
    memberId,
    date,
    ...row,
  }));
}

/** Kestrel & Vale with four past weeks and this week up to now, all invented. */
export function seedTables(now: number, weeks = 4): Tables {
  const ids = new Map<string, string>();
  const id = (key: string) => ids.get(key) ?? (ids.set(key, randomUUID()), ids.get(key)!);
  const orgId = id("org");
  const org: Org = {
    id: orgId,
    name: ORG.name,
    shortName: ORG.shortName,
    domains: [ORG.domain],
    entraTenantId: ORG.tenant,
    policy: {
      timeZone: ORG.timeZone,
      coreStart: ORG.coreStart,
      coreEnd: ORG.coreEnd,
      workingDays: [1, 2, 3, 4, 5],
      leaveTypes: ["Annual leave", "Sick leave", "Study leave", "Compassionate leave"],
    },
    retention: { activityMonths: 13, timesheetYears: 7 },
  };
  const t: Tables = {
    orgs: [org],
    teams: TEAMS.map((name) => ({ id: id("team_" + name), orgId, name })),
    clients: CLIENTS.map((c) => ({ id: id("client_" + c.key), orgId, name: c.name, code: c.code, aliases: c.aliases, domains: c.domains, billable: c.billable })),
    projects: PROJECTS.map((p) => ({ id: id("project_" + p.key), orgId, clientId: id("client_" + p.client), name: p.name, code: p.code, keywords: p.keywords, billable: p.billable })),
    members: MEMBERS.map((m) => ({
      id: id(m.key),
      orgId,
      entraObjectId: m.oid,
      email: m.email,
      name: m.name,
      title: m.title,
      role: m.role,
      adminScope: m.role === "admin" ? "teams" : undefined,
      status: "active",
    })),
    teamMembers: MEMBERS.flatMap((m) => [
      { orgId, teamId: id("team_" + m.team), memberId: id(m.key), isAdminScope: m.adminOf.includes(m.team) },
      ...m.adminOf.filter((team) => team !== m.team).map((team) => ({ orgId, teamId: id("team_" + team), memberId: id(m.key), isAdminScope: true })),
    ]),
    devices: MEMBERS.map((m, i) => ({
      id: id("device_" + m.key),
      orgId,
      memberId: id(m.key),
      platform: "windows",
      appVersion: "2.0.0-beta.1",
      lastSeenAt: m.activeNow ? now - Math.floor(rng(i)() * 4) * 60_000 : now - 3 * 3_600_000,
    })),
    assignments: PROJECTS.filter((p) => p.client !== "int").flatMap((p) =>
      TEAMS.filter((team) => MEMBERS.some((m) => m.team === team && m.primary === p.key)).map((team) => ({
        id: randomUUID(),
        orgId,
        projectId: id("project_" + p.key),
        teamId: id("team_" + team),
      })),
    ),
    blocks: [],
    dailyRollups: [],
    timesheets: [],
    timesheetLines: [],
    auditLog: [{ orgId, action: "org.seeded", target: ORG.name, at: now }],
  };

  const today = localDate(now, ORG.timeZone);
  const thisWeek = mondayOf(today);
  const dates = datesBetween(addDays(thisWeek, -7 * weeks), today);
  const graceDate = graceDateFor(today);
  const clientOf = new Map(PROJECTS.map((p) => [p.key, p.client]));
  const owner = id(MEMBERS.find((m) => m.role === "owner")!.key);

  for (const [i, m] of MEMBERS.entries()) {
    for (const date of dates) {
      seedDay(m, i, date, now, graceDate).forEach((b, n) =>
        t.blocks.push({
          id: `${id(m.key)}-${date}-${n}`,
          orgId,
          memberId: id(m.key),
          deviceId: id("device_" + m.key),
          revision: 1,
          start: b.start,
          end: b.end,
          kind: b.kind,
          label: b.label,
          summary: b.summary,
          app: b.app,
          title: b.title,
          siteDomain: b.siteDomain,
          projectId: b.projectKey && id("project_" + b.projectKey),
          clientId: b.projectKey && id("client_" + clientOf.get(b.projectKey)),
          confidence: b.confidence,
          evidence: b.evidence,
          deleted: false,
        }),
      );
    }
  }
  for (const m of MEMBERS) {
    const own = t.blocks.filter((b) => b.memberId === id(m.key));
    for (const date of dates) t.dailyRollups.push(...rollupsFor(own, t.projects, org, id(m.key), date));
  }

  for (const [i, m] of MEMBERS.entries()) {
    const own = t.blocks.filter((b) => b.memberId === id(m.key));
    for (let w = 0; w <= weeks; w++) {
      const weekStart = addDays(thisWeek, -7 * (weeks - w));
      const status = weekStart === thisWeek ? CURRENT_WEEK_STATUS[i % CURRENT_WEEK_STATUS.length]! : "approved";
      if (status === "missing") continue;
      const sheetId = randomUUID();
      const friday = dayStart(addDays(weekStart, 4), ORG.timeZone) + 16 * 3_600_000;
      const sheet: Timesheet = { id: sheetId, orgId, memberId: id(m.key), weekStart, status };
      if (status !== "draft") sheet.submittedAt = Math.min(friday, now);
      if (status === "approved") Object.assign(sheet, { approvedBy: owner, approvedAt: Math.min(friday + 3 * 3_600_000, now) });
      t.timesheets.push(sheet);
      const lines: TimesheetLine[] = t.dailyRollups
        .filter((r) => r.memberId === id(m.key) && r.projectId && r.date >= weekStart && r.date < addDays(weekStart, 7) && r.seconds >= 900)
        .map((r) => ({
          timesheetId: sheetId,
          date: r.date,
          projectId: r.projectId!,
          hours: Math.round((r.seconds / 3600) * 4) / 4,
          description: own.find((b) => b.projectId === r.projectId && b.start >= dayStart(r.date, ORG.timeZone))?.label ?? "",
        }));
      t.timesheetLines.push(...lines);
    }
  }
  return t;
}
