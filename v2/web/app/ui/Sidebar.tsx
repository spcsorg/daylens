"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { initials } from "@/lib/format";
import { Icon, Mark, type IconName } from "./Icon";

export function Sidebar({
  org,
  admin,
  signOut,
}: {
  org: string;
  admin: { name: string; role: string; scope: string[] | null };
  signOut: () => Promise<void>;
}) {
  const path = usePathname();
  const [menu, setMenu] = useState(false);
  const nav = (href: string, label: string, icon: IconName) => {
    const current = path === href || path.startsWith(href + "/");
    return (
      <Link className="nav" href={href} aria-current={current ? "page" : undefined}>
        <Icon name={icon} filled={current} />
        {label}
      </Link>
    );
  };
  return (
    <aside className="sidebar">
      <div className="org">
        <Mark />
        {org}
      </div>
      {nav("/overview", "Overview", "overview")}
      {nav("/people", "People", "people")}
      <span className="spacer" />
      <div style={{ position: "relative" }}>
        {menu && (
          <form action={signOut} className="popover" style={{ top: "auto", bottom: "calc(100% + 6px)" }}>
            <button type="submit" className="menu-item">Sign out</button>
          </form>
        )}
        <button type="button" className="admin" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          <span className="avatar">{initials(admin.name)}</span>
          <span>
            <b>{admin.name}</b>
            <small>
              {admin.role === "owner" ? "Owner" : "Admin"} · {admin.scope ? admin.scope.join(", ") : "Whole firm"}
            </small>
          </span>
        </button>
      </div>
    </aside>
  );
}
