import type { CSSProperties, ReactNode } from "react";
import { APPS } from "./world";

// The Daylens V4 window, drawn from the Figma file at its own size (1120 × 720) and scaled by the camera around it.

const PATHS: Record<string, string> = {
  search: "M7.25 12.5a5.25 5.25 0 1 0 0-10.5 5.25 5.25 0 0 0 0 10.5ZM14 14l-3-3",
  today: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM8 4.5V8l2.25 1.5",
  apps: "M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z",
  ask: "M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H6l-3.5 2.5v-9Z",
  check: "M3 8.5 6.5 12 13 4.5",
  settings: "M2.5 5h7M12.5 5h1M2.5 11h1M6.5 11h7M11 3.5v3M5 9.5v3",
  left: "M10 3.5 5.5 8l4.5 4.5",
  right: "M6 3.5 10.5 8 6 12.5",
  calendar: "M3 4.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4.5ZM3 7h10M5.5 2v2.5M10.5 2v2.5",
  arrow: "M3.5 8h9M8.5 4l4 4-4 4",
  x: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  lock: "M4 7.5h8v6H4zM5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2",
  pause: "M6 4v8M10 4v8",
  return: "M12.5 3.5v4a2 2 0 0 1-2 2h-7M6 6.5l-3 3 3 3",
};

export function Glyph({ name, size = 16, style }: { name: string; size?: number; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className="f-glyph" style={style} aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

export function AppIcons({ apps, size = 16 }: { apps: string[]; size?: number }) {
  return (
    <span className="f-apps">
      {apps.map((src) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={src} src={src} width={size} height={size} alt="" />
      ))}
    </span>
  );
}

export function Window({ children, sidebar, overlay, style }: { children: ReactNode; sidebar?: string; overlay?: ReactNode; style?: CSSProperties }) {
  return (
    <div className="f-window" style={style}>
      <div className="f-lights" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      {sidebar ? <Sidebar active={sidebar} /> : null}
      <div className={sidebar ? "f-main" : "f-main is-full"}>{children}</div>
      {overlay}
    </div>
  );
}

function Sidebar({ active }: { active: string }) {
  const item = (id: string, label: string) => (
    <div className={active === id ? "f-nav is-on" : "f-nav"} key={id}>
      <Glyph name={id} />
      {label}
    </div>
  );
  return (
    <aside className="f-sidebar">
      <div className="f-navs">{[item("search", "Search"), item("today", "Today"), item("apps", "Apps"), item("ask", "Ask")]}</div>
      <div className="f-navs is-foot">
        <div className="f-nav">
          <Glyph name="settings" />
          Settings
        </div>
      </div>
    </aside>
  );
}

export function Segmented({ value, hover }: { value: "Day" | "Week" | "Month"; hover?: string }) {
  return (
    <div className="f-head-tools">
      <div className="f-seg">
        {(["Day", "Week", "Month"] as const).map((v) => (
          <span key={v} className={v === value ? "is-on" : v === hover ? "is-hover" : undefined}>
            {v}
          </span>
        ))}
      </div>
      <Glyph name="left" />
      <Glyph name="right" style={{ opacity: 0.4 }} />
      <Glyph name="calendar" />
    </div>
  );
}

export function Cursor({ x, y, press = 0 }: { x: number; y: number; press?: number }) {
  return (
    <svg className="f-cursor" viewBox="0 0 24 24" width="24" height="24" style={{ transform: `translate(${x - 4}px, ${y - 2}px) scale(${1 - press * 0.14})` }} aria-hidden="true">
      <path d="M5 2.5v16.2l4.1-3.9 2.6 6 2.9-1.3-2.6-5.9H18L5 2.5Z" fill="#141619" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export const ICON = APPS;
