import type { DailyRollup, Org, Tables, TimesheetStatus } from "../domain/model";
import { coreSecondsPerDay } from "../domain/rollup";
import { addDays, dayStart, datesBetween, DAY_MS, isoWeekday, localDate, mondayOf } from "../domain/time";
import { timeline, totalsBy } from "../domain/timeline";
import { AccessError, membersInScope, requireAdmin, requireAssignee, requireMemberInScope, type Session } from "./access";

const ACTIVE_WINDOW_MS = 5 * 60_000;

export type Range = { from: string; to: string };

function checkRange({ from, to }: Range) {
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (!date.test(from) || !date.test(to) || from > to) throw new AccessError("That date range isn’t valid");
  if (datesBetween(from, to).length > 62) throw new AccessError("Pick a range of two months or less");
}

const sum = <T>(rows: T[], pick: (r: T) => number) => rows.reduce((a, r) => a + pick(r), 0);
const isWeek = ({ from, to }: Range) => mondayOf(from) === from && addDays(from, 6) === to;

/** Core-hours seconds one person could have covered in the range, stopping at today. */
function expectedCoreSeconds(org: Org, { from, to }: Range, now: number): number {
  const today = localDate(now, org.policy.timeZone);
  const last = to < today ? to : today;
  if (last < from) return 0;
  return datesBetween(from, last).filter((d) => org.policy.workingDays.includes(isoWeekday(d))).length * coreSecondsPerDay(org.policy);
}

function rollups(t: Tables, orgId: string, { from, to }: Range, members: Set<string>) {
  return t.dailyRollups.filter((r) => r.orgId === orgId && r.date >= from && r.date <= to && members.has(r.memberId));
}

function teamsByMember(t: Tables, orgId: string) {
  const names = new Map(t.teams.filter((x) => x.orgId === orgId).map((x) => [x.id, x.name]));
  const out = new Map<string, string[]>();
  for (const l of t.teamMembers) if (names.has(l.teamId)) out.set(l.memberId, [...(out.get(l.memberId) ?? []), names.get(l.teamId)!]);
  return out;
}

function projectLabel(t: Tables, projectId: string) {
  const p = t.projects.find((x) => x.id === projectId);
  const c = p && t.clients.find((x) => x.id === p.clientId);
  return { name: p?.name ?? "", code: p?.code ?? "", clientId: p?.clientId ?? "", clientName: c?.name ?? "", internal: c?.billable === false, billable: p?.billable ?? false };
}

export type ProjectLabel = ReturnType<typeof projectLabel>;

/** The signed-in admin, their org, and what the filter menus offer within their scope. */
export function me(t: Tables, session: Session | null) {
  const { org, member, teamIds } = requireAdmin(t, session);
  const teams = t.teams.filter((x) => x.orgId === org.id && (!teamIds || teamIds.includes(x.id)));
  return {
    member: { name: member.name, title: member.title, role: member.role, scope: teamIds ? teams.map((x) => x.name) : null },
    org: { name: org.name, shortName: org.shortName, timeZone: org.policy.timeZone, coreStart: org.policy.coreStart, coreEnd: org.policy.coreEnd, workingDays: org.policy.workingDays },
    teams: teams.map((x) => ({ id: x.id, name: x.name })),
    clients: t.clients.filter((c) => c.orgId === org.id && !c.archivedAt).map((c) => ({ id: c.id, name: c.name, billable: c.billable })),
    projects: t.projects
      .filter((p) => p.orgId === org.id && !p.archivedAt && !t.clients.find((c) => c.id === p.clientId)?.archivedAt)
      .map((p) => ({ id: p.id, name: p.name, clientId: p.clientId })),
  };
}

export type Me = ReturnType<typeof me>;

export type OverviewArgs = Range & { teamId?: string; clientId?: string; projectId?: string; billable?: boolean };

export function overview(t: Tables, session: Session | null, args: OverviewArgs, now: number) {
  checkRange(args);
  const access = requireAdmin(t, session);
  const { org } = access;
  const people = membersInScope(t, access, args.teamId);
  const ids = new Set(people.map((m) => m.id));
  const projects = new Map(t.projects.filter((p) => p.orgId === org.id).map((p) => [p.id, p]));
  const clients = new Map(t.clients.filter((c) => c.orgId === org.id).map((c) => [c.id, c]));
  const filtered = args.clientId !== undefined || args.projectId !== undefined || args.billable !== undefined;
  const keep = (r: DailyRollup) => {
    if (!filtered) return true;
    const p = r.projectId ? projects.get(r.projectId) : undefined;
    if (!p) return false;
    if (args.projectId && p.id !== args.projectId) return false;
    if (args.clientId && p.clientId !== args.clientId) return false;
    return args.billable === undefined || p.billable === args.billable;
  };
  const days = datesBetween(args.from, args.to).length;
  const rows = rollups(t, org.id, args, ids).filter(keep);
  const previous = rollups(t, org.id, { from: addDays(args.from, -days), to: addDays(args.from, -1) }, ids).filter(keep);
  const withProject = rows.filter((r) => r.projectId);

  const byClient = new Map<string, number>();
  const byProject = new Map<string, { seconds: number; people: Set<string> }>();
  for (const r of withProject) {
    const p = projects.get(r.projectId!);
    if (!p) continue;
    byClient.set(p.clientId, (byClient.get(p.clientId) ?? 0) + r.seconds);
    const e = byProject.get(p.id) ?? { seconds: 0, people: new Set<string>() };
    e.seconds += r.seconds;
    e.people.add(r.memberId);
    byProject.set(p.id, e);
  }

  const expected = expectedCoreSeconds(org, args, now);
  const core = new Map<string, number>();
  for (const r of rows) core.set(r.memberId, (core.get(r.memberId) ?? 0) + r.coreSeconds);

  const activeIds = new Set(t.devices.filter((d) => d.orgId === org.id && d.lastSeenAt >= now - ACTIVE_WINDOW_MS && ids.has(d.memberId)).map((d) => d.memberId));
  const active = people
    .filter((m) => activeIds.has(m.id))
    .map((m) => {
      const latest = t.blocks.filter((b) => b.memberId === m.id && b.kind === "work" && !b.deleted && b.start <= now).at(-1);
      return {
        memberId: m.id,
        name: m.name,
        project: latest?.projectId ? projectLabel(t, latest.projectId) : null,
        minutes: latest ? Math.max(0, Math.round((now - latest.start) / 60_000)) : 0,
      };
    })
    .sort((a, b) => a.minutes - b.minutes);

  let timesheetsNotIn: number | null = null;
  if (isWeek(args)) {
    const sent = new Set(
      t.timesheets.filter((s) => s.orgId === org.id && s.weekStart === args.from && (s.status === "submitted" || s.status === "approved")).map((s) => s.memberId),
    );
    timesheetsNotIn = people.filter((m) => !sent.has(m.id)).length;
  }

  return {
    people: people.length,
    totalSeconds: sum(rows, (r) => r.seconds),
    previousTotalSeconds: sum(previous, (r) => r.seconds),
    withProjectSeconds: sum(withProject, (r) => r.seconds),
    billableSeconds: sum(rows, (r) => r.billableSeconds),
    unattributedSeconds: sum(rows.filter((r) => !r.projectId), (r) => r.seconds),
    coverage: expected > 0 && people.length > 0 ? sum(people, (m) => Math.min(1, (core.get(m.id) ?? 0) / expected)) / people.length : null,
    byClient: [...byClient]
      .filter(([, s]) => s > 0)
      .map(([id, seconds]) => ({ id, name: clients.get(id)?.name ?? "", billable: clients.get(id)?.billable ?? false, seconds }))
      .sort((a, b) => b.seconds - a.seconds),
    byProject: [...byProject]
      .filter(([, e]) => e.seconds > 0)
      .map(([id, e]) => ({ id, ...projectLabel(t, id), seconds: e.seconds, people: e.people.size }))
      .sort((a, b) => b.seconds - a.seconds),
    byDay: datesBetween(args.from, args.to).map((date) => {
      const day = rows.filter((r) => r.date === date);
      return { date, seconds: sum(day, (r) => r.seconds), billableSeconds: sum(day, (r) => r.billableSeconds) };
    }),
    active: active.slice(0, 9),
    activeCount: active.length,
    timesheetsNotIn,
  };
}

export type Overview = ReturnType<typeof overview>;
export type PeopleArgs = Range & { teamId?: string; clientId?: string };

export function people(t: Tables, session: Session | null, args: PeopleArgs, now: number) {
  checkRange(args);
  const access = requireAdmin(t, session);
  const { org } = access;
  const members = membersInScope(t, access, args.teamId);
  const rows = rollups(t, org.id, args, new Set(members.map((m) => m.id)));
  const clientOf = new Map(t.projects.map((p) => [p.id, p.clientId]));
  const teams = teamsByMember(t, org.id);
  const sheets = isWeek(args) ? new Map(t.timesheets.filter((s) => s.orgId === org.id && s.weekStart === args.from).map((s) => [s.memberId, s.status])) : null;
  const expected = expectedCoreSeconds(org, args, now);
  return members
    .filter((m) => !args.clientId || rows.some((r) => r.memberId === m.id && r.projectId && clientOf.get(r.projectId) === args.clientId && r.seconds > 0))
    .map((m) => {
      const own = rows.filter((r) => r.memberId === m.id);
      const seconds = sum(own, (r) => r.seconds);
      const withProject = sum(own.filter((r) => r.projectId), (r) => r.seconds);
      const core = sum(own, (r) => r.coreSeconds);
      return {
        memberId: m.id,
        name: m.name,
        title: m.title,
        teams: teams.get(m.id) ?? [],
        seconds,
        billableShare: withProject > 0 ? sum(own, (r) => r.billableSeconds) / withProject : null,
        coverage: expected > 0 ? Math.min(1, core / expected) : null,
        idleSeconds: sum(own, (r) => r.idleSeconds),
        outsideCoreSeconds: seconds - core,
        unattributedSeconds: seconds - withProject,
        timesheet: sheets ? ((sheets.get(m.id) ?? "missing") as TimesheetStatus | "missing") : null,
      };
    });
}

export type PersonRow = ReturnType<typeof people>[number];

export function person(t: Tables, session: Session | null, args: Range & { memberId: string }, now: number) {
  checkRange(args);
  const access = requireAdmin(t, session);
  const { org } = access;
  const member = requireMemberInScope(t, access, args.memberId);
  const rows = t.dailyRollups.filter((r) => r.memberId === member.id && r.date >= args.from && r.date <= args.to);
  const short = datesBetween(args.from, args.to).length <= 7;
  const from = dayStart(args.from, org.policy.timeZone);
  const to = dayStart(args.to, org.policy.timeZone) + DAY_MS;
  const blocks = short ? t.blocks.filter((b) => b.memberId === member.id && !b.deleted && b.start >= from && b.start < to).sort((a, b) => a.start - b.start) : [];
  const work = blocks.filter((b) => b.kind === "work");

  const byProject = new Map<string | null, number>();
  for (const r of rows) byProject.set(r.projectId ?? null, (byProject.get(r.projectId ?? null) ?? 0) + r.seconds);
  const referenced = new Set([...rows, ...work].flatMap((r) => (r.projectId ? [r.projectId] : [])));
  const seconds = sum(rows, (r) => r.seconds);
  const withProject = sum(rows.filter((r) => r.projectId), (r) => r.seconds);
  const core = sum(rows, (r) => r.coreSeconds);
  const expected = expectedCoreSeconds(org, args, now);
  const sheet = isWeek(args) ? t.timesheets.find((s) => s.memberId === member.id && s.weekStart === args.from) : undefined;
  const lines = sheet ? t.timesheetLines.filter((l) => l.timesheetId === sheet.id) : [];

  return {
    member: { id: member.id, name: member.name, title: member.title, teams: teamsByMember(t, org.id).get(member.id) ?? [] },
    projects: Object.fromEntries([...referenced].map((id) => [id, projectLabel(t, id)])) as Record<string, ProjectLabel>,
    totals: {
      seconds,
      billableSeconds: sum(rows, (r) => r.billableSeconds),
      withProjectSeconds: withProject,
      coverage: expected > 0 ? Math.min(1, core / expected) : null,
      outsideCoreSeconds: seconds - core,
      idleSeconds: sum(rows, (r) => r.idleSeconds),
    },
    byProject: [...byProject].filter(([, s]) => s > 0).map(([projectId, s]) => ({ projectId, seconds: s })).sort((a, b) => b.seconds - a.seconds),
    days: datesBetween(args.from, args.to).map((date) => {
      const day = rows.filter((r) => r.date === date);
      const top = day.filter((r) => r.projectId).sort((a, b) => b.seconds - a.seconds)[0];
      return { date, seconds: sum(day, (r) => r.seconds), topProjectId: top?.projectId ?? null };
    }),
    entries: timeline(blocks),
    firstSeen: work[0]?.start ?? null,
    lastSeen: work.at(-1)?.end ?? null,
    apps: totalsBy(work, (b) => b.app, 7),
    sites: totalsBy(work, (b) => b.siteDomain, 5),
    documents: totalsBy(work, (b) => (b.siteDomain ? undefined : b.title), 5).map((d) => ({ ...d, app: work.find((b) => b.title === d.name)?.app ?? "" })),
    timesheet: sheet
      ? { status: sheet.status, submittedAt: sheet.submittedAt ?? null, hours: sum(lines, (l) => l.hours), projects: new Set(lines.map((l) => l.projectId)).size }
      : null,
  };
}

export type Person = ReturnType<typeof person>;


/** Clients with their projects, each project's hours in the range from rollups, and who it's assigned to, within the admin's scope. */
export function catalog(t: Tables, session: Session | null, range: Range) {
  checkRange(range);
  const access = requireAdmin(t, session);
  const { org } = access;
  const people = membersInScope(t, access);
  const rows = rollups(t, org.id, range, new Set(people.map((m) => m.id)));
  const names = new Map(t.members.map((m) => [m.id, m.name]));
  const teams = new Map(t.teams.filter((x) => x.orgId === org.id).map((x) => [x.id, x.name]));
  const mayAssign = (a: { memberId?: string; teamId?: string }) => {
    try {
      requireAssignee(t, access, a, false);
      return true;
    } catch {
      return false;
    }
  };
  const projects = t.projects
    .filter((p) => p.orgId === org.id)
    .map((p) => {
      const own = rows.filter((r) => r.projectId === p.id);
      return {
        id: p.id,
        clientId: p.clientId,
        name: p.name,
        code: p.code,
        billable: p.billable,
        keywords: p.keywords,
        archived: !!p.archivedAt,
        seconds: sum(own, (r) => r.seconds),
        people: new Set(own.filter((r) => r.seconds > 0).map((r) => r.memberId)).size,
        assignments: t.assignments
          .filter((a) => a.projectId === p.id)
          .map((a) => ({
            id: a.id,
            team: !!a.teamId,
            name: a.teamId ? (teams.get(a.teamId) ?? "A team") : (names.get(a.memberId!) ?? "Someone outside your teams"),
            startsAt: a.startsAt ?? null,
            endsAt: a.endsAt ?? null,
            editable: mayAssign(a),
          }))
          .sort((a, b) => Number(b.team) - Number(a.team) || a.name.localeCompare(b.name)),
      };
    })
    .sort((a, b) => Number(a.archived) - Number(b.archived) || b.seconds - a.seconds || a.name.localeCompare(b.name));
  const clients = t.clients
    .filter((c) => c.orgId === org.id)
    .map((c) => {
      const own = projects.filter((p) => p.clientId === c.id);
      return {
        id: c.id,
        name: c.name,
        code: c.code,
        billable: c.billable,
        aliases: c.aliases,
        domains: c.domains,
        emailDomains: c.emailDomains,
        archived: !!c.archivedAt,
        seconds: sum(own, (p) => p.seconds),
        projects: own,
      };
    })
    .sort((a, b) => Number(a.archived) - Number(b.archived) || Number(b.billable) - Number(a.billable) || b.seconds - a.seconds || a.name.localeCompare(b.name));
  const assignTeams = t.teams.filter((x) => x.orgId === org.id && (!access.teamIds || access.teamIds.includes(x.id)));
  return {
    clients,
    assignable: {
      teams: assignTeams.map((x) => ({ id: x.id, name: x.name })).sort((a, b) => a.name.localeCompare(b.name)),
      members: people.map((m) => ({ id: m.id, name: m.name })).sort((a, b) => a.name.localeCompare(b.name)),
    },
  };
}

export type Catalog = ReturnType<typeof catalog>;
export type CatalogClient = Catalog["clients"][number];
export type CatalogProject = CatalogClient["projects"][number];

export type Waiting = { weekStart: string; count: number }[];

/** Everyone in scope for one week, with their timesheet's status, the hours they claimed and the time Daylens tracked. */
export function timesheetQueue(t: Tables, session: Session | null, args: { weekStart: string; teamId?: string }, waiting: Waiting) {
  const week = { from: args.weekStart, to: addDays(args.weekStart, 6) };
  checkRange(week);
  if (mondayOf(args.weekStart) !== args.weekStart) throw new AccessError("A timesheet week starts on a Monday");
  const access = requireAdmin(t, session);
  const { org } = access;
  const members = membersInScope(t, access, args.teamId);
  const rows = rollups(t, org.id, week, new Set(members.map((m) => m.id)));
  const billable = new Map(t.projects.map((p) => [p.id, p.billable]));
  const teams = teamsByMember(t, org.id);
  return {
    people: members
      .map((m) => {
        const sheet = t.timesheets.find((s) => s.memberId === m.id && s.weekStart === args.weekStart);
        const lines = sheet ? t.timesheetLines.filter((l) => l.timesheetId === sheet.id) : [];
        const own = rows.filter((r) => r.memberId === m.id);
        return {
          memberId: m.id,
          name: m.name,
          teams: teams.get(m.id) ?? [],
          sheet: sheet ? { id: sheet.id, version: sheet.version, submittedAt: sheet.submittedAt ?? null } : null,
          status: (sheet?.status ?? "missing") as TimesheetStatus | "missing",
          hours: sum(lines, (l) => l.hours),
          billableHours: sum(lines.filter((l) => billable.get(l.projectId)), (l) => l.hours),
          trackedSeconds: sum(own, (r) => r.seconds),
          unattributedSeconds: sum(own.filter((r) => !r.projectId), (r) => r.seconds),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    waitingElsewhere: waiting.filter((w) => w.weekStart !== args.weekStart),
  };
}

export type TimesheetQueue = ReturnType<typeof timesheetQueue>;
export type QueueRow = TimesheetQueue["people"][number];

/** One timesheet for review: hours by project and day with the descriptions, beside what Daylens tracked each day. */
export function timesheetReview(t: Tables, session: Session | null, id: string, last: { action: string; actorId: string | null; at: number } | null) {
  const access = requireAdmin(t, session);
  const sheet = t.timesheets.find((s) => s.id === id && s.orgId === access.org.id);
  if (!sheet) throw new AccessError("That timesheet is outside your admin scope");
  requireAssignee(t, access, { memberId: sheet.memberId }, false);
  const member = t.members.find((m) => m.id === sheet.memberId)!;
  const lines = t.timesheetLines.filter((l) => l.timesheetId === sheet.id);
  const tracked = t.dailyRollups.filter((r) => r.memberId === member.id);
  const week = datesBetween(sheet.weekStart, addDays(sheet.weekStart, 6));
  const days = week.filter((d) => access.org.policy.workingDays.includes(isoWeekday(d)) || lines.some((l) => l.date === d) || sum(tracked.filter((r) => r.date === d), (r) => r.seconds) >= 900);
  const byProject = [...new Set(lines.map((l) => l.projectId))].map((projectId) => {
    const own = lines.filter((l) => l.projectId === projectId).sort((a, b) => a.date.localeCompare(b.date));
    return {
      projectId,
      project: projectLabel(t, projectId),
      hours: days.map((d) => sum(own.filter((l) => l.date === d), (l) => l.hours)),
      descriptions: [...new Set(own.map((l) => l.description.trim()).filter(Boolean))],
      total: sum(own, (l) => l.hours),
    };
  });
  const name = (who: string | null | undefined) => (!who ? null : who === access.member.id ? "you" : (t.members.find((m) => m.id === who)?.name ?? "another admin"));
  return {
    id: sheet.id,
    version: sheet.version,
    status: sheet.status,
    weekStart: sheet.weekStart,
    member: { id: member.id, name: member.name, teams: teamsByMember(t, access.org.id).get(member.id) ?? [] },
    submittedAt: sheet.submittedAt ?? null,
    approved: sheet.approvedAt ? { by: name(sheet.approvedBy), at: sheet.approvedAt } : null,
    note: sheet.reviewNote ?? null,
    lastReview: last && { reopened: last.action === "timesheet.reopened", by: name(last.actorId), at: last.at },
    days,
    rows: byProject.sort((a, b) => b.total - a.total),
    claimed: days.map((d) => sum(lines.filter((l) => l.date === d), (l) => l.hours)),
    tracked: days.map((d) => sum(tracked.filter((r) => r.date === d), (r) => r.seconds) / 3600),
  };
}

export type TimesheetReview = ReturnType<typeof timesheetReview>;
