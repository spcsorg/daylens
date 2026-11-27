"use server";

import { revalidatePath } from "next/cache";
import { setMemberActive, updateMember, updatePolicy, ValidationError } from "@/lib/data";
import { AccessError, type Session } from "@/lib/data/access";
import type { Fields } from "@/lib/data/catalog";
import { requireSession } from "@/lib/session";

export type Result = { ok: true } | { ok: false; message: string; fields?: Fields };

const str = (x: unknown) => (typeof x === "string" ? x : "");
const strs = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
const nums = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is number => typeof v === "number") : []);
const num = (x: unknown) => (typeof x === "number" ? x : NaN);

/** Settings change what every screen counts, so each save re-reads the whole dashboard. */
async function run(what: string, write: (session: Session) => Promise<unknown>): Promise<Result> {
  const session = await requireSession();
  try {
    await write(session);
    return { ok: true };
  } catch (e) {
    if (e instanceof ValidationError) return { ok: false, message: e.message, fields: e.fields };
    if (e instanceof AccessError) return { ok: false, message: `Couldn’t ${what}. ${e.message}.` };
    console.error(e);
    return { ok: false, message: `Couldn’t ${what}: Daylens didn’t answer. Try again.` };
  } finally {
    revalidatePath("/", "layout");
  }
}

export async function savePolicy(input: { timeZone?: unknown; coreStart?: unknown; coreEnd?: unknown; workingDays?: unknown; leaveTypes?: unknown }) {
  return run("save the policy", (s) =>
    updatePolicy(s, { timeZone: str(input.timeZone), coreStart: num(input.coreStart), coreEnd: num(input.coreEnd), workingDays: nums(input.workingDays), leaveTypes: strs(input.leaveTypes) }),
  );
}

export async function saveMember(id: string, input: { role?: unknown; adminScope?: unknown; teamIds?: unknown; adminTeamIds?: unknown }) {
  const role = str(input.role);
  const adminScope = str(input.adminScope);
  return run("save the change", (s) =>
    updateMember(s, str(id), {
      role: role === "owner" || role === "admin" || role === "employee" ? role : ("" as "employee"),
      adminScope: adminScope === "org" || adminScope === "teams" ? adminScope : null,
      teamIds: strs(input.teamIds),
      adminTeamIds: strs(input.adminTeamIds),
    }),
  );
}

export async function setActive(id: string, active: boolean) {
  return run(active ? "reactivate them" : "deactivate them", (s) => setMemberActive(s, str(id), active === true));
}
