import { getTimesheetReview, getTimesheets } from "@/lib/data";
import { AccessError } from "@/lib/data/access";
import { period } from "@/lib/period";
import { loadMe, requireSession, today } from "@/lib/session";
import { Filters } from "../../ui/Filters";
import type { Tab } from "@/lib/tables";
import { ExportButtons } from "../../ui/ExportButtons";
import { Header, Steps } from "../../ui/parts";
import { TimesheetsScreen } from "./TimesheetsScreen";

type Params = Record<string, string | undefined>;

const TABS: Tab[] = ["submitted", "rejected", "approved", "missing"];

function href(params: Params, changes: Params) {
  const next = new URLSearchParams(Object.entries({ ...params, ...changes }).filter((e): e is [string, string] => !!e[1]));
  return `/timesheets?${next}`;
}

export default async function TimesheetsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const [session, me, now] = [await requireSession(), await loadMe(), await today()];
  const p = period("week", params.date, now);
  const queue = await getTimesheets(session, { weekStart: p.from, teamId: params.team });
  let review = null;
  let problem = null;
  if (params.sheet) {
    try {
      review = await getTimesheetReview(session, params.sheet);
    } catch (e) {
      if (!(e instanceof AccessError)) throw e;
      problem = `Couldn’t open that timesheet. ${e.message}.`;
    }
  }
  const step = { sheet: undefined };
  return (
    <>
      <Header title="Timesheets" sub={`Week of ${p.label} · due Friday 6:00 PM`}>
        <Steps earlier={href(params, { ...step, date: p.earlier })} later={p.later && href(params, { ...step, date: p.later })} />
        <ExportButtons table="timesheets" params={{ ...params, sheet: undefined }} />
      </Header>
      <div className="scroll">
        <Filters filters={[{ key: "team", label: "Team", all: "All teams", options: me.teams.map((t) => ({ value: t.id, label: t.name })) }]} />
        <TimesheetsScreen
          key={p.from}
          queue={queue}
          review={review}
          problem={problem}
          tab={TABS.find((t) => t === params.tab) ?? "submitted"}
          week={{ from: p.from, label: p.label }}
          timeZone={me.org.timeZone}
        />
      </div>
    </>
  );
}
