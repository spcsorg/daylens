/** The org data model from SRS section 6, kept independent of the database that will store it. */

export type Role = "owner" | "admin" | "employee";
export type BlockKind = "work" | "idle" | "away";
export type TimesheetStatus = "draft" | "submitted" | "approved" | "rejected";

export type Org = {
  id: string;
  name: string;
  shortName: string;
  domains: string[];
  entraTenantId: string;
  policy: { timeZone: string; coreStart: number; coreEnd: number; workingDays: number[]; leaveTypes: string[] };
  retention: { activityMonths: number; timesheetYears: number };
};

export type Member = {
  id: string;
  orgId: string;
  entraObjectId: string;
  email: string;
  name: string;
  title: string;
  role: Role;
  /** An admin sees the whole org, or only the teams whose team_members row has isAdminScope. */
  adminScope?: "org" | "teams";
  status: "active" | "deactivated";
};

export type Team = { id: string; orgId: string; name: string };
export type TeamMember = { orgId: string; teamId: string; memberId: string; isAdminScope: boolean };
export type Device = { id: string; orgId: string; memberId: string; platform: "windows" | "macos" | "linux"; appVersion: string; lastSeenAt: number };
/** An archived client or project leaves the pickers but keeps its history; neither is ever deleted. */
export type Client = { id: string; orgId: string; name: string; code: string; aliases: string[]; domains: string[]; emailDomains: string[]; billable: boolean; archivedAt?: number };
export type Project = { id: string; orgId: string; clientId: string; name: string; code: string; keywords: string[]; billable: boolean; odooId?: number; archivedAt?: number };
export type Assignment = { id: string; orgId: string; projectId: string; memberId?: string; teamId?: string; startsAt?: string; endsAt?: string };

export type Block = {
  id: string;
  orgId: string;
  memberId: string;
  deviceId: string;
  revision: number;
  start: number;
  end: number;
  kind: BlockKind;
  label?: string;
  summary?: string;
  app?: string;
  title?: string;
  siteDomain?: string;
  clientId?: string;
  projectId?: string;
  confidence?: number;
  evidence?: string[];
  deleted: boolean;
};

/** One row per member, local date and project; the row without a project holds unattributed work and idle time. */
export type DailyRollup = {
  orgId: string;
  memberId: string;
  date: string;
  projectId?: string;
  seconds: number;
  billableSeconds: number;
  coreSeconds: number;
  idleSeconds: number;
};

export type Timesheet = {
  id: string;
  orgId: string;
  memberId: string;
  weekStart: string;
  status: TimesheetStatus;
  submittedAt?: number;
  approvedBy?: string;
  approvedAt?: number;
  version: number;
  reviewNote?: string;
};
export type TimesheetLine = { timesheetId: string; date: string; projectId: string; hours: number; description: string };
/** Whole days, startsOn to endsOn inclusive; the type is one of the org's leave types when it was recorded. */
export type Leave = { id: string; orgId: string; memberId: string; type: string; startsOn: string; endsOn: string };
export type AuditEntry = { orgId: string; actorId?: string; action: string; target: string; detail?: string; at: number };

export type Tables = {
  orgs: Org[];
  members: Member[];
  teams: Team[];
  teamMembers: TeamMember[];
  devices: Device[];
  clients: Client[];
  projects: Project[];
  assignments: Assignment[];
  blocks: Block[];
  dailyRollups: DailyRollup[];
  timesheets: Timesheet[];
  timesheetLines: TimesheetLine[];
  leave: Leave[];
  auditLog: AuditEntry[];
};
