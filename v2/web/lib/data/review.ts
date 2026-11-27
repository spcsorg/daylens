import { and, eq, inArray } from "drizzle-orm";
import { appDb, type Db, type Tx } from "../db/client";
import * as s from "../db/schema";
import type { Tables, TimesheetStatus } from "../domain/model";
import { AccessError, requireAssignee, type Access, type Session } from "./access";
import { asWriter, audit, ValidationError } from "./catalog";

/**
 * Reviewing timesheets: approve, send back with a comment, or reopen an approved one with a reason (FR-39, FR-42).
 * Each call names the version it was shown; a timesheet that changed since is refused, so nobody approves what they didn't see.
 * Approve, send back and reopen run as daylens_app like every write, and add an audit_log row per timesheet in the same transaction.
 */

export type Seen = { id: string; version: number };

const NOTE_MAX = 2000;

const VERB: Record<string, string> = { approved: "nothing was approved", rejected: "it wasn’t sent back", submitted: "it wasn’t reopened" };

async function load(tx: Tx, t: Tables, access: Access, seen: Seen[]) {
  const ids = [...new Set(seen.map((x) => x.id))];
  const rows = ids.length ? await tx.select().from(s.timesheets).where(and(inArray(s.timesheets.id, ids), eq(s.timesheets.orgId, access.org.id))) : [];
  return ids.map((id) => {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new AccessError("That timesheet is outside your admin scope");
    requireAssignee(t, access, { memberId: row.memberId }, false);
    const name = t.members.find((m) => m.id === row.memberId)!.name;
    return { row, name, version: seen.find((x) => x.id === id)!.version };
  });
}

/** Moves each timesheet from one status to the next, only if it's still the version the admin saw. */
async function move(tx: Tx, t: Tables, access: Access, seen: Seen[], from: TimesheetStatus, to: TimesheetStatus, set: Partial<typeof s.timesheets.$inferInsert>, detail?: string) {
  const sheets = await load(tx, t, access, seen);
  for (const { row, name, version } of sheets) {
    const changed = () => new ValidationError({ form: `${name}’s timesheet changed since you opened it, so ${VERB[to]}. It’s up to date now; check it again.` });
    if (row.version !== version) throw changed();
    if (row.status !== from) {
      const what = { submitted: "waiting for approval", approved: "approved", rejected: "sent back", draft: "sent" }[from];
      throw new ValidationError({ form: `${name}’s timesheet isn’t ${what}, so ${VERB[to]}.` });
    }
    const done = await tx
      .update(s.timesheets)
      .set({ ...set, status: to })
      .where(and(eq(s.timesheets.id, row.id), eq(s.timesheets.version, version), eq(s.timesheets.status, from)))
      .returning({ id: s.timesheets.id });
    if (!done.length) throw changed();
    await audit(tx, access, `timesheet.${to === "submitted" ? "reopened" : to}`, `timesheet:${row.id}`, detail);
  }
  return sheets.length;
}

function note(value: string, field: string, missing: string) {
  const v = value.trim();
  if (!v) throw new ValidationError({ [field]: missing });
  if (v.length > NOTE_MAX) throw new ValidationError({ [field]: `Keep it under ${NOTE_MAX.toLocaleString("en-GB")} characters.` });
  return v;
}

/** Approves one or many submitted timesheets together: all of them, or none if any changed. */
export function approveTimesheets(session: Session, seen: Seen[], db: Db = appDb()) {
  return asWriter(session, db, async (tx, t, access) => {
    if (!seen.length) throw new ValidationError({ form: "Pick the timesheets to approve." });
    return move(tx, t, access, seen, "submitted", "approved", { approvedBy: access.member.id, approvedAt: new Date(), reviewNote: null });
  });
}

export function rejectTimesheet(session: Session, seen: Seen, comment: string, db: Db = appDb()) {
  return asWriter(session, db, async (tx, t, access) => {
    const v = note(comment, "comment", "Say what should change, so they know what to fix.");
    await move(tx, t, access, [seen], "submitted", "rejected", { reviewNote: v }, v);
  });
}

/** Unlocks an approved timesheet and puts it back to submitted; the reason goes on the timesheet and in the audit log. */
export function reopenTimesheet(session: Session, seen: Seen, reason: string, db: Db = appDb()) {
  return asWriter(session, db, async (tx, t, access) => {
    const v = note(reason, "reason", "Say why it needs reopening. It goes in the audit log.");
    await move(tx, t, access, [seen], "approved", "submitted", { approvedBy: null, approvedAt: null, reviewNote: v }, v);
  });
}
