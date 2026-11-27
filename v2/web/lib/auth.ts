import { randomBytes } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import { cookies } from "next/headers";
import { appDb } from "./db/client";
import { members, orgs, sessions } from "./db/schema";
import type { Session } from "./data/access";

const COOKIE = "daylens_session";
const LIFETIME_MS = 12 * 3_600_000;

/** The dev sign-in, which picks a seeded member. Off unless DAYLENS_DEV_SIGN_IN=1, and never on in production. */
export function devSignInEnabled(): boolean {
  return process.env.DAYLENS_DEV_SIGN_IN === "1" && process.env.NODE_ENV !== "production";
}

export async function currentSession(): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const [row] = await appDb()
    .select({ memberId: sessions.memberId })
    .from(sessions)
    .where(and(eq(sessions.sessionToken, token), gt(sessions.expires, new Date())));
  return row ?? null;
}

export async function startSession(memberId: string) {
  const sessionToken = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + LIFETIME_MS);
  await appDb().insert(sessions).values({ sessionToken, memberId, expires });
  (await cookies()).set(COOKIE, sessionToken, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", expires, path: "/" });
}

export async function endSession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await appDb().delete(sessions).where(eq(sessions.sessionToken, token));
  jar.delete(COOKIE);
}

export async function signInChoices() {
  return appDb()
    .select({ id: members.id, name: members.name, title: members.title, role: members.role, org: orgs.shortName })
    .from(members)
    .innerJoin(orgs, eq(orgs.id, members.orgId))
    .orderBy(asc(members.role), asc(members.name));
}
