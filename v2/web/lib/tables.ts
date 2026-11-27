import type { Attendance, PersonRow, QueueRow } from "./data/queries";
import { localDate } from "./domain/time";
import { clock, dayOfMonth, hm, hrs, weekdayShort } from "./format";

/**
 * What the People, Timesheets and Attendance tables show, row for row, shared by each screen and its export (FR-24),
 * so a download carries exactly the rows, order and filters on screen.
 */

export type Cell = string | number | null;
export type Table = { name: string; columns: string[]; rows: Cell[][] };

type PeopleSort = "name" | "seconds" | "billableShare" | "coverage" | "idleSeconds" | "outsideCoreSeconds" | "unattributedSeconds" | "timesheet";

export const PEOPLE_COLUMNS: [PeopleSort, string, boolean][] = [
  ["name", "Person", false],
  ["seconds", "Hours", true],
  ["billableShare", "Billable", true],
  ["coverage", "Core-hours coverage", false],
  ["idleSeconds", "Idle", true],
  ["outsideCoreSeconds", "Evenings", true],
  ["unattributedSeconds", "Needs a project", true],
  ["timesheet", "Timesheet", false],
];

/** Sorts in place by the column and direction in the URL, defaulting to most hours first. */
export function sortPeople(rows: PersonRow[], sortParam?: string, dirParam?: string) {
  const sort = PEOPLE_COLUMNS.find((c) => c[0] === sortParam)?.[0] ?? "seconds";
  const textual = sort === "name" || sort === "timesheet";
  const dir: "asc" | "desc" = dirParam === "asc" || dirParam === "desc" ? dirParam : textual ? "asc" : "desc";
  rows.sort((a, b) => {
    const x = a[sort];
    const y = b[sort];
    if (typeof x === "string" || typeof y === "string") return String(x ?? "").localeCompare(String(y ?? ""));
    return (x ?? -1) - (y ?? -1);
  });
  if (dir === "desc") rows.reverse();
  return { sort, dir };
}

export const STATUS = { draft: "Draft", submitted: "Submitted", approved: "Approved", rejected: "Rejected", missing: "Not started" };

export type Tab = "submitted" | "rejected" | "approved" | "missing";

export const inTab = (tab: Tab, r: QueueRow) => (tab === "missing" ? r.status === "missing" || r.status === "draft" : r.status === tab);

/** What's worth a second look before approving: hours far from what Daylens tracked, time with no project, a long week. */
export function timesheetFlags(r: QueueRow) {
  if (r.status === "missing") return [];
  const out: string[] = [];
  const gap = r.hours * 3600 - r.trackedSeconds;
  if (Math.abs(gap) >= 2 * 3600) out.push(`${hrs(Math.abs(gap))} ${gap > 0 ? "more" : "less"} than tracked`);
  if (r.unattributedSeconds >= 1.5 * 3600) out.push(`${hm(r.unattributedSeconds)} needs a project`);
  if (r.hours > 45) out.push("Over 45 h");
  return out;
}

export function sentAt(r: QueueRow, timeZone: string) {
  if (r.status === "missing") return "—";
  if (!r.sheet?.submittedAt) return "Draft, not sent";
  return `${weekdayShort(localDate(r.sheet.submittedAt, timeZone))} ${clock(r.sheet.submittedAt, timeZone)}`;
}

const hours = (seconds: number) => Math.round((seconds / 3600) * 100) / 100;
const percent = (x: number | null) => (x === null ? null : Math.round(x * 100));

export function peopleTable(rows: PersonRow[], weekOf: string): Table {
  return {
    name: `People, week of ${weekOf}`,
    columns: ["Person", "Title", "Teams", "Hours", "Billable %", "Core-hours coverage %", "Idle hours", "Evening hours", "Hours needing a project", "Timesheet"],
    rows: rows.map((r) => [
      r.name,
      r.title,
      r.teams.join(", "),
      hours(r.seconds),
      percent(r.billableShare),
      percent(r.coverage),
      hours(r.idleSeconds),
      hours(r.outsideCoreSeconds),
      hours(r.unattributedSeconds),
      r.timesheet ? STATUS[r.timesheet] : null,
    ]),
  };
}

export function timesheetsTable(rows: QueueRow[], weekOf: string, timeZone: string): Table {
  return {
    name: `Timesheets, week of ${weekOf}`,
    columns: ["Person", "Teams", "Hours", "Tracked hours", "Billable %", "Sent", "Worth a look", "Status"],
    rows: rows.map((r) => [
      r.name,
      r.teams.join(", "),
      r.sheet ? r.hours : null,
      hours(r.trackedSeconds),
      r.hours ? percent(r.billableHours / r.hours) : null,
      sentAt(r, timeZone),
      timesheetFlags(r).join(" · ") || null,
      STATUS[r.status],
    ]),
  };
}

export function attendanceTable(a: Attendance, month: string): Table {
  return {
    name: `Attendance, ${month}`,
    columns: ["Person", "Title", ...a.days.map((d) => `${weekdayShort(d.date)} ${dayOfMonth(d.date)}`), "Days worked", "Leave days"],
    rows: a.people.map((p) => [
      p.name,
      p.title,
      ...p.cells.map((c): Cell => {
        if (c.kind === "leave") return c.flag ? `${c.leaveType}, ${hm(c.seconds)} active` : c.leaveType;
        if (c.kind === "none") return "No activity";
        return c.seconds >= 60 ? hours(c.seconds) : null;
      }),
      p.daysWorked,
      p.leaveDays,
    ]),
  };
}
