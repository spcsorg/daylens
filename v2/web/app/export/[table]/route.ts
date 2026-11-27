import { currentSession } from "@/lib/auth";
import { getAttendance, getMe, getPeople, getTimesheets } from "@/lib/data";
import { AccessError, type Session } from "@/lib/data/access";
import { localDate } from "@/lib/domain/time";
import { download } from "@/lib/export";
import { period } from "@/lib/period";
import { attendanceTable, inTab, peopleTable, sortPeople, timesheetsTable, type Table, type Tab } from "@/lib/tables";

export const dynamic = "force-dynamic";

const TABS: Tab[] = ["submitted", "rejected", "approved", "missing"];

/** The table a screen shows, from the same URL parameters, as Excel or CSV. */
async function build(session: Session, table: string, q: Record<string, string | undefined>): Promise<{ data: Table; file: string } | null> {
  const timeZone = (await getMe(session)).org.timeZone;
  const today = localDate(Date.now(), timeZone);
  if (table === "people") {
    const p = period("week", q.date, today);
    const rows = await getPeople(session, { from: p.from, to: p.to, teamId: q.team, clientId: q.client });
    sortPeople(rows, q.sort, q.dir);
    return { data: peopleTable(rows, p.label), file: `people-${p.from}` };
  }
  if (table === "timesheets") {
    const p = period("week", q.date, today);
    const tab = TABS.find((t) => t === q.tab) ?? "submitted";
    const queue = await getTimesheets(session, { weekStart: p.from, teamId: q.team });
    return { data: timesheetsTable(queue.people.filter((r) => inTab(tab, r)), p.label, timeZone), file: `timesheets-${p.from}-${tab}` };
  }
  if (table === "attendance") {
    const p = period("month", q.date, today);
    const data = await getAttendance(session, { from: p.from, to: p.to, teamId: q.team });
    return { data: attendanceTable(data, p.label), file: `attendance-${p.from.slice(0, 7)}` };
  }
  return null;
}

export async function GET(request: Request, { params }: { params: Promise<{ table: string }> }) {
  const session = await currentSession();
  if (!session) return new Response("Couldn’t export: you’re signed out. Sign in again.", { status: 401 });
  const url = new URL(request.url);
  const format = url.searchParams.get("format") === "csv" ? "csv" : "xlsx";
  try {
    const built = await build(session, (await params).table, Object.fromEntries(url.searchParams));
    if (!built) return new Response("Couldn’t export: there’s no such table.", { status: 404 });
    return await download(built.data, format, built.file);
  } catch (e) {
    if (e instanceof AccessError) return new Response(`Couldn’t export. ${e.message}.`, { status: 403 });
    console.error(e);
    return new Response("Couldn’t export: the file didn’t build. Try again.", { status: 500 });
  }
}
