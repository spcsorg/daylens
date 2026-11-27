CREATE TYPE "public"."admin_scope" AS ENUM('org', 'teams');--> statement-breakpoint
CREATE TYPE "public"."block_kind" AS ENUM('work', 'idle', 'away');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('active', 'deactivated');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'employee');--> statement-breakpoint
CREATE TYPE "public"."timesheet_status" AS ENUM('draft', 'submitted', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"member_id" uuid,
	"team_id" uuid,
	"starts_at" date,
	"ends_at" date
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"end" timestamp with time zone NOT NULL,
	"kind" "block_kind" NOT NULL,
	"label" text,
	"summary" text,
	"app" text,
	"title" text,
	"site_domain" text,
	"client_id" uuid,
	"project_id" uuid,
	"confidence" real,
	"evidence" text[],
	"deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"aliases" text[] NOT NULL,
	"domains" text[] NOT NULL,
	"billable" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_rollups" (
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"date" date NOT NULL,
	"project_id" uuid,
	"seconds" real NOT NULL,
	"billable_seconds" real NOT NULL,
	"core_seconds" real NOT NULL,
	"idle_seconds" real NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"app_version" text NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"entra_object_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"role" "member_role" NOT NULL,
	"admin_scope" "admin_scope",
	"status" "member_status" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"short_name" text NOT NULL,
	"domains" text[] NOT NULL,
	"entra_tenant_id" text NOT NULL,
	"policy" jsonb NOT NULL,
	"retention" jsonb NOT NULL,
	CONSTRAINT "orgs_entraTenantId_unique" UNIQUE("entra_tenant_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"keywords" text[] NOT NULL,
	"billable" boolean NOT NULL,
	"odoo_id" integer
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"is_admin_scope" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timesheet_lines" (
	"timesheet_id" uuid NOT NULL,
	"date" date NOT NULL,
	"project_id" uuid NOT NULL,
	"hours" real NOT NULL,
	"description" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timesheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"status" timesheet_status NOT NULL,
	"submitted_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_members_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_rollups" ADD CONSTRAINT "daily_rollups_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_rollups" ADD CONSTRAINT "daily_rollups_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_rollups" ADD CONSTRAINT "daily_rollups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_lines" ADD CONSTRAINT "timesheet_lines_timesheet_id_timesheets_id_fk" FOREIGN KEY ("timesheet_id") REFERENCES "public"."timesheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_lines" ADD CONSTRAINT "timesheet_lines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_approved_by_members_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignments_project_id_index" ON "assignments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "audit_log_org_id_at_index" ON "audit_log" USING btree ("org_id","at");--> statement-breakpoint
CREATE INDEX "blocks_org_id_member_id_start_index" ON "blocks" USING btree ("org_id","member_id","start");--> statement-breakpoint
CREATE INDEX "clients_org_id_index" ON "clients" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "daily_rollups_org_id_date_index" ON "daily_rollups" USING btree ("org_id","date");--> statement-breakpoint
CREATE INDEX "daily_rollups_member_id_date_index" ON "daily_rollups" USING btree ("member_id","date");--> statement-breakpoint
CREATE INDEX "devices_org_id_last_seen_at_index" ON "devices" USING btree ("org_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "members_org_id_index" ON "members" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "members_org_id_entra_object_id_index" ON "members" USING btree ("org_id","entra_object_id");--> statement-breakpoint
CREATE INDEX "projects_org_id_index" ON "projects" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "team_members_team_id_index" ON "team_members" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "team_members_member_id_index" ON "team_members" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "teams_org_id_index" ON "teams" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "timesheet_lines_timesheet_id_index" ON "timesheet_lines" USING btree ("timesheet_id");--> statement-breakpoint
CREATE INDEX "timesheets_org_id_week_start_index" ON "timesheets" USING btree ("org_id","week_start");--> statement-breakpoint
CREATE INDEX "timesheets_member_id_week_start_index" ON "timesheets" USING btree ("member_id","week_start");