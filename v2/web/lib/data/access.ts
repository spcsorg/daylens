import type { Member, Org, Tables } from "../domain/model";

/** Who a session belongs to. The dev sign-in writes it today; Auth.js with Microsoft Entra ID will later. */
export type Session = { memberId: string };

export class AccessError extends Error {}

export type Access = {
  org: Org;
  member: Member;
  /** Null when the admin sees the whole org. */
  teamIds: string[] | null;
};

export function requireAdmin(t: Tables, session: Session | null): Access {
  if (!session) throw new AccessError("Not signed in");
  const member = t.members.find((m) => m.id === session.memberId);
  const org = member && t.orgs.find((o) => o.id === member.orgId);
  if (!org || !member || member.status !== "active") throw new AccessError("You’re not a member of this organisation");
  if (member.role === "employee") throw new AccessError("Only admins can open the dashboard");
  if (member.role === "owner" || member.adminScope === "org") return { org, member, teamIds: null };
  const teamIds = t.teamMembers.filter((r) => r.memberId === member.id && r.isAdminScope).map((r) => r.teamId);
  return { org, member, teamIds };
}

/** Active members the admin may see, narrowed to one team when asked. */
export function membersInScope(t: Tables, access: Access, teamId?: string): Member[] {
  if (teamId && access.teamIds && !access.teamIds.includes(teamId)) {
    throw new AccessError("That team is outside your admin scope");
  }
  const teamIds = teamId ? [teamId] : access.teamIds;
  const ids = teamIds && new Set(t.teamMembers.filter((r) => teamIds.includes(r.teamId)).map((r) => r.memberId));
  return t.members.filter((m) => m.orgId === access.org.id && m.status === "active" && (!ids || ids.has(m.id)));
}

export function requireMemberInScope(t: Tables, access: Access, memberId: string): Member {
  const member = membersInScope(t, access).find((m) => m.id === memberId);
  if (!member) throw new AccessError("That person is outside your admin scope");
  return member;
}
