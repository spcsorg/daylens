import { redirect } from "next/navigation";
import { cache } from "react";
import { currentSession } from "./auth";
import { getMe } from "./data";
import { localDate } from "./domain/time";

/** The signed-in admin for this request, or a trip to the sign-in page. */
export const requireSession = cache(async () => {
  const session = await currentSession();
  if (!session) redirect("/sign-in");
  return session;
});

export const loadMe = cache(async () => getMe(await requireSession()));

export async function today(): Promise<string> {
  return localDate(Date.now(), (await loadMe()).org.timeZone);
}
