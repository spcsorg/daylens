"use server";

import { revalidatePath } from "next/cache";
import { approveTimesheets, rejectTimesheet, reopenTimesheet, ValidationError } from "@/lib/data";
import { AccessError, type Session } from "@/lib/data/access";
import type { Fields } from "@/lib/data/catalog";
import type { Seen } from "@/lib/data/review";
import { requireSession } from "@/lib/session";

export type Result = { ok: true } | { ok: false; message: string; fields?: Fields };

const seen = (x: unknown): Seen => {
  const v = (x ?? {}) as { id?: unknown; version?: unknown };
  return { id: typeof v.id === "string" ? v.id : "", version: typeof v.version === "number" ? v.version : -1 };
};

/** Every outcome re-reads the screen and the sidebar count, so a refused review shows what changed. */
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

export async function approve(sheets: unknown) {
  const list = Array.isArray(sheets) ? sheets.map(seen) : [];
  return run("approve", (s) => approveTimesheets(s, list));
}

export async function sendBack(sheet: unknown, comment: unknown) {
  return run("send it back", (s) => rejectTimesheet(s, seen(sheet), typeof comment === "string" ? comment : ""));
}

export async function reopen(sheet: unknown, reason: unknown) {
  return run("reopen it", (s) => reopenTimesheet(s, seen(sheet), typeof reason === "string" ? reason : ""));
}
