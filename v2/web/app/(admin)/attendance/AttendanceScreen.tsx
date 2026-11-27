"use client";

import Link from "next/link";
import { useState, useTransition, type ReactNode } from "react";
import type { Attendance, AttendanceLeave } from "@/lib/data/queries";
import { dayOfMonth, dayRange, hm, initials, longDate, monthName, weekdayShort } from "@/lib/format";
import { Dialog, Field, ToastView, useToast, type Toast } from "../../ui/controls";
import { Icon } from "../../ui/Icon";
import { Empty, Header, Panel } from "../../ui/parts";
import { deleteLeave, saveLeave, type Result } from "./actions";

type Open = { kind: "new" } | { kind: "edit"; leave: AttendanceLeave } | null;

const first = (name: string) => name.split(" ")[0];
const when = (from: string, to: string) => (from === to ? `${dayOfMonth(from)} ${monthName(from)}` : dayRange(from, to));
const failed = (): Result => ({ ok: false, message: "Couldn’t save: Daylens didn’t answer. Try again." });
const dayLink = (memberId: string, date: string) => `/people/${memberId}?range=day&date=${date}`;

export function AttendanceScreen({ data, month, sub, controls, filters, today }: { data: Attendance; month: string; sub: string; controls: ReactNode; filters: ReactNode; today: string }) {
  const [open, setOpen] = useState<Open>(null);
  const [toast, notify] = useToast();

  const head = (
    <Header title="Attendance and leave" sub={sub}>
      {controls}
      <button type="button" className="btn primary small" disabled={!data.people.length} onClick={() => setOpen({ kind: "new" })}>
        <Icon name="plus" />
        Record leave
      </button>
    </Header>
  );

  return (
    <>
      {head}
      <div className="scroll">
        {filters}
        {data.people.length === 0 ? (
          <Empty lede="No one in this team yet" line="Add people to the team from Settings, or pick another team." />
        ) : (
          <>
            <div className="legend" style={{ padding: "0 0 16px" }}>
              <span><span className="swatch" style={{ background: "color-mix(in srgb, var(--text) 60%, transparent)" }} />Worked (darker is longer)</span>
              <span><span className="swatch att-leave-swatch" />Leave</span>
              <span><span className="swatch none" />No activity</span>
              <span><span className="swatch" style={{ boxShadow: "0 0 0 2px var(--text)" }} />Doesn’t add up</span>
            </div>
            <div className="att-wrap">
              <table className="table att-table">
                <thead>
                  <tr>
                    <th className="att-sticky" style={{ minWidth: 200 }}>Person</th>
                    {data.days.map((d) => (
                      <th key={d.date} className={`att-d${d.working ? "" : " off"}${d.date === today ? " today" : ""}`}>
                        {weekdayShort(d.date)[0]}
                        <br />
                        {dayOfMonth(d.date)}
                      </th>
                    ))}
                    <th className="r">Days worked</th>
                    <th className="r">Leave</th>
                  </tr>
                </thead>
                <tbody>
                  {data.people.map((p) => (
                    <tr key={p.memberId}>
                      <td className="att-sticky">
                        <div className="who">
                          <span className="avatar">{initials(p.name)}</span>
                          <div>
                            <b>{p.name}</b>
                            <small>{p.title}</small>
                          </div>
                        </div>
                      </td>
                      {p.cells.map((c) => {
                        const label = `${longDate(c.date)}: ${
                          c.kind === "leave" ? (c.flag ? `${c.leaveType}, ${hm(c.seconds)} active` : c.leaveType) : c.kind === "none" ? "no activity, no leave recorded" : c.seconds >= 60 ? hm(c.seconds) : "nothing recorded"
                        }`;
                        const shade = c.kind === "worked" ? { background: `color-mix(in srgb, var(--text) ${Math.round(Math.min(90, Math.max(15, 20 + (c.seconds / 3600 - 5) * 14)))}%, transparent)` } : undefined;
                        const cls = `att-cell ${c.kind}${c.flag ? " flag" : ""}`;
                        return (
                          <td key={c.date} className="att" title={label}>
                            {c.kind === "worked" || c.kind === "leave" || c.kind === "none" ? (
                              <Link className={cls} style={shade} href={dayLink(p.memberId, c.date)} aria-label={`${p.name}, ${label}`}>
                                {c.kind === "leave" ? "L" : ""}
                              </Link>
                            ) : (
                              <span className={cls} />
                            )}
                          </td>
                        );
                      })}
                      <td className="r">{p.daysWorked}</td>
                      <td className="r muted">{p.leaveDays || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <Panel title="Doesn’t add up" figure={data.flags.length ? `${data.flags.length} day${data.flags.length === 1 ? "" : "s"}` : undefined}>
                {data.flags.length === 0 ? (
                  <p className="muted" style={{ padding: "0 12px 8px" }}>Every working day in {month} so far has activity or recorded leave.</p>
                ) : (
                  data.flags.map((f) => (
                    <Link key={f.memberId + f.date} className="app-row" href={dayLink(f.memberId, f.date)}>
                      <span className="avatar">{initials(f.name)}</span>
                      <span className="app-row-text">
                        <span className="app-row-name">{f.name} · {longDate(f.date)}</span>
                        <span className="app-row-detail" style={{ whiteSpace: "normal" }}>
                          {f.leaveType
                            ? `${f.leaveType} is recorded, but ${first(f.name)} was active for ${hm(f.seconds)}${f.mostly ? `, mostly on ${f.mostly.internal ? f.mostly.name : f.mostly.clientName}` : ""}.`
                            : "No activity and no leave recorded on a working day."}
                        </span>
                      </span>
                      <Icon name="chevron-right" />
                    </Link>
                  ))
                )}
              </Panel>
              <Panel title={`Leave in ${month}`}>
                {data.leave.length === 0 ? (
                  <p className="muted" style={{ padding: "0 12px 8px" }}>No leave recorded in {month}.</p>
                ) : (
                  data.leave.map((l) => (
                    <button key={l.id} type="button" className="app-row" title={`Change ${first(l.name)}’s leave`} onClick={() => setOpen({ kind: "edit", leave: l })}>
                      <span className="avatar">{initials(l.name)}</span>
                      <span className="app-row-text">
                        <span className="app-row-name" style={{ font: "var(--label)" }}>{l.name}</span>
                        <span className="app-row-detail">
                          {l.type} · {when(l.startsOn, l.endsOn)} · {l.days} working day{l.days === 1 ? "" : "s"}
                        </span>
                      </span>
                      <Icon name="edit" />
                    </button>
                  ))
                )}
              </Panel>
            </div>
          </>
        )}
      </div>
      {open && <LeaveDialog open={open} data={data} today={today} onClose={() => setOpen(null)} notify={notify} />}
      <ToastView toast={toast} />
    </>
  );
}

function LeaveDialog({ open, data, today, onClose, notify }: { open: NonNullable<Open>; data: Attendance; today: string; onClose: () => void; notify: (t: Toast) => void }) {
  const editing = open.kind === "edit" ? open.leave : null;
  const types = editing && !data.leaveTypes.includes(editing.type) ? [...data.leaveTypes, editing.type] : data.leaveTypes;
  const [memberId, setMemberId] = useState(editing?.memberId ?? data.people[0]?.memberId ?? "");
  const [type, setType] = useState(editing?.type ?? types[0] ?? "");
  const [startsOn, setStartsOn] = useState(editing?.startsOn ?? today);
  const [endsOn, setEndsOn] = useState(editing?.endsOn ?? today);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, start] = useTransition();
  const fields = result && !result.ok ? (result.fields ?? {}) : {};
  const name = editing?.name ?? data.people.find((p) => p.memberId === memberId)?.name ?? "";

  const save = () =>
    start(async () => {
      const r = await saveLeave(editing?.id ?? null, { memberId, type, startsOn, endsOn }).catch(failed);
      setResult(r);
      if (!r.ok) {
        if (!r.fields) notify({ text: r.message, error: true });
        return;
      }
      notify({ text: editing ? `Changed ${first(name)}’s leave` : `${type} recorded for ${name}` });
      onClose();
    });

  const remove = () =>
    start(async () => {
      const r = await deleteLeave(editing!.id).catch(failed);
      if (!r.ok) return notify({ text: r.message, error: true });
      notify({ text: `Removed ${first(name)}’s ${editing!.type.toLowerCase()}` });
      onClose();
    });

  return (
    <Dialog title={editing ? `${first(editing.name)}’s leave` : "Record leave"} onClose={onClose} onSubmit={save}>
      {editing ? (
        <p className="muted">{editing.name}</p>
      ) : (
        <Field label="Person" error={fields.memberId}>
          <select className="field" value={memberId} onChange={(e) => setMemberId(e.target.value)} aria-invalid={!!fields.memberId}>
            {data.people.map((p) => (
              <option key={p.memberId} value={p.memberId}>{p.name}</option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Type" error={fields.type}>
        <select className="field" value={type} onChange={(e) => setType(e.target.value)} aria-invalid={!!fields.type}>
          {types.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </Field>
      <div className="form-row">
        <Field label="First day" error={fields.startsOn}>
          <input
            className="field"
            type="date"
            value={startsOn}
            aria-invalid={!!fields.startsOn}
            onChange={(e) => {
              setStartsOn(e.target.value);
              if (e.target.value > endsOn) setEndsOn(e.target.value);
            }}
          />
        </Field>
        <Field label="Last day" error={fields.endsOn}>
          <input className="field" type="date" value={endsOn} min={startsOn} aria-invalid={!!fields.endsOn} onChange={(e) => setEndsOn(e.target.value)} />
        </Field>
      </div>
      <p className="muted" style={{ font: "var(--caption)" }}>Whole days. Only working days inside the dates count as leave.</p>
      {fields.form && <p className="form-error">{fields.form}</p>}
      <div className="dialog-actions">
        {editing && (
          <button type="button" className="btn danger-quiet small" style={{ marginRight: "auto" }} disabled={busy} onClick={remove}>
            Remove
          </button>
        )}
        <button type="button" className="btn quiet small" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn primary small" disabled={busy} aria-busy={busy}>
          {editing ? "Save" : "Record leave"}
        </button>
      </div>
    </Dialog>
  );
}
