import { and, eq, gte, lte, sql } from "drizzle-orm";
import { appDb, type Db, type Tx } from "../db/client";
import * as s from "../db/schema";
import { emptyTables, loadBlocks } from "../db/store";
import type { Org, Role, Tables } from "../domain/model";
import { rebuildRollups } from "../domain/rollup";
import { AccessError, type Access, type Session } from "./access";
import { asWriter, audit, ValidationError, type Fields } from "./catalog";

/**
 * Org settings (FR-9, FR-10): the policy, and members' roles, admin scope, teams and status. Owners change them; admins only read them.
 * Each write runs as daylens_app with an audit row in the same transaction. Postgres keeps an active owner in every org whatever the caller.
 */

export type Policy = Org["policy"];
export type MemberInput = { role: Role; adminScope: "org" | "teams" | null; teamIds: string[]; adminTeamIds: string[] };

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const days = (xs: number[]) => xs.map((d) => WEEKDAYS[d - 1]).join(", ");
const first = (name: string) => name.split(" ")[0];

function requireOwner(access: Access) {
  if (access.member.role !== "owner") throw new AccessError("Only an owner can change settings");
}

function validZone(zone: string) {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone.length > 0;
  } catch {
    return false;
  }
}

function checkPolicy(input: Policy): Policy {
  const errors: Fields = {};
  const timeZone = input.timeZone.trim();
  if (!validZone(timeZone)) errors.timeZone = "Pick a time zone.";
  const minute = (m: number) => Number.isInteger(m) && m >= 0 && m <= 24 * 60 && m % 5 === 0;
  if (!minute(input.coreStart)) errors.coreStart = "Pick when core hours start.";
  if (!minute(input.coreEnd)) errors.coreEnd = "Pick when core hours end.";
  else if (!errors.coreStart && input.coreEnd <= input.coreStart) errors.coreEnd = "Core hours end before they start.";
  const workingDays = [...new Set(input.workingDays)].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort();
  if (!workingDays.length) errors.workingDays = "Pick at least one working day.";
  const seen = new Set<string>();
  const leaveTypes = input.leaveTypes.map((x) => x.trim()).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
  if (!leaveTypes.length) errors.leaveTypes = "Keep at least one type of leave.";
  else if (leaveTypes.some((x) => x.length > 40)) errors.leaveTypes = "Keep each type under 40 characters.";
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { timeZone, coreStart: input.coreStart, coreEnd: input.coreEnd, workingDays, leaveTypes };
}

/** Rebuilds every member's rollups from their blocks under the new policy, so core-hours coverage and local days follow it. */
async function rebuildOrgRollups(tx: Tx, t: Tables, org: Org) {
  for (const m of t.members.filter((x) => x.orgId === org.id)) {
    const own = emptyTables();
    await loadBlocks(tx, own, org.id, 0, Date.UTC(9999, 0, 1), [m.id]);
    const rebuilt = rebuildRollups(own.blocks, t.projects, org, m.id);
    if (!rebuilt) continue;
    await tx.delete(s.dailyRollups).where(and(eq(s.dailyRollups.orgId, org.id), eq(s.dailyRollups.memberId, m.id), gte(s.dailyRollups.date, rebuilt.from), lte(s.dailyRollups.date, rebuilt.to)));
    for (let i = 0; i < rebuilt.rows.length; i += 1000) await tx.insert(s.dailyRollups).values(rebuilt.rows.slice(i, i + 1000));
  }
}

export function updatePolicy(session: Session, input: Policy, db: Db = appDb()) {
  return asWriter(session, db, async (tx, t, access) => {
    requireOwner(access);
    const next = checkPolicy(input);
    const [locked] = (await tx.execute(sql`select policy from orgs where id = ${access.org.id} for update`)).rows as { policy: Org["policy"] }[];
    if (!locked) throw new ValidationError({ form: "That firm isn’t there any more." });
    const old = locked.policy;
    const changes = [
      old.timeZone !== next.timeZone && `time zone ${old.timeZone} to ${next.timeZone}`,
      (old.coreStart !== next.coreStart || old.coreEnd !== next.coreEnd) && `core hours ${hhmm(old.coreStart)}–${hhmm(old.coreEnd)} to ${hhmm(next.coreStart)}–${hhmm(next.coreEnd)}`,
      days(old.workingDays) !== days(next.workingDays) && `working days ${days(old.workingDays)} to ${days(next.workingDays)}`,
      old.leaveTypes.join("|") !== next.leaveTypes.join("|") && `leave types ${old.leaveTypes.join(", ")} to ${next.leaveTypes.join(", ")}`,
    ].filter((x): x is string => !!x);
    if (!changes.length) return;
    await tx.update(s.orgs).set({ policy: next }).where(eq(s.orgs.id, access.org.id));
    const recount = old.timeZone !== next.timeZone || old.coreStart !== next.coreStart || old.coreEnd !== next.coreEnd || days(old.workingDays) !== days(next.workingDays);
    if (recount) await rebuildOrgRollups(tx, t, { ...access.org, policy: next });
    await audit(tx, access, "org.policy_changed", `org:${access.org.id}`, changes.join("; "));
  });
}

function findMember(t: Tables, access: Access, id: string) {
  const member = t.members.find((m) => m.id === id && m.orgId === access.org.id);
  if (!member) throw new ValidationError({ form: "That person isn’t in the firm any more." });
  return member;
}

function otherActiveOwner(t: Tables, access: Access, id: string) {
  return t.members.some((m) => m.orgId === access.org.id && m.id !== id && m.role === "owner" && m.status === "active");
}

/** Changes someone's role, admin scope and teams in one go. Admin of a team keeps them in that team, as scope has always worked. */
export function updateMember(session: Session, id: string, input: MemberInput, db: Db = appDb()) {
  return asWriter(session, db, async (tx, t, access) => {
    requireOwner(access);
    const member = findMember(t, access, id);
    const teams = new Map(t.teams.filter((x) => x.orgId === access.org.id).map((x) => [x.id, x.name]));
    const errors: Fields = {};
    if (!["owner", "admin", "employee"].includes(input.role)) errors.role = "Pick a role.";
    const adminScope = input.role === "admin" ? input.adminScope : null;
    if (input.role === "admin" && adminScope !== "org" && adminScope !== "teams") errors.adminScope = "Pick what they admin.";
    const adminTeamIds = adminScope === "teams" ? [...new Set(input.adminTeamIds)] : [];
    const teamIds = [...new Set([...input.teamIds, ...adminTeamIds])];
    if (teamIds.some((x) => !teams.has(x))) errors.teams = "One of those teams no longer exists. Reload and try again.";
    if (adminScope === "teams" && !adminTeamIds.length) errors.adminScope = "Pick at least one team they admin.";
    if (member.role === "owner" && input.role !== "owner" && member.status === "active" && !otherActiveOwner(t, access, id)) {
      errors.role = `${first(member.name)} is the only owner. Make someone else an owner first.`;
    }
    if (Object.keys(errors).length) throw new ValidationError(errors);

    const before = t.teamMembers.filter((r) => r.memberId === id && teams.has(r.teamId));
    const describe = (rows: { teamId: string; isAdminScope: boolean }[]) =>
      rows.map((r) => teams.get(r.teamId)! + (r.isAdminScope ? " (admin)" : "")).sort().join(", ") || "no teams";
    const after = teamIds.map((teamId) => ({ teamId, isAdminScope: adminTeamIds.includes(teamId) }));
    if (describe(before) !== describe(after)) {
      await tx.delete(s.teamMembers).where(and(eq(s.teamMembers.memberId, id), eq(s.teamMembers.orgId, access.org.id)));
      if (after.length) await tx.insert(s.teamMembers).values(after.map((r) => ({ ...r, orgId: access.org.id, memberId: id })));
      await audit(tx, access, "member.teams_changed", `member:${id}`, `${describe(before)} to ${describe(after)}`);
    }
    // Last, because row-level security reads this row: an owner changing their own role still needs their old one for the writes above.
    if (member.role !== input.role || (member.adminScope ?? null) !== adminScope) {
      const scope = (role: Role, sc: string | null) => (role === "admin" ? `admin of ${sc === "org" ? "the whole firm" : "chosen teams"}` : role);
      await audit(tx, access, "member.role_changed", `member:${id}`, `${scope(member.role, member.adminScope ?? null)} to ${scope(input.role, adminScope)}`);
      const changed = await tx.update(s.members).set({ role: input.role, adminScope }).where(and(eq(s.members.id, id), eq(s.members.orgId, access.org.id))).returning({ id: s.members.id });
      if (!changed.length) throw new ValidationError({ form: "Someone changed that person's role while you were editing it." });
    }
  });
}

export function setMemberActive(session: Session, id: string, active: boolean, db: Db = appDb()) {
  return asWriter(session, db, async (tx, t, access) => {
    requireOwner(access);
    const member = findMember(t, access, id);
    if (member.status === (active ? "active" : "deactivated")) return;
    if (!active && id === access.member.id) throw new ValidationError({ form: "You can’t deactivate yourself. Ask another owner." });
    if (!active && member.role === "owner" && !otherActiveOwner(t, access, id)) {
      throw new ValidationError({ form: `${first(member.name)} is the only owner. Make someone else an owner first.` });
    }
    await audit(tx, access, active ? "member.reactivated" : "member.deactivated", `member:${id}`);
    const changed = await tx.update(s.members).set({ status: active ? "active" : "deactivated" }).where(and(eq(s.members.id, id), eq(s.members.orgId, access.org.id))).returning({ id: s.members.id });
    if (!changed.length) throw new ValidationError({ form: "Someone changed that person's status while you were editing it." });
  });
}
