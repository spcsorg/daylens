import Link from "next/link";
import type { ReactNode } from "react";
import { clientColors } from "@/lib/colors";
import { getPerson } from "@/lib/data";
import { AccessError } from "@/lib/data/access";
import type { Person, ProjectLabel } from "@/lib/data/queries";
import { addDays, dayStart, isoWeekday } from "@/lib/domain/time";
import { clock, dayOfMonth, hm, hrs, pct, span, weekdayName, weekdayShort } from "@/lib/format";
import { period } from "@/lib/period";
import { loadMe, requireSession, today } from "@/lib/session";
import { Icon } from "../../../ui/Icon";
import { AppIcon, Empty, Header, Panel, ProjectTag, Segmented, Share, Stat, Steps, TimesheetStatus } from "../../../ui/parts";

type Params = Record<string, string | undefined>;
type Colour = (clientId: string | undefined) => string;

const EVIDENCE: Record<string, string> = { assignment: "assignment", title: "title", keyword: "keyword", domain: "site", correction: "an earlier correction" };

function label(project: ProjectLabel | undefined) {
  if (!project) return "Needs a project";
  return project.internal ? project.name : `${project.clientName} · ${project.name}`;
}

function colours(data: Person): Colour {
  const byClient = new Map<string, { id: string; billable: boolean; seconds: number }>();
  for (const { projectId, seconds } of data.byProject) {
    const p = projectId ? data.projects[projectId] : undefined;
    if (!p) continue;
    const c = byClient.get(p.clientId) ?? { id: p.clientId, billable: !p.internal, seconds: 0 };
    c.seconds += seconds;
    byClient.set(p.clientId, c);
  }
  return clientColors([...byClient.values()]);
}

function Bars({ title, figure, items }: { title: string; figure?: string; items: { key: string; icon: ReactNode; name: string; seconds: number; color?: string }[] }) {
  const max = items[0]?.seconds ?? 1;
  return (
    <Panel title={title} figure={figure}>
      {items.map((x) => (
        <div className="app-row" key={x.key}>
          {x.icon}
          <span className="app-row-text">
            <span className="app-row-name" style={{ font: "var(--label)" }}>{x.name}</span>
            <Share value={x.seconds / max} color={x.color} />
          </span>
          <span className="app-row-ms">{hm(x.seconds)}</span>
        </div>
      ))}
    </Panel>
  );
}

function projectItems(data: Person, color: Colour) {
  return data.byProject.map(({ projectId, seconds }) => {
    const p = projectId ? data.projects[projectId] : undefined;
    const c = p ? color(p.clientId) : "var(--line-strong)";
    return { key: projectId ?? "none", icon: <span className={`swatch${p ? "" : " none"}`} style={p ? { background: c } : undefined} />, name: label(p), seconds, color: c };
  });
}

function Day({ data, first, tz, date, core }: { data: Person; first: string; tz: string; date: string; core: [number, number] }) {
  const color = colours(data);
  const base = dayStart(date, tz);
  const left = (ms: number) => ((ms - base) / 3_600_000 - 7) / 14 * 100;
  const width = (a: number, b: number) => ((b - a) / 3_600_000 / 14) * 100;
  const top = data.byProject.filter((x) => x.projectId).slice(0, 2).map((x) => label(data.projects[x.projectId!]));
  const billable = data.totals.seconds ? data.totals.billableSeconds / data.totals.seconds : 0;
  const clientsInDay = [...new Map(data.entries.flatMap((e) => (e.kind === "work" && e.projectId ? [[data.projects[e.projectId]!.clientId, data.projects[e.projectId]!]] : []))).values()];
  return (
    <>
      <p className="digest" style={{ marginBottom: 24 }}>
        {first} worked {hm(data.totals.seconds)} on {weekdayName(date)}
        {top.length ? `, most of it on ${top[0]}${top[1] ? `, then ${top[1]}` : ""}` : ""}.
        {data.totals.outsideCoreSeconds >= 900 && ` ${hm(data.totals.outsideCoreSeconds)} of it was outside core hours.`}
      </p>
      <div className="stats">
        <Stat label="Worked" value={hm(data.totals.seconds)} note={data.firstSeen && data.lastSeen ? `First seen ${clock(data.firstSeen, tz)}, last ${clock(data.lastSeen, tz)}` : ""} />
        <Stat label="Billable" value={pct(billable)} share={billable} note={`${hm(data.totals.billableSeconds)} on billable projects`} />
        <Stat label="Core-hours coverage" value={data.totals.coverage === null ? "—" : pct(data.totals.coverage)} share={data.totals.coverage ?? 0} note={`Idle or away ${hm(data.totals.idleSeconds)}`} />
        <Stat label="Outside core hours" value={hm(data.totals.outsideCoreSeconds)} note="Before or after core hours" />
      </div>
      <div className="panel" style={{ marginBottom: 24, padding: "16px 24px 12px" }}>
        <div className="strip">
          <div className="core" style={{ left: `${left(base + core[0] * 60_000)}%`, width: `${width(base + core[0] * 60_000, base + core[1] * 60_000)}%` }} />
          {data.entries.map((e, i) =>
            e.kind === "work" ? (
              <a
                key={i}
                href={`#entry-${i}`}
                title={`${e.label} · ${span(e.start, e.end, tz)}`}
                style={{
                  left: `${left(e.start)}%`,
                  width: `calc(${width(e.start, e.end)}% - 2px)`,
                  background: e.projectId ? color(data.projects[e.projectId]?.clientId) : "transparent",
                  boxShadow: e.projectId ? undefined : "inset 0 0 0 1.5px var(--line-strong)",
                }}
              />
            ) : (
              <div key={i} className="gap" title={`${e.kind === "idle" ? "Idle" : "Away"} · ${span(e.start, e.end, tz)}`} style={{ left: `${left(e.start)}%`, width: `${width(e.start, e.end)}%` }} />
            ),
          )}
        </div>
        <div className="axis">
          {["7 AM", "9", "11", "1 PM", "3", "5", "7", "9 PM"].map((t) => <span key={t}>{t}</span>)}
        </div>
        <div className="legend" style={{ padding: "6px 0 0" }}>
          {clientsInDay.filter((p) => !p.internal).map((p) => (
            <span key={p.clientId}><span className="swatch" style={{ background: color(p.clientId) }} />{p.clientName}</span>
          ))}
          <span><span className="swatch" style={{ background: "var(--work-other)" }} />Internal</span>
          <span><span className="swatch none" />Needs a project</span>
          <span>Dashed lines: core hours</span>
        </div>
      </div>
      <div className="grid-2">
        <div>
          {data.entries.map((e, i) =>
            e.kind === "work" ? (
              <div className="hour" id={`entry-${i}`} key={i}>
                <div className="hour-time">{clock(e.start, tz)}</div>
                <div className="hour-body">
                  <div className="hour-title">{e.label}</div>
                  {e.summary && <div className="hour-summary">{e.summary}</div>}
                  <div className="hour-apps">
                    {e.apps.map((a) => <AppIcon key={a} app={a} />)}
                    <span className="faint" style={{ font: "var(--caption)", marginLeft: 10 }}>
                      {span(e.start, e.end, tz)} · {hm((e.end - e.start) / 1000)}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", paddingTop: 6 }}>
                    <ProjectTag project={e.projectId ? data.projects[e.projectId]! : null} color={color(e.projectId ? data.projects[e.projectId]?.clientId : undefined)} />
                    <span className="faint" style={{ font: "var(--caption)" }}>
                      {e.projectId ? `Matched by ${e.evidence.map((x) => EVIDENCE[x] ?? x).join(" and ") || "rule"}` : `Waiting for ${first} to pick`}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="hour gap" id={`entry-${i}`} key={i}>
                <div className="hour-time">{clock(e.start, tz)}</div>
                <div className="hour-body">
                  <div className="hour-title">{e.kind === "idle" ? "Idle" : "Away"} · {hm((e.end - e.start) / 1000)}</div>
                </div>
              </div>
            ),
          )}
        </div>
        <div className="stack">
          <Bars title="Clients and projects" items={projectItems(data, color)} />
          {data.apps.length > 0 && <Bars title="Apps" items={data.apps.map((a) => ({ key: a.name, icon: <AppIcon app={a.name} />, name: a.name, seconds: a.seconds }))} />}
          {data.sites.length > 0 && (
            <Bars
              title="Sites"
              items={data.sites.map((s) => ({ key: s.name, icon: <span className="app-icon" style={{ background: "var(--sel)", color: "var(--text-2)" }}><Icon name="globe" size={12} /></span>, name: s.name, seconds: s.seconds }))}
            />
          )}
          {data.documents.length > 0 && <Bars title="Documents" items={data.documents.map((d) => ({ key: d.name, icon: <AppIcon app={d.app} />, name: d.name, seconds: d.seconds }))} />}
        </div>
      </div>
    </>
  );
}

const HOUR_PX = 56;
const FIRST_HOUR = 8;
const LAST_HOUR = 21;

function Week({ data, id, tz, from, today: now }: { data: Person; id: string; tz: string; from: string; today: string }) {
  const color = colours(data);
  const days = [0, 1, 2, 3, 4].map((i) => addDays(from, i));
  const sheet = data.timesheet;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 340px", gap: 32, alignItems: "start" }}>
      <div className="week">
        <div />
        {days.map((d) => (
          <div key={d} className={`week-day${d === now ? " today" : ""}`}>
            {weekdayShort(d)}
            <b>{dayOfMonth(d)}</b>
          </div>
        ))}
        <div>
          {Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, h) => (
            <div key={h} className="week-hour" style={{ height: HOUR_PX }}>{clockHour(FIRST_HOUR + h)}</div>
          ))}
        </div>
        {days.map((d) => {
          const base = dayStart(d, tz);
          const top = (ms: number) => Math.max(0, ((ms - base) / 3_600_000 - FIRST_HOUR) * HOUR_PX);
          return (
            <div key={d} className="week-col" style={{ height: (LAST_HOUR - FIRST_HOUR) * HOUR_PX }}>
              {data.entries.map((e, i) =>
                e.kind === "work" && e.start >= base && e.start < base + 86_400_000 ? (
                  <Link
                    key={i}
                    href={`/people/${id}?range=day&date=${d}`}
                    className={`week-block${e.projectId ? "" : " none"}`}
                    title={`${e.label} · ${span(e.start, e.end, tz)}`}
                    style={{ top: top(e.start) + 1, height: Math.max(18, top(e.end) - top(e.start) - 2), borderLeftColor: e.projectId ? color(data.projects[e.projectId]?.clientId) : undefined }}
                  >
                    {e.projectId ? e.label : `${e.label}, needs a project`}
                  </Link>
                ) : null,
              )}
            </div>
          );
        })}
      </div>
      <div className="stack">
        <Bars title="Time per piece of work" figure={hrs(data.totals.seconds)} items={projectItems(data, color)} />
        <Panel title="Timesheet" figure={sheet ? <TimesheetStatus status={sheet.status} /> : <TimesheetStatus status="missing" />}>
          <p className="muted" style={{ padding: "0 12px 4px" }}>
            {!sheet
              ? "Not started yet."
              : `${hrs(sheet.hours * 3600)} across ${sheet.projects} project${sheet.projects === 1 ? "" : "s"}${sheet.submittedAt ? `, sent ${weekdayName(new Date(sheet.submittedAt).toISOString().slice(0, 10))} at ${clock(sheet.submittedAt, tz)}` : ", still a draft"}.`}
          </p>
        </Panel>
      </div>
    </div>
  );
}

function clockHour(h: number) {
  return `${((h + 11) % 12) + 1} ${h < 12 ? "AM" : "PM"}`;
}

function Month({ data, id, from, today: now }: { data: Person; id: string; from: string; today: string }) {
  const lead = isoWeekday(from) - 1;
  const top = data.byProject.filter((x) => x.projectId).slice(0, 3);
  const billable = data.totals.withProjectSeconds ? data.totals.billableSeconds / data.totals.withProjectSeconds : 0;
  return (
    <>
      <div className="month-head">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d}>{d}</div>)}
      </div>
      <div className="month">
        {Array.from({ length: lead }, (_, i) => <div key={`lead${i}`} className="month-cell" />)}
        {data.days.map((d) => {
          const body = (
            <>
              <span className={`n${d.date === now ? " today" : ""}`}>{dayOfMonth(d.date)}</span>
              {d.seconds > 0 && (
                <>
                  <span className="t">{d.topProjectId ? data.projects[d.topProjectId]?.name : "Needs a project"}</span>
                  <span className="w">{hrs(d.seconds)}</span>
                </>
              )}
            </>
          );
          return d.date <= now ? (
            <Link key={d.date} className="month-cell" href={`/people/${id}?range=day&date=${d.date}`}>{body}</Link>
          ) : (
            <div key={d.date} className="month-cell">{body}</div>
          );
        })}
      </div>
      <p className="muted" style={{ marginTop: 16, font: "var(--label-regular)" }}>
        {data.totals.seconds > 0
          ? `${hrs(data.totals.seconds)} this month, ${pct(billable)} billable. ${top.map((x) => `${label(data.projects[x.projectId!])} ${hrs(x.seconds)}`).join(", ")}.`
          : "Nothing recorded this month."}
      </p>
    </>
  );
}

export default async function PersonPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Params> }) {
  const { id } = await params;
  const query = await searchParams;
  const [session, me, now] = [await requireSession(), await loadMe(), await today()];
  const kind = query.range === "week" || query.range === "month" ? query.range : "day";
  const p = period(kind, query.date, now);
  const link = (changes: Params) => {
    const next = new URLSearchParams(Object.entries({ range: kind, date: query.date, ...changes }).filter((e): e is [string, string] => !!e[1]));
    return `/people/${id}?${next}`;
  };
  let data: Person;
  try {
    data = await getPerson(session, { from: p.from, to: p.to, memberId: id });
  } catch (e) {
    if (!(e instanceof AccessError)) throw e;
    return (
      <>
        <Header title="Person" sub="" back="/people" />
        <div className="scroll"><Empty lede={e.message} line="You can see the people in the teams you admin." /></div>
      </>
    );
  }
  const first = data.member.name.split(" ")[0]!;
  const rangeLabel = kind === "week" ? `Week of ${p.label}` : p.label;
  return (
    <>
      <Header title={data.member.name} sub={`${data.member.title} · ${data.member.teams.join(", ")}`} back="/people" avatar={data.member.name}>
        <Segmented options={(["day", "week", "month"] as const).map((k) => ({ label: k[0]!.toUpperCase() + k.slice(1), href: link({ range: k }), current: kind === k }))} />
        <Steps earlier={link({ date: p.earlier })} later={p.later && link({ date: p.later })} label={rangeLabel} />
      </Header>
      <div className="scroll">
        {data.totals.seconds === 0 && kind === "day" ? (
          <Empty lede={`${first} has nothing recorded on ${p.label}`} line={`Daylens wasn’t running on ${first}’s computer that day.`} />
        ) : kind === "day" ? (
          <Day data={data} first={first} tz={me.org.timeZone} date={p.from} core={[me.org.coreStart, me.org.coreEnd]} />
        ) : kind === "week" ? (
          <Week data={data} id={id} tz={me.org.timeZone} from={p.from} today={now} />
        ) : (
          <Month data={data} id={id} from={p.from} today={now} />
        )}
      </div>
    </>
  );
}
