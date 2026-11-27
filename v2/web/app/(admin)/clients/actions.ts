"use server";

import { revalidatePath } from "next/cache";
import { assign, createClient, createProject, setClientArchived, setProjectArchived, unassign, updateAssignment, updateClient, updateProject, ValidationError } from "@/lib/data";
import { AccessError, type Session } from "@/lib/data/access";
import type { ClientInput, Fields, ProjectInput } from "@/lib/data/catalog";
import { requireSession } from "@/lib/session";

export type Result = { ok: true; id?: string } | { ok: false; message: string; fields?: Fields };

const str = (x: unknown) => (typeof x === "string" ? x : "");
const strs = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
const opt = (x: unknown) => str(x) || undefined;

function client(x: Partial<Record<keyof ClientInput, unknown>>): Partial<ClientInput> {
  const out: Partial<ClientInput> = {};
  if ("name" in x) out.name = str(x.name);
  if ("code" in x) out.code = str(x.code);
  if ("billable" in x) out.billable = x.billable === true;
  if ("aliases" in x) out.aliases = strs(x.aliases);
  if ("domains" in x) out.domains = strs(x.domains);
  if ("emailDomains" in x) out.emailDomains = strs(x.emailDomains);
  return out;
}

function project(x: Partial<Record<keyof ProjectInput, unknown>>): Partial<ProjectInput> {
  const out: Partial<ProjectInput> = {};
  if ("clientId" in x) out.clientId = str(x.clientId);
  if ("name" in x) out.name = str(x.name);
  if ("code" in x) out.code = str(x.code);
  if ("billable" in x) out.billable = x.billable === true;
  if ("keywords" in x) out.keywords = strs(x.keywords);
  return out;
}

async function run(what: string, write: (session: Session) => Promise<string | void>): Promise<Result> {
  const session = await requireSession();
  try {
    const id = await write(session);
    revalidatePath("/clients");
    return { ok: true, id: id ?? undefined };
  } catch (e) {
    if (e instanceof ValidationError) return { ok: false, message: e.message, fields: e.fields };
    if (e instanceof AccessError) return { ok: false, message: `Couldn’t ${what}. ${e.message}.` };
    console.error(e);
    return { ok: false, message: `Couldn’t ${what}: Daylens didn’t answer. Try again.` };
  }
}

const full = { name: "", code: "", billable: true, aliases: [], domains: [], emailDomains: [] } satisfies ClientInput;

export async function saveClient(id: string | null, input: Partial<Record<keyof ClientInput, unknown>>) {
  return run("save the client", (s) => (id ? updateClient(s, id, client(input)) : createClient(s, { ...full, ...client(input) })));
}

export async function archiveClient(id: string, archived: boolean) {
  return run(archived ? "archive the client" : "restore the client", (s) => setClientArchived(s, str(id), archived === true));
}

export async function saveProject(id: string | null, input: Partial<Record<keyof ProjectInput, unknown>>) {
  return run("save the project", (s) =>
    id ? updateProject(s, id, project(input)) : createProject(s, { clientId: "", name: "", code: "", billable: true, keywords: [], ...project(input) }),
  );
}

export async function archiveProject(id: string, archived: boolean) {
  return run(archived ? "archive the project" : "restore the project", (s) => setProjectArchived(s, str(id), archived === true));
}

export async function saveAssignment(id: string | null, input: { projectId?: unknown; memberId?: unknown; teamId?: unknown; startsAt?: unknown; endsAt?: unknown }) {
  const dates = { startsAt: opt(input.startsAt), endsAt: opt(input.endsAt) };
  return run("assign", (s) =>
    id ? updateAssignment(s, id, dates) : assign(s, { projectId: str(input.projectId), memberId: opt(input.memberId), teamId: opt(input.teamId), ...dates }),
  );
}

export async function removeAssignment(id: string) {
  return run("remove the assignment", (s) => unassign(s, str(id)));
}
