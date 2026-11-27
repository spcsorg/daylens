import { dayRange, longDate, monthName } from "./format";
import { addDays, mondayOf } from "./domain/time";

export type PeriodKind = "day" | "week" | "month";

export type Period = {
  kind: PeriodKind;
  from: string;
  to: string;
  /** The working days shown, Monday to Friday for a week. */
  label: string;
  current: boolean;
  earlier: string;
  later: string | null;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function monthEnd(date: string): string {
  const [y, m] = date.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function period(kind: string | undefined, date: string | undefined, today: string): Period {
  const k: PeriodKind = kind === "day" || kind === "month" ? kind : "week";
  const anchor = date && DATE.test(date) && date <= today ? date : today;
  if (k === "day") {
    return { kind: k, from: anchor, to: anchor, label: longDate(anchor), current: anchor === today, earlier: addDays(anchor, -1), later: anchor < today ? addDays(anchor, 1) : null };
  }
  if (k === "month") {
    const from = anchor.slice(0, 8) + "01";
    const to = monthEnd(from);
    const current = today >= from && today <= to;
    return { kind: k, from, to, label: monthName(from), current, earlier: addDays(from, -1).slice(0, 8) + "01", later: current ? null : addDays(to, 1) };
  }
  const from = mondayOf(anchor);
  const to = addDays(from, 6);
  const current = today >= from && today <= to;
  return { kind: k, from, to, label: dayRange(from, addDays(from, 4)), current, earlier: addDays(from, -7), later: current ? null : addDays(from, 7) };
}
