"use client";

import { useCallback, useState, useTransition } from "react";
import type { Settings, SettingsMember } from "@/lib/data/queries";
import { coreHours, initials } from "@/lib/format";
import { Dialog, Field, ToastView, useToast, type Toast } from "../../ui/controls";
import { Icon } from "../../ui/Icon";
import { saveMember, savePolicy, setActive, type Result } from "./actions";

type Notify = (t: Toast) => void;

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const failed = (): Result => ({ ok: false, message: "Couldn’t save: Daylens didn’t answer. Try again." });
const first = (name: string) => name.split(" ")[0];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const minutes = (v: string) => (/^\d{2}:\d{2}$/.test(v) ? Number(v.slice(0, 2)) * 60 + Number(v.slice(3)) : NaN);

function Row({ label, detail, error, children }: { label: string; detail: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <span className="settings-row-label">{label}</span>
        <span className="settings-row-detail">{detail}</span>
        {error && <span className="field-error">{error}</span>}
      </div>
      {children}
    </div>
  );
}

export function PolicyTab({ data }: { data: Settings }) {
  const p = data.policy;
  const [timeZone, setTimeZone] = useState(p.timeZone);
  const [start, setStart] = useState(hhmm(p.coreStart));
  const [end, setEnd] = useState(hhmm(p.coreEnd));
  const [days, setDays] = useState(p.workingDays);
  const [types, setTypes] = useState(p.leaveTypes);
  const [adding, setAdding] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, run] = useTransition();
  const [toast, notify] = useToast();
  const zones = [...new Set([p.timeZone, ...Intl.supportedValuesOf("timeZone")])].sort();
  const fields = result && !result.ok ? (result.fields ?? {}) : {};
  const off = !data.canEdit || busy;
  const recounts = timeZone !== p.timeZone || minutes(start) !== p.coreStart || minutes(end) !== p.coreEnd || [...days].sort().join() !== [...p.workingDays].sort().join();
  const dirty = recounts || types.join("|") !== p.leaveTypes.join("|");

  const addType = () => {
    const v = adding?.trim();
    if (v && !types.some((x) => x.toLowerCase() === v.toLowerCase())) setTypes([...types, v]);
    setAdding(null);
  };

  const save = () =>
    run(async () => {
      const r = await savePolicy({ timeZone, coreStart: minutes(start), coreEnd: minutes(end), workingDays: days, leaveTypes: types }).catch(failed);
      setResult(r);
      if (!r.ok) return notify({ text: r.message, error: true });
      notify({ text: recounts ? "Saved. Core-hours coverage is recounted on every screen" : "Saved" });
    });

  return (
    <form
      className="settings-stack"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div>
        <p className="settings-heading">Working time</p>
        <div className="settings-card">
          <Row label="Time zone" detail="Where the firm’s days start and end." error={fields.timeZone}>
            <select className="field small" style={{ width: 240 }} value={timeZone} disabled={off} onChange={(e) => setTimeZone(e.target.value)} aria-label="Time zone">
              {zones.map((z) => <option key={z}>{z}</option>)}
            </select>
          </Row>
          <Row label="Core hours" detail={`Coverage counts time inside these hours, now ${coreHours(p.coreStart, p.coreEnd)}.`} error={fields.coreStart ?? fields.coreEnd}>
            <span className="toolbar">
              <input className="field small" style={{ width: 120 }} type="time" step={300} value={start} disabled={off} aria-label="Core hours start" onChange={(e) => setStart(e.target.value)} />
              <span className="faint">to</span>
              <input className="field small" style={{ width: 120 }} type="time" step={300} value={end} disabled={off} aria-label="Core hours end" onChange={(e) => setEnd(e.target.value)} />
            </span>
          </Row>
          <Row label="Working days" detail="Days off don’t count against coverage or attendance." error={fields.workingDays}>
            <span className="day-pick" role="group" aria-label="Working days">
              {WEEKDAYS.map((w, i) => (
                <button key={w} type="button" aria-pressed={days.includes(i + 1)} disabled={off} onClick={() => setDays(days.includes(i + 1) ? days.filter((d) => d !== i + 1) : [...days, i + 1].sort())}>
                  {w}
                </button>
              ))}
            </span>
          </Row>
        </div>
      </div>
      <div>
        <p className="settings-heading">Leave types</p>
        <div className="settings-card">
          <Row label="Types admins can record" detail="Removing one keeps the leave already recorded with it." error={fields.leaveTypes}>
            <span />
          </Row>
          <div className="chips" style={{ padding: "0 0 16px" }}>
            {types.map((x) => (
              <span key={x} className={`chip-x${data.canEdit ? "" : " fixed"}`}>
                {x}
                {data.canEdit && (
                  <button type="button" aria-label={`Remove ${x}`} disabled={busy} onClick={() => setTypes(types.filter((y) => y !== x))}>
                    <Icon name="x" size={12} />
                  </button>
                )}
              </span>
            ))}
            {data.canEdit &&
              (adding === null ? (
                <button type="button" className="chip-x add" onClick={() => setAdding("")}>
                  <Icon name="plus" size={12} />
                  Add a type
                </button>
              ) : (
                <input
                  className="chip-input"
                  autoFocus
                  placeholder="Maternity leave"
                  aria-label="New leave type"
                  value={adding}
                  onChange={(e) => setAdding(e.target.value)}
                  onBlur={addType}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addType();
                    }
                    if (e.key === "Escape") setAdding(null);
                  }}
                />
              ))}
          </div>
        </div>
      </div>
      {data.canEdit && (
        <div className="toolbar">
          {recounts && <span className="muted" style={{ font: "var(--caption)" }}>Saving recounts core-hours coverage for every day Daylens still has activity for.</span>}
          <span className="grow" />
          <button type="button" className="btn quiet small" disabled={!dirty || busy} onClick={() => { setTimeZone(p.timeZone); setStart(hhmm(p.coreStart)); setEnd(hhmm(p.coreEnd)); setDays(p.workingDays); setTypes(p.leaveTypes); setResult(null); }}>
            Undo changes
          </button>
          <button type="submit" className="btn primary small" disabled={!dirty || busy} aria-busy={busy}>
            Save policy
          </button>
        </div>
      )}
      <ToastView toast={toast} />
    </form>
  );
}

function roleText(m: SettingsMember, teams: Map<string, string>) {
  if (m.role === "owner") return "Owner";
  if (m.role === "employee") return "Employee";
  return m.adminScope === "org" ? "Admin · whole firm" : `Admin · ${m.adminTeamIds.map((id) => teams.get(id)).sort().join(", ") || "no teams"}`;
}

export function MembersTab({ data }: { data: Settings }) {
  const [editing, setEditing] = useState<SettingsMember | null>(null);
  const close = useCallback(() => setEditing(null), []);
  const [toast, notify] = useToast();
  const teams = new Map(data.teams.map((t) => [t.id, t.name]));
  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>Person</th>
            <th>Role</th>
            <th>Teams</th>
            <th>Status</th>
            {data.canEdit && <th />}
          </tr>
        </thead>
        <tbody>
          {data.members.map((m) => (
            <tr key={m.id} style={m.active ? undefined : { color: "var(--text-3)" }}>
              <td>
                <div className="who">
                  <span className="avatar">{initials(m.name)}</span>
                  <div>
                    <b>{m.name}</b>
                    <small>{m.email}</small>
                  </div>
                </div>
              </td>
              <td>{roleText(m, teams)}</td>
              <td className="muted">{m.teamIds.map((id) => teams.get(id)).sort().join(", ") || "—"}</td>
              <td>{m.active ? "Active" : "Deactivated"}</td>
              {data.canEdit && (
                <td className="r">
                  <button type="button" className="btn quiet small" onClick={() => setEditing(m)}>
                    <Icon name="edit" />
                    Edit
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <MemberDialog member={editing} data={data} onClose={close} notify={notify} />}
      <ToastView toast={toast} />
    </>
  );
}

function MemberDialog({ member, data, onClose, notify }: { member: SettingsMember; data: Settings; onClose: () => void; notify: Notify }) {
  const [role, setRole] = useState(member.role);
  const [scope, setScope] = useState<"org" | "teams">(member.adminScope ?? "teams");
  const [teamIds, setTeamIds] = useState(member.teamIds);
  const [adminTeamIds, setAdminTeamIds] = useState(member.adminTeamIds);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, run] = useTransition();
  const fields = result && !result.ok ? (result.fields ?? {}) : {};
  const name = first(member.name);
  const self = member.id === data.selfId;
  const flip = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const save = () =>
    run(async () => {
      const r = await saveMember(member.id, { role, adminScope: role === "admin" ? scope : null, teamIds, adminTeamIds: role === "admin" && scope === "teams" ? adminTeamIds : [] }).catch(failed);
      setResult(r);
      if (!r.ok) {
        if (!r.fields) notify({ text: r.message, error: true });
        return;
      }
      notify({ text: `Saved ${name}’s role and teams` });
      onClose();
    });

  const toggleActive = () =>
    run(async () => {
      const r = await setActive(member.id, !member.active).catch(failed);
      if (!r.ok) {
        setConfirm(false);
        return notify({ text: r.message, error: true });
      }
      notify({ text: member.active ? `Deactivated ${member.name}` : `Reactivated ${member.name}` });
      onClose();
    });

  if (confirm) {
    return (
      <Dialog title={`Deactivate ${member.name}?`} onClose={() => setConfirm(false)} onSubmit={toggleActive}>
        <p className="muted">
          {name} leaves People, Timesheets and Attendance{member.role === "employee" ? "" : " and can’t open the dashboard"}. Their history stays, and you can reactivate them here.
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn quiet small" onClick={() => setConfirm(false)}>Cancel</button>
          <button type="submit" className="btn primary small" disabled={busy} aria-busy={busy}>Deactivate</button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={member.name} onClose={onClose} onSubmit={save}>
      <p className="muted" style={{ marginTop: -8 }}>{member.email}{member.active ? "" : " · Deactivated"}</p>
      <Field label="Role" error={fields.role}>
        <select className="field" value={role} onChange={(e) => setRole(e.target.value as SettingsMember["role"])} aria-invalid={!!fields.role}>
          <option value="employee">Employee: uses the Daylens app</option>
          <option value="admin">Admin: sees and reviews people in their scope</option>
          <option value="owner">Owner: sees everyone and changes settings</option>
        </select>
      </Field>
      {role === "admin" && (
        <Field label="Admin of" error={fields.adminScope}>
          <select className="field" value={scope} onChange={(e) => setScope(e.target.value as "org" | "teams")}>
            <option value="org">The whole firm</option>
            <option value="teams">Chosen teams</option>
          </select>
        </Field>
      )}
      <div className="team-pick" role="group" aria-label="Teams">
        <span className="faint">Team</span>
        <span className="faint">In team</span>
        <span className="faint">{role === "admin" && scope === "teams" ? "Admin" : ""}</span>
        {data.teams.map((t) => {
          const isAdmin = role === "admin" && scope === "teams" && adminTeamIds.includes(t.id);
          const inTeam = teamIds.includes(t.id) || isAdmin;
          return [
            <span key={t.id}>{t.name}</span>,
            <button key={t.id + "-in"} type="button" className="check" role="checkbox" aria-checked={inTeam} aria-label={`In ${t.name}`} disabled={isAdmin} onClick={() => setTeamIds(flip(teamIds, t.id))}>
              {inTeam && <Icon name="check" size={12} />}
            </button>,
            role === "admin" && scope === "teams" ? (
              <button key={t.id + "-admin"} type="button" className="check" role="checkbox" aria-checked={isAdmin} aria-label={`Admin of ${t.name}`} onClick={() => setAdminTeamIds(flip(adminTeamIds, t.id))}>
                {isAdmin && <Icon name="check" size={12} />}
              </button>
            ) : (
              <span key={t.id + "-admin"} />
            ),
          ];
        })}
      </div>
      {fields.teams && <p className="form-error">{fields.teams}</p>}
      {fields.form && <p className="form-error">{fields.form}</p>}
      <div className="dialog-actions">
        {!self && (
          <button type="button" className={`btn small ${member.active ? "danger-quiet" : "secondary"}`} style={{ marginRight: "auto" }} disabled={busy} onClick={() => (member.active ? setConfirm(true) : toggleActive())}>
            {member.active ? "Deactivate" : "Reactivate"}
          </button>
        )}
        <button type="button" className="btn quiet small" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn primary small" disabled={busy} aria-busy={busy}>Save</button>
      </div>
    </Dialog>
  );
}
