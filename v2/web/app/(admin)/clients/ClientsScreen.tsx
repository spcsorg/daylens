"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { clientColors } from "@/lib/colors";
import type { Catalog, CatalogClient, CatalogProject } from "@/lib/data/queries";
import { hrs, initials, shortDate, wholeHours } from "@/lib/format";
import { Dialog, Field, Toggle, ToastView, useToast, type Toast } from "../../ui/controls";
import { Icon } from "../../ui/Icon";
import { Empty, Header } from "../../ui/parts";
import { archiveClient, archiveProject, removeAssignment, saveAssignment, saveClient, saveProject, type Result } from "./actions";

type Assignment = CatalogProject["assignments"][number];
type Open =
  | { kind: "client"; id: string | null }
  | { kind: "project"; id: string | null; clientId?: string }
  | { kind: "assign"; projectId: string }
  | { kind: "dates"; assignment: Assignment };
type Notify = (t: Toast) => void;

const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const matches = (q: string, ...xs: string[]) => xs.some((x) => x.toLowerCase().includes(q));

function when(a: { startsAt: string | null; endsAt: string | null }) {
  if (a.startsAt && a.endsAt) return `${shortDate(a.startsAt)} to ${shortDate(a.endsAt)}`;
  if (a.startsAt) return `From ${shortDate(a.startsAt)}, no end date`;
  if (a.endsAt) return `Until ${shortDate(a.endsAt)}`;
  return "Always";
}

export function ClientsScreen({ data, selected }: { data: Catalog; selected?: string }) {
  const [q, setQ] = useState("");
  const [current, setCurrent] = useState(selected);
  const [open, setOpen] = useState<Open | null>(null);
  const [toast, notify] = useToast();
  const color = clientColors(data.clients);
  const projects = data.clients.flatMap((c) => c.projects);
  const project = projects.find((p) => p.id === current) ?? projects.find((p) => !p.archived) ?? projects[0];
  const client = project && data.clients.find((c) => c.id === project.clientId);
  const active = data.clients.filter((c) => !c.archived);
  const select = (id: string) => {
    setCurrent(id);
    window.history.replaceState(null, "", `?project=${id}`);
  };

  const head = (
    <Header title="Clients and projects" sub={`${active.length} clients · ${active.flatMap((c) => c.projects).filter((p) => !p.archived).length} projects`}>
      <button type="button" className="btn quiet small" onClick={() => setOpen({ kind: "client", id: null })}>New client</button>
      {active.length > 0 && (
        <button type="button" className="btn primary small" onClick={() => setOpen({ kind: "project", id: null, clientId: client && !client.archived ? client.id : undefined })}>
          <Icon name="plus" />
          New project
        </button>
      )}
    </Header>
  );

  const dialogs = (
    <>
      {open?.kind === "client" && (
        <ClientDialog
          client={data.clients.find((c) => c.id === open.id)}
          onClose={() => setOpen(null)}
          notify={notify}
          onCreated={(id, name) => {
            notify({ text: `Added ${name}. Add its first project next` });
            setOpen({ kind: "project", id: null, clientId: id });
          }}
        />
      )}
      {open?.kind === "project" && (
        <ProjectDialog
          project={projects.find((p) => p.id === open.id)}
          clientId={open.clientId}
          clients={data.clients}
          onClose={() => setOpen(null)}
          notify={notify}
          onCreated={select}
        />
      )}
      {open?.kind === "assign" && project && <AssignDialog project={project} data={data} onClose={() => setOpen(null)} notify={notify} />}
      {open?.kind === "dates" && <DatesDialog assignment={open.assignment} onClose={() => setOpen(null)} notify={notify} />}
      <ToastView toast={toast} />
    </>
  );

  if (!data.clients.length) {
    return (
      <>
        {head}
        <div className="scroll">
          <Empty
            lede="No clients yet"
            line="Add the firm’s clients and their projects, and Daylens starts matching people’s work to them."
            action={<button type="button" className="btn primary small" onClick={() => setOpen({ kind: "client", id: null })}><Icon name="plus" />New client</button>}
          />
        </div>
        {dialogs}
      </>
    );
  }

  const needle = q.trim().toLowerCase();
  const shown = (c: CatalogClient, archived: boolean) =>
    c.projects.filter((p) => (archived ? p.archived || c.archived : !p.archived && !c.archived) && (!needle || matches(needle, c.name, c.code, p.name, p.code)));
  const groups = active.filter((c) => (needle ? shown(c, false).length > 0 || matches(needle, c.name, c.code) : true));
  const archivedRows = data.clients.flatMap((c) => shown(c, true).map((p) => ({ c, p })));
  const archivedEmpty = data.clients.filter((c) => c.archived && !c.projects.length && (!needle || matches(needle, c.name, c.code)));
  const row = (c: CatalogClient, p: CatalogProject, detail: string) => (
    <button key={p.id} type="button" className="app-row" aria-current={p.id === project?.id} onClick={() => select(p.id)}>
      <span className="app-row-text">
        <span className="app-row-name" style={{ font: "var(--label)" }}>{p.name}</span>
        <span className="app-row-detail">{detail}</span>
      </span>
      <span className="app-row-ms">{p.seconds > 0 ? hrs(p.seconds) : "—"}</span>
    </button>
  );

  return (
    <>
      {head}
      <div className="scroll">
        <div className="split">
          <div className="panel list-panel">
            <div style={{ padding: "0 4px 8px" }}>
              <input className="field small" placeholder="Find a client, project or code" aria-label="Find a client, project or code" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {groups.length === 0 && archivedRows.length === 0 && archivedEmpty.length === 0 ? (
              <div className="empty" style={{ padding: "32px 12px" }}>
                <p>Nothing matches “{q}”.</p>
                <button type="button" className="btn secondary small" onClick={() => setQ("")}>Clear search</button>
              </div>
            ) : (
              <>
                {groups.map((c) => (
                  <div key={c.id}>
                    <button type="button" className="list-group" title={`Edit ${c.name}`} onClick={() => setOpen({ kind: "client", id: c.id })}>
                      <span className="swatch" style={{ background: color(c.id) }} />
                      <span className="grow">{c.name}</span>
                      <span className="faint">{c.code}</span>
                    </button>
                    {shown(c, false).map((p) => row(c, p, p.code + (p.billable ? "" : " · non-billable")))}
                    {!c.projects.some((p) => !p.archived) && (
                      <button type="button" className="app-row" onClick={() => setOpen({ kind: "project", id: null, clientId: c.id })}>
                        <span className="app-row-detail">No projects yet. Add one</span>
                      </button>
                    )}
                  </div>
                ))}
                {(archivedRows.length > 0 || archivedEmpty.length > 0) && <div className="list-divider">Archived</div>}
                {archivedRows.map(({ c, p }) => row(c, p, `${c.name} · ${p.code}`))}
                {archivedEmpty.map((c) => (
                  <button key={c.id} type="button" className="list-group" onClick={() => setOpen({ kind: "client", id: c.id })}>
                    <span className="swatch none" />
                    <span className="grow">{c.name}</span>
                    <span className="faint">{c.code}</span>
                  </button>
                ))}
              </>
            )}
          </div>
          {project && client ? (
            <ProjectDetail key={project.id} project={project} client={client} notify={notify} open={setOpen} />
          ) : (
            <Empty
              lede="No projects yet"
              line="Add a project to a client, then assign the people working on it."
              action={<button type="button" className="btn primary small" onClick={() => setOpen({ kind: "project", id: null })}><Icon name="plus" />New project</button>}
            />
          )}
        </div>
      </div>
      {dialogs}
    </>
  );
}

function useSave(notify: Notify) {
  const [busy, start] = useTransition();
  const save = (call: () => Promise<Result>, done: string) =>
    new Promise<boolean>((resolve) =>
      start(async () => {
        const r = await call().catch((): Result => ({ ok: false, message: "Couldn’t save: Daylens didn’t answer. Try again." }));
        notify(r.ok ? { text: done } : { text: r.message, error: true });
        resolve(r.ok);
      }),
    );
  return [busy, save] as const;
}

function ProjectDetail({ project, client, notify, open }: { project: CatalogProject; client: CatalogClient; notify: Notify; open: (o: Open) => void }) {
  const [busy, save] = useSave(notify);
  const archived = project.archived || client.archived;
  const setClient = (changes: Record<string, string[]>, done: string) => save(() => saveClient(client.id, changes), done);
  return (
    <div className="stack">
      <div className="detail-head">
        <div className="grow">
          <div className="faint" style={{ font: "var(--caption-strong)" }}>{client.name} · {project.code}</div>
          <h2>{project.name}</h2>
        </div>
        <button type="button" className="btn secondary small" onClick={() => open({ kind: "project", id: project.id })}>
          <Icon name="edit" />
          Edit
        </button>
      </div>
      {archived && (
        <div className="notice">
          <span>
            {project.archived ? "This project is archived" : `${client.name} is archived`}. It’s hidden from pickers and can’t be assigned; its hours stay in every report.
          </span>
          <button
            type="button"
            className="notice-action"
            disabled={busy}
            onClick={() => save(() => (project.archived ? archiveProject(project.id, false) : archiveClient(client.id, false)), `Restored ${project.archived ? project.name : client.name}`)}
          >
            Restore
          </button>
        </div>
      )}
      <div className="stats" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", margin: 0 }}>
        <div className="stat">
          <span className="stat-label">This week</span>
          <span className="stat-value">{wholeHours(project.seconds)}<small>h</small></span>
        </div>
        <div className="stat">
          <span className="stat-label">People with time on it</span>
          <span className="stat-value">{project.people}</span>
        </div>
      </div>
      <div>
        <p className="settings-heading">Billing</p>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-text">
              <span className="settings-row-label">Billable</span>
              <span className="settings-row-detail">Counts toward billable hours and exports to Odoo as billable time</span>
            </div>
            <Toggle
              checked={project.billable}
              label="Billable"
              disabled={busy}
              onChange={(next) => save(() => saveProject(project.id, { billable: next }), `${project.name} is ${next ? "billable" : "non-billable"}`)}
            />
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <span className="settings-row-label">Odoo project</span>
              <span className="settings-row-detail">Approved hours go to the Odoo project with the same code</span>
            </div>
            <span className="muted">{project.code}</span>
          </div>
        </div>
      </div>
      <div>
        <p className="settings-heading">How Daylens recognises it</p>
        <div className="settings-card" style={{ padding: "16px 20px" }}>
          <dl className="kv">
            <dt>Client names</dt>
            <dd><Chips label="Other name" fixed={client.name} busy={busy} items={client.aliases} onChange={(aliases, done) => setClient({ aliases }, done)} /></dd>
            <dt>Keywords</dt>
            <dd><Chips label="Keyword" busy={busy} items={project.keywords} onChange={(keywords, done) => save(() => saveProject(project.id, { keywords }), done)} /></dd>
            <dt>Websites</dt>
            <dd><Chips label="Website" busy={busy} items={client.domains} onChange={(domains, done) => setClient({ domains }, done)} /></dd>
            <dt>Email domains</dt>
            <dd><Chips label="Email domain" busy={busy} items={client.emailDomains} onChange={(emailDomains, done) => setClient({ emailDomains }, done)} /></dd>
          </dl>
        </div>
      </div>
      <div>
        <div className="section-head">
          <p className="settings-heading">Assigned</p>
          {!archived && (
            <button type="button" className="btn quiet small" onClick={() => open({ kind: "assign", projectId: project.id })}>
              <Icon name="plus" />
              Assign
            </button>
          )}
        </div>
        <div className="settings-card">
          {project.assignments.length === 0 ? (
            <div className="empty" style={{ padding: 28 }}>
              <p>No one is assigned yet. Daylens can still match time by the names and keywords above.</p>
            </div>
          ) : (
            project.assignments.map((a) => (
              <div key={a.id} className="settings-row" style={{ minHeight: 56 }}>
                <span className="avatar">{a.team ? <Icon name="people" size={14} /> : a.editable ? initials(a.name) : "?"}</span>
                <div className="settings-row-text">
                  <span className="settings-row-label">{a.team ? `${a.name} team` : a.name}</span>
                  <span className="settings-row-detail">{when(a)}</span>
                </div>
                {a.editable && (
                  <>
                    <button type="button" className="icon-btn" aria-label={`Change dates for ${a.name}`} onClick={() => open({ kind: "dates", assignment: a })}>
                      <Icon name="edit" />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Remove ${a.name}`}
                      disabled={busy}
                      onClick={() => save(() => removeAssignment(a.id), `${a.name} unassigned from ${project.name}`)}
                    >
                      <Icon name="x" />
                    </button>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Chips({ items, fixed, label, busy, onChange }: { items: string[]; fixed?: string; label: string; busy: boolean; onChange: (next: string[], done: string) => Promise<boolean> }) {
  const [adding, setAdding] = useState<string | null>(null);
  const add = async () => {
    const v = adding?.trim();
    if (!v) return setAdding(null);
    if (await onChange([...items, v], `Added ${v}`)) setAdding(null);
  };
  return (
    <div className="chips">
      {fixed && <span className="chip-x fixed" title="The client’s own name always counts">{fixed}</span>}
      {items.map((x) => (
        <span key={x} className="chip-x">
          {x}
          <button type="button" aria-label={`Remove ${x}`} disabled={busy} onClick={() => onChange(items.filter((y) => y !== x), `Removed ${x}`)}>
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
      {adding === null ? (
        <button type="button" className="chip-x add" disabled={busy} onClick={() => setAdding("")}>
          <Icon name="plus" size={12} />
          Add
        </button>
      ) : (
        <input
          className="chip-input"
          autoFocus
          aria-label={label}
          placeholder={label}
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onBlur={() => !adding.trim() && setAdding(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
            if (e.key === "Escape") setAdding(null);
          }}
        />
      )}
    </div>
  );
}

/** The fields, busy state and errors every dialog shares. A failed save keeps what was typed and says why. */
function useForm<T extends Record<string, string | boolean>>(initial: T) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, start] = useTransition();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const set = (k: keyof T) => (v: string | boolean) => setValues((x) => ({ ...x, [k]: v }));
  const submit = (call: () => Promise<Result>, ok: (r: Extract<Result, { ok: true }>) => void) =>
    start(async () => {
      const r = await call().catch((): Result => ({ ok: false, message: "Couldn’t save: Daylens didn’t answer. Your changes are still in the form." }));
      if (r.ok) return ok(r);
      setErrors(r.fields ?? { form: r.message });
    });
  return { values, set, errors, busy, submit, alive };
}

function Actions({ busy, label, onClose, left }: { busy: boolean; label: string; onClose: () => void; left?: ReactNode }) {
  return (
    <div className="dialog-actions">
      {left}
      <span className="grow" />
      <button type="button" className="btn quiet small" onClick={onClose}>Cancel</button>
      <button type="submit" className="btn primary small" disabled={busy} aria-busy={busy}>{label}</button>
    </div>
  );
}

function ClientDialog({ client, onClose, notify, onCreated }: { client?: CatalogClient; onClose: () => void; notify: Notify; onCreated: (id: string, name: string) => void }) {
  const f = useForm({ name: client?.name ?? "", code: client?.code ?? "", email: "", billable: client?.billable ?? true });
  const [archiving, start] = useTransition();
  const { values: v, errors: e } = f;
  const archive = () =>
    start(async () => {
      const r = await archiveClient(client!.id, !client!.archived).catch((): Result => ({ ok: false, message: "Couldn’t archive the client: Daylens didn’t answer. Try again." }));
      notify(r.ok ? { text: client!.archived ? `Restored ${client!.name}` : `Archived ${client!.name} and hid its projects from pickers` } : { text: r.message, error: true });
      if (r.ok && f.alive.current) onClose();
    });
  return (
    <Dialog
      title={client ? "Edit client" : "New client"}
      onClose={onClose}
      onSubmit={() =>
        f.submit(
          () => saveClient(client?.id ?? null, client ? { name: v.name, code: v.code, billable: v.billable } : { name: v.name, code: v.code, billable: v.billable, emailDomains: csv(v.email) }),
          (r) => {
            if (!f.alive.current) return;
            if (client) {
              notify({ text: `Saved ${v.name.trim()}` });
              onClose();
            } else onCreated(r.id!, v.name.trim());
          },
        )
      }
    >
      <Field label="Name" error={e.name}>
        <input className="field" aria-invalid={!!e.name} value={v.name} onChange={(x) => f.set("name")(x.target.value)} placeholder="Mara Coffee Exporters" />
      </Field>
      <div className="form-row">
        <Field label="Code" error={e.code}>
          <input className="field" aria-invalid={!!e.code} value={v.code} onChange={(x) => f.set("code")(x.target.value)} placeholder="MCE" />
        </Field>
        {!client && (
          <Field label="Email domain" error={e.emailDomains}>
            <input className="field" aria-invalid={!!e.emailDomains} value={v.email} onChange={(x) => f.set("email")(x.target.value)} placeholder="maracoffee.example" />
          </Field>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span className="grow" style={{ font: "var(--body-strong)" }}>Billable client</span>
        <Toggle checked={v.billable} label="Billable client" onChange={f.set("billable")} />
      </div>
      {e.form && <p className="form-error">{e.form}</p>}
      <Actions
        busy={f.busy}
        label={client ? "Save" : "Add client"}
        onClose={onClose}
        left={client && (
          <button type="button" className={`btn small ${client.archived ? "secondary" : "danger-quiet"}`} disabled={archiving} aria-busy={archiving} onClick={archive}>
            {client.archived ? "Restore client" : "Archive client"}
          </button>
        )}
      />
    </Dialog>
  );
}

function ProjectDialog({
  project,
  clientId,
  clients,
  onClose,
  notify,
  onCreated,
}: {
  project?: CatalogProject;
  clientId?: string;
  clients: CatalogClient[];
  onClose: () => void;
  notify: Notify;
  onCreated: (id: string) => void;
}) {
  const choices = clients.filter((c) => !c.archived || c.id === project?.clientId);
  const f = useForm({ name: project?.name ?? "", clientId: project?.clientId ?? clientId ?? choices[0]?.id ?? "", code: project?.code ?? "", keywords: project?.keywords.join(", ") ?? "", billable: project?.billable ?? true });
  const [archiving, start] = useTransition();
  const { values: v, errors: e } = f;
  const archive = () =>
    start(async () => {
      const r = await archiveProject(project!.id, !project!.archived).catch((): Result => ({ ok: false, message: "Couldn’t archive the project: Daylens didn’t answer. Try again." }));
      notify(r.ok ? { text: project!.archived ? `Restored ${project!.name}` : `Archived ${project!.name}. Its hours stay in every report` } : { text: r.message, error: true });
      if (r.ok && f.alive.current) onClose();
    });
  return (
    <Dialog
      title={project ? "Edit project" : "New project"}
      onClose={onClose}
      onSubmit={() =>
        f.submit(
          () => saveProject(project?.id ?? null, { name: v.name, clientId: v.clientId, code: v.code, keywords: csv(v.keywords), billable: v.billable }),
          (r) => {
            notify({ text: project ? `Saved ${v.name.trim()}` : `Created ${v.name.trim()}` });
            if (!f.alive.current) return;
            if (!project) onCreated(r.id!);
            onClose();
          },
        )
      }
    >
      <Field label="Name" error={e.name}>
        <input className="field" aria-invalid={!!e.name} value={v.name} onChange={(x) => f.set("name")(x.target.value)} placeholder="FY2027 statutory audit" />
      </Field>
      <div className="form-row">
        <Field label="Client" error={e.clientId}>
          <select className="field" aria-invalid={!!e.clientId} value={v.clientId} onChange={(x) => f.set("clientId")(x.target.value)}>
            {choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Code" error={e.code}>
          <input className="field" aria-invalid={!!e.code} value={v.code} onChange={(x) => f.set("code")(x.target.value)} placeholder="LKB-AUD-27" />
        </Field>
      </div>
      <Field label="Keywords people’s work might mention" error={e.keywords}>
        <input className="field" value={v.keywords} onChange={(x) => f.set("keywords")(x.target.value)} placeholder="year-end, stock count" />
      </Field>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span className="grow" style={{ font: "var(--body-strong)" }}>Billable</span>
        <Toggle checked={v.billable} label="Billable" onChange={f.set("billable")} />
      </div>
      {e.form && <p className="form-error">{e.form}</p>}
      <Actions
        busy={f.busy}
        label={project ? "Save" : "Create project"}
        onClose={onClose}
        left={project && (
          <button type="button" className={`btn small ${project.archived ? "secondary" : "danger-quiet"}`} disabled={archiving} aria-busy={archiving} onClick={archive}>
            {project.archived ? "Restore project" : "Archive project"}
          </button>
        )}
      />
    </Dialog>
  );
}

function AssignDialog({ project, data, onClose, notify }: { project: CatalogProject; data: Catalog; onClose: () => void; notify: Notify }) {
  const { teams, members } = data.assignable;
  const f = useForm({ who: "", startsAt: new Date().toLocaleDateString("en-CA"), endsAt: "" });
  const { values: v, errors: e } = f;
  const [kind, id] = v.who.split(":");
  const name = kind === "team" ? `${teams.find((t) => t.id === id)?.name} team` : members.find((m) => m.id === id)?.name;
  return (
    <Dialog
      title={`Assign to ${project.name}`}
      onClose={onClose}
      onSubmit={() =>
        f.submit(
          () => saveAssignment(null, { projectId: project.id, [kind === "team" ? "teamId" : "memberId"]: id, startsAt: v.startsAt, endsAt: v.endsAt }),
          () => {
            notify({ text: `${name} assigned to ${project.name}` });
            if (f.alive.current) onClose();
          },
        )
      }
    >
      <Field label="Person or team" error={e.who}>
        <select className="field" aria-invalid={!!e.who} value={v.who} onChange={(x) => f.set("who")(x.target.value)}>
          <option value="" disabled>Pick a person or team</option>
          <optgroup label="Teams">
            {teams.map((t) => <option key={t.id} value={`team:${t.id}`}>{t.name} team</option>)}
          </optgroup>
          <optgroup label="People">
            {members.map((m) => <option key={m.id} value={`member:${m.id}`}>{m.name}</option>)}
          </optgroup>
        </select>
      </Field>
      <DateFields values={v} errors={e} set={f.set} />
      <p className="muted" style={{ font: "var(--caption)" }}>Assigned people’s work leans toward this project when Daylens isn’t sure.</p>
      {e.form && <p className="form-error">{e.form}</p>}
      <Actions busy={f.busy} label="Assign" onClose={onClose} />
    </Dialog>
  );
}

function DatesDialog({ assignment, onClose, notify }: { assignment: Assignment; onClose: () => void; notify: Notify }) {
  const f = useForm({ startsAt: assignment.startsAt ?? "", endsAt: assignment.endsAt ?? "" });
  return (
    <Dialog
      title={`${assignment.team ? `${assignment.name} team` : assignment.name}’s dates`}
      onClose={onClose}
      onSubmit={() =>
        f.submit(
          () => saveAssignment(assignment.id, f.values),
          () => {
            notify({ text: `Saved ${assignment.name}’s dates` });
            if (f.alive.current) onClose();
          },
        )
      }
    >
      <DateFields values={f.values} errors={f.errors} set={f.set} />
      {f.errors.form && <p className="form-error">{f.errors.form}</p>}
      <Actions busy={f.busy} label="Save" onClose={onClose} />
    </Dialog>
  );
}

function DateFields({ values, errors, set }: { values: { startsAt: string; endsAt: string }; errors: Record<string, string>; set: (k: "startsAt" | "endsAt") => (v: string) => void }) {
  return (
    <div className="form-row">
      <Field label="From (optional)" error={errors.startsAt}>
        <input type="date" className="field" aria-invalid={!!errors.startsAt} value={values.startsAt} onChange={(x) => set("startsAt")(x.target.value)} />
      </Field>
      <Field label="Until (optional)" error={errors.endsAt}>
        <input type="date" className="field" aria-invalid={!!errors.endsAt} value={values.endsAt} onChange={(x) => set("endsAt")(x.target.value)} />
      </Field>
    </div>
  );
}
