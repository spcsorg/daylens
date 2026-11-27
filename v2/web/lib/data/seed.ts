import { randomUUID } from "node:crypto";
import { CLIENTS, graceDateFor, MEMBERS, ORG, PROJECTS, rng, seedDay, TEAMS } from "../domain/firm";
import type { Leave, Org, Tables, Timesheet, TimesheetLine } from "../domain/model";
import { rollupsFor } from "../domain/rollup";
import { addDays, dayStart, datesBetween, localDate, mondayOf } from "../domain/time";

const CURRENT_WEEK_STATUS = ["submitted", "submitted", "approved", "submitted", "draft", "submitted", "missing", "rejected", "submitted", "approved"] as const;

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
    clients: CLIENTS.map((c) => ({ id: id("client_" + c.key), orgId, name: c.name, code: c.code, aliases: c.aliases, domains: c.domains, emailDomains: c.domains, billable: c.billable })),
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
    leave: [],
    auditLog: [{ orgId, action: "org.seeded", target: ORG.name, at: now }],
  };

  const today = localDate(now, ORG.timeZone);
  const thisWeek = mondayOf(today);
  const personal: [string, string, number, number | null][] = [
    ["Leah Wanjiru", "lkb-aud", -7, 11],
    ["Leah Wanjiru", "lkb-tax", -14, 11],
    ["Tomás Herrera", "twg-erp", -21, null],
  ];
  for (const [name, project, from, to] of personal) {
    t.assignments.push({
      id: randomUUID(),
      orgId,
      projectId: id("project_" + project),
      memberId: id(MEMBERS.find((m) => m.name === name)!.key),
      startsAt: addDays(thisWeek, from),
      endsAt: to === null ? undefined : addDays(thisWeek, to),
    });
  }
  const memberId = (name: string) => id(MEMBERS.find((m) => m.name === name)!.key);
  // The prototype's month: leave that matches an empty day, one leave day with activity, one working day with neither, and leave still to come.
  const leave: [string, string, number, number][] = [
    ["Claudine Umutoni", "Annual leave", -21, -17],
    ["Esther Mutoni", "Study leave", -14, -13],
    ["Olivier Habimana", "Annual leave", -11, -11],
    ["Moses Tumusiime", "Sick leave", -7, -5],
    ["Leah Wanjiru", "Annual leave", 7, 8],
  ];
  t.leave = leave.map(([name, type, from, to]): Leave => ({ id: randomUUID(), orgId, memberId: memberId(name), type, startsOn: addDays(thisWeek, from), endsOn: addDays(thisWeek, to) }));
  const activeOnLeave = { memberId: memberId("Olivier Habimana"), date: addDays(thisWeek, -11), minutes: 126 };
  const noActivity = { memberId: memberId("Aline Uwera"), date: addDays(thisWeek, -14) };
  const away = (who: string, date: string) =>
    (who === noActivity.memberId && date === noActivity.date) || t.leave.some((l) => l.memberId === who && l.startsOn <= date && l.endsOn >= date);
  const dates = datesBetween(addDays(thisWeek, -7 * weeks), today);
  const graceDate = graceDateFor(today);
  const clientOf = new Map(PROJECTS.map((p) => [p.key, p.client]));
  const owner = id(MEMBERS.find((m) => m.role === "owner")!.key);

  for (const [i, m] of MEMBERS.entries()) {
    for (const date of dates) {
      let day = seedDay(m, i, date, now, graceDate);
      if (id(m.key) === activeOnLeave.memberId && date === activeOnLeave.date) {
        const cut = day[0]!.start + activeOnLeave.minutes * 60_000;
        day = day.filter((b) => b.start < cut).map((b) => ({ ...b, end: Math.min(b.end, cut) }));
      } else if (away(id(m.key), date)) day = [];
      day.forEach((b, n) =>
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
      const sheet: Timesheet = { id: sheetId, orgId, memberId: id(m.key), weekStart, status, version: 1 };
      if (status === "rejected") sheet.reviewNote = "Split Tuesday between the VAT return and the WHT schedules, then send it again.";
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
