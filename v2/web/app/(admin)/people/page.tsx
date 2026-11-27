import Link from "next/link";
import { getPeople } from "@/lib/data";
import type { PersonRow } from "@/lib/data/queries";
import { hm, hrs, initials, pct } from "@/lib/format";
import { period } from "@/lib/period";
import { loadMe, requireSession, today } from "@/lib/session";
import { Filters } from "../../ui/Filters";
import { Empty, Header, Share, Steps, TimesheetStatus } from "../../ui/parts";

type Params = Record<string, string | undefined>;
type SortKey = "name" | "seconds" | "billableShare" | "coverage" | "idleSeconds" | "outsideCoreSeconds" | "unattributedSeconds" | "timesheet";

const COLUMNS: [SortKey, string, boolean][] = [
  ["name", "Person", false],
  ["seconds", "Hours", true],
  ["billableShare", "Billable", true],
  ["coverage", "Core-hours coverage", false],
  ["idleSeconds", "Idle", true],
  ["outsideCoreSeconds", "Evenings", true],
  ["unattributedSeconds", "Needs a project", true],
  ["timesheet", "Timesheet", false],
];

function href(params: Params, changes: Params) {
  const next = new URLSearchParams(Object.entries({ ...params, ...changes }).filter((e): e is [string, string] => !!e[1]));
  return `/people?${next}`;
}

function compare(key: SortKey) {
  return (a: PersonRow, b: PersonRow) => {
    const x = a[key];
    const y = b[key];
    if (typeof x === "string" || typeof y === "string") return String(x ?? "").localeCompare(String(y ?? ""));
    return (x ?? -1) - (y ?? -1);
  };
}

export default async function PeoplePage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const [session, me, now] = [await requireSession(), await loadMe(), await today()];
  const p = period("week", params.date, now);
  const rows = await getPeople(session, { from: p.from, to: p.to, teamId: params.team, clientId: params.client });
  const sort = (COLUMNS.find((c) => c[0] === params.sort)?.[0] ?? "seconds") as SortKey;
  const textual = sort === "name" || sort === "timesheet";
  const dir = params.dir === "asc" || params.dir === "desc" ? params.dir : textual ? "asc" : "desc";
  rows.sort(compare(sort));
  if (dir === "desc") rows.reverse();
  const total = (k: "seconds" | "outsideCoreSeconds" | "unattributedSeconds") => rows.reduce((a, r) => a + r[k], 0);
  const avg = (k: "billableShare" | "coverage") => {
    const xs = rows.map((r) => r[k]).filter((x): x is number => x !== null);
    return xs.length ? pct(xs.reduce((a, x) => a + x, 0) / xs.length) : "—";
  };

  return (
    <>
      <Header title="People" sub={p.current ? `This week · ${p.label}` : `Week of ${p.label}`}>
        <Steps earlier={href(params, { date: p.earlier })} later={p.later && href(params, { date: p.later })} />
      </Header>
      <div className="scroll">
        <Filters
          filters={[
            { key: "team", label: "Team", all: "All teams", options: me.teams.map((t) => ({ value: t.id, label: t.name })) },
            { key: "client", label: "Client", all: "All clients", options: me.clients.map((c) => ({ value: c.id, label: c.name })) },
          ]}
        />
        {rows.length === 0 ? (
          <Empty
            lede="No one matches these filters"
            line="Try another team or client."
            action={<Link className="btn secondary small" href={href(params, { team: undefined, client: undefined })}>Clear filters</Link>}
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                {COLUMNS.flatMap(([key, label, right]) => [
                  key === "seconds" ? <th key="team">Team</th> : null,

                  <th key={key} className={right ? "r" : undefined} aria-sort={key === sort ? (dir === "asc" ? "ascending" : "descending") : undefined}>
                    <Link href={href(params, { sort: key, dir: key === sort ? (dir === "asc" ? "desc" : "asc") : undefined })}>
                      {label}
                      {key === sort ? (dir === "asc" ? " ↑" : " ↓") : ""}
                    </Link>
                  </th>,
                ])}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.memberId}>
                  <td>
                    <div className="who">
                      <span className="avatar">{initials(r.name)}</span>
                      <div>
                        <Link className="row-link" href={`/people/${r.memberId}?range=week&date=${p.from}`}>
                          <b>{r.name}</b>
                        </Link>
                        <small>{r.title}</small>
                      </div>
                    </div>
                  </td>
                  <td className="muted">{r.teams.join(", ")}</td>
                  <td className="r"><b style={{ font: "var(--label)" }}>{hrs(r.seconds)}</b></td>
                  <td className="r">{r.billableShare === null ? "—" : pct(r.billableShare)}</td>
                  <td>
                    {r.coverage === null ? "—" : (
                      <span className="mini-bar">
                        <Share value={r.coverage} color={r.coverage < 0.5 ? "var(--danger)" : "var(--text-2)"} />
                        <span className="num">{pct(r.coverage)}</span>
                      </span>
                    )}
                  </td>
                  <td className="r muted">{hm(r.idleSeconds)}</td>
                  <td className="r muted">{r.outsideCoreSeconds >= 900 ? hm(r.outsideCoreSeconds) : "—"}</td>
                  <td className="r muted">{r.unattributedSeconds >= 60 ? hm(r.unattributedSeconds) : "—"}</td>
                  <td>{r.timesheet && <TimesheetStatus status={r.timesheet} />}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>{rows.length} people</td>
                <td />
                <td className="r">{hrs(total("seconds"))}</td>
                <td className="r">{avg("billableShare")}</td>
                <td>{avg("coverage")} average</td>
                <td />
                <td className="r">{hrs(total("outsideCoreSeconds"))}</td>
                <td className="r">{hrs(total("unattributedSeconds"))}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </>
  );
}
