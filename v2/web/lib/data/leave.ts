import { and, eq, gte, lte, ne, sql } from "drizzle-orm";
import { appDb, type Db, type Tx } from "../db/client";
import * as s from "../db/schema";
import type { Tables } from "../domain/model";
import { addDays, datesBetween, isoWeekday } from "../domain/time";
import { requireMemberInScope, type Access, type Session } from "./access";
import { asWriter, audit, validDate, ValidationError, type Fields } from "./catalog";

/**
 * Recording leave (FR-23): admins record, change and remove whole days of leave for people in their scope.
 * Each write runs as daylens_app, so row-level security checks the scope again, and adds its audit row in the same transaction.
 */

export type LeaveInput = { memberId: string; type: string; startsOn: string; endsOn: string };

const longDay = (d: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "long" }).format(new Date(`${d}T00:00:00Z`));
const span = (a: string, b: string) => (a === b ? longDay(a) : `${longDay(a)} to ${longDay(b)}`);

async function check(tx: Tx, t: Tables, access: Access, input: LeaveInput, self?: { id: string; type: string }) {
  const errors: Fields = {};
  if (!input.memberId) errors.memberId = "Pick who’s on leave.";
  const member = input.memberId ? requireMemberInScope(t, access, input.memberId) : null;
  const type = input.type.trim();
  if (!access.org.policy.leaveTypes.includes(type) && type !== self?.type) errors.type = "Pick a type of leave.";
  if (!validDate(input.startsOn)) errors.startsOn = "Pick the first day.";
  if (!validDate(input.endsOn)) errors.endsOn = "Pick the last day.";
  else if (!errors.startsOn && input.endsOn < input.startsOn) errors.endsOn = "The last day is before the first.";
  if (Object.keys(errors).length) throw new ValidationError(errors);
  if (input.endsOn > addDays(input.startsOn, 365)) throw new ValidationError({ endsOn: "Record a year or less at a time." });
  const days = datesBetween(input.startsOn, input.endsOn);
  if (!days.some((d) => access.org.policy.workingDays.includes(isoWeekday(d)))) {
    throw new ValidationError({ endsOn: "Those are all non-working days, so there’s no leave to record." });
  }
  // Two admins recording leave for one person at once wait here, so the overlap check below can't miss either write.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${member!.id}))`);
  const [clash] = await tx
    .select()
    .from(s.leave)
    .where(
      and(
        eq(s.leave.orgId, access.org.id),
        eq(s.leave.memberId, member!.id),
        lte(s.leave.startsOn, input.endsOn),
        gte(s.leave.endsOn, input.startsOn),
        self ? ne(s.leave.id, self.id) : undefined,
      ),
    )
    .limit(1);
  if (clash) {
    throw new ValidationError({ startsOn: `${member!.name.split(" ")[0]} already has ${clash.type.toLowerCase()} on ${span(clash.startsOn, clash.endsOn)}. Change that instead.` });
  }
  return { memberId: member!.id, type, startsOn: input.startsOn, endsOn: input.endsOn };
}

async function find(tx: Tx, t: Tables, access: Access, id: string) {
  const [row] = /^[0-9a-f-]{36}$/i.test(id) ? await tx.select().from(s.leave).where(and(eq(s.leave.id, id), eq(s.leave.orgId, access.org.id))) : [];
  if (!row) throw new ValidationError({ form: "That leave was already removed." });
  requireMemberInScope(t, access, row.memberId);
  return row;
}

const target = (row: { id: string; memberId: string }) => `member:${row.memberId}/leave:${row.id}`;
const detail = (row: { type: string; startsOn: string; endsOn: string }) => `${row.type}, ${row.startsOn} to ${row.endsOn}`;

export function recordLeave(session: Session, input: LeaveInput, db: Db = appDb()) {
  return asWriter(session, db, async (tx, t, access) => {
    const row = await check(tx, t, access, input);
    const [{ id }] = (await tx.insert(s.leave).values({ ...row, orgId: access.org.id }).returning({ id: s.leave.id })) as [{ id: string }];
    await audit(tx, access, "leave.recorded", target({ id, memberId: row.memberId }), detail(row));
    return id;
  });
}

/** Changes the type or dates; the person stays the same. */
export function updateLeave(session: Session, id: string, input: Omit<LeaveInput, "memberId">, db: Db = appDb()) {
  return asWriter(session, db, async (tx, t, access) => {
    const old = await find(tx, t, access, id);
    const row = await check(tx, t, access, { ...input, memberId: old.memberId }, old);
    const changed = await tx.update(s.leave).set({ type: row.type, startsOn: row.startsOn, endsOn: row.endsOn }).where(and(eq(s.leave.id, id), eq(s.leave.orgId, access.org.id))).returning({ id: s.leave.id });
    if (!changed.length) throw new ValidationError({ form: "Someone removed that leave while you were changing it." });
    await audit(tx, access, "leave.updated", target(old), `${detail(old)} became ${detail(row)}`);
  });
}

export function removeLeave(session: Session, id: string, db: Db = appDb()) {
  return asWriter(session, db, async (tx, t, access) => {
    const old = await find(tx, t, access, id);
    const gone = await tx.delete(s.leave).where(and(eq(s.leave.id, id), eq(s.leave.orgId, access.org.id))).returning({ id: s.leave.id });
    if (!gone.length) throw new ValidationError({ form: "Someone removed that leave already." });
    await audit(tx, access, "leave.removed", target(old), detail(old));
  });
}
