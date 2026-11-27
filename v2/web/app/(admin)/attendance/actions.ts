"use server";

import { revalidatePath } from "next/cache";
import { recordLeave, removeLeave, updateLeave, ValidationError } from "@/lib/data";
import { AccessError, type Session } from "@/lib/data/access";
import type { Fields } from "@/lib/data/catalog";
import { requireSession } from "@/lib/session";

export type Result = { ok: true } | { ok: false; message: string; fields?: Fields };

const str = (x: unknown) => (typeof x === "string" ? x : "");

async function run(what: string, write: (session: Session) => Promise<unknown>): Promise<Result> {
  const session = await requireSession();
  try {
    await write(session);
    revalidatePath("/attendance");
    return { ok: true };
  } catch (e) {
    if (e instanceof ValidationError) return { ok: false, message: e.message, fields: e.fields };
    if (e instanceof AccessError) return { ok: false, message: `Couldn’t ${what}. ${e.message}.` };
    console.error(e);
    return { ok: false, message: `Couldn’t ${what}: Daylens didn’t answer. Try again.` };
  }
}

export async function saveLeave(id: string | null, input: { memberId?: unknown; type?: unknown; startsOn?: unknown; endsOn?: unknown }) {
  const dates = { type: str(input.type), startsOn: str(input.startsOn), endsOn: str(input.endsOn) };
  return run("record the leave", (s) => (id ? updateLeave(s, str(id), dates) : recordLeave(s, { memberId: str(input.memberId), ...dates })));
}

export async function deleteLeave(id: string) {
  return run("remove the leave", (s) => removeLeave(s, str(id)));
}
