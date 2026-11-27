import Link from "next/link";
import { clientColors } from "@/lib/colors";
import { getOverview } from "@/lib/data";
import { hm, hrs, initials, pct, wholeHours, weekdayShort } from "@/lib/format";
import { isoWeekday } from "@/lib/domain/time";
import { period } from "@/lib/period";
import { loadMe, requireSession, today } from "@/lib/session";
import { AutoRefresh } from "../../ui/AutoRefresh";
import { Filters } from "../../ui/Filters";
import { Icon } from "../../ui/Icon";
import { Empty, Header, Panel, Segmented, Share, Stat, Steps } from "../../ui/parts";

type Params = Record<string, string | undefined>;

function href(params: Params, changes: Params) {
  const next = new URLSearchParams(Object.entries({ ...params, ...changes }).filter((e): e is [string, string] => !!e[1]));
  return `/overview?${next}`;
}

function sentence(scope: string, plural: boolean, current: boolean, kind: string, total: number, previous: number) {
  const when = kind === "day" ? "day" : kind;
  const hours = Math.round(total / 3600).toLocaleString("en-GB");
  if (current) return { lead: `${scope} ${plural ? "have" : "has"} logged `, hours: `${hours} hours`, tail: ` so far this ${when}.` };
  const change = previous === 0 ? "" : total > previous * 1.03 ? `, a little more than the ${when} before` : total < previous * 0.97 ? `, a little less than the ${when} before` : `, about the same as the ${when} before`;
  return { lead: `${scope} logged `, hours: `${hours} hours`, tail: ` that ${when}${change}.` };
}

export default async function OverviewPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const [session, me, now] = [await requireSession(), await loadMe(), await today()];
  const p = period(params.period, params.date, now);
  const billable = params.billable === "billable" ? true : params.billable === "non-billable" ? false : undefined;
  const o = await getOverview(session, { from: p.from, to: p.to, teamId: params.team, clientId: params.client, projectId: params.project, billable });
  const color = clientColors(o.byClient);
  const team = me.teams.find((t) => t.id === params.team);
  const teams = team ? [team.name] : me.member.scope;
  const scope = teams ? `The ${teams.join(" and ").toLowerCase()} team${teams.length > 1 ? "s" : ""}` : "The firm";
  const unit = p.kind === "day" ? "day" : p.kind;
  const sub = p.current ? `This ${unit} · ${p.label}` : p.kind === "week" ? `Week of ${p.label}` : p.label;
  const s = sentence(scope, (teams?.length ?? 0) > 1, p.current, p.kind, o.totalSeconds, o.previousTotalSeconds);
  const topClient = o.byClient.find((c) => c.billable);
  const days = o.byDay.filter((d) => p.kind !== "week" || me.org.workingDays.includes(isoWeekday(d.date)));
  const maxDay = Math.max(1, ...days.map((d) => d.seconds));
  const billShare = o.withProjectSeconds > 0 ? o.billableSeconds / o.withProjectSeconds : 0;
  const clientMax = o.byClient[0]?.seconds ?? 1;
  const clientTotal = o.byClient.reduce((a, c) => a + c.seconds, 0);

  return (
    <>
      <Header title="Overview" sub={sub}>
        <Segmented
          options={(["day", "week", "month"] as const).map((k) => ({ label: k[0]!.toUpperCase() + k.slice(1), href: href(params, { period: k, date: undefined }), current: p.kind === k }))}
        />
        <Steps earlier={href(params, { date: p.earlier })} later={p.later && href(params, { date: p.later })} />
      </Header>
      <div className="scroll">
        <AutoRefresh seconds={30} />
        <Filters
          filters={[
            { key: "team", label: "Team", all: "All teams", options: me.teams.map((t) => ({ value: t.id, label: t.name })) },
            { key: "client", label: "Client", all: "All clients", options: me.clients.map((c) => ({ value: c.id, label: c.name })) },
            { key: "project", label: "Project", all: "All projects", options: me.projects.filter((x) => !params.client || x.clientId === params.client).map((x) => ({ value: x.id, label: x.name })) },
            { key: "billable", label: "Billable", all: "Billable and not", options: [{ value: "billable", label: "Billable" }, { value: "non-billable", label: "Non-billable" }] },
          ]}
        />
        {o.totalSeconds === 0 ? (
          <Empty
            lede={`Nothing recorded this ${unit}${p.current ? " yet" : ""}`}
            line={`Hours appear here once people at ${me.org.shortName} sign in to the Daylens app on their computers.`}
          />
        ) : (
          <>
            <p className="digest">
              {s.lead}
              <Link href="/people">{s.hours}</Link>
              {s.tail}
              {topClient && ` ${topClient.name} took the most client time.`}
              {o.unattributedSeconds >= 3600 && ` ${Math.round(o.unattributedSeconds / 3600)} hours are still waiting for people to pick a project`}
              {o.unattributedSeconds >= 3600 && (o.timesheetsNotIn ? `, and ${o.timesheetsNotIn} timesheets aren’t in yet.` : ".")}
              {o.unattributedSeconds < 3600 && !!o.timesheetsNotIn && ` ${o.timesheetsNotIn} timesheets aren’t in yet.`}
            </p>
            <div className="stats">
              <Stat href="/people" label="Total hours" value={wholeHours(o.totalSeconds)} unit="h" note={`${o.people} people · ${hrs(o.totalSeconds / Math.max(1, o.people))} each on average`} />
              <Stat label="Billable" value={pct(billShare)} share={billShare} note={`${wholeHours(o.billableSeconds)} h billable of ${wholeHours(o.withProjectSeconds)} h with a project`} />
              <Stat
                label="Core-hours coverage"
                value={o.coverage === null ? "—" : pct(o.coverage)}
                share={o.coverage ?? 0}
                note={`Of ${clockOf(me.org.coreStart)}–${clockOf(me.org.coreEnd)}, Monday to Friday`}
              />
              <Stat label="Active now" value={o.activeCount} unit={`of ${o.people}`} note={<><span className="dot-now" />Working in the last 5 minutes</>} />
            </div>
            <div className="grid-2">
              <div className="stack">
                <Panel title="By client" figure={hrs(clientTotal)}>
                  {o.byClient.map((c) => (
                    <div className="app-row" key={c.id}>
                      <span className="swatch" style={{ background: color(c.id) }} />
                      <span className="app-row-text">
                        <span className="app-row-name">
                          {c.name}
                          {!c.billable && <span className="faint" style={{ font: "var(--caption)" }}> · non-billable</span>}
                        </span>
                        <Share value={c.seconds / clientMax} color={color(c.id)} />
                        <span className="app-row-detail">{pct(c.seconds / clientTotal)} of the {unit}</span>
                      </span>
                      <span className="app-row-ms">{hrs(c.seconds)}</span>
                    </div>
                  ))}
                </Panel>
                <Panel title="By project" figure={`Top ${Math.min(8, o.byProject.length)} of ${o.byProject.length}`}>
                  <table className="table">
                    <thead>
                      <tr><th>Project</th><th>Client</th><th className="r">Hours</th><th className="r">People</th></tr>
                    </thead>
                    <tbody>
                      {o.byProject.slice(0, 8).map((x) => (
                        <tr key={x.id}>
                          <td>
                            <b style={{ font: "var(--label)" }}>{x.name}</b>
                            <div className="faint" style={{ font: "var(--caption)" }}>{x.code}{x.billable ? "" : " · non-billable"}</div>
                          </td>
                          <td className="muted">{x.clientName}</td>
                          <td className="r">{hrs(x.seconds)}</td>
                          <td className="r muted">{x.people}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Panel>
              </div>
              <div className="stack">
                <Panel title="Active now" figure={`${o.activeCount} working · ${o.people - o.activeCount} away`}>
                  {o.active.length === 0 && <p className="app-row muted">No one has been at their computer in the last 5 minutes.</p>}
                  {o.active.map((a) => (
                    <Link className="app-row" key={a.memberId} href={`/people/${a.memberId}?range=day`}>
                      <span className="avatar">{initials(a.name)}</span>
                      <span className="app-row-text">
                        <span className="app-row-name">{a.name}</span>
                        <span className="app-row-detail">{a.project ? (a.project.internal ? a.project.name : `${a.project.clientName} · ${a.project.name}`) : "Needs a project"}</span>
                      </span>
                      <span className="dot-now" title="Active now" />
                      <span className="faint num" style={{ font: "var(--caption)", minWidth: 52, textAlign: "right", whiteSpace: "nowrap" }}>{hm(a.minutes * 60)}</span>
                    </Link>
                  ))}
                  <Link className="btn quiet small" style={{ margin: "6px 0 0 4px" }} href="/people">
                    Everyone
                    <Icon name="arrow-right" />
                  </Link>
                </Panel>
                {p.kind !== "day" && (
                  <Panel title="By day">
                    <div className="legend" style={{ marginBottom: 12 }}>
                      <span><span className="swatch" style={{ background: "var(--text)" }} />Billable</span>
                      <span><span className="swatch" style={{ background: "var(--line-strong)" }} />Non-billable</span>
                    </div>
                    <div className="bars">
                      {days.map((d) => (
                        <div className="bar" key={d.date}>
                          <span className="v">{Math.round(d.seconds / 3600)} h</span>
                          <div className="col" style={{ height: (d.seconds / maxDay) * 110 }}>
                            <span style={{ height: `${d.seconds ? (d.billableSeconds / d.seconds) * 100 : 0}%`, background: d.date === now ? "var(--text)" : "var(--text-2)" }} />
                            <span style={{ height: `${d.seconds ? 100 - (d.billableSeconds / d.seconds) * 100 : 0}%`, background: "var(--line-strong)" }} />
                          </div>
                          <span className="d">{p.kind === "month" ? Number(d.date.slice(8)) : weekdayShort(d.date)}</span>
                        </div>
                      ))}
                    </div>
                  </Panel>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function clockOf(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
