import { addDays, dayStart, datesBetween, DAY_MS, mondayOf } from "../domain/time";
import { appDb, asAdmin, type Db } from "../db/client";
import { loadAssignments, loadBlocks, loadDevices, loadFirstDays, loadLastReview, loadLeave, loadOrg, loadRollups, loadTimesheet, loadTimesheets, loadWaiting } from "../db/store";
import { AccessError, membersInScope, requireAdmin, requireMemberInScope, type Session } from "./access";
import { attendance, catalog, me, overview, people, person, settings, timesheetQueue, timesheetReview, type AttendanceArgs, type OverviewArgs, type PeopleArgs, type Range } from "./queries";

export { approveTimesheets, rejectTimesheet, reopenTimesheet } from "./review";
export { recordLeave, removeLeave, updateLeave } from "./leave";
export { setMemberActive, updateMember, updatePolicy } from "./settings";
export { assign, createClient, createProject, setClientArchived, setProjectArchived, unassign, updateAssignment, updateClient, updateProject, ValidationError } from "./catalog";

/**
 * The one way screens read and write org data. Each call loads only the admin's org and scope, as daylens_app,
 * then hands the rows to the pure functions in queries.ts; writes live in catalog.ts, review.ts, leave.ts and settings.ts.
 */

const isWeek = ({ from, to }: Range) => mondayOf(from) === from && addDays(from, 6) === to;

/** The signed-in admin, with how many timesheets in their scope are waiting for approval, for the sidebar. */
export function getMe(session: Session, db: Db = appDb()) {
  return asAdmin(db, session.memberId, async (tx) => {
    const t = await loadOrg(tx, session.memberId);
    const out = me(t, session);
    const access = requireAdmin(t, session);
    const waiting = await loadWaiting(tx, access.org.id, membersInScope(t, access).map((m) => m.id));
    return { ...out, waitingTimesheets: waiting.reduce((a, w) => a + w.count, 0) };
  });
}

export function getOverview(session: Session, args: OverviewArgs, now = Date.now(), db: Db = appDb()) {
  return asAdmin(db, session.memberId, async (tx) => {
    const t = await loadOrg(tx, session.memberId);
    const access = requireAdmin(t, session);
    const ids = membersInScope(t, access, args.teamId).map((m) => m.id);
    const days = datesBetween(args.from, args.to).length;
    await loadRollups(tx, t, access.org.id, addDays(args.from, -days), args.to, ids);
    await loadDevices(tx, t, access.org.id, now - 5 * 60_000, ids);
    await loadBlocks(tx, t, access.org.id, now - DAY_MS, now + 1, t.devices.map((d) => d.memberId));
    if (isWeek(args)) await loadTimesheets(tx, t, access.org.id, args.from, ids, false);
    return overview(t, session, args, now);
  });
}

export function getPeople(session: Session, args: PeopleArgs, now = Date.now(), db: Db = appDb()) {
  return asAdmin(db, session.memberId, async (tx) => {
    const t = await loadOrg(tx, session.memberId);
    const access = requireAdmin(t, session);
    const ids = membersInScope(t, access, args.teamId).map((m) => m.id);
    await loadRollups(tx, t, access.org.id, args.from, args.to, ids);
    if (isWeek(args)) await loadTimesheets(tx, t, access.org.id, args.from, ids, false);
    return people(t, session, args, now);
  });
}

export function getPerson(session: Session, args: Range & { memberId: string }, now = Date.now(), db: Db = appDb()) {
  return asAdmin(db, session.memberId, async (tx) => {
    const t = await loadOrg(tx, session.memberId);
    const access = requireAdmin(t, session);
    const { id } = requireMemberInScope(t, access, args.memberId);
    const tz = access.org.policy.timeZone;
    await loadRollups(tx, t, access.org.id, args.from, args.to, [id]);
    if (datesBetween(args.from, args.to).length <= 7) {
      await loadBlocks(tx, t, access.org.id, dayStart(args.from, tz), dayStart(args.to, tz) + DAY_MS, [id]);
    }
    if (isWeek(args)) await loadTimesheets(tx, t, access.org.id, args.from, [id], true);
    return person(t, session, args, now);
  });
}

export function getCatalog(session: Session, range: Range, db: Db = appDb()) {
  return asAdmin(db, session.memberId, async (tx) => {
    const t = await loadOrg(tx, session.memberId);
    const access = requireAdmin(t, session);
    await loadAssignments(tx, t, access.org.id);
    await loadRollups(tx, t, access.org.id, range.from, range.to, membersInScope(t, access).map((m) => m.id));
    return catalog(t, session, range);
  });
}

export function getTimesheets(session: Session, args: { weekStart: string; teamId?: string }, db: Db = appDb()) {
  return asAdmin(db, session.memberId, async (tx) => {
    const t = await loadOrg(tx, session.memberId);
    const access = requireAdmin(t, session);
    const ids = membersInScope(t, access, args.teamId).map((m) => m.id);
    await loadTimesheets(tx, t, access.org.id, args.weekStart, ids, true);
    await loadRollups(tx, t, access.org.id, args.weekStart, addDays(args.weekStart, 6), ids);
    return timesheetQueue(t, session, args, await loadWaiting(tx, access.org.id, ids));
  });
}

export function getTimesheetReview(session: Session, id: string, db: Db = appDb()) {
  return asAdmin(db, session.memberId, async (tx) => {
    const t = await loadOrg(tx, session.memberId);
    const access = requireAdmin(t, session);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AccessError("That timesheet is outside your admin scope");
    await loadTimesheet(tx, t, access.org.id, id);
    const sheet = t.timesheets[0];
    if (sheet) await loadRollups(tx, t, access.org.id, sheet.weekStart, addDays(sheet.weekStart, 6), [sheet.memberId]);
    return timesheetReview(t, session, id, await loadLastReview(tx, access.org.id, id));
  });
}

export function getAttendance(session: Session, args: AttendanceArgs, now = Date.now(), db: Db = appDb()) {
  return asAdmin(db, session.memberId, async (tx) => {
    const t = await loadOrg(tx, session.memberId);
    const access = requireAdmin(t, session);
    const ids = membersInScope(t, access, args.teamId).map((m) => m.id);
    await loadRollups(tx, t, access.org.id, args.from, args.to, ids);
    await loadLeave(tx, t, access.org.id, args.from, args.to, ids);
    return attendance(t, session, args, await loadFirstDays(tx, access.org.id, ids), now);
  });
}

export function getSettings(session: Session, db: Db = appDb()) {
  return asAdmin(db, session.memberId, async (tx) => settings(await loadOrg(tx, session.memberId), session));
}
