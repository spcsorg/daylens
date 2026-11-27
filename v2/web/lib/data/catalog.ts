import { and, eq } from "drizzle-orm";
import type { Access } from "./access";
import { requireAdmin, requireAssignee, type Session } from "./access";
import { appDb, asAdmin, type Db, type Tx } from "../db/client";
import * as s from "../db/schema";
import { loadAssignments, loadOrg } from "../db/store";
import type { Tables } from "../domain/model";

/**
 * Writes to clients, projects and assignments. Each runs as daylens_app with the admin set, so row-level security
 * checks it again, and adds its audit_log row in the same transaction.
 */

export type Fields = Record<string, string>;

/** What's wrong with the form, by field, for the dialog to show beside each one. */
export class ValidationError extends Error {
  constructor(readonly fields: Fields) {
    super(Object.values(fields)[0]);
  }
}

export type ClientInput = { name: string; code: string; billable: boolean; aliases: string[]; domains: string[]; emailDomains: string[] };
export type ProjectInput = { clientId: string; name: string; code: string; billable: boolean; keywords: string[] };
export type AssignmentInput = { projectId: string; memberId?: string; teamId?: string; startsAt?: string; endsAt?: string };

const CODE = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;
const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function list(values: string[], clean = (v: string) => v) {
  const seen = new Set<string>();
  return values.map((v) => clean(v.trim())).filter((v) => v && !seen.has(v.toLowerCase()) && seen.add(v.toLowerCase()));
}

const domain = (v: string) => v.toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
const emailDomain = (v: string) => v.toLowerCase().replace(/^.*@/, "");

function name(value: string, what: string, errors: Fields) {
  const v = value.trim();
  if (!v) errors.name = `Add the ${what}’s name.`;
  else if (v.length > 120) errors.name = "Keep the name under 120 characters.";
  return v;
}

function code(value: string, taken: { code: string; id: string }[], self: string | undefined, what: string, errors: Fields) {
  const v = value.trim().toUpperCase();
  if (!v) errors.code = `Add a code. It links the ${what} to Odoo.`;
  else if (!CODE.test(v)) errors.code = "Use letters, numbers and dashes, up to 32 characters.";
  else if (taken.some((x) => x.id !== self && x.code.toUpperCase() === v)) errors.code = `Another ${what} already uses ${v}.`;
  return v;
}

function domains(values: string[], clean: (v: string) => string, field: string, example: string, errors: Fields) {
  const out = list(values, clean);
  const bad = out.find((d) => !DOMAIN.test(d));
  if (bad) errors[field] = `“${bad}” isn’t a domain like ${example}.`;
  return out;
}

function checkClient(t: Tables, access: Access, input: ClientInput, self?: string) {
  const errors: Fields = {};
  const row = {
    name: name(input.name, "client", errors),
    code: code(input.code, t.clients.filter((c) => c.orgId === access.org.id), self, "client", errors),
    billable: input.billable,
    aliases: list(input.aliases),
    domains: domains(input.domains, domain, "domains", "client.com", errors),
    emailDomains: domains(input.emailDomains, emailDomain, "emailDomains", "client.com", errors),
  };
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return row;
}

function checkProject(t: Tables, access: Access, input: ProjectInput, self?: string) {
  const errors: Fields = {};
  const client = t.clients.find((c) => c.id === input.clientId && c.orgId === access.org.id);
  if (!client) errors.clientId = "Pick the client this project is for.";
  else if (client.archivedAt && client.id !== t.projects.find((p) => p.id === self)?.clientId) errors.clientId = `${client.name} is archived. Restore it first.`;
  const row = {
    clientId: input.clientId,
    name: name(input.name, "project", errors),
    code: code(input.code, t.projects.filter((p) => p.orgId === access.org.id), self, "project", errors),
    billable: input.billable,
    keywords: list(input.keywords),
  };
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return row;
}

function checkDates(startsAt: string | undefined, endsAt: string | undefined) {
  const errors: Fields = {};
  const valid = (d: string) => DATE.test(d) && new Date(d + "T00:00:00Z").toISOString().startsWith(d);
  if (startsAt && !valid(startsAt)) errors.startsAt = "Pick a start date.";
  if (endsAt && !valid(endsAt)) errors.endsAt = "Pick an end date.";
  if (startsAt && endsAt && !errors.startsAt && !errors.endsAt && endsAt < startsAt) errors.endsAt = "The end date is before the start date.";
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { startsAt: startsAt || null, endsAt: endsAt || null };
}

/** A unique-code race that slipped past the check above still reads as the form error. */
async function codeConflict<T>(what: "client" | "project", codeValue: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause ?? (e as { code?: string });
    if (cause?.code === "23505") throw new ValidationError({ code: `Another ${what} already uses ${codeValue}.` });
    throw e;
  }
}

async function audit(tx: Tx, access: Access, action: string, target: string) {
  await tx.insert(s.auditLog).values({ orgId: access.org.id, actorId: access.member.id, action, target });
}

function asWriter<T>(session: Session, db: Db, fn: (tx: Tx, t: Tables, access: Access) => Promise<T>) {
  return asAdmin(db, session.memberId, async (tx) => {
    const t = await loadOrg(tx, session.memberId);
    const access = requireAdmin(t, session);
    return fn(tx, t, access);
  });
}

function findClient(t: Tables, access: Access, id: string) {
  const client = t.clients.find((c) => c.id === id && c.orgId === access.org.id);
  if (!client) throw new ValidationError({ form: "That client no longer exists." });
  return client;
}

function findProject(t: Tables, access: Access, id: string) {
  const project = t.projects.find((p) => p.id === id && p.orgId === access.org.id);
  if (!project) throw new ValidationError({ form: "That project no longer exists." });
  return project;
}

export function createClient(session: Session, input: ClientInput, db: Db = appDb()) {
  return asWriter(session, db, async (tx, t, access) => {
    const row = checkClient(t, access, input);
    const [{ id }] = await codeConflict("client", row.code, () => tx.insert(s.clients).values({ ...row, orgId: access.org.id }).returning({ id: s.clients.id })) as [{ id: string }];
    await audit(tx, access, "client.created", `client:${id}`);
    return id;
  });
}

export function updateClient(session: Session, id: string, changes: Partial<ClientInput>, db: Db = appDb()) {
  return asWriter(session, db, async (tx, t, access) => {
    const client = findClient(t, access, id);
    const row = checkClient(t, access, { ...client, ...changes }, id);
    await codeConflict("client", row.code, () => tx.update(s.clients).set(row).where(and(eq(s.clients.id, id), eq(s.clients.orgId, access.org.id))));
    await audit(tx, access, "client.updated", `client:${id}`);
  });
}

export function setClientArchived(session: Session, id: string, archived: boolean, db: Db = appDb()) {
  return asWriter(session, db, async (tx, t, access) => {
    findClient(t, access, id);
    await tx.update(s.clients).set({ archivedAt: archived ? new Date() : null }).where(and(eq(s.clients.id, id), eq(s.clients.orgId, access.org.id)));
    await audit(tx, access, archived ? "client.archived" : "client.restored", `client:${id}`);
  });
}

export function createProject(session: Session, input: ProjectInput, db: Db = appDb()) {
  return asWriter(session, db, async (tx, t, access) => {
    const row = checkProject(t, access, input);
    const [{ id }] = await codeConflict("project", row.code, () => tx.insert(s.projects).values({ ...row, orgId: access.org.id }).returning({ id: s.projects.id })) as [{ id: string }];
    await audit(tx, access, "project.created", `project:${id}`);
    return id;
  });
}

export function updateProject(session: Session, id: string, changes: Partial<ProjectInput>, db: Db = appDb()) {
  return asWriter(session, db, async (tx, t, access) => {
    const project = findProject(t, access, id);
    const row = checkProject(t, access, { ...project, ...changes }, id);
    await codeConflict("project", row.code, () => tx.update(s.projects).set(row).where(and(eq(s.projects.id, id), eq(s.projects.orgId, access.org.id))));
    await audit(tx, access, "project.updated", `project:${id}`);
  });
}

export function setProjectArchived(session: Session, id: string, archived: boolean, db: Db = appDb()) {
  return asWriter(session, db, async (tx, t, access) => {
    findProject(t, access, id);
    await tx.update(s.projects).set({ archivedAt: archived ? new Date() : null }).where(and(eq(s.projects.id, id), eq(s.projects.orgId, access.org.id)));
    await audit(tx, access, archived ? "project.archived" : "project.restored", `project:${id}`);
  });
}

const assignee = (a: { memberId?: string | null; teamId?: string | null }) => (a.teamId ? `team:${a.teamId}` : `member:${a.memberId}`);

export function assign(session: Session, input: AssignmentInput, db: Db = appDb()) {
  return asWriter(session, db, async (tx, t, access) => {
    const project = findProject(t, access, input.projectId);
    if (project.archivedAt) throw new ValidationError({ form: `${project.name} is archived. Restore it to assign people.` });
    if (!input.memberId === !input.teamId) throw new ValidationError({ who: "Pick a person or a team." });
    requireAssignee(t, access, input, true);
    const dates = checkDates(input.startsAt, input.endsAt);
    const who = { memberId: input.memberId ?? null, teamId: input.teamId ?? null };
    const [{ id }] = (await tx.insert(s.assignments).values({ orgId: access.org.id, projectId: project.id, ...who, ...dates }).returning({ id: s.assignments.id })) as [{ id: string }];
    await audit(tx, access, "assignment.created", `project:${project.id}/${assignee(who)}`);
    return id;
  });
}

async function findAssignment(tx: Tx, t: Tables, access: Access, id: string) {
  await loadAssignments(tx, t, access.org.id);
  const a = t.assignments.find((x) => x.id === id);
  if (!a) throw new ValidationError({ form: "That assignment no longer exists." });
  requireAssignee(t, access, a, false);
  return a;
}

export function updateAssignment(session: Session, id: string, input: { startsAt?: string; endsAt?: string }, db: Db = appDb()) {
  return asWriter(session, db, async (tx, t, access) => {
    const a = await findAssignment(tx, t, access, id);
    await tx.update(s.assignments).set(checkDates(input.startsAt, input.endsAt)).where(and(eq(s.assignments.id, id), eq(s.assignments.orgId, access.org.id)));
    await audit(tx, access, "assignment.updated", `project:${a.projectId}/${assignee(a)}`);
  });
}

export function unassign(session: Session, id: string, db: Db = appDb()) {
  return asWriter(session, db, async (tx, t, access) => {
    const a = await findAssignment(tx, t, access, id);
    await tx.delete(s.assignments).where(and(eq(s.assignments.id, id), eq(s.assignments.orgId, access.org.id)));
    await audit(tx, access, "assignment.removed", `project:${a.projectId}/${assignee(a)}`);
  });
}
