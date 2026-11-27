"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import type { QueueRow, TimesheetQueue, TimesheetReview } from "@/lib/data/queries";
import { addDays, localDate } from "@/lib/domain/time";
import { clock, dayOfMonth, dayRange, hm, hrs, initials, pct, weekdayName, weekdayShort } from "@/lib/format";
import { Dialog, Field, ToastView, useToast, type Toast } from "../../ui/controls";
import { Icon } from "../../ui/Icon";
import { Empty, TimesheetStatus } from "../../ui/parts";
import { approve, reopen, sendBack, type Result } from "./actions";

export type Tab = "submitted" | "rejected" | "approved" | "missing";
type Notify = (t: Toast) => void;

const TABS: [Tab, string][] = [
  ["submitted", "Waiting for you"],
  ["rejected", "Sent back"],
  ["approved", "Approved"],
  ["missing", "Not sent yet"],
];

const inTab = (tab: Tab, r: QueueRow) => (tab === "missing" ? r.status === "missing" || r.status === "draft" : r.status === tab);
const first = (name: string) => name.split(" ")[0];
const quarter = (h: number) => (h ? h.toFixed(2) : "—");
const failed = (): Result => ({ ok: false, message: "Couldn’t save: Daylens didn’t answer. Try again." });

/** What's worth a second look before approving: hours far from what Daylens tracked, time with no project, a long week. */
function flags(r: QueueRow) {
  if (r.status === "missing") return [];
  const out: string[] = [];
  const gap = r.hours * 3600 - r.trackedSeconds;
  if (Math.abs(gap) >= 2 * 3600) out.push(`${hrs(Math.abs(gap))} ${gap > 0 ? "more" : "less"} than tracked`);
  if (r.unattributedSeconds >= 1.5 * 3600) out.push(`${hm(r.unattributedSeconds)} needs a project`);
  if (r.hours > 45) out.push("Over 45 h");
  return out;
}

function useLink() {
  const path = usePathname();
  const params = useSearchParams();
  return (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    return `${path}?${next}`;
  };
}

export function TimesheetsScreen({
  queue,
  review,
  problem,
  tab,
  week,
  timeZone,
}: {
  queue: TimesheetQueue;
  review: TimesheetReview | null;
  problem: string | null;
  tab: Tab;
  week: { from: string; label: string };
  timeZone: string;
}) {
  const link = useLink();
  const router = useRouter();
  const [toast, notify] = useToast();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, start] = useTransition();
  const rows = queue.people.filter((r) => inTab(tab, r));
  const selectable = tab === "submitted" ? rows.filter((r) => r.sheet) : [];
  const selected = selectable.filter((r) => picked.has(r.sheet!.id));
  const all = selectable.length > 0 && selected.length === selectable.length;
  const toggle = (id: string) => setPicked((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const close = () => router.replace(link({ sheet: null }), { scroll: false });
  const earlier = queue.waitingElsewhere[0];
  const elsewhere = queue.waitingElsewhere.reduce((a, w) => a + w.count, 0);

  const bulk = () =>
    start(async () => {
      const r = await approve(selected.map((x) => ({ id: x.sheet!.id, version: x.sheet!.version }))).catch(failed);
      if (!r.ok) return notify({ text: r.message, error: true });
      notify({ text: `Approved ${selected.length} timesheet${selected.length === 1 ? "" : "s"}. They’re locked now` });
      setPicked(new Set());
    });

  const sent = (r: QueueRow) => {
    if (r.status === "missing") return "—";
    if (!r.sheet?.submittedAt) return "Draft, not sent";
    return `${weekdayShort(localDate(r.sheet.submittedAt, timeZone))} ${clock(r.sheet.submittedAt, timeZone)}`;
  };

  return (
    <>
      {problem && (
        <div className="notice problem" role="alert" style={{ marginBottom: 16 }}>
          <Icon name="alert" />
          <span>{problem}</span>
        </div>
      )}
      {earlier && (
        <div className="notice" style={{ marginBottom: 16 }}>
          <span>
            {elsewhere} more {elsewhere === 1 ? "timesheet is" : "timesheets are"} waiting for you from other weeks, starting with {dayRange(earlier.weekStart, addDays(earlier.weekStart, 4))}.
          </span>
          <Link className="notice-action" href={link({ date: earlier.weekStart, tab: null, sheet: null })}>Open that week</Link>
        </div>
      )}
      <nav className="settings-tabs" aria-label="Timesheets by status">
        {TABS.map(([key, label]) => (
          <Link key={key} aria-current={tab === key ? "page" : undefined} href={link({ tab: key === "submitted" ? null : key, sheet: null })} scroll={false}>
            {label} <span className="faint">{queue.people.filter((r) => inTab(key, r)).length}</span>
          </Link>
        ))}
      </nav>
      {tab === "submitted" && rows.length > 0 && (
        <div className="toolbar" style={{ marginBottom: 12, minHeight: 32, paddingLeft: 12 }}>
          <button
            type="button"
            className="check"
            role="checkbox"
            aria-checked={all ? true : selected.length ? "mixed" : false}
            aria-label="Select all"
            onClick={() => setPicked(all ? new Set() : new Set(selectable.map((r) => r.sheet!.id)))}
          >
            {all ? <Icon name="check" size={12} /> : selected.length ? <Icon name="minus" size={12} /> : null}
          </button>
          <span className="muted" style={{ marginLeft: 8 }}>
            {selected.length ? `${selected.length} selected · ${hrs(selected.reduce((a, r) => a + r.hours, 0) * 3600)}` : "Select timesheets to approve together"}
          </span>
          <span className="grow" />
          <button type="button" className="btn primary small" disabled={!selected.length || busy} aria-busy={busy} onClick={bulk}>
            {selected.length ? `Approve ${selected.length}` : "Approve"}
          </button>
        </div>
      )}
      {rows.length === 0 ? (
        <Empty
          lede={{ submitted: "Nothing waiting for you", rejected: "Nothing sent back", approved: "Nothing approved yet", missing: "Everyone has sent theirs" }[tab]}
          line={
            queue.people.length === 0
              ? "No one in this team yet. Pick another team."
              : {
                  submitted: `Every timesheet for ${week.label} is approved or still with its owner.`,
                  rejected: `No timesheet for ${week.label} is waiting on changes.`,
                  approved: `Timesheets you approve for ${week.label} show here, locked.`,
                  missing: `Every timesheet for ${week.label} has been sent.`,
                }[tab]
          }
        />
      ) : (
        <table className="table">
          <thead>
            <tr>
              {tab === "submitted" && <th style={{ width: 40 }} />}
              <th>Person</th>
              <th className="r">Hours</th>
              <th className="r">Tracked</th>
              <th className="r">Billable</th>
              <th>Sent</th>
              <th>Worth a look</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const f = flags(r);
              const isPicked = !!r.sheet && picked.has(r.sheet.id);
              return (
                <tr key={r.memberId} aria-selected={isPicked}>
                  {tab === "submitted" && (
                    <td>
                      <button type="button" className="check" role="checkbox" aria-checked={isPicked} aria-label={`Select ${r.name}`} onClick={() => toggle(r.sheet!.id)}>
                        {isPicked && <Icon name="check" size={12} />}
                      </button>
                    </td>
                  )}
                  <td>
                    <div className="who">
                      <span className="avatar">{initials(r.name)}</span>
                      <div>
                        <Link className="row-link" href={r.sheet ? link({ sheet: r.sheet.id }) : `/people/${r.memberId}?range=week&date=${week.from}`} scroll={false}>
                          <b>{r.name}</b>
                        </Link>
                        <small>{r.teams.join(", ")}</small>
                      </div>
                    </div>
                  </td>
                  <td className="r"><b style={{ font: "var(--label)" }}>{r.sheet ? hrs(r.hours * 3600) : "—"}</b></td>
                  <td className="r muted">{hrs(r.trackedSeconds)}</td>
                  <td className="r">{r.hours ? pct(r.billableHours / r.hours) : "—"}</td>
                  <td className="muted">{sent(r)}</td>
                  <td>{f.length ? <span className="muted">{f.join(" · ")}</span> : <span className="faint">—</span>}</td>
                  <td><TimesheetStatus status={r.status} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {review && <ReviewDialog key={review.id + review.version} review={review} timeZone={timeZone} onClose={close} notify={notify} />}
      <ToastView toast={toast} />
    </>
  );
}

function ReviewDialog({ review, timeZone, onClose, notify }: { review: TimesheetReview; timeZone: string; onClose: () => void; notify: Notify }) {
  const [step, setStep] = useState<"review" | "send-back" | "reopen">("review");
  const [busy, start] = useTransition();
  const name = first(review.member.name);
  const seen = { id: review.id, version: review.version };
  const total = review.claimed.reduce((a, x) => a + x, 0);
  const trackedTotal = review.tracked.reduce((a, x) => a + x, 0);
  const day = (ms: number) => weekdayName(localDate(ms, timeZone));

  if (step === "send-back") {
    return (
      <NoteDialog
        title={`Send ${name}’s timesheet back`}
        label="What should change?"
        placeholder="Move Tuesday’s 3 h from the Lakeside audit to the tax health check"
        hint={`${name} sees this in the Daylens app and can send it again.`}
        action="Send back"
        field="comment"
        onCancel={() => setStep("review")}
        save={(note) => sendBack(seen, note)}
        done={() => {
          notify({ text: `Sent back to ${name}` });
          if (new URLSearchParams(window.location.search).get("sheet") === review.id) onClose();
        }}
        onFail={notify}
      />
    );
  }
  if (step === "reopen") {
    return (
      <NoteDialog
        title={`Reopen ${name}’s timesheet`}
        label="Why does it need reopening?"
        placeholder="Wednesday’s hours went to the wrong project"
        hint="It goes back to Waiting for you, unlocked. The reason goes in the audit log."
        action="Reopen"
        field="reason"
        onCancel={() => setStep("review")}
        save={(note) => reopen(seen, note)}
        done={() => notify({ text: "Reopened. The reason is in the audit log" })}
        onFail={notify}
      />
    );
  }

  const doApprove = () =>
    start(async () => {
      const r = await approve([seen]).catch(failed);
      if (!r.ok) return notify({ text: r.message, error: true });
      notify({ text: `Approved ${review.member.name}’s timesheet` });
      if (new URLSearchParams(window.location.search).get("sheet") === review.id) onClose();
    });

  const last = review.lastReview;
  const note =
    review.note &&
    (review.status === "rejected"
      ? `${last && !last.reopened ? `${last.by === "you" ? "You" : last.by} sent it back on ${day(last.at)}` : "Sent back"}: “${review.note}”`
      : review.status === "submitted"
        ? `${last?.reopened ? `${last.by === "you" ? "You" : last.by} reopened it on ${day(last.at)}` : "Reopened"}: “${review.note}”`
        : null);

  return (
    <Dialog
      title={`${review.member.name}’s timesheet`}
      wide
      onClose={onClose}
      onSubmit={() => {}}
      heading={
        <div className="dialog-head">
          <span className="avatar lg">{initials(review.member.name)}</span>
          <div className="grow">
            <h2>{review.member.name}</h2>
            <div className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {dayRange(review.weekStart, addDays(review.weekStart, 4))} · {hrs(total * 3600)} · <TimesheetStatus status={review.status} />
            </div>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
      }
    >
      {note && (
        <div className="notice">
          <Icon name="alert" />
          <span>{note}</span>
        </div>
      )}
      {review.rows.length === 0 ? (
        <p className="muted">No hours on it yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Project</th>
              {review.days.map((d) => <th key={d} className="r">{weekdayShort(d)} {dayOfMonth(d)}</th>)}
              <th className="r">Total</th>
            </tr>
          </thead>
          <tbody>
            {review.rows.map((r) => (
              <tr key={r.projectId}>
                <td className="lines">
                  <b style={{ font: "var(--label)" }}>{r.project.internal ? r.project.name : `${r.project.clientName} · ${r.project.name}`}</b>
                  {r.descriptions.length > 0 && <div className="muted" style={{ font: "var(--caption)" }}>{r.descriptions.join("; ")}</div>}
                </td>
                {r.hours.map((h, i) => <td key={i} className="r">{h ? quarter(h) : <span className="faint">—</span>}</td>)}
                <td className="r"><b style={{ font: "var(--label)" }}>{quarter(r.total)}</b></td>
              </tr>
            ))}
            <tr>
              <td style={{ font: "var(--label)" }}>Total</td>
              {review.claimed.map((h, i) => <td key={i} className="r">{quarter(h)}</td>)}
              <td className="r"><b style={{ font: "var(--label)" }}>{quarter(total)}</b></td>
            </tr>
            <tr className="tracked">
              <td>Tracked by Daylens</td>
              {review.tracked.map((h, i) => <td key={i} className="r">{h ? h.toFixed(2) : "—"}</td>)}
              <td className="r">{trackedTotal.toFixed(2)}</td>
            </tr>
          </tbody>
        </table>
      )}
      <div className="dialog-actions">
        <Link className="btn quiet small" href={`/people/${review.member.id}?range=week&date=${review.weekStart}`}>
          Open {name}’s week
          <Icon name="arrow-right" />
        </Link>
        <span className="grow" />
        {review.status === "submitted" && (
          <>
            <button type="button" className="btn secondary small" onClick={() => setStep("send-back")}>Send back</button>
            <button type="button" className="btn primary small" disabled={busy} aria-busy={busy} onClick={doApprove}>Approve</button>
          </>
        )}
        {review.status === "approved" && (
          <>
            <span className="muted">
              Approved{review.approved?.by ? ` by ${review.approved.by}` : ""}
              {review.approved ? ` on ${day(review.approved.at)}` : ""} · locked
            </span>
            <button type="button" className="btn secondary small" onClick={() => setStep("reopen")}>Reopen</button>
          </>
        )}
        {review.status === "rejected" && <span className="muted">Waiting for {name} to send it again</span>}
        {review.status === "draft" && <span className="muted">{name} hasn’t sent it yet</span>}
      </div>
    </Dialog>
  );
}

function NoteDialog({
  title,
  label,
  placeholder,
  hint,
  action,
  field,
  onCancel,
  save,
  done,
  onFail,
}: {
  title: string;
  label: string;
  placeholder: string;
  hint: string;
  action: string;
  field: string;
  onCancel: () => void;
  save: (note: string) => Promise<Result>;
  done: () => void;
  onFail: Notify;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const submit = () => {
    if (!note.trim()) return setError(field === "comment" ? "Say what should change, so they know what to fix." : "Say why it needs reopening. It goes in the audit log.");
    start(async () => {
      const r = await save(note).catch(failed);
      if (r.ok) return done();
      if (r.fields?.[field]) return setError(r.fields[field]);
      onFail({ text: r.message, error: true });
      onCancel();
    });
  };
  return (
    <Dialog title={title} onClose={onCancel} onSubmit={submit}>
      <Field label={label} error={error ?? undefined}>
        <textarea className="field" rows={4} aria-invalid={!!error} value={note} placeholder={placeholder} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <p className="muted" style={{ font: "var(--caption)" }}>{hint}</p>
      <div className="dialog-actions">
        <button type="button" className="btn quiet small" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn primary small" disabled={busy} aria-busy={busy}>{action}</button>
      </div>
    </Dialog>
  );
}
