import { getAttendance } from "@/lib/data";
import { coreHours } from "@/lib/format";
import { period } from "@/lib/period";
import { loadMe, requireSession, today } from "@/lib/session";
import { ExportButtons } from "../../ui/ExportButtons";
import { Filters } from "../../ui/Filters";
import { Steps } from "../../ui/parts";
import { AttendanceScreen } from "./AttendanceScreen";

type Params = Record<string, string | undefined>;

function href(params: Params, changes: Params) {
  const next = new URLSearchParams(Object.entries({ ...params, ...changes }).filter((e): e is [string, string] => !!e[1]));
  return `/attendance?${next}`;
}

export default async function AttendancePage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const [session, me, now] = [await requireSession(), await loadMe(), await today()];
  const p = period("month", params.date, now);
  const data = await getAttendance(session, { from: p.from, to: p.to, teamId: params.team });
  return (
    <AttendanceScreen
      key={p.from}
      data={data}
      month={p.label}
      sub={`${p.label} · ${coreHours(me.org.coreStart, me.org.coreEnd)} core hours`}
      controls={
        <>
          <Steps earlier={href(params, { date: p.earlier })} later={p.later && href(params, { date: p.later })} />
          <ExportButtons table="attendance" params={{ ...params, date: p.from }} disabled={!data.people.length} />
        </>
      }
      filters={<Filters filters={[{ key: "team", label: "Team", all: "Everyone", options: me.teams.map((t) => ({ value: t.id, label: t.name })) }]} />}
      today={now}
    />
  );
}
