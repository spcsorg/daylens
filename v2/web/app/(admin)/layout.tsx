import type { ReactNode } from "react";
import { AccessError } from "@/lib/data/access";
import { loadMe } from "@/lib/session";
import { signOut } from "../actions";
import { Sidebar } from "../ui/Sidebar";
import { Empty } from "../ui/parts";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  let me;
  try {
    me = await loadMe();
  } catch (e) {
    if (!(e instanceof AccessError)) throw e;
    return (
      <main className="signin">
        <Empty
          lede={e.message}
          line="The dashboard is for the firm’s admins. Your own day is in the Daylens app on your computer."
          action={
            <form action={signOut}>
              <button type="submit" className="btn secondary small">Sign out</button>
            </form>
          }
        />
      </main>
    );
  }
  return (
    <div className="window">
      <Sidebar org={me.org.shortName} admin={me.member} signOut={signOut} />
      <main className="main">{children}</main>
    </div>
  );
}
