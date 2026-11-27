import { addDays, dayStart, datesBetween, DAY_MS, mondayOf } from "../domain/time";
import { appDb, asAdmin, type Db } from "../db/client";
import { loadAssignments, loadBlocks, loadDevices, loadOrg, loadRollups, loadTimesheets } from "../db/store";
import { membersInScope, requireAdmin, requireMemberInScope, type Session } from "./access";
import { catalog, me, overview, people, person, type OverviewArgs, type PeopleArgs, type Range } from "./queries";

export { assign, createClient, createProject, setClientArchived, setProjectArchived, unassign, updateAssignment, updateClient, updateProject, ValidationError } from "./catalog";

/**
 * The one way screens read and write org data. Each call loads only the admin's org and scope, as daylens_app,
 * then hands the rows to the pure functions in queries.ts; writes live in catalog.ts.
 */

const isWeek = ({ from, to }: Range) => mondayOf(from) === from && addDays(from, 6) === to;

export function getMe(session: Session, db: Db = appDb()) {
  return asAdmin(db, session.memberId, async (tx) => me(await loadOrg(tx, session.memberId), session));
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
