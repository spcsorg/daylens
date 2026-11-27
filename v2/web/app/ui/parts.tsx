import Link from "next/link";
import type { ReactNode } from "react";
import { initials } from "@/lib/format";
import type { ProjectLabel } from "@/lib/data/queries";
import { Icon } from "./Icon";

export function Header({ title, sub, back, avatar, children }: { title: string; sub: string; back?: string; avatar?: string; children?: ReactNode }) {
  return (
    <header className="header">
      {back && (
        <Link className="icon-btn" href={back} aria-label="Back to people">
          <Icon name="chevron-left" />
        </Link>
      )}
      {avatar && <span className="avatar lg">{initials(avatar)}</span>}
      <div className="grow">
        <h1 className="title">{title}</h1>
        <div className="subhead">{sub}</div>
      </div>
      {children}
    </header>
  );
}

export function Segmented({ options }: { options: { label: string; href: string; current: boolean }[] }) {
  return (
    <nav className="segmented">
      {options.map((o) => (
        <Link key={o.label} href={o.href} aria-current={o.current}>
          {o.label}
        </Link>
      ))}
    </nav>
  );
}

export function Steps({ earlier, later, label }: { earlier: string; later: string | null; label?: string }) {
  return (
    <div className="toolbar">
      <Link className="icon-btn" href={earlier} aria-label="Earlier">
        <Icon name="chevron-left" />
      </Link>
      {later ? (
        <Link className="icon-btn" href={later} aria-label="Later">
          <Icon name="chevron-right" />
        </Link>
      ) : (
        <span className="icon-btn" aria-disabled="true" aria-label="Later">
          <Icon name="chevron-right" />
        </span>
      )}
      {label && <span className="subhead" style={{ minWidth: 150 }}>{label}</span>}
    </div>
  );
}

export function Share({ value, color }: { value: number; color?: string }) {
  return (
    <div className="share">
      <span style={{ width: `${Math.max(2, Math.min(100, value * 100))}%`, background: color }} />
    </div>
  );
}

export function Stat({ label, value, unit, share, note, href }: { label: string; value: ReactNode; unit?: string; share?: number; note: ReactNode; href?: string }) {
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
      {share !== undefined && <Share value={share} color="var(--text)" />}
      <span className="stat-note">{note}</span>
    </>
  );
  return href ? <Link className="stat" href={href}>{body}</Link> : <div className="stat">{body}</div>;
}

export function Panel({ title, figure, children }: { title: string; figure?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {figure !== undefined && <span className="faint">{figure}</span>}
      </div>
      {children}
    </section>
  );
}

/** Client and project as one tag; internal projects show the project only, and no project reads "Needs a project". */
export function ProjectTag({ project, color }: { project: ProjectLabel | null; color: string }) {
  if (!project) return <span className="tag unattributed">Needs a project</span>;
  const text = project.internal ? project.name : `${project.clientName} · ${project.name}`;
  return (
    <span className="tag" title={text}>
      <span className="swatch" style={{ background: color }} />
      {text}
    </span>
  );
}

const STATUS = { draft: "Draft", submitted: "Submitted", approved: "Approved", rejected: "Rejected", missing: "Not started" };

export function TimesheetStatus({ status }: { status: keyof typeof STATUS }) {
  return <span className={`status ${status}`}>{STATUS[status]}</span>;
}

const APPS: Record<string, [string, string]> = {
  Excel: ["X", "#1f7a48"],
  Word: ["W", "#2b5aa8"],
  Outlook: ["O", "#1a6fc0"],
  Teams: ["T", "#5b5fc7"],
  Edge: ["E", "#1b8a9e"],
  Acrobat: ["A", "#b8342b"],
  PowerPoint: ["P", "#c4532b"],
};

export function AppIcon({ app }: { app: string }) {
  const [letter, color] = APPS[app] ?? [app[0] ?? "?", "var(--text-3)"];
  return (
    <span className="app-icon" title={app} style={{ background: color }}>
      {letter}
    </span>
  );
}

export function Empty({ lede, line, action }: { lede: string; line: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="lede">{lede}</p>
      <p>{line}</p>
      {action}
    </div>
  );
}
